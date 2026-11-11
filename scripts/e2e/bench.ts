// Speed benchmark for Lens (chat tools over MCP, Lens pages and APIs) and PostHog (API, static assets),
// against the test VM through the tunnels. Each item: one cold run, then N warm runs; reports cold,
// p50 and max in ms, plus response size. Writes JSON for before/after comparison.
//   npx tsx scripts/e2e/bench.ts <label>   (LENS_URL, POSTHOG_URL, E2E_TOKEN or E2E_TOKEN_FILE: a Lens admin chat key;
//   POSTHOG_PERSONAL_API_KEY for the PostHog API items; E2E_OUT for the JSON)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const S = process.env.E2E_OUT || 'e2e-out'; mkdirSync(S, { recursive: true })
const LENS = process.env.LENS_URL || 'http://127.0.0.1:8080', PH = process.env.POSTHOG_URL || 'http://127.0.0.1'
const token = (process.env.E2E_TOKEN ?? readFileSync(process.env.E2E_TOKEN_FILE || '', 'utf8')).trim()
const phKey = process.env.POSTHOG_PERSONAL_API_KEY || ''
const label = process.argv[2] || 'run'
const WARM = Number(process.env.WARM || 4)
type Result = { name: string; cold: number; p50: number; max: number; bytes: number; ok: boolean; note?: string }
const results: Result[] = []

async function measure(name: string, fn: () => Promise<{ ok: boolean; bytes: number; note?: string }>) {
    const times: number[] = []; let last = { ok: false, bytes: 0, note: '' as string | undefined }
    for (let i = 0; i <= WARM; i++) {
        const t = performance.now()
        try { last = await fn() } catch (e) { last = { ok: false, bytes: 0, note: String((e as Error).message).slice(0, 120) } }
        times.push(performance.now() - t)
    }
    const warm = times.slice(1).sort((a, b) => a - b)
    const r = { name, cold: Math.round(times[0]), p50: Math.round(warm[Math.floor(warm.length / 2)] ?? times[0]), max: Math.round(Math.max(...warm, 0)), bytes: last.bytes, ok: last.ok, note: last.note }
    results.push(r)
    console.log(`${r.ok ? '  ' : '✗ '}${name.padEnd(46)} cold ${String(r.cold).padStart(6)}  p50 ${String(r.p50).padStart(6)}  max ${String(r.max).padStart(6)}  ${String(Math.round(r.bytes / 1024)).padStart(5)} KB${r.note ? '  ' + r.note : ''}`)
}

// ---- MCP (streamable HTTP)
let sid = '', phSid = ''
async function rpc(path: string, method: string, params: unknown, session: string) {
    const r = await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const text = await r.text()
    const data = r.headers.get('content-type')?.includes('event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).pop() : text ? JSON.parse(text) : undefined
    return { status: r.status, sid: r.headers.get('mcp-session-id') || session, data, bytes: text.length }
}
async function open(path: string) {
    const init = await rpc(path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } }, '')
    if (init.sid) await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': init.sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    return init.sid || ''
}
const tool = (name: string, args: Record<string, unknown> = {}, path = '/mcp') => async () => {
    const r = await rpc(path, 'tools/call', { name, arguments: args }, path === '/mcp' ? sid : phSid)
    const err = r.data?.error?.message || (r.data?.result?.isError ? JSON.stringify(r.data.result.content).slice(0, 100) : '')
    return { ok: r.status === 200 && !err, bytes: r.bytes, note: err || undefined }
}

