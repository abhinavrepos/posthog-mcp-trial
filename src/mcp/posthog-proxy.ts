// Routing text is pure; the HTTP adapter only handles authentication and transport.
import { safetyWith, staffEmails } from '../core/aisafety.ts'
import { identityTokens } from '../core/rescueprivacy.ts'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

import { anonFor, hideClients, namesClient, posthogMode, refusalText, revealCodenames } from '../core/anonymise.ts'
import { countBlock } from '../core/anonymise.ts'
import { refreshRoster } from '../core/anonroster.ts'
import { guardRequest, guardResponse } from './anonymise.ts'

/** What the proxy says about Lens: its server name, the tracked app's name and its tool names. */
export interface LensInfo {
    app: string
    tools: string[]
}
const DEFAULT_INFO: LensInfo = { app: 'the app', tools: ['get_replay_link'] }

export function routingBlock(name: string, info: LensInfo = DEFAULT_INFO): string {
    const app = info.app
    return `Replays are private: use ${name}'s get_replay_link and give the person the link; never call session-recording-*, query-session-recordings-list or vision-* tools.
Messaging (workflows-*, broadcasts-*), person lists (persons-*, query-*-actors, cohort membership changes), session lookups (heatmaps-events, logs-impact), error investigation (query-error-tracking-issue, query-error-tracking-issue-events, query-error-tracking-issues-list) and surveys are refused. Use discover_workflows/workflow_completion for app tasks, resolve_client/client_experience/client_signals for clients, session_story/find_client_incidents/find_silent_issues for sessions, error_blast_radius for errors and Lens survey tools for surveys.
Use the Lens server (${name}) instead for a named ${app} client or user, trade/link id, ${app} dialog/screen/button, errors ${app} showed users, which clients or users an error hit, one session, Jira ticket, release outcome, "where do clients struggle" or "who is at risk", which clients stopped doing a task, how long a flow takes or which path people take${info.tools.includes('design_survey') ? `, and in-app surveys for ${app} users (making, stopping, answers; launching only on the Lens Surveys page)` : ''}. Call its tools directly with JSON arguments, never through exec.
Use PostHog exec for generic product analytics and PostHog objects: trends, funnels, retention, insights, dashboards, feature flags, experiments, cohorts, annotations, actions/event definitions, error-tracking administration, data warehouse/batch exports, docs/SDK help and raw SQL.`
}

export function execRoutingLine(name: string, info: LensInfo = DEFAULT_INFO): string {
    return `Replays, session/user lookups, error investigation, person lists, messaging and surveys are refused; use get_replay_link, session_story, find_client_incidents, find_silent_issues, error_blast_radius, resolve_client, client_experience, client_signals, discover_workflows, workflow_completion and Lens survey tools. Not for ${info.app} clients or users, trade ids, ${info.app} screens or the errors it shows users, client task maps, flow times and paths, single sessions, replays, Jira tickets${info.tools.includes('design_survey') ? ', release outcomes or in-app surveys' : ' or release outcomes'}: use the ${name} server's tools (${info.tools.join(', ')}) for those.`
}

type Rpc = Record<string, any>
const object = (value: unknown): value is Rpc => !!value && typeof value === 'object' && !Array.isArray(value)

/** Rewrite by result shape, so GET/SSE responses need no per-session request state. Never mutate input. */
export function rewriteResponse(value: unknown, name = 'lens', info: LensInfo = DEFAULT_INFO): unknown {
    if (Array.isArray(value)) return value.map((item) => rewriteResponse(item, name, info))
    if (!object(value) || !object(value.result)) return value
    const result = value.result
    if (result.serverInfo && result.protocolVersion) {
        return { ...value, result: { ...result, instructions: `${routingBlock(name, info)}\n\n${result.instructions || ''}` } }
    }
    if (Array.isArray(result.tools)) {
        return { ...value, result: { ...result, tools: result.tools.map((tool: Rpc) => tool.name === 'exec'
            ? { ...tool, description: `${execRoutingLine(name, info)}\n${tool.description || ''}` } : tool) } }
    }
    return value
}

/** SSE data JSON occupies one line in MCP. Preserve comments, event/id fields and non-JSON data. */
export function rewriteSseLine(line: string, name = 'lens', info: LensInfo = DEFAULT_INFO): string {
    if (!line.startsWith('data:')) return line
    const match = /^(data: *)(.*?)(\r?)$/.exec(line)!
    let value: unknown
    try { value = JSON.parse(match[2]) } catch { return line }
    return `${match[1]}${JSON.stringify(rewriteResponse(value, name, info))}${match[3]}`
}

