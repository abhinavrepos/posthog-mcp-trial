import { outputFilter } from './output-filter.ts'
import { compactInfo, compactTools, metadataCommand, posthogDocsCache, posthogServerKey } from './posthog-docs.ts'
import { annotatePosthogBuckets } from './posthog-buckets.ts'
import { closestNames, toolNames, obsoleteCorrection, posthogInputWarnings } from './posthog-input.ts'
import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { toolLimiter } from './ratelimit.ts'
import { writeToolAudit } from './toolaudit.ts'
import type { ChatCaller } from '../service/access.ts'
import { isPosthogMetadata, isPosthogQuery, posthogQueryGate, posthogQueryContext } from './posthog-query.ts'
import { posthogFailure, posthogPublicMessage, UNKNOWN_COMMAND_MESSAGE, HOGQL_HINT, looksLikeSqlTool } from './posthog-error.ts'
import { toolError } from './toolerror.ts'
import { createHash, randomUUID } from 'node:crypto'
// Routing text is pure; the HTTP adapter only handles authentication and transport.
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'


/** What the proxy says about Lens: its server name, the tracked app's name and its tool names. */
export interface LensInfo {
    app: string
    tools: string[]
}
const DEFAULT_INFO: LensInfo = { app: 'the app', tools: ['get_replay_link'] }

export function routingBlock(_name: string, _info: LensInfo = DEFAULT_INFO): string {
    return 'Use posthog_exec for analysis: tools / info <tool> / call <tool> <json>. For replays use resolve_client then find_sessions and give both links. Save graphs with pin_graph.'
}
export const execRoutingLine = routingBlock

type Rpc = Record<string, any>
const object = (value: unknown): value is Rpc => !!value && typeof value === 'object' && !Array.isArray(value)

/** Rewrite by result shape, so GET/SSE responses need no per-session request state. Never mutate input. */
export function rewriteResponse(value: unknown, name = 'lens', info: LensInfo = DEFAULT_INFO): unknown {
    if (Array.isArray(value)) return value.map((item) => rewriteResponse(item, name, info))
    if (!object(value)) return value
    if (value.error || value.result?.isError) {
        const id = randomUUID()
        const mapped = toolError(posthogFailure(value.error || value.result, undefined, undefined, id), 'posthog_exec', id).result
        return value.error ? { ...value, error: { code: -32603, message: mapped.content[0].text } } : { ...value, result: mapped }
    }
    if (!object(value.result)) return value
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
    caller?: Pick<ChatCaller,'who'|'email'|'tokenId'>
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

/** A completed JSON-RPC reply ends a call even if its SSE connection stays open. */
async function readSseReply(body: ReadableStream<Uint8Array>, id: unknown, limit: number): Promise<Rpc | undefined> {
    const decoder = new StringDecoder('utf8')
    let pending = '', data: string[] = [], size = 0
    const line = (text: string): Rpc | undefined => {
        text = text.replace(/\r$/, '')
        if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''))
        else if (!text && data.length) {
            const event = data.join('\n'); data = []
            try {
                const value = JSON.parse(event)
                return (Array.isArray(value) ? value : [value]).find(v => v?.id === id && ('result' in v || 'error' in v))
            } catch { /* Ignore keepalives and non-JSON events. */ }
        }
    }
    // Returning from the iterator cancels the remaining body and releases the upstream socket.
    for await (const chunk of Readable.fromWeb(body as import('node:stream/web').ReadableStream)) {
        size += chunk.length
        if (size > limit) throw new BodyTooLarge()
        pending += decoder.write(chunk)
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
            const reply = line(pending.slice(0, end)); pending = pending.slice(end + 1)
            if (reply) return reply
        }
    }
    pending += decoder.end()
    if (pending) line(pending)
    return line('')
}

function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
}

