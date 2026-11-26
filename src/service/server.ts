// Signal HTTP and MCP: clips, Live, Surveys, Pinned, Admin and Connect.
import { jobStates, plainReason } from '../core/jobhealth.ts'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { basename, join } from 'node:path'
import { brotliCompress, constants, gzip } from 'node:zlib'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { shutdownClips } from '../core/clip.ts'
import { warmClientNames } from '../core/resolve.ts'
import { config, jiraConfigured, posthogMcpActive, surveysActive } from '../core/config.ts'
import { listSurveys } from '../core/surveys.ts'
import { verifyClipLink } from '../core/links.ts'
import { bearerAuthorized, handlePosthogMcp } from '../mcp/posthog-proxy.ts'
import { lensServerInfo } from '../mcp/server-info.ts'
import { serverInstructions } from '../mcp/instructions.ts'
import { lensToolNames, registerTools } from '../mcp/tools.ts'
import { appEvents } from '../core/appevents.ts'
import { audit, chatCaller, loadAccess } from './access.ts'
import { captionedFile } from '../core/comments.ts'
import { getClip, handleReplays, pruneOldClips, streamMp4 } from './replays.ts'
import { retentionJobState, startReplayRetention } from './replayretention.ts'
import { startSurveySync, surveySyncJobState } from './surveysync.ts'
import { publicRequestFailure } from './failure.ts'


const FONT_ASSETS: Record<string, Buffer> = {
    'Geist-Variable.woff2': readFileSync(new URL('../../assets/fonts/Geist-Variable.woff2', import.meta.url)),
    'GeistMono-Variable.woff2': readFileSync(new URL('../../assets/fonts/GeistMono-Variable.woff2', import.meta.url)),
}

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

async function serveClip(req: IncomingMessage, res: ServerResponse, url: URL) {
    const name = decodeURIComponent(url.pathname.slice('/clips/'.length))
    if (name !== basename(name) || !/^[A-Za-z0-9-]+_\d+-\d+\.mp4$/.test(name)) return send(res, 404, 'not found')
    if (!loadAccess().allow_share_links) return send(res, 403, 'Clip sharing is disabled.')
    if (!verifyClipLink(name, url.searchParams.get('exp'), url.searchParams.get('sig'), config.service.clipLinkSecret, Date.now(), url.searchParams.get('c') === '1')) return send(res, 403, 'This clip link is invalid or has expired.')
    const file = join(config.clip.outDir, name)
    if (!existsSync(file)) return send(res, 404, 'not found')
    // c=1: with the comments burned in, as they are now (a link shared before an edit shows the edit).
    const clip = url.searchParams.get('c') === '1' ? getClip(name) : undefined
    const out = clip ? await captionedFile(name, clip.end_s - clip.start_s) : file
    if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit('signed-link', 'clip.viewed', { clip: name, comments: out !== file })
    streamMp4(req, res, out)
}

function featureState() {
    return { lens_mcp: config.features.lensMcp, posthog_mcp: posthogMcpActive(), posthog_mcp_switch: config.features.posthogMcp, jira: jiraConfigured() }
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
    const server = new McpServer(lensServerInfo, { instructions: serverInstructions(undefined, caller.surveyRole, caller.dashboardRole, caller.admin || caller.insights) })
    registerTools(server, undefined, caller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
        void transport.close()
        void server.close()
    })
    await server.connect(transport)
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

const server = createServer((req, res) => {
    void (async () => {
        let url: URL | undefined
        try {
            compressResponse(req, res)
            try { url = new URL(req.url || '/', 'http://localhost') }
            catch { return send(res, 400, { error: 'invalid request target' }) }
            if (req.method === 'GET' && (url.pathname === '/replays/assets/fonts/Geist-Variable.woff2' || url.pathname === '/replays/assets/fonts/GeistMono-Variable.woff2')) {
                const name = url.pathname.slice('/replays/assets/fonts/'.length)
                const font = FONT_ASSETS[name]!
                res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-length': font.length })
                return res.end(font)
            }
            if (url.pathname === '/healthz') return send(res, 200, 'ok')
            // For the status page: up, and which switches are on. No secrets, no data.
            // Jobs: name, level and a plain reason only (core/jobhealth.ts); the status service shows them.
            if (url.pathname === '/health') return send(res, 200, { ok: true, features: featureState(), jobs: [retentionJobState(), surveySyncJobState(), ...jobStates()] })
            if (url.pathname === '/favicon.ico') {
                res.writeHead(204, { 'cache-control': 'max-age=86400' })
                return res.end()
            }
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
                caller: callerOf(req),
                info: { app: appEvents()?.app || 'the app', tools: lensToolNames() },
            })
            if (url.pathname === '/mcp') return await handleMcp(req, res)
            if (url.pathname === '/status') {
                if (!bearerOk(req)) return send(res, 401, { error: 'needs Authorization: Bearer <MCP_TOKEN>' })
                return send(res, 200, { features: featureState() })
            }
            send(res, 404, 'not found')
        } catch (e) {
            log('request failed', { path: url?.pathname, error: (e as Error).message })
            if (!res.headersSent) { const failure = publicRequestFailure(url?.pathname, e); send(res, failure.status, failure.body) }
        }
    })().catch((error) => {
        if (!res.headersSent) { try { const failure = publicRequestFailure(req.url?.split('?')[0], error); send(res, failure.status, failure.body) } catch { res.destroy() } }
        else res.destroy()
    })
})

if (!jiraConfigured()) log('Jira is not connected; survey launch ticket checks use the ticket format only.')
for (const [name, value] of Object.entries({ ...(jiraConfigured() ? { JIRA_WEBHOOK_SECRET: config.jira.webhookSecret } : {}), CLIP_LINK_SECRET: config.service.clipLinkSecret, ...(config.features.lensMcp ? { MCP_TOKEN: config.service.mcpToken } : {}) })) {
    if (!value) log(`warning: ${name} is not set; that feature refuses every request until it is`)
}

warmClientNames()
pruneOldClips()
// A crash says why in the log before the process ends (the service manager then restarts it). The monitor
// hook only observes: what happens after an uncaught error is unchanged.
process.on('uncaughtExceptionMonitor', (err, origin) => log('service crashed', { origin, reason: plainReason(err), error: String((err as Error)?.stack || err).split('\n').slice(0, 6).join(' | ') }))
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') log('node warning', { name: w.name, message: w.message.slice(0, 200) }) })

setInterval(() => pruneOldClips(), 6 * 3_600_000).unref()

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000
server.requestTimeout = 300_000

server.listen(config.service.port, '0.0.0.0', () => log('Signal listening', { port: config.service.port, features: featureState() }))

// A read migrates former Signal surveys through PostHog's public API. Retry while PostHog starts.
const migrationTimer = setInterval(() => { void migrateSurveys() }, 10 * 60_000)
migrationTimer.unref()
async function migrateSurveys(): Promise<void> {
    if (!surveysActive()) { clearInterval(migrationTimer); return }
    try { await listSurveys(); clearInterval(migrationTimer) }
    catch (error) { log('survey migration retry pending', { reason: plainReason(error) }) }
}
void migrateSurveys()

const stopSurveySync = startSurveySync()

const stop = async () => {
    clearInterval(migrationTimer)
    stopSurveySync()
    server.close()
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
// Session replay retention set on the admin page (off by default): once a UTC day, see replayretention.ts.
startReplayRetention()