/** Check each call separately so lookups remain available and chained calls cannot bypass policy. */
export function commandRefusal(value: unknown, name = 'lens'): Rpc | undefined {
    if (!object(value) || value.method !== 'tools/call' || value.params?.name !== 'exec') return
    const command = value.params.arguments?.command
    if (typeof command !== 'string') return
    for (const part of command.split(/[\n;&|]+/)) {
        const match = /^\s*call\s+(?:--[\w-]+\s+)*([^\s]+)(?:\s|$)/i.exec(part)
        if (!match) continue
        // exec also accepts namespaced names (posthog:persons-list); a quoted name is the same command.
        const tool = match[1].replace(/^["'`]|["'`]$/g, '').replace(/^posthog:/i, '').toLowerCase()
        let message: string | undefined
        if (/^(?:session-recording[\w-]*|query-session-recordings-list|vision-[\w-]+)$/.test(tool))
            message = 'Replays are private. Use Lens get_replay_link for a link or session_story for the event timeline.'
        else if (/^(?:heatmaps-events|logs-impact)$/.test(tool))
            message = 'Session and user lookups go through Lens: session_story, find_client_incidents or find_silent_issues.'
        else if (/^query-error-tracking-(?:issue|issue-events|issues-list)$/.test(tool))
            message = 'Use Lens error_blast_radius (which clients and users an error hit, trend, releases) or find_client_incidents.'
        else if (/^(?:persons-[\w-]*|query-[\w-]+-actors|cohorts-add-persons-to-static-cohort[\w-]*|cohorts-rm-person-from-static-cohort[\w-]*)$/.test(tool))
            message = 'Client-user identities and person lists are private. Lens answers per client (resolve_client, client_experience, client_signals) without naming people.'
        else if (/^(?:workflows-|broadcasts-)[\w-]*$/.test(tool))
            message = "Messaging users is disabled. Lens's discover_workflows and workflow_completion measure app tasks; they never send anything."
        else if (/^survey[\w-]*$/.test(tool))
            message = `In-app surveys are managed only in Lens: use the ${name} server's survey tools (list_surveys, survey_results, design_survey, save_survey, stop_survey), which follow each person's survey role; launching is only on the Lens Surveys page. PostHog survey commands are refused.`
        if (message) return { jsonrpc: '2.0', id: value.id ?? null, error: { code: -32602, message: 'PostHog command refused. ' + message } }
    }
}
export const replayRefusal = commandRefusal

// ------------------------------------------------------------------ client anonymisation (src/core/anonymise.ts)
// block (the default): exec may look up tools (help, tools, search, info, schema) and search PostHog's docs;
// every other call is refused, since any query or list can return client names in a form no filter can
// recognise (concatenated, encoded, aggregated). filter: calls run with codenames in the command turned
// into client codes, client names and codes in the command refused, and results cleaned (best effort).
const LOOKUP = new Set(['help', 'tools', 'search', 'info', 'schema'])
const DOCS_ONLY = new Set(['docs-search'])
export function anonRefusal(value: unknown, name = 'lens', mode: 'block' | 'filter' | 'off' = posthogMode()): { refusal?: Rpc; value?: unknown } {
    if (!object(value)) return { value }
    if (value.method === 'tools/call' && value.params?.name === 'exec') {
        const command = String(value.params.arguments?.command ?? '')
        const refuse = (why: string) => { countBlock('posthog_refused'); return { refusal: { jsonrpc: '2.0', id: value.id ?? null, result: { isError: true, content: [{ type: 'text', text: why }] } } } }
        if (mode === 'block') {
            for (const part of command.split(/[\n;&|]+/).map((x) => x.trim()).filter(Boolean)) {
                const [verb, ...rest] = part.split(/\s+/)
                const v = verb.toLowerCase()
                if (LOOKUP.has(v)) continue
                const tool = rest.find((w) => !w.startsWith('-'))?.toLowerCase()
                if (v === 'call' && tool && DOCS_ONLY.has(tool)) continue
                return refuse(`PostHog data commands are switched off while client anonymisation is on in Lens: their results can contain client names. Use the ${name} server's tools instead; they answer with client codenames. PostHog's docs search still works (call docs-search).`)
            }
            if (namesClient(command)) return refuse(refusalText())
            return { value }
        }
        if (namesClient(command)) return refuse(refusalText())
        // Raw SQL can return client names in forms no filter recognises (renamed columns, encodings), so while
        // client anonymisation is on it is refused in filter mode too, as in block mode (owner's decision).
        if (/(?:^|[\n;&|])\s*call\s+(?:--[\w-]+\s+)*["'`]?(?:posthog:)?execute-sql\b/i.test(command))
            return refuse(`Raw SQL is switched off while client anonymisation is on in Lens. Use PostHog's aggregate queries (trends, funnels, retention) or the ${name} server's tools.`)
        return { value: { ...value, params: { ...value.params, arguments: { ...value.params.arguments, command: revealCodenames(command) } } } }
    }
    const g = guardRequest(value, 'posthog_refused')
    return g.answer ? { refusal: g.answer } : { value: g.msg }
}

export function bearerAuthorized(req: IncomingMessage, token: string): boolean {
    if (!token) return false
    const got = Buffer.from(/^Bearer (.+)$/.exec(String(req.headers.authorization || ''))?.[1] || '')
    const want = Buffer.from(token)
    return got.length === want.length && timingSafeEqual(got, want)
}

export interface ProxyOptions {
    url: string
    apiKey: string
    token: string
    name: string
    enabled: boolean
    authorize?: (req: IncomingMessage) => boolean // instead of the shared token alone (personal tokens too)
    info?: LensInfo
    timeoutMs?: number
    maxBodyBytes?: number
}
const headersToPass = ['mcp-session-id', 'mcp-protocol-version', 'accept', 'content-type', 'last-event-id']
class BodyTooLarge extends Error {}

async function readBody(stream: AsyncIterable<Uint8Array>, limit: number): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of stream) {
        size += chunk.length
        if (size > limit) throw new BodyTooLarge()
        chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
}

export async function handlePosthogMcp(req: IncomingMessage, res: ServerResponse, options: ProxyOptions): Promise<void> {
    if (!(options.authorize ? options.authorize(req) : bearerAuthorized(req, options.token))) return send(res, 401, { error: 'MCP needs Authorization: Bearer <MCP_TOKEN or your personal token>' })
    if (!options.enabled || !options.url || !options.apiKey) return send(res, 503, { error: 'PostHog MCP proxy is off or not configured' })
    if (!['POST', 'GET', 'DELETE'].includes(req.method || '')) {
        res.setHeader('allow', 'POST, GET, DELETE')
        return send(res, 405, { error: 'method not allowed' })
    }
    const limit = options.maxBodyBytes ?? 5_000_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
    const onClose = () => controller.abort()
    res.once('close', onClose)
    // User identities and amounts are always cleaned; client anonymisation adds its own guard.
    // Checked again for every message: a stream opened before an admin turned it on is cleaned from then on.
    const anon = anonFor('posthog')
    let tokens: string[] = [], staff = new Set<string>()
    const cleanText = (v: string) => safetyWith(v, tokens, staff)
    const clean = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(clean)
        if (!object(v)) return v
        // The safety pass handles answers, not protocol versions or request ids.
        const safe = { ...v }
        // Notifications (progress, log messages) carry text too: their params are cleaned like answers.
        for (const key of ['result', 'error', 'params']) if (key in safe) {
            const answer = safetyWith(safe[key], tokens, staff)
            safe[key] = anonFor('posthog') ? guardResponse(answer, 'posthog_cleaned') : answer
        }
        return safe
    }
    const out = (v: unknown) => clean(rewriteResponse(v, options.name, options.info))
    const sseLine = (line: string) => {
        if (!line.startsWith('data:')) return cleanText(anonFor('posthog') ? hideClients(line).text : line)
        const m = /^(data: *)(.*?)(\r?)$/.exec(line)!
        try { return `${m[1]}${JSON.stringify(out(JSON.parse(m[2])))}${m[3]}` } catch { return cleanText(anonFor('posthog') ? hideClients(line).text : line) }
    }
    try {
        tokens = await identityTokens(); staff = staffEmails()
        if (anon) await refreshRoster()
        let body: string | undefined
        let batch = false
        const refusals: Rpc[] = []
        if (req.method === 'POST') {
            const raw = await readBody(req.iterator({ destroyOnReturn: false }), limit)
            let value: unknown
            try { value = JSON.parse(raw) } catch { return send(res, 400, { error: 'invalid JSON' }) }
            batch = Array.isArray(value)
            const allowed = (batch ? value as unknown[] : [value]).flatMap((item) => {
                const refusal = commandRefusal(item, options.name)
                if (refusal) { refusals.push(refusal); return [] }
                if (!anon) return [item]
                const a = anonRefusal(item, options.name)
                if (a.refusal) { refusals.push(a.refusal); return [] }
                return [a.value]
            })
            if (!allowed.length && refusals.length) return send(res, 200, batch ? refusals : refusals[0])
            body = JSON.stringify(batch ? allowed : allowed[0])
        }
        const headers = new Headers({ authorization: `Bearer ${options.apiKey}` })
        for (const name of headersToPass) {
            const value = req.headers[name]
            if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const url = new URL(options.url)
        // Preserve resume/query parameters without changing the configured upstream path.
        for (const [key, value] of new URL(req.url || '/', 'http://localhost').searchParams) url.searchParams.append(key, value)
        const upstream = await upstreamRequest(url, options.apiKey, { method: req.method, headers, body, signal: controller.signal })
        for (const name of headersToPass) {
            const value = upstream.headers.get(name)
            if (value) res.setHeader(name, value)
        }
        const sse = upstream.headers.get('content-type')?.includes('text/event-stream')
        if (sse && upstream.body) {
            res.writeHead(upstream.status)
            const decoder = new StringDecoder('utf8')
            let pending = ''
            let size = 0
            const transform = new Transform({
                transform(chunk: Buffer, _encoding, cb) {
                    size += chunk.length
                    if (size > limit) return cb(new BodyTooLarge())
                    pending += decoder.write(chunk)
                    let end: number
                    while ((end = pending.indexOf('\n')) >= 0) {
                        this.push(sseLine(pending.slice(0, end)) + '\n')
                        pending = pending.slice(end + 1)
                    }
                    cb()
                },
                flush(cb) {
                    pending += decoder.end()
                    if (pending) this.push(sseLine(pending))
                    if (refusals.length) this.push(`\n\ndata: ${JSON.stringify(refusals)}\n\n`)
                    cb()
                },
            })
            await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), transform, res)
        } else {
            const raw = upstream.body ? await readBody(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), limit) : ''
            let output = raw
            if (upstream.headers.get('content-type')?.includes('application/json') && raw) {
                const value = out(JSON.parse(raw))
                output = JSON.stringify(refusals.length ? [...(Array.isArray(value) ? value : [value]), ...refusals] : value)
            } else if (refusals.length) {
                return send(res, 200, refusals)
            } else output = cleanText(anonFor('posthog') ? hideClients(raw).text : raw)
            res.writeHead(upstream.status)
            res.end(output)
        }
    } catch (error) {
        // Upstream errors can include URLs or credentials. Return only fixed messages; never log them.
        if (!res.headersSent) send(res, error instanceof BodyTooLarge ? 413 : controller.signal.aborted ? 504 : 502,
            { error: error instanceof BodyTooLarge ? 'MCP body too large' : controller.signal.aborted ? 'PostHog MCP timed out' : 'PostHog MCP upstream failed' })
        else res.destroy()
    } finally {
        clearTimeout(timer)
        res.off('close', onClose)
    }
}

