import { TRENDS_CORRECTION } from './posthog-error.ts'
export { TRENDS_CORRECTION } from './posthog-error.ts'
import { appEvents, observedAppEventNames, type AppEvents } from '../core/appevents.ts'
import { config } from '../core/config.ts'

const GENERIC = new Set(['get', 'all', 'list', 'create', 'update', 'delete', 'partial', 'retrieve', 'query', 'run', 'by', 'id', 'one', 'many', 'search'])
export function closestNames(input: string, names: string[]): string[] {
    // PostHog names the same action two ways (dashboards-get-all, experiment-list): "all" reads as "list".
    const words = (s: string) => s.toLowerCase().replace(/get[-_]all\b/g, 'list').split(/[-_]/).map(w => w.replace(/s$/, ''))
    const distance = (a: string, b: string) => {
        let row = Array.from({ length: b.length + 1 }, (_, i) => i)
        for (let i = 0; i < a.length; i++) {
            const next = [i + 1]
            for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])))
            row = next
        }
        return row[b.length]
    }
    if (input.length > 128) return []
    return [...new Set(names)].filter(n => /^[\w$-]{1,64}$/.test(n)).map(name => {
        // The subject ("experiment") decides; generic verbs ("get", "all", "list") only break ties. Before, a
        // shared "get-all" ranked endpoints-get-all above experiment-list for experiments-get-all.
        const common = words(name).filter(w => words(input).includes(w))
        const shared = common.length, subject = common.filter(w => !GENERIC.has(w)).length
        const d = distance(words(input).join('-'), words(name).join('-')) // compared as normalised words
        return { name, d, shared, score: d - shared * 2 - subject * 12 }
    }).filter(x => x.shared || x.d <= Math.max(2, input.length / 3)).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, 3).map(x => x.name)
}
export function commandInput(command: string): { tool: string; input: unknown } | undefined {
    const m = /^\s*call\s+(?:--[\w-]+\s+)*["'`]?(?:posthog:)?([\w-]+)["'`]?\s+([\s\S]+)$/i.exec(command)
    if (!m) return
    try { return { tool: m[1], input: JSON.parse(m[2]) } } catch { return }
}
export function toolNames(result: unknown): string[] {
    const content = (result as { content?: { text?: string }[] })?.content
    const names: string[] = []
    for (const c of content || []) try {
        const v = JSON.parse(c.text || '')
        if (Array.isArray(v)) names.push(...v.filter((x): x is string => typeof x === 'string' && /^[a-z0-9-]{1,64}$/.test(x)))
    } catch {}
    return names
}
export function obsoleteCorrection(command: string): string | undefined {
    const call = commandInput(command)
    const input = call?.input as { breakdownFilter?: Record<string, unknown> } | undefined
    if (call?.tool === 'query-trends' && input?.breakdownFilter && typeof input.breakdownFilter === 'object' && 'breakdown_type' in input.breakdownFilter) return TRENDS_CORRECTION
}

export function queryWarnings(command: string, app: AppEvents | null, observed: string[] | undefined, properties: string[]): string[] {
    const call = commandInput(command)
    if (!app || !call || !/^(?:query-|execute-sql$)/.test(call.tool)) return []
    const events = new Set<string>(), keys = new Set<string>()
    const walk = (v: unknown, depth = 0): void => {
        if (!v || depth > 30) return
        if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return }
        if (typeof v !== 'object') return
        const r = v as Record<string, unknown>
        if (typeof r.event === 'string') events.add(r.event)
        if (r.type === 'events' && typeof r.id === 'string') events.add(r.id)
        if (typeof r.key === 'string' && (!r.type || r.type === 'event' || r.type === 'person')) keys.add(r.key)
        for (const k of ['property', 'math_property', 'breakdown']) if (typeof r[k] === 'string') keys.add(r[k] as string)
        for (const [k, x] of Object.entries(r)) if (!['value', 'values'].includes(k)) walk(x, depth + 1)
    }
    walk(call.input)
    // Only recognize SQL event literals and property references; never put SQL or values in warnings.
    const sql = (call.input as { query?: unknown })?.query
    if (typeof sql === 'string') {
        for (const m of sql.matchAll(/\bevent\s*=\s*'((?:[^']|'')*)'|\bevent\s+IN\s*\(([^)]*)\)/gi)) {
            if (m[1] !== undefined) events.add(m[1])
            else for (const v of m[2].matchAll(/'((?:[^']|'')*)'/g)) events.add(v[1])
        }
        for (const m of sql.matchAll(/\bproperties\.([\w$]+)/g)) keys.add(m[1])
    }
    const warnings: string[] = []
    if (observed && [...events].some(e => !observed.includes(e)))
        warnings.push(`Warning: A requested event has not been observed in ${app.app}'s data; its screen event is ${app.events.screen} and its interaction event is ${app.events.interaction}.`)
    for (const key of keys) if (!key.startsWith('$') && !properties.includes(key)) {
        const suggestion = closestNames(key, properties)[0]
        warnings.push(`Warning: A property key is outside the data dictionary.${suggestion ? ` Did you mean ${suggestion}?` : ' Check the configured app event map or use read-data-schema.'}`)
    }
    return [...new Set(warnings)].slice(0, 4)
}
export async function posthogInputWarnings(command: string): Promise<string[]> {
    const app = appEvents()
    if (!app || !/^(?:query-|execute-sql$)/.test(commandInput(command)?.tool || '')) return []
    const properties = [...Object.values(app.properties).map(p => p.name), config.properties.client, config.properties.clientName, config.properties.version, config.properties.personEmail].filter((p): p is string => !!p)
    const tentative = queryWarnings(command, app, [], properties)
    if (!tentative.some(w => w.includes('requested event'))) return tentative
    const observed = await observedAppEventNames().catch(() => undefined)
    return queryWarnings(command, app, observed, properties)
}
