// Routing text is pure; the HTTP adapter only handles authentication and transport.
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
Use the Lens server (${name}) instead for a named ${app} client or user, trade/link id, ${app} dialog/screen/button, errors ${app} showed users, which clients or users an error hit, one session, Jira ticket, release outcome, "where do clients struggle" or "who is at risk", which clients stopped doing a task, how long a flow takes or which path people take${info.tools.includes('design_survey') ? `, and in-app surveys for ${app} users (making, stopping, answers; launching only on the Lens Surveys page)` : ''}. Call its tools directly with JSON arguments, never through exec.
Use PostHog exec for generic product analytics and PostHog objects: trends, funnels, retention, insights, dashboards, feature flags, experiments, ${info.tools.includes('design_survey') ? '' : 'surveys, '}cohorts, annotations, actions/event definitions, error-tracking issue management, data warehouse/batch exports, docs/SDK help and raw SQL.`
}

export function execRoutingLine(name: string, info: LensInfo = DEFAULT_INFO): string {
    return `Not for ${info.app} clients or users, trade ids, ${info.app} screens or the errors it shows users, client task maps, flow times and paths, single sessions, replays, Jira tickets${info.tools.includes('design_survey') ? ', release outcomes or in-app surveys' : ' or release outcomes'}: use the ${name} server's tools (${info.tools.join(', ')}) for those.`
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

/** exec's command language uses `call <tool> ...`; reject all replay tool references conservatively. */
export function replayRefusal(value: unknown, name = 'lens'): Rpc | undefined {
    if (!object(value) || value.method !== 'tools/call' || value.params?.name !== 'exec') return
    const command = value.params.arguments?.command
    if (typeof command !== 'string') return
    if (/\b(?:session-recording[\w-]*|query-session-recordings-list|vision-[\w-]+)\b/i.test(command))
        return { jsonrpc: '2.0', id: value.id ?? null, error: { code: -32602, message: `Replays are private. Use the ${name} server's get_replay_link and give the person the link. PostHog replay and vision commands are refused.` } }
    // In-app surveys are made, launched and read only in Lens, under its survey roles.
    if (/\bsurvey[\w-]*/i.test(command) && /\bcall\b/i.test(command))
        return { jsonrpc: '2.0', id: value.id ?? null, error: { code: -32602, message: `In-app surveys are managed only in Lens: use the ${name} server's survey tools (list_surveys, survey_results, design_survey, save_survey, stop_survey), which follow each person's survey role; launching is only on the Lens Surveys page. PostHog survey commands are refused.` } }
}

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
    // Client anonymisation (Admin → Client privacy for AI): requests checked, every answer cleaned.
    // Checked again for every message: a stream opened before an admin turned it on is cleaned from then on.
    const anon = anonFor('posthog')
    const clean = (v: unknown) => (anonFor('posthog') ? guardResponse(v, 'posthog_cleaned') : v)
    const out = (v: unknown) => clean(rewriteResponse(v, options.name, options.info))
    const sseLine = (line: string) => {
        if (!anonFor('posthog')) return rewriteSseLine(line, options.name, options.info)
        if (!line.startsWith('data:')) return hideClients(line).text
        const m = /^(data: *)(.*?)(\r?)$/.exec(line)!
        try { return `${m[1]}${JSON.stringify(out(JSON.parse(m[2])))}${m[3]}` } catch { return hideClients(line).text }
    }
    try {
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
                const refusal = replayRefusal(item, options.name)
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
        const upstream = await fetch(url, { method: req.method, headers, body, signal: controller.signal, redirect: 'error' })
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
            } else if (anonFor('posthog')) output = hideClients(raw).text
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
