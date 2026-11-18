// Shared PostHog command policy for MCP and saved charts.
import { privacyMode, anonFor, posthogMode, namesClient, refusalText, revealCodenames, countBlock } from './anonymise.ts'
import { guardRequest } from '../mcp/anonymise.ts'
type Rpc = Record<string, any>
const object = (v: unknown): v is Rpc => !!v && typeof v === 'object' && !Array.isArray(v)

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
        else if (/^(?:persons-[\w-]*|query-[\w-]+-actors|cohorts-add-persons-to-static-cohort[\w-]*|cohorts-rm-person-from-static-cohort[\w-]*)$/.test(tool)) {
            if (!(privacyMode() === 'open' && /^(?:persons-(?:list|get|retrieve)|query-[\w-]+-actors)$/.test(tool))) message = 'Client-user identities and person lists are private. Lens answers per client (resolve_client, client_experience, client_signals) without naming people.'
        } else if (/^(?:workflows-|broadcasts-)[\w-]*$/.test(tool))
            message = "Messaging users is disabled. Lens's discover_workflows and workflow_completion measure app tasks; they never send anything."
        else if (/^survey[\w-]*$/.test(tool))
            message = `In-app surveys are managed only in Lens: use the ${name} server's survey tools (list_surveys, survey_results, design_survey, save_survey, stop_survey), which follow each person's survey role; launching is only on the Lens Surveys page. PostHog survey commands are refused.`
        if (message) return { jsonrpc: '2.0', id: value.id ?? null, error: { code: -32602, message: 'PostHog command refused. ' + message } }
    }
}

// ------------------------------------------------------------------ client anonymisation (src/core/anonymise.ts)
// block (the default): exec may look up tools (help, tools, search, info, schema) and search PostHog's docs;
// every other call is refused, since any query or list can return client names in a form no filter can
// recognise (concatenated, encoded, aggregated). filter: calls run with codenames in the command turned
// into client codes, client names and codes in the command refused, and results cleaned (best effort).
const LOOKUP = new Set(['help', 'tools', 'search', 'info', 'schema'])
const DOCS_ONLY = new Set(['docs-search'])
export function anonRefusal(value: unknown, name = 'lens', mode: 'block' | 'filter' = posthogMode()): { refusal?: Rpc; value?: unknown } {
    if (!anonFor('posthog') || !object(value)) return { value }
    if (value.method === 'tools/call' && /^(?:posthog:)?execute-sql$/i.test(String(value.params?.name || ''))) {
        countBlock('posthog_refused')
        return { refusal: { jsonrpc: '2.0', id: value.id ?? null, result: { isError: true, content: [{ type: 'text', text: 'Raw SQL is refused in private mode. Use Lens tools instead.' }] } } }
    }
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