// Both entry points use the same credentials, redirect policy and transport.
function upstreamRequest(url: string | URL, apiKey: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${apiKey}`)
    return fetch(url, { ...init, headers, redirect: 'error' })
}

export async function posthogExec(command: string, options: Pick<ProxyOptions, 'url' | 'apiKey' | 'name' | 'timeoutMs'>): Promise<any> {
    let call: unknown = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'exec', arguments: { command } } }
    const refused = commandRefusal(call, options.name)
    if (refused) return { isError: true, content: [{ type: 'text', text: refused.error.message }] }
    if (anonFor('posthog')) {
        await refreshRoster()
        const a = anonRefusal(call, options.name)
        if (a.refusal) return a.refusal.result
        call = a.value
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000)
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
    let session: string | null = null
    const request = (body: unknown, method = 'POST', signal = controller.signal) => upstreamRequest(options.url, options.apiKey, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal })
    const read = async (res: Response, id: number): Promise<Rpc> => {
        if (!res.ok) throw new Error('PostHog MCP upstream failed')
        const raw = res.body ? await readBody(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), 5_000_000) : ''
        const values = res.headers.get('content-type')?.includes('text/event-stream')
            ? raw.split('\n').filter(l => l.startsWith('data:')).flatMap(l => { try { return [JSON.parse(l.slice(5))] } catch { return [] } })
            : [JSON.parse(raw)]
        const reply = values.flat().find(v => v?.id === id)
        if (!reply || reply.error) throw new Error('PostHog MCP upstream failed')
        return reply.result
    }
    try {
        const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: options.name, version: '1' } } })
        session = initialized.headers.get('mcp-session-id')
        if (session) headers.set('mcp-session-id', session)
        const init = await read(initialized, 1)
        headers.set('mcp-protocol-version', init.protocolVersion)
        const notified = await request({ jsonrpc: '2.0', method: 'notifications/initialized' })
        await notified.body?.cancel()
        return await read(await request(call), 2)
    } catch {
        throw new Error(controller.signal.aborted ? 'PostHog MCP timed out' : 'PostHog MCP upstream failed')
    } finally {
        clearTimeout(timer)
        // Sessions belong to this call only, including failed calls.
        if (session) {
            try { const res = await request(undefined, 'DELETE', AbortSignal.timeout(2_000)); await res.body?.cancel() } catch { /* upstream may not support session deletion */ }
        }
    }
}