console.log(`\n== ${label}: Lens chat tools (MCP)`)
await measure('mcp initialize', async () => { const t = await rpc('/mcp', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'b', version: '1' } }, ''); return { ok: t.status === 200, bytes: t.bytes } })
sid = await open('/mcp')
await measure('mcp tools/list', async () => { const r = await rpc('/mcp', 'tools/list', {}, sid); return { ok: r.status === 200, bytes: r.bytes } })
const tools: any[] = (await rpc('/mcp', 'tools/list', {}, sid)).data?.result?.tools || []
writeFileSync(`${S}/bench-tools.json`, JSON.stringify(tools.map((t) => ({ name: t.name, required: t.inputSchema?.required || [], props: Object.keys(t.inputSchema?.properties || {}) })), null, 1))
await measure('task_map (default)', tool('task_map'))
await measure('task_map (one client)', tool('task_map', { client: 'Treasury 2' }))
await measure('find_task "hedge"', tool('find_task', { query: 'hedge' }))
await measure('flow_time "hedge designation"', tool('flow_time', { task: 'hedge designation' }))
await measure('list_dashboards', tool('list_dashboards'))
await measure('list_surveys', tool('list_surveys'))
const sv = (await rpc('/mcp', 'tools/call', { name: 'list_surveys', arguments: {} }, sid)).data?.result?.content?.[0]?.text || ''
const surveyId = /"id":\s*"([0-9a-f-]{36})"/.exec(sv)?.[1]
if (surveyId) await measure('survey_results', tool('survey_results', { survey_id: surveyId }))
// every other read-only tool that takes no required argument
const skip = new Set(['task_map', 'find_task', 'flow_time', 'list_dashboards', 'list_surveys', 'survey_results'])
for (const t of tools) if (!skip.has(t.name) && !(t.inputSchema?.required || []).length && !/launch|stop|pin|share|create|update|delete|archive|save|clip|record|ticket|comment/.test(t.name)) await measure(`${t.name}`, tool(t.name))

console.log(`\n== ${label}: PostHog through Lens (posthog-mcp)`)
phSid = await open('/posthog-mcp')
await measure('posthog-mcp tools/list', async () => { const r = await rpc('/posthog-mcp', 'tools/list', {}, phSid); return { ok: r.status === 200, bytes: r.bytes } })
await measure('posthog exec: SQL count today', tool('exec', { command: 'call execute-sql {"query":"SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 DAY"}' }, '/posthog-mcp'))
await measure('posthog exec: SQL events by day 30d', tool('exec', { command: 'call execute-sql {"query":"SELECT toDate(timestamp) d, count() FROM events WHERE timestamp > now() - INTERVAL 30 DAY GROUP BY d ORDER BY d"}' }, '/posthog-mcp'))

console.log(`\n== ${label}: PostHog API and static files`)
const ph = (path: string, init: RequestInit = {}) => async () => { const r = await fetch(PH + path, init); const b = Buffer.from(await r.arrayBuffer()); return { ok: r.ok, bytes: b.length, note: [r.headers.get('content-encoding'), r.headers.get('cache-control')].filter(Boolean).join(' | ') || undefined } }
await measure('posthog /_health', ph('/_health'))
await measure('posthog login page', ph('/login'))
const loginHtml = await (await fetch(PH + '/login')).text()
const assets = [...loginHtml.matchAll(/(?:src|href)="(\/static\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]).slice(0, 4)
for (const a of assets) await measure(`static ${a.split('/').pop()!.slice(0, 30)} (br,gzip)`, ph(a, { headers: { 'accept-encoding': 'br, gzip' } }))
if (phKey) {
    const q = (query: string) => ph('/api/projects/1/query/', { method: 'POST', headers: { authorization: 'Bearer ' + phKey, 'content-type': 'application/json' }, body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }) })
    await measure('posthog API: HogQL count 1 day', q('SELECT count() FROM events WHERE timestamp > now() - INTERVAL 1 DAY'))
    await measure('posthog API: HogQL by day 30d', q('SELECT toDate(timestamp) d, count() FROM events WHERE timestamp > now() - INTERVAL 30 DAY GROUP BY d ORDER BY d'))
    await measure('posthog API: trends 7d (insight)', ph('/api/projects/1/query/', { method: 'POST', headers: { authorization: 'Bearer ' + phKey, 'content-type': 'application/json' }, body: JSON.stringify({ query: { kind: 'TrendsQuery', series: [{ kind: 'EventsNode', event: null, math: 'total' }], dateRange: { date_from: '-7d' }, interval: 'day' } }) }))
    await measure('posthog API: replay list', ph('/api/projects/1/session_recordings?limit=20', { headers: { authorization: 'Bearer ' + phKey } }))
}

console.log(`\n== ${label}: Lens pages (unauthenticated paths) and health`)
await measure('lens /replays (sign-in page)', async () => { const r = await fetch(LENS + '/replays'); const t = await r.text(); return { ok: r.ok, bytes: t.length, note: r.headers.get('content-encoding') || undefined } })

writeFileSync(`${S}/bench-${label}.json`, JSON.stringify(results, null, 1))
console.log(`\nsaved bench-${label}.json (${results.filter((r) => !r.ok).length} failed items)`)
