// The one place every MCP message passes when client anonymisation is on (src/core/anonymise.ts): Lens's
// own server over HTTP and stdio (guardTransport), and the PostHog proxy (guardRequest/guardResponse).
//   in:  codenames in client arguments become the client's code; a client name or code anywhere in the
//        arguments is refused with the same message for known and unknown clients (so a refusal never
//        tells the AI that a name is a client)
//   out: every string and key of every message (results, errors, tool lists, instructions, prompts) has
//        client names and codes replaced by codenames
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

import { anonymiseOn, clientOfCodename, countBlock, hideClientsDeep, namesClient, outsideEmail, REFUSAL, type BlockKind } from '../core/anonymise.ts'

type Rpc = Record<string, any>
const isObj = (v: unknown): v is Rpc => !!v && typeof v === 'object' && !Array.isArray(v)
const CLIENT_KEY = /^(client|clients|client_id|client_ids|client_code)$/i

class Refused extends Error {}
/** Arguments with codenames turned into client codes; throws Refused for a client name or code. */
export function revealArgs(tool: string, args: unknown): unknown {
    if (tool === 'resolve_client' && isObj(args)) {
        // Name or email lookup would tell the AI which names are clients, or link a company's email domain
        // to its codename: only a codename is taken.
        const id = clientOfCodename(String(args.query ?? '').trim())
        if (id) return { ...args, query: id }
        throw new Refused()
    }
    const walk = (v: unknown, key: string): unknown => {
        if (typeof v === 'string') {
            if (CLIENT_KEY.test(key)) {
                if (!v.trim()) return v
                const id = clientOfCodename(v)
                if (!id) throw new Refused()
                return id
            }
            // A client's user's email names the company by its domain.
            if (namesClient(v) || outsideEmail(v)) throw new Refused()
            return v
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key))
        if (isObj(v)) {
            const o: Rpc = {}
            for (const [k, x] of Object.entries(v)) { if (namesClient(k)) throw new Refused(); o[k] = walk(x, k) }
            return o
        }
        return v
    }
    return walk(args, '')
}

/** What the server offers: tool and prompt names with their argument names (null: arguments not known). */
export interface Registry { tools(): Map<string, string[] | null>; prompts(): Map<string, string[] | null> }
/** The registry of an McpServer from the SDK (its registered tools and prompts). */
export function registryOf(server: unknown): Registry | undefined {
    const s = server as { _registeredTools?: Record<string, { inputSchema?: unknown }>; _registeredPrompts?: Record<string, { argsSchema?: unknown }> }
    if (!s?._registeredTools || !s._registeredPrompts) return undefined
    const keys = (schema: unknown): string[] | null => {
        const z = schema as { shape?: unknown; _def?: { shape?: unknown } } | undefined
        if (!z) return []
        const shape = typeof z.shape === 'function' ? (z.shape as () => object)() : z.shape ?? (typeof z._def?.shape === 'function' ? (z._def.shape as () => object)() : z._def?.shape)
        if (shape && typeof shape === 'object') return Object.keys(shape)
        return typeof schema === 'object' ? Object.keys(schema as object) : null
    }
    return {
        tools: () => new Map(Object.entries(s._registeredTools!).map(([n, t]) => [n, keys(t.inputSchema)])),
        prompts: () => new Map(Object.entries(s._registeredPrompts!).map(([n, p]) => [n, keys(p.argsSchema)])),
    }
}

/** A request on its way in: the request to run (codenames turned into codes), or the answer to send instead.
 * With a registry, an unknown tool or prompt gets one fixed answer (an error that repeats the name back
 * would show its codename), and arguments a tool does not take are dropped before any matching. */
export function guardRequest(msg: unknown, kind: BlockKind = 'lens_refused', registry?: Registry): { msg?: Rpc; answer?: Rpc } {
    if (!anonymiseOn() || !isObj(msg) || typeof msg.method !== 'string') return { msg: msg as Rpc }
    const refuse = (): { answer: Rpc } => {
        countBlock(kind)
        return { answer: msg.method === 'tools/call'
            ? { jsonrpc: '2.0', id: msg.id ?? null, result: { content: [{ type: 'text', text: REFUSAL }], isError: true } }
            : { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: REFUSAL } } }
    }
    try {
        if (msg.method === 'tools/call' || msg.method === 'prompts/get') {
            const p = msg.params || {}
            const name = String(p.name || '')
            let args = p.arguments ?? {}
            if (registry) {
                const known = (msg.method === 'tools/call' ? registry.tools() : registry.prompts())
                if (!known.has(name)) return { answer: { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: msg.method === 'tools/call' ? 'Unknown tool.' : 'Unknown prompt.' } } }
                const allowed = known.get(name)
                if (allowed && isObj(args)) args = Object.fromEntries(Object.entries(args).filter(([k]) => allowed.includes(k)))
            } else if (namesClient(name)) return refuse()
            return { msg: { ...msg, params: { ...p, arguments: revealArgs(name, args) } } }
        }
        // Anything else that carries text from the AI (resource addresses, completions, sampling, logging).
        if (msg.params !== undefined && namesClient(JSON.stringify(msg.params))) return refuse()
        return { msg }
    } catch (e) {
        if (e instanceof Refused) return refuse()
        throw e
    }
}

/** A message on its way out, with every client name and code replaced by its codename. */
export function guardResponse<T>(msg: T, kind: BlockKind = 'lens_cleaned'): T {
    if (!anonymiseOn()) return msg
    const { value, n } = hideClientsDeep(withoutMedia(msg) as T)
    if (n) countBlock(kind)
    return value
}

/** Pictures, sound and binary resources cannot be checked for names (a screenshot shows them): withheld. */
function withoutMedia(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(withoutMedia)
    if (!isObj(v)) return v
    if ((v.type === 'image' || v.type === 'audio') && typeof v.data === 'string') return { type: 'text', text: '[A picture or recording was withheld: client anonymisation is on in Lens.]' }
    if (typeof v.blob === 'string') return { ...(typeof v.uri === 'string' ? { uri: v.uri } : {}), text: '[Binary content withheld: client anonymisation is on in Lens.]' }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutMedia(x)]))
}

/** Wraps a connected transport (HTTP or stdio): both directions go through the guard. */
export function guardTransport(t: Transport, registry?: Registry): void {
    const send = t.send.bind(t)
    t.send = (message, options) => send(guardResponse(message), options)
    const onmessage = t.onmessage
    if (!onmessage) throw new Error('guardTransport: connect the server first')
    t.onmessage = (message, extra) => {
        const g = guardRequest(message, 'lens_refused', registry)
        if (g.answer) { void send(g.answer as JSONRPCMessage); return }
        onmessage(g.msg as JSONRPCMessage, extra)
    }
}
