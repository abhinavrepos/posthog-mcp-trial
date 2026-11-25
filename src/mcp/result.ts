/** Preserve the data in text and MCP structured output, with no masking. */
export const jsonResult = (label: string, value: unknown) => ({
    content:[{type:'text' as const,text:label + '\n' + JSON.stringify(value)}],
    structuredContent: value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {rows:value},
})

const WINDOW_KEYS = new Set(['window','period','from','to','when','compare','compare_from','compare_to','compare_with','compared_with','days','weeks','cursor'])
const BULKY = new Set(['questions','steps','reset_on','look','chart','note','description'])
const SOURCES: Record<string,string> = {
    resolve_client: 'PostHog events (HogQL, live)', find_sessions: 'PostHog events and recordings (HogQL, live)', posthog_exec: 'PostHog MCP tools',
    data_guide: 'Lens app event map and PostHog coverage', get_replay_link: 'PostHog recordings and Lens clips', pin_graph: 'Lens snapshots', list_pinned: 'Lens snapshots', unpin_graph: 'Lens snapshots',
    design_survey: 'PostHog surveys and events', save_survey: 'PostHog surveys', stop_survey: 'PostHog surveys', list_surveys: 'PostHog surveys and survey events', survey_results: 'PostHog survey events',
}
/** Every successful result starts with what it covers: the resolved window, the filters, the source and how much is shown. */
export function withContext(result: any, tool: string, args: Record<string, unknown> = {}, window?: Record<string, unknown>) {
    const sc = result?.structuredContent && typeof result.structuredContent === 'object' ? result.structuredContent as Record<string, any> : undefined
    if (sc?.status === 'running') return result
    const filters = Object.fromEntries(Object.entries(args).filter(([k, v]) => !WINDOW_KEYS.has(k) && !BULKY.has(k) && v !== undefined && k !== 'command').map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]))
    const text = (result?.content || []).map((c: any) => c?.text || '').join('\n')
    const recipe = tool === 'posthog_exec' ? /^\s*recipe\s+([\w-]+)/i.exec(String(args.command || ''))?.[1] : undefined
    const upstream = tool === 'posthog_exec' && !recipe ? /^\s*(?:call|info)\s+([\w-]+)/i.exec(String(args.command || ''))?.[1] : undefined
    const list = sc ? ['sessions', 'matches', 'rows', 'surveys', 'results', 'items'].map(k => sc[k]).find(Array.isArray) : undefined
    const capped = text.includes('rows capped at 500')
    const context: Record<string, unknown> = {
        tool, ...(recipe ? { recipe } : {}), ...(upstream ? { posthog_tool: upstream } : {}),
        ...(window ? { window } : {}), ...(Object.keys(filters).length ? { filters } : {}),
        source: recipe ? 'Lens recipe over PostHog events (HogQL, live)' : SOURCES[tool] || 'Lens',
        ...(list ? { shown: list.length } : {}), ...(typeof sc?.total === 'number' ? { total: sc.total } : {}),
        ...(sc?.truncated_by_size || sc?.truncated || sc?.partial || capped ? { truncated: true } : {}), ...(sc?.next_cursor ? { more: 'pass next_cursor as cursor for the next page' } : {}),
        ...(capped ? { row_cap: 500 } : {}),
    }
    // Text stays "<label>\n<json>" for existing readers: the context becomes the JSON object's first key; a JSON list
    // keeps its text (structuredContent carries the context); other text gets a first "Context:" line.
    const content = Array.isArray(result?.content) ? result.content : []
    const first = content.findIndex((c: any) => c?.type === 'text')
    const m = first >= 0 ? /^([^\n]*)\n(\{[\s\S]*\})$/.exec(content[first].text) : null
    let json: Record<string, unknown> | undefined
    if (m) { try { const v = JSON.parse(m[2]); if (v && typeof v === 'object' && !Array.isArray(v)) json = v } catch { /* not JSON */ } }
    const listText = first >= 0 && /^[^\n]*\n\[[\s\S]*\]$/.test(content[first].text)
    const text0 = first < 0 ? '' : json ? `${m![1]}\n${JSON.stringify({ context, ...json })}` : listText ? content[first].text : `Context: ${JSON.stringify(context)}\n${content[first].text}`
    const next = first >= 0 ? [...content.slice(0, first), { ...content[first], text: text0 }, ...content.slice(first + 1)] : [{ type: 'text' as const, text: 'Context: ' + JSON.stringify(context) }, ...content]
    return { ...result, content: next, ...(sc ? { structuredContent: { context, ...sc } } : {}) }
}
