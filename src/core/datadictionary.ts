import { appEvents, type AppEvents, type Role } from './appevents.ts'
import { config } from './config.ts'
import { privacyMode } from './anonymise.ts'

export const DICTIONARY_LIMITS = { compact: 6000, exec: 8000, routing: 8000, describe: 1000 } as const
type Live = { properties: { name: string; examples: string[] }[] }
type Options = {
    format: 'compact' | 'full'
    live?: Live
    /** Explicit vocabulary for offline generation and deployments without an app map. */
    app?: AppEvents | null
    properties?: typeof config.properties
    private?: boolean
}
const dimensions: Partial<Record<Role, string>> = {
    dialog: 'dialog', dialogName: 'dialog_name', tab: 'tab', action: 'action', button: 'button',
}
const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ')
const literal = (s: string) => "'" + s.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"

/** One vocabulary for tool descriptions, routing, on-demand results and generated human docs.
 * Static examples come only from config; live values never enter startup descriptions. */
export function dataDictionary(options: Options): string {
    const a = options.app === undefined ? appEvents() : options.app
    const p = options.properties ?? config.properties
    const privateMode = options.private ?? privacyMode() === 'private'
    const full = options.format === 'full'
    const rows: string[][] = []
    const both = a ? `${a.events.screen}, ${a.events.interaction}` : 'events'
    if (a) for (const [role, prop] of Object.entries(a.properties)) {
        const values = full ? options.live?.properties.find((x) => x.name === prop.name)?.examples : undefined
        rows.push([prop.name, both, prop.meaning, (values?.length ? values : prop.examples || []).slice(0, full ? 5 : 3).join(', ') || '—',
            `properties.${prop.name}`, dimensions[role as Role] || '—'])
    }
    rows.push([p.client, both, 'Client id', privateMode ? 'Client 100 (Lens codename)' : 'C123', `properties.${p.client}`, 'client'])
    if (p.clientName) rows.push([p.clientName, both, 'Client display name', '<client name>', `properties.${p.clientName}`, 'client (resolved name)'])
    if (p.version) rows.push([p.version, both, 'App release', '<app> 1.0', `properties.${p.version}`, 'app_version'])
    rows.push(['$time', both, 'Client clock, epoch seconds', '1700000000', 'properties.$time', '—'])
    rows.push([p.personEmail, 'person', 'User email (privacy restricted)', '<email>', `person.properties.${p.personEmail}`, 'email (where supported)'])
    const table = (head: string[], body: string[][]) => [head, head.map(() => '---'), ...body].map((r) => '| ' + r.map(cell).join(' | ') + ' |').join('\n')
    const parts = a?.distinctIdParts
    const clientPart = p.clientFromDistinctId
    const userPart = parts?.indexOf('{user}')
    const identity = [
        'Columns: event, timestamp (UTC; use end-exclusive ranges), distinct_id, person_id; session: $session_id / properties.$session_id. Person fields: person.properties.*.',
        parts?.length ? `distinct_id format: ${privateMode ? '<private identity>' : parts.map((v) => v === '{client}' ? 'C123' : v === '{user}' ? 'user1' : v).join(p.distinctIdSeparator)}; separator ${JSON.stringify(p.distinctIdSeparator)}.${userPart !== undefined && userPart >= 0 ? ` User is part ${userPart + 1} (1-based).` : ''}` : 'distinct_id format/user position is not configured; do not guess.',
        clientPart ? `Client is part ${clientPart} (1-based) of distinct_id${privateMode ? '' : `: splitByChar(${literal(p.distinctIdSeparator)}, distinct_id)[${clientPart}]`}; Lens client dimension uses this instead of the property.` : `Lens client dimension uses properties.${p.client}; no distinct_id client extraction is configured.`,
        privateMode ? 'PRIVATE: use client codenames in Lens filters; execute-sql is refused. Resolve values through Lens.' : 'Identity examples are placeholders, not live identities.',
    ]
    const sections = [
        `${a?.app || 'Application'} data dictionary`,
        a ? table(['event', 'what it is', 'key properties'], [
            [a.events.screen, `Dialog/window opened, focused or closed (${Object.values(a.screenActions).flat().join('/')})`, Object.values(a.properties).map((x) => x.name).join(', ')],
            [a.events.interaction, 'Click, field change or button; messages are interactions', Object.values(a.properties).map((x) => x.name).join(', ')],
        ]) : 'No app event map configured; discover event names and properties before querying.',
        table(['property', 'on', 'meaning', 'examples', 'HogQL path', 'Lens filter/dimension'], rows),
        ...identity,
    ]
    if (a) {
        const d = a.properties.dialog!
        const dialog = d.examples?.[0] || '<dialog code>'
        const next = d.examples?.[1] || '<next dialog code>'
        const node = (value: string) => ({ kind: 'EventsNode', event: a.events.screen, properties: [{ key: d.name, value: [value], operator: 'exact', type: 'event' }] })
        const range = { date_from: '2026-01-01', date_to: '2026-02-01' }
        const command = (tool: string, input: unknown) => `call ${tool} ${JSON.stringify(input)}`
        sections.push('Copy-ready PostHog commands (replace synthetic values; info <tool> / schema <tool> <field> checks the installed schema):',
            command('query-trends', { series: [node(dialog)], dateRange: range }),
            command('query-trends', { series: [{ kind: 'EventsNode', event: a.events.screen }], dateRange: range, breakdownFilter: { breakdowns: [{ property: p.client, type: 'event' }] } }),
            command('query-funnel', { series: [node(dialog), node(next)], dateRange: range, funnelsFilter: { funnelOrderType: 'ordered' }, breakdownFilter: { breakdown: p.client, breakdown_type: 'event' } }),
            command('query-paths', { dateRange: range, pathsFilter: { includeEventTypes: ['hogql'], pathsHogQLExpression: `toString(properties.${d.name})`, stepLimit: 5 } }),
        )
        if (!privateMode) sections.push(command('execute-sql', { query: `SELECT properties.${d.name} AS dialog, count() AS events_count FROM events WHERE properties.${p.client} = 'C123' AND timestamp >= '2026-01-01' AND timestamp < '2026-02-01' AND event IN (${literal(a.events.screen)}, ${literal(a.events.interaction)}) GROUP BY dialog ORDER BY events_count DESC` }),
            'SQL: alias count() AS events_count so privacy keeps counts.')
        if (full) sections.push('Retention uses retentionFilter.targetEntity and returningEntity with {id: <event>, name: <event>, type: "events"}; event property filters belong in top-level properties. aggregate_events accepts group_by and filters.dimension using the Lens names above; control, title, client_name and $time have no aggregate dimension. Not every event fills every property.')
    }
    sections.push('Call describe_app_events for live values and the full dictionary.')
    return sections.join('\n\n')
}
