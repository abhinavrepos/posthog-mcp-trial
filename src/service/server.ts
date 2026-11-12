import { startBriefingDelivery } from '../core/briefingdelivery.ts'
// The triage service:
//   POST /webhooks/jira   signed Jira webhook → 202 at once, triage runs in the background
//   GET  /clips/<name>    signed, expiring clip links (with Range support so the video can seek)
//   POST /mcp             the MCP tools over Streamable HTTP, behind a bearer token
//   POST/GET/DELETE /posthog-mcp  PostHog MCP with Lens routing and replay refusal
//   GET  /status          recent jobs
//   GET  /replays         the replay clip page (PostHog login), see replays.ts
import { startPrewarm } from '../mcp/prewarm.ts'
import { startReplaySignals } from '../core/experience.ts'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { brotliCompress, constants, gzip } from 'node:zlib'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { makeAi } from '../core/ai.ts'
import { shutdownClips } from '../core/clip.ts'
import { config, jiraConfigured, posthogMcpActive } from '../core/config.ts'
import { verifyClipLink } from '../core/links.ts'
import { renderReport } from '../core/report.ts'
import { triage } from '../core/triage.ts'
import { addAttachment, addComment, addLabels, getIssue, hasTriageComment, issueToTicket, verifyWebhookSignature } from '../jira/client.ts'
import { bearerAuthorized, handlePosthogMcp } from '../mcp/posthog-proxy.ts'
import { lensServerInfo } from '../mcp/server-info.ts'
import { guardTransport, registryOf } from '../mcp/anonymise.ts'
import { anonymiseOn } from '../core/anonymise.ts'
import { refreshRoster } from '../core/anonroster.ts'
import { serverInstructions } from '../mcp/instructions.ts'
import { lensToolNames, registerTools } from '../mcp/tools.ts'
import { appEvents } from '../core/appevents.ts'
import { startTaskHistory } from '../core/tasks.ts'
import { audit, chatCaller } from './access.ts'
import { keptReleases, syncReleases, syncStatus } from '../core/releases.ts'
import { captionedFile } from '../core/comments.ts'
import { getClip, handleReplays, pruneOldClips, streamMp4 } from './replays.ts'

const ai = makeAi()

interface Job {
    key: string
    event: string
    state: 'queued' | 'running' | 'done' | 'skipped' | 'failed'
    detail?: string
    priority?: string
    at: string
    elapsed_s?: number
}
const jobs: Job[] = []
const inFlight = new Set<string>()
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))

async function readRaw(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
        size += (c as Buffer).length
        if (size > limit) throw new Error('body too large')
        chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', ...headers })
    res.end(text)
}

async function runJob(job: Job) {
    if (inFlight.has(job.key)) {
        job.state = 'skipped'
        job.detail = 'already running'
        return
    }
    inFlight.add(job.key)
    job.state = 'running'
    try {
        const issue = await getIssue(job.key)
        const ticket = issueToTicket(issue)
        if (!ticket) {
            job.state = 'skipped'
            job.detail = `issue type "${issue.fields.issuetype?.name}" is not triaged`
            return
        }
        // Jira retries deliveries. The marker comment makes a second delivery a no-op.
        if (await hasTriageComment(job.key)) {
            job.state = 'skipped'
            job.detail = 'already triaged'
            return
        }
        const report = await triage(ticket, { ai })
        if (report.clip) await addAttachment(job.key, report.clip.file)
        await addComment(job.key, renderReport(report))
        await addLabels(job.key, ['triaged', `suggested-${report.severity.priority.toLowerCase()}`])
        job.state = 'done'
        job.priority = report.severity.priority
        job.elapsed_s = report.elapsed_s
        job.detail = report.incident ? `${report.incident.kind} in ${report.incident.session_id}` : report.struggle ? 'struggle session' : 'no session found'
        log('triaged', { key: job.key, priority: job.priority, elapsed_s: job.elapsed_s })
    } catch (e) {
        job.state = 'failed'
        job.detail = (e as Error).message
        log('triage failed', { key: job.key, error: job.detail })
    } finally {
        inFlight.delete(job.key)
    }
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse) {
    if (!jiraConfigured()) return send(res, 503, { error: 'Jira is not connected: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN' })
    const raw = await readRaw(req)
    if (!verifyWebhookSignature(raw, req.headers['x-hub-signature'] as string | undefined)) {
        log('webhook rejected: bad signature')
        return send(res, 401, { error: 'invalid signature' })
    }
    let body: { webhookEvent?: string; issue?: { key?: string } }
    try {
        body = JSON.parse(raw.toString('utf8'))
    } catch {
        return send(res, 400, { error: 'invalid JSON' })
    }
    const key = body.issue?.key
    const event = body.webhookEvent || ''
    if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return send(res, 400, { error: 'no issue key' })
    if (event !== 'jira:issue_created') return send(res, 200, { ignored: event })
    const job: Job = { key, event, state: 'queued', at: new Date().toISOString() }
    jobs.unshift(job)
    jobs.length = Math.min(jobs.length, 100)
    send(res, 202, { accepted: key })
    void runJob(job)
}

