import { createHash } from 'node:crypto'

type Doc = Record<string, any>
const TTL = 60 * 60 * 1000, REFRESH_AHEAD = 10 * 60 * 1000
/** Process-local metadata only. Pending entries share work; invalidation also fences late completions. */
export class PosthogDocsCache {
    private servers = new Map<string, Map<string, { expires: number; value: Promise<any>; refreshing?: boolean; next?: Promise<any> }>>()
    invalidate(server: string): void { this.servers.delete(server) }
    get<T>(server: string, command: string, fetch: () => Promise<T>, now = Date.now()): Promise<T> {
        let entries = this.servers.get(server)
        if (!entries) { entries = new Map(); this.servers.set(server, entries) }
        const hit = entries.get(command)
        if (hit && hit.expires > now) {
            // Refresh ahead in the last 10 minutes: a compact info can take ~10 s to build from upstream, and nobody
            // should wait for that. The old value answers until the new one is ready.
            if (hit.expires - now < REFRESH_AHEAD && !hit.refreshing) {
                hit.refreshing = true
                const next = hit.next = Promise.resolve().then(fetch)
                next.then(() => { if (this.servers.get(server) === entries && entries.get(command) === hit) entries.set(command, { expires: now + TTL, value: next }) },
                    () => { hit.refreshing = false })
            }
            return hit.value
        }
        // Expired while its refresh is still running: share that fetch instead of starting another.
        if (hit?.next) { const value = hit.next; entries.set(command, { expires: now + TTL, value }); return value }
        const value = Promise.resolve().then(fetch).catch(error => {
            if (this.servers.get(server) === entries) this.invalidate(server)
            throw error
        })
        entries.set(command, { expires: now + TTL, value })
        return value
    }
}
export const posthogDocsCache = new PosthogDocsCache()
/** The docs agents read most (graded runs): built at startup and kept warm, so no one waits ~10 s for a compact info. */
export const PREWARM_DOCS = ['tools', 'info execute-sql', 'info query-trends', 'info query-funnel', 'info query-retention', 'info query-paths', 'info query-lifecycle', 'info read-data-schema']
export const posthogServerKey = (url: string, apiKey: string) => createHash('sha256').update(url).update('\0').update(apiKey).digest('hex')
export function metadataCommand(command: string): { raw: string; tool?: string; compact: boolean } | undefined {
    const match = /^\s*(tools|info|schema)(?:[ \t]+(?:posthog:)?([\w-]+))?((?:[ \t]+[\w.$-]+)*)[ \t]*$/i.exec(command)
    if (!match || match[1].toLowerCase() !== 'tools' && !match[2] || match[1].toLowerCase() === 'tools' && (match[2] || match[3].trim())) return
    const verb = match[1].toLowerCase(), tool = match[2]
    const suffix = match[3].trim()
    if (verb === 'info' && suffix && suffix !== 'full') return
    return { raw: `${verb}${tool ? ` ${tool}` : ''}${verb === 'schema' && suffix ? ` ${suffix}` : ''}`, tool, compact: verb === 'tools' || verb === 'info' && suffix !== 'full' }
}
export function infoSchema(text: string): Doc | undefined {
    try {
        const match = /^inputSchema: (.+)$/m.exec(text)
        if (!match) return
        const schema = JSON.parse(match[1])
        return typeof schema === 'string' ? JSON.parse(schema) : schema
    } catch { return }
}
function variants(schema: Doc, root: Doc, seen = new Set<Doc>()): Doc[] {
    if (seen.has(schema)) return []
    seen = new Set(seen).add(schema)
    if (schema.$ref?.startsWith('#/')) {
        const resolved = schema.$ref.slice(2).split('/').reduce((v: any, key: string) => v?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root)
        if (resolved && resolved !== schema) return variants(resolved, root, seen)
    }
    return [schema, ...(schema.anyOf || schema.oneOf || schema.variants || []).flatMap((v: Doc) => variants(v, root, seen)), ...(schema.allOf || []).flatMap((v: Doc) => variants(v, root, seen))]
}
function summary(schema: Doc, root: Doc): string {
    const options = variants(schema, root)
    const types = [...new Set(options.flatMap(s => Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ['object'] : []))]
    const enums = [...new Set(options.flatMap(s => s.enum || ('const' in s ? [s.const] : [])))]
    const values = enums.slice(0, 16).map(v => JSON.stringify(v)).join('|')
    const constraints = ['default', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].flatMap(key => schema[key] !== undefined ? [`${key}=${JSON.stringify(schema[key])}`] : [])
    return `${types.join('|') || 'any'}${enums.length ? ` enum=${values}${enums.length > 16 ? `|… (${enums.length} values)` : ''}` : ''}${constraints.length ? ' ' + constraints.join(' ') : ''}`
}
function callRequirements(schema: Doc): string {
    // JSON schemas sometimes leave cross-field requirements in prose (e.g. Requires connectionId).
    if (typeof schema.description !== 'string') return ''
    const sentences = schema.description.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)
    const requirements = sentences.filter((sentence: string) => /^(?:Requires?\b|Must\b|Do not\b|Cannot\b)/i.test(sentence))
    return requirements.length ? ` — ${requirements.join(' ').slice(0, 240)}` : ''
}
function fields(schema: Doc, root: Doc): Map<string, { schema: Doc; required: boolean }> {
    const result = new Map<string, { schema: Doc; required: boolean }>()
    for (const option of variants(schema, root)) {
        for (const [name, field] of Object.entries(option.properties || {}) as [string, Doc][]) {
            const previous = result.get(name)
            result.set(name, { schema: previous ? { anyOf: [previous.schema, field] } : field, required: field.required === true || Array.isArray(option.required) && option.required.includes(name) || previous?.required || false })
        }
        for (const name of option.fields || []) if (!result.has(name)) result.set(name, { schema: { type: 'unknown (schema needed)' }, required: false })
    }
    return result
}
/** Hydrate only the first field layer hidden by upstream's abbreviated info schema. */
export const HOGQL_DIGEST = `HogQL essentials (PostHog's SQL, mostly ClickHouse):
- Prefer typed tools (query-trends, query-funnel, query-retention, query-paths, query-lifecycle) when they fit; SQL for custom grouping, cross-event logic, record inspection and system.* entities (insights, dashboards, cohorts, flags, experiments).
- Always bound time: timestamp >= '2026-01-01' AND timestamp < '2026-02-01' (end-exclusive, UTC). Add event IN (...) and property filters early.
- Properties: properties.dialog_id, properties.client_id, person.properties.x; session: $session_id. Verify names with read-data-schema or describe_app_events; columns of other tables via system.information_schema.
- Scan events once: countIf/uniqIf/sumIf/argMax or a window function instead of self-joins, repeated subqueries or UNIONs of the same range. No raw joins on events; a subquery used as a join source must pre-filter and pre-aggregate. LEFT ANY JOIN for one-match lookups. CTEs are inlined (a CTE used twice runs twice).
- Name aggregates (count() AS events_count, uniq(person_id) AS people) so results stay readable; add LIMIT for row lists.
- Out of memory or time limit: narrow the range, filter earlier, or use Lens aggregate_events / workflow_completion.`
export async function compactInfo(text: string, tool: string, fetchSchema: (path: string) => Promise<Doc | undefined>): Promise<string> {
    const root = infoSchema(text)
    if (!root) return text // Unknown formats stay usable, and never silently lose their contract.
    const top = fields(root, root)
    await Promise.all([...top].map(async ([name, field]) => {
        if (variants(field.schema, root).some(s => s.hint || s.fields || typeof s.items === 'string')) {
            const full = await fetchSchema(name)
            if (full) {
                field.schema = full
                if (full.$defs) root.$defs = { ...root.$defs, ...full.$defs }
            }
        }
    }))
    const description = /\ndescription: [|>]-?\n([\s\S]*?)(?=\n\S|$)/.exec(text)?.[1] || ''
    const intro = description.trim().split(/\n\s*\n/).slice(0, 2).join('\n\n').replace(/^  /gm, '').slice(0, 1000)
    const lines = [`${tool}: ${intro}`, 'Input (top-level arguments; * required, within matching variant for unions; nested array fields describe items):']
    for (const [name, field] of top) {
        lines.push(`${name}${field.required ? '*' : ''}: ${summary(field.schema, root)}${callRequirements(field.schema)}`)
        const children = fields(field.schema, root)
        for (const [key, child] of children) lines.push(`  ${key}${child.required ? '*' : ''}: ${summary(child.schema, root)}`)
        for (const option of variants(field.schema, root)) if (option.items && typeof option.items === 'object') {
            const items = variants(option.items, root).filter(item => Object.keys(item.properties || {}).length)
            for (const item of items) {
                const label = item.properties?.kind?.const
                if (items.length > 1) lines.push(`  [${label ? `kind=${JSON.stringify(label)}` : 'variant'}]`)
                for (const [key, child] of fields(item, root)) lines.push(`  ${key}${child.required ? '*' : ''}: ${summary(child.schema, root)}`)
            }
        }
    }
    // PostHog's execute-sql document is mostly a HogQL guide (~45k chars). Its rules keep queries correct and inside
    // the server's memory, so the compact form keeps them as a digest instead of dropping them with the prose.
    if (tool === 'execute-sql') lines.push(HOGQL_DIGEST)
    lines.push(`schema ${tool} <field.path> for one field in full; info ${tool} full for the raw document`)
    return lines.join('\n')
}
export function compactTools(text: string): string {
    let tools: { name: string; description?: string }[]
    try {
        const parsed = JSON.parse(text)
        tools = (Array.isArray(parsed) ? parsed : parsed.tools).map((v: any) => typeof v === 'string' ? { name: v } : v)
        if (!tools.every(v => typeof v.name === 'string')) return text
    } catch { return text }
    const groups = new Map<string, typeof tools>()
    for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
        const prefix = tool.name.split('-')[0]
        if (!groups.has(prefix)) groups.set(prefix, [])
        groups.get(prefix)!.push(tool)
    }
    return [...groups].map(([prefix, group]) => `[${prefix}]\n` + group.map(tool => {
        const description = tool.description?.split(/[\n.!?]/)[0].trim()
        return description ? `${tool.name}: ${description}`.slice(0, 100) : tool.name
    }).join('\n')).join('\n')
}
