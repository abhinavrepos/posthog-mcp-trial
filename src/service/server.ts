// The triage service:
//   POST /webhooks/jira   signed Jira webhook → 202 at once, triage runs in the background
//   GET  /clips/<name>    signed, expiring clip links (with Range support so the video can seek)
//   POST /mcp             the MCP tools over Streamable HTTP, behind a bearer token
//   GET  /status          recent jobs
//   GET  /replays         the replay clip page (PostHog login), see replays.ts
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { makeAi } from '../core/ai.ts'
import { shutdownClips } from '../core/clip.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { verifyClipLink } from '../core/links.ts'
import { renderReport } from '../core/report.ts'
import { triage } from '../core/triage.ts'
import { addAttachment, addComment, addLabels, getIssue, hasTriageComment, issueToTicket, verifyWebhookSignature } from '../jira/client.ts'
import { serverInstructions } from '../mcp/instructions.ts'
import { registerTools } from '../mcp/tools.ts'
import { audit } from './access.ts'
import { keptReleases, syncReleases, syncStatus } from '../core/releases.ts'
import { handleReplays, pruneOldClips, streamMp4 } from './replays.ts'

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

function serveClip(req: IncomingMessage, res: ServerResponse, url: URL) {
    const name = decodeURIComponent(url.pathname.slice('/clips/'.length))
    if (name !== basename(name) || !/^[A-Za-z0-9-]+_\d+-\d+\.mp4$/.test(name)) return send(res, 404, 'not found')
    if (!verifyClipLink(name, url.searchParams.get('exp'), url.searchParams.get('sig'))) return send(res, 403, 'This clip link is invalid or has expired.')
    const file = join(config.clip.outDir, name)
    if (!existsSync(file)) return send(res, 404, 'not found')
    if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit('signed-link', 'clip.viewed', { clip: name })
    streamMp4(req, res, file)
}

function featureState() {
    return { lens_mcp: config.features.lensMcp, posthog_mcp: posthogMcpActive(), posthog_mcp_switch: config.features.posthogMcp, ai: !!ai }
}

function bearerOk(req: IncomingMessage): boolean {
    const token = config.service.mcpToken
    if (!token) return false
    const got = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1] || ''
    const a = Buffer.from(got)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    if (!config.features.lensMcp) return send(res, 503, { error: `${config.app.name}'s MCP tools are switched off (FEATURE_LENS_MCP=off).` })
    if (!bearerOk(req)) return send(res, 401, { error: 'MCP needs Authorization: Bearer <MCP_TOKEN>' })
    // Stateless: a fresh server and transport per request.
    const server = new McpServer({ name: 'ticket-triage', version: '0.1.0' }, { instructions: serverInstructions() })
    registerTools(server, ai)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
        void transport.close()
        void server.close()
    })
    await server.connect(transport)
    const body = req.method === 'POST' ? JSON.parse((await readRaw(req, 5_000_000)).toString('utf8') || 'null') : undefined
    await transport.handleRequest(req, res, body)
}

const server = createServer(async (req, res) => {
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
        if (url.pathname.startsWith('/clips/') && req.method === 'GET') return serveClip(req, res, url)
        if (url.pathname === '/') {
            res.writeHead(302, { location: '/replays' })
            return res.end()
        }
        if (await handleReplays(req, res, url)) return
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

for (const [name, value] of Object.entries({ JIRA_WEBHOOK_SECRET: config.jira.webhookSecret, CLIP_LINK_SECRET: config.service.clipLinkSecret, ...(config.features.lensMcp ? { MCP_TOKEN: config.service.mcpToken } : {}) })) {
    if (!value) log(`warning: ${name} is not set; that feature refuses every request until it is`)
}

pruneOldClips()
setInterval(() => pruneOldClips(), 6 * 3_600_000).unref()

// The release dashboard reads Jira and PostHog at start (when its data is older than an hour)
// and every 6 hours. Numbers for the latest release keep moving while it is new.
const syncNow = (why: string) =>
    syncReleases()
        .then((r) => log('releases synced', { why, releases: r.releases.length, tickets: r.tickets, seconds: r.seconds, dropped: r.dropped }))
        .catch((e) => log('release sync failed', { why, error: (e as Error).message }))
const last = syncStatus().at
if (!keptReleases().length || !last || Date.now() - Date.parse(last) > 3_600_000) setTimeout(() => void syncNow('start'), 5_000).unref()
setInterval(() => void syncNow('schedule'), 6 * 3_600_000).unref()

server.listen(config.service.port, '0.0.0.0', () => log('triage service listening', { port: config.service.port, ai: !!ai, ai_model: ai ? config.anthropic.model : undefined, features: featureState() }))

const stop = async () => {
    server.close()
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