async function serveClip(req: IncomingMessage, res: ServerResponse, url: URL) {
    const name = decodeURIComponent(url.pathname.slice('/clips/'.length))
    if (name !== basename(name) || !/^[A-Za-z0-9-]+_\d+-\d+\.mp4$/.test(name)) return send(res, 404, 'not found')
    if (!verifyClipLink(name, url.searchParams.get('exp'), url.searchParams.get('sig'))) return send(res, 403, 'This clip link is invalid or has expired.')
    const file = join(config.clip.outDir, name)
    if (!existsSync(file)) return send(res, 404, 'not found')
    // c=1: with the comments burned in, as they are now (a link shared before an edit shows the edit).
    const clip = url.searchParams.get('c') === '1' ? getClip(name) : undefined
    const out = clip ? await captionedFile(name, clip.end_s - clip.start_s) : file
    if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit('signed-link', 'clip.viewed', { clip: name, comments: out !== file })
    streamMp4(req, res, out)
}

function featureState() {
    return { lens_mcp: config.features.lensMcp, posthog_mcp: posthogMcpActive(), posthog_mcp_switch: config.features.posthogMcp, jira: jiraConfigured(), ai: !!ai }
}

function bearerOk(req: IncomingMessage): boolean {
    return bearerAuthorized(req, config.service.mcpToken)
}
/** The shared token, or a person's own token (Connect chat page): who asks, and their survey role. */
const callerOf = (req: IncomingMessage) => chatCaller(/^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1], config.service.mcpToken)

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (!config.features.lensMcp) return send(res, 503, { error: `${config.app.name}'s MCP tools are switched off (FEATURE_LENS_MCP=off).` })
    const caller = callerOf(req)
    if (!caller) return send(res, 401, { error: 'MCP needs Authorization: Bearer <MCP_TOKEN or your personal token from the Connect chat page>' })
    // Stateless: a fresh server and transport per request, with the tools this caller may use.
    const server = new McpServer(lensServerInfo, { instructions: serverInstructions(undefined, caller.surveyRole, caller.dashboardRole) })
    registerTools(server, ai, caller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
        void transport.close()
        void server.close()
    })
    await server.connect(transport)
    // Client anonymisation (Admin → Client privacy for AI): every message in and out goes through the guard.
    if (anonymiseOn()) await refreshRoster()
    guardTransport(transport, registryOf(server))
    const body = req.method === 'POST' ? JSON.parse((await readRaw(req, 5_000_000)).toString('utf8') || 'null') : undefined
    await transport.handleRequest(req, res, body)
}

/** Compress only complete HTML/JSON bodies. The first write/flush commits a stream unchanged.
 * No response cache: authenticated pages and tool results must retain their own cache policy.
 */