export function handlePosthogMcp(req: IncomingMessage, res: ServerResponse, options: ProxyOptions): Promise<void> {
    return handlePosthogMcpFrozen(req, res, options)
}
async function handlePosthogMcpFrozen(req: IncomingMessage, res: ServerResponse, options: ProxyOptions): Promise<void> {
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
    const out = (v: unknown) => {
        for(const answer of Array.isArray(v) ? v : [v]) if(object(answer)) {
            const record=records.find(r=>r.id===answer.id)
            if(record) { record.chars=JSON.stringify(answer).length;if(answer.error || answer.result?.isError) record.error='upstream' }
        }
        return outputFilter(rewriteResponse(v, options.name, options.info))
    }
    const sseLine = (line: string) => {
        if (!line.startsWith('data:')) return line
        const m = /^(data: *)(.*?)(\r?)$/.exec(line)!
        try { return `${m[1]}${JSON.stringify(out(JSON.parse(m[2])))}${m[3]}` } catch { return line }
    }
    const records: {id:unknown; tool:string; keys:string[]; correlation:string; started:number; release?:()=>void; error?:string; chars:number}[] = []
    const analytics = (item:Rpc) => isPosthogQuery(item.params?.name === 'exec' ? item.params.arguments?.command : `call ${item.params?.name} ${JSON.stringify(item.params?.arguments || {})}`)
    let gateRelease: (()=>void)|undefined
    const enterGate = async () => {
        let entered!:()=>void
        const ready=new Promise<void>(resolve=>{entered=resolve})
        const held=posthogQueryGate.run(controller.signal,()=>new Promise<void>(resolve=>{gateRelease=resolve;entered()}))
        await Promise.race([ready,held])
        // Gate refusal must propagate rather than silently executing without a slot.
        void held.catch(()=>{})
    }
    try {
        let body: string | undefined
        let batch = false
        const refusals: Rpc[] = []
        if (req.method === 'POST') {
            const raw = await readBody(req.iterator({ destroyOnReturn: false }), limit)
            let value: unknown
            try { value = JSON.parse(raw) } catch { return send(res, 400, { error: 'invalid JSON' }) }
            batch = Array.isArray(value)
            const allowed = (batch ? value as unknown[] : [value]).flatMap((item) => {
                let record: typeof records[number] | undefined
                if(object(item) && item.method==='tools/call') {
                    const command=item.params?.name==='exec' ? /^\s*(?:call\s+)?(?:posthog:)?([\w-]+)/i.exec(String(item.params.arguments?.command || ''))?.[1] || 'exec' : String(item.params?.name || 'unknown')
                    record={id:item.id,tool:'posthog:'+(/^[\w-]{1,80}$/.test(command) ? command : 'unknown'),keys:object(item.params?.arguments) ? Object.keys(item.params.arguments).filter(k=>/^[\w-]{1,80}$/.test(k)).sort() : [],correlation:randomUUID(),started:Date.now(),chars:0}
                    records.push(record)
                    try {record.release=toolLimiter.acquire(options.caller?.email || options.caller?.who || 'shared',options.caller?.tokenId || options.caller?.who || 'shared',record.tool,analytics(item) ? 5 : 1)}
                    catch(error) {
                        const mapped=toolError(error,record.tool,record.correlation);record.error=mapped.kind
                        refusals.push({jsonrpc:'2.0',id:item.id??null,result:mapped.result});return []
                    }
                }
                return [item]
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
        const request = (body: string | undefined) => upstreamRequest(url,options.apiKey,{method:req.method,headers,body,signal:controller.signal})
        let upstream: Response
        const items=body ? JSON.parse(body) : undefined
        if(batch && Array.isArray(items) && items.some(item=>object(item) && item.method==='tools/call' && analytics(item))) {
            // Dispatch batch members separately so an upstream parallel batch cannot exceed the gate.
            const replies: unknown[]=[]
            for(const item of items) {
                const read=async()=>{
                    const response=await request(JSON.stringify(item))
                    if(response.ok && response.body && item.id != null && response.headers.get('content-type')?.includes('text/event-stream')) {
                        const reply=await readSseReply(response.body,item.id,limit)
                        if(!reply) throw posthogFailure('Missing MCP reply')
                        replies.push(reply)
                        return
                    }
                    const raw=response.body ? await readBody(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),limit) : ''
                    if(!response.ok) throw posthogFailure(raw,response.status,response.headers.get('retry-after'))
                    if(response.headers.get('content-type')?.includes('text/event-stream')) {
                        for(const line of raw.split('\n'))if(line.startsWith('data:')) {try{replies.push(JSON.parse(line.slice(5)))}catch{}}
                    } else if(raw) {const reply=JSON.parse(raw);replies.push(...(Array.isArray(reply)?reply:[reply]))}
                }
                try {
                    if(object(item) && item.method==='tools/call' && analytics(item)) await posthogQueryGate.run(controller.signal,read)
                    else await read()
                } catch(error) {
                    const record=records.find(r=>r.id===item.id)
                    const id=record?.correlation || randomUUID()
                    const mapped=toolError(error instanceof Error && posthogPublicMessage(error.message) ? error : posthogFailure(error), 'posthog_exec', id)
                    if(record) record.error=mapped.kind
                    if(item.id != null) refusals.push({jsonrpc:'2.0',id:item.id,result:mapped.result})
                }
            }
            upstream=new Response(JSON.stringify(replies),{headers:{'content-type':'application/json'}})
        } else {
            if(object(items) && items.method==='tools/call' && analytics(items)) await enterGate()
            upstream=await request(body)
        }
        if (!upstream.ok) {
            for(const record of records) record.error ||= 'upstream'
            const detail = upstream.body ? await readBody(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), limit) : ''
            const id = randomUUID()
            const mapped = toolError(posthogFailure(detail, upstream.status, upstream.headers.get('retry-after'), id), 'posthog_exec', id)
            if (upstream.headers.get('retry-after')) res.setHeader('retry-after', upstream.headers.get('retry-after')!)
            return send(res, upstream.status, { error: mapped.result.content[0].text })
        }
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
            } else output = raw
            res.writeHead(upstream.status)
            res.end(output)
        }
    } catch (error) {
        for(const record of records) record.error ||= 'upstream'
        if (!res.headersSent) {
            if (error instanceof BodyTooLarge) send(res, 413, { error: 'MCP body too large' })
            else {
                const id = randomUUID()
                const mapped = toolError(posthogFailure(controller.signal.aborted ? 'timeout' : error, undefined, undefined, id), 'posthog_exec', id)
                send(res, controller.signal.aborted ? 504 : 502, { error: mapped.result.content[0].text })
            }
        } else res.destroy()
    } finally {
        gateRelease?.()
        for(const record of records) {
            record.release?.()
            try {writeToolAudit({at:new Date(record.started).toISOString(),user_email:options.caller?.email || options.caller?.who || 'shared',token_id:options.caller?.tokenId || options.caller?.who || 'shared',tool:record.tool,argument_keys:record.keys,client_ids:[],duration_ms:Date.now()-record.started,result_chars:record.chars,is_error:!!record.error,error_kind:record.error,correlation_id:record.correlation})}
            catch(error) {errorDiagnostic(error,record.tool,'audit',record.correlation)}
        }
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

export function posthogExec(command: string, options: Pick<ProxyOptions, 'url' | 'apiKey' | 'name' | 'timeoutMs'>): Promise<any> {
    return posthogExecFrozen(command, options)
}
const upstreamToolNames = new Map<string, { at: number; names: string[] }>()
async function posthogExecFrozen(command: string, options: Pick<ProxyOptions, 'url' | 'apiKey' | 'name' | 'timeoutMs'>): Promise<any> {
    const server = posthogServerKey(options.url, options.apiKey)
    const metadata = isPosthogMetadata(command) ? metadataCommand(command) : undefined
    const fetchRaw = async (upstreamCommand: string) => {
        return posthogExecRaw({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'exec',arguments:{command:upstreamCommand}}}, upstreamCommand, options)
    }
    const docs = (raw: string): Promise<any> => posthogDocsCache.get(server, raw, () => fetchRaw(raw))
    try {
        let raw: any
        if (metadata) {
            raw = await docs(metadata.raw)
            if (metadata.compact && !raw?.isError) raw = await posthogDocsCache.get(server, `compact:${metadata.raw}`, async () => {
                const content = await Promise.all((raw.content || []).map(async (block: Rpc) => {
                    if (block.type !== 'text') return block
                    const text = metadata.tool ? await compactInfo(block.text, metadata.tool, async path => {
                        const field = await docs(`schema ${metadata.tool} ${path}`)
                        for (const part of field?.content || []) {
                            try { const parsed = JSON.parse(part.text); if (parsed.schema) return parsed.schema } catch { /* unfamiliar formats retain the original outline */ }
                        }
                    }) : compactTools(block.text)
                    return { ...block, text }
                }))
                return { ...raw, content }
            })
        } else raw = await fetchRaw(command)
        if (isPosthogMetadata(command)) return raw
        const warnings = await posthogInputWarnings(command).catch(() => [])
        const annotated = annotatePosthogBuckets(command, warnings.length ? { ...raw, content: [...(raw.content || []), ...warnings.map(text => ({ type: 'text', text }))] } : raw)
        return annotated
    } catch (error) {
        posthogDocsCache.invalidate(server)
        if (error instanceof Error && posthogPublicMessage(error.message)) throw error
        throw posthogFailure(error)
    }
}
async function posthogExecRaw(call: unknown, command: string, options: Pick<ProxyOptions, 'url' | 'apiKey' | 'name' | 'timeoutMs'>): Promise<any> {
    const toolCacheKey = options.url + ':' + createHash('sha256').update(options.apiKey).digest('hex')
    const controller = new AbortController()
    const query = posthogQueryContext.getStore()
    const abort = () => controller.abort()
    query?.signal.addEventListener('abort', abort, { once: true })
    if (query?.signal.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), query?.timeoutMs ?? options.timeoutMs ?? 30_000)
    const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' })
    let session: string | null = null
    const request = (body: unknown, method = 'POST', signal = controller.signal) => upstreamRequest(options.url, options.apiKey, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal })
    const read = async (res: Response, id: number): Promise<Rpc> => {
        let reply: Rpc | undefined
        if (res.ok && res.body && res.headers.get('content-type')?.includes('text/event-stream')) reply = await readSseReply(res.body, id, 5_000_000)
        else {
            const raw = res.body ? await readBody(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), 5_000_000) : ''
            if (!res.ok) throw posthogFailure(raw, res.status, res.headers.get('retry-after'))
            const value = JSON.parse(raw)
            reply = (Array.isArray(value) ? value : [value]).find(v => v?.id === id)
        }
        if (!reply || reply.error || reply.result?.isError) {
            const failure = posthogFailure(reply?.error || reply?.result || 'Missing MCP reply')
            if (id === 2 && failure.message.startsWith('PostHog does not know that command.')) {
                const key = toolCacheKey
                let cached = upstreamToolNames.get(key)
                if (!cached || Date.now() - cached.at > 300_000) try {
                    const listed = await read(await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'exec', arguments: { command: 'tools' } } }), 3)
                    cached = { at: Date.now(), names: toolNames(listed) }
                    if (upstreamToolNames.size >= 32) upstreamToolNames.delete(upstreamToolNames.keys().next().value!)
                    upstreamToolNames.set(key, cached)
                } catch { /* suggestions are optional */ }
                const requested = /^\s*(?:(?:call|info|schema)\s+)?(?:posthog:)?([\w-]+)/i.exec(command)?.[1] || ''
                const sql = looksLikeSqlTool(requested) && (!cached?.names.length || cached.names.includes('execute-sql'))
                const closest = closestNames(requested, cached?.names || [])
                const suggestions = sql ? ['execute-sql', ...closest.filter(n => n !== 'execute-sql')].slice(0,3) : closest
                failure.message = UNKNOWN_COMMAND_MESSAGE
                if (suggestions.length) failure.message += ` Closest tools: ${suggestions.join(', ')}.`
                if (sql) failure.message += ' ' + HOGQL_HINT
            }
            if (id === 2 && failure.message.startsWith('PostHog rejected the input')) {
                const correction = obsoleteCorrection(command)
                if (correction) failure.message += ' ' + correction
            }
            throw failure
        }
        return reply.result
    }
    try {
        const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: options.name, version: '1' } } })
        session = initialized.headers.get('mcp-session-id')
        if (session) headers.set('mcp-session-id', session)
        const init = await read(initialized, 1)
        headers.set('mcp-protocol-version', init.protocolVersion)
        const notified = await request({ jsonrpc: '2.0', method: 'notifications/initialized' })
        if (!notified.ok) { await read(notified, 0) }
        await notified.body?.cancel()
        const raw = await read(await request(call), 2)
        if (/^\s*tools\s*$/i.test(command)) {
            const names = toolNames(raw)
            if (names.length) {
                if (upstreamToolNames.size >= 32) upstreamToolNames.delete(upstreamToolNames.keys().next().value!)
                upstreamToolNames.set(toolCacheKey, { at: Date.now(), names })
            }
        }
        return raw
    } catch (error) {
        if (error instanceof Error && posthogPublicMessage(error.message)) throw error
        throw posthogFailure(controller.signal.aborted ? 'timeout' : error)
    } finally {
        clearTimeout(timer)
        query?.signal.removeEventListener('abort', abort)
        // Sessions belong to this call only, including failed calls.
        if (session) {
            try { const res = await request(undefined, 'DELETE', AbortSignal.timeout(2_000)); await res.body?.cancel() } catch { /* upstream may not support session deletion */ }
        }
    }
}