export function compressResponse(req: IncomingMessage, res: ServerResponse) {
    if (req.method === 'HEAD' || req.headers.range || process.env.LENS_HTTP_COMPRESSION === 'off') return
    const writeHead = res.writeHead.bind(res)
    const write = res.write.bind(res)
    const end = res.end.bind(res)
    const flush = res.flushHeaders.bind(res)
    let pending: (() => void) | undefined
    const commit = () => { res.writeHead = writeHead; const fn = pending; pending = undefined; fn?.() }
    // Defer just the headers until end(), so existing page handlers need no changes.
    res.writeHead = ((status: number, reason: unknown, headers?: unknown) => {
        const values = typeof reason === 'string' ? headers : reason
        if (Array.isArray(values)) {
            for (let i = 0; i < values.length; i += 2) res.setHeader(String(values[i]), String(values[i + 1]))
        } else if (values) {
            for (const [key, value] of Object.entries(values)) if (value !== undefined) res.setHeader(key, value as string | number | string[])
        }
        res.statusCode = status
        if (typeof reason === 'string') res.statusMessage = reason
        pending = () => { writeHead(res.statusCode) }
        const type = String(res.getHeader('content-type') || '')
        if (!/^(text\/html|application\/(?:[\w.+-]+\+)?json)(?:;|$)/i.test(type)
            || [204, 206, 304].includes(status) || res.hasHeader('content-encoding') || res.hasHeader('content-range')) commit()
        return res
    }) as typeof res.writeHead
    res.write = ((...args: Parameters<typeof res.write>) => { commit(); return write(...args) }) as typeof res.write
    res.flushHeaders = () => { commit(); flush() }
    res.end = ((chunk?: string | Uint8Array | (() => void), encoding?: BufferEncoding | (() => void), callback?: () => void) => {
        const done = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback
        const body = typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined
        const type = String(res.getHeader('content-type') || '')
        const eligible = !res.headersSent && body && body.length >= 1024 && body.length <= 4 * 1024 * 1024
            && /^(text\/html|application\/(?:[\w.+-]+\+)?json)(?:;|$)/i.test(type)
            && res.statusCode !== 206 && res.statusCode !== 204 && res.statusCode !== 304
            && !res.hasHeader('content-encoding') && !res.hasHeader('content-range')
            && !/\bno-transform\b/i.test(String(res.getHeader('cache-control') || ''))
        if (!eligible) { commit(); return end(body, done) }
        const vary = String(res.getHeader('vary') || '')
        if (vary !== '*' && !vary.toLowerCase().split(/\s*,\s*/).includes('accept-encoding')) res.setHeader('vary', [vary, 'Accept-Encoding'].filter(Boolean).join(', '))
        const accepted = new Map(String(req.headers['accept-encoding'] || '').toLowerCase().split(',').map(part => {
            const [name, ...params] = part.trim().split(';')
            const q = params.find(p => p.trim().startsWith('q='))?.trim().slice(2)
            return [name!, q === undefined ? 1 : Number(q)]
        }))
        const quality = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0
        const br = quality('br'), gz = quality('gzip')
        const coding = br > 0 && br >= gz ? 'br' : gz > 0 ? 'gzip' : undefined
        if (!coding) { commit(); return end(body, done) }
        const finish = (error: Error | null, packed: Buffer) => {
            if (res.destroyed) return
            if (!error && packed.length < body.length) {
                res.setHeader('content-encoding', coding)
                res.setHeader('content-length', packed.length)
                // Strong ETags describe the identity representation; preserve conditional semantics.
                const etag = res.getHeader('etag')
                if (typeof etag === 'string' && !etag.startsWith('W/')) res.setHeader('etag', `W/${etag}`)
            }
            commit()
            end(!error && packed.length < body.length ? packed : body, done)
        }
        if (coding === 'br') brotliCompress(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }, finish)
        else gzip(body, { level: 4 }, finish)
        return res
    }) as typeof res.end
}

const server = createServer(async (req, res) => {
    compressResponse(req, res)
    const url = new URL(req.url || '/', 'http://localhost')
    try {
        if (url.pathname === '/healthz') return send(res, 200, 'ok')
        // For the status page: up, and which switches are on. No secrets, no data.
        if (url.pathname === '/health') return send(res, 200, { ok: true, features: featureState() })
        if (url.pathname === '/favicon.ico') {
            res.writeHead(204, { 'cache-control': 'max-age=86400' })
            return res.end()
        }
        if (url.pathname === '/webhooks/jira' && req.method === 'POST') return await handleWebhook(req, res)
        if (url.pathname.startsWith('/clips/') && req.method === 'GET') return await serveClip(req, res, url)
        if (url.pathname === '/') {
            res.writeHead(302, { location: '/replays' })
            return res.end()
        }
        if (await handleReplays(req, res, url)) return
        if (url.pathname === '/posthog-mcp') return await handlePosthogMcp(req, res, {
            url: config.posthog.mcpUrl, apiKey: config.posthog.mcpApiKey,
            token: config.service.mcpToken, name: config.mcp.name,
            enabled: config.posthog.mcpViaLens && posthogMcpActive(),
            authorize: (r) => !!callerOf(r),
            info: { app: appEvents()?.app || 'the app', tools: lensToolNames() },
        })
        if (url.pathname === '/mcp') return await handleMcp(req, res)
        if (url.pathname === '/status') {
            if (!bearerOk(req)) return send(res, 401, { error: 'needs Authorization: Bearer <MCP_TOKEN>' })
            return send(res, 200, { ai: !!ai, features: featureState(), jobs })
        }
        send(res, 404, 'not found')
    } catch (e) {
        log('request failed', { path: url.pathname, error: (e as Error).message })
        if (!res.headersSent) send(res, 500, { error: 'internal error' })
    }
})

if (!jiraConfigured()) log('Jira is not connected: webhooks answer 503 and release outcomes keep their last numbers until JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set')
for (const [name, value] of Object.entries({ ...(jiraConfigured() ? { JIRA_WEBHOOK_SECRET: config.jira.webhookSecret } : {}), CLIP_LINK_SECRET: config.service.clipLinkSecret, ...(config.features.lensMcp ? { MCP_TOKEN: config.service.mcpToken } : {}) })) {
    if (!value) log(`warning: ${name} is not set; that feature refuses every request until it is`)
}

pruneOldClips()
// The task history behind the dashboards: day by day in the background (core/tasks.ts).
if (appEvents()) startTaskHistory()
if (appEvents()) startBriefingDelivery()
if (appEvents() && config.features.lensMcp) startPrewarm()
// Session replays read as structure only, into per-client experience signals (src/core/experience.ts).
if (appEvents()) startReplaySignals()
// Client codenames (src/core/anonymise.ts): every client Lens sees gets one, also while anonymisation is off, so
// it is ready the moment an admin turns it on. Every five minutes; requests refresh it too while it is on.
if (config.features.lensMcp) {
    setTimeout(() => void refreshRoster(0).catch(() => {}), 30_000).unref()
    setInterval(() => void refreshRoster(5 * 60_000).catch(() => {}), 5 * 60_000).unref()
}
setInterval(() => pruneOldClips(), 6 * 3_600_000).unref()

// The release dashboard reads Jira and PostHog at start (when its data is older than an hour)
// and every 6 hours. Numbers for the latest release keep moving while it is new.
const syncNow = async (why: string) => {
    if (!jiraConfigured()) return
    await syncReleases()
        .then((r) => log('releases synced', { why, releases: r.releases.length, tickets: r.tickets, seconds: r.seconds, dropped: r.dropped }))
        .catch((e) => log('release sync failed', { why, error: (e as Error).message }))
}
const last = syncStatus().at
if (!keptReleases().length || !last || Date.now() - Date.parse(last) > 3_600_000) setTimeout(() => void syncNow('start'), 5_000).unref()
setInterval(() => void syncNow('schedule'), 6 * 3_600_000).unref()

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.requestTimeout = 300_000

server.listen(config.service.port, '0.0.0.0', () => log('triage service listening', { port: config.service.port, ai: !!ai, ai_model: ai ? config.anthropic.model : undefined, features: featureState() }))

const stop = async () => {
    server.close()
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
