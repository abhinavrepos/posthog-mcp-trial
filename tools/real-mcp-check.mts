// Read-only live check. Run with: node --import tsx tools/real-mcp-check.mts
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

type Dict = Record<string, unknown>
type Call = { window_days: number; name: string; page?: number; ms: number; ok: boolean; error_kind?: string; error?: string; counts?: Dict; job_id?: string }
const windows = [1, 7, 30, 90, 365]
const envPath = '/root/briefs/ph-test.env'
const env: NodeJS.ProcessEnv = { ...process.env }
try {
    for (const line of (await readFile(envPath, 'utf8')).split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$/.exec(line)
        if (!m || env[m[1]] !== undefined) continue
        let value = m[2]
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
        else value = value.replace(/\s+#.*$/, '')
        env[m[1]] = value
    }
} catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
}
env.TEAM_ID ??= env.TEAM ?? env.POSTHOG_PROJECT_ID
env.POSTHOG_PROJECT_ID ??= env.TEAM_ID
env.POSTHOG_PROJECT_TOKEN ??= env.PROJECT_TOKEN
env.POSTHOG_PERSONAL_API_KEY ??= env.PERSONAL_KEY
env.POSTHOG_MCP_API_KEY ??= env.PERSONAL_KEY
env.POSTHOG_SURVEY_API_KEY ??= env.PERSONAL_KEY
env.POSTHOG_HOST ??= 'http://127.0.0.1'
env.POSTHOG_MCP_URL ??= 'http://127.0.0.1:8787/mcp'
// The simulated Reval: client code is the 3rd part of PROD|01|SEM|user, and its app events file.
env.APP_EVENTS_FILE ??= resolve('config/app-events.reval.json')
env.CLIENT_FROM_DISTINCT_ID ??= '3'
env.DISTINCT_ID_SEPARATOR ??= '|'
env.FEATURE_SURVEYS ??= 'on'

const team = env.TEAM_ID
if (!team || !/^\d+$/.test(team)) throw new Error('Set numeric TEAM_ID (or TEAM) for the direct ClickHouse comparison.')
const runAt = new Date()
const stamp = runAt.toISOString().replace(/[:.]/g, '-')
const today = new Date(Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate()))
const calls: Call[] = []
const rows: Dict[] = []
const client = new Client({ name: 'real-mcp-check', version: '1.0.0' })
const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/mcp/stdio.ts'], cwd: resolve('.'), env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: 'pipe' })
// Keep the child's stderr drained without persisting keys or full server logs.
transport.stderr?.on('data', () => {})

function object(v: unknown): Dict | undefined { return v && typeof v === 'object' && !Array.isArray(v) ? v as Dict : undefined }
function payload(result: Dict): Dict {
    const structured = object(result.structuredContent)
    if (structured && (Object.keys(structured).length > 0)) return structured
    const text = (result.content as Array<{type?: string; text?: string}> | undefined)?.find(x => x.type === 'text')?.text || ''
    try { return object(JSON.parse(text.slice(text.indexOf('\n') + 1))) || object(JSON.parse(text)) || {} } catch { return {} }
}
function errorKind(result: Dict, body: Dict): string {
    const explicit = body.error_kind ?? object(result.structuredContent)?.error_kind
    if (typeof explicit === 'string') return explicit
    const message = String((result.content as Array<{text?: string}> | undefined)?.[0]?.text || '')
    if (/invalid arguments|invalid time|maximum|expected|validation/i.test(message)) return 'validation'
    if (/time.?out|too large|memory|limit exceeded/i.test(message)) return 'capacity'
    if (/not found|no client matches/i.test(message)) return 'not_found'
    if (/unavailable|refused|fetch failed|connection/i.test(message)) return 'unavailable'
    return 'internal'
}
function countsFor(name: string, body: Dict): Dict {
    if (name === 'resolve_client') return { matches: Array.isArray(body.matches) ? body.matches.length : undefined, client_events: object((body.matches as unknown[] | undefined)?.[0])?.client_events }
    if (name === 'find_sessions') return { sessions: Array.isArray(body.sessions) ? body.sessions.length : undefined, next_cursor: typeof body.next_cursor === 'string', truncated_by_size: body.truncated_by_size === true }
    if (name === 'list_surveys') return { surveys: Array.isArray(body.rows) ? body.rows.length : Array.isArray(body.surveys) ? body.surveys.length : undefined }
    if (name === 'design_survey') return { problems: Array.isArray(body.problems) ? body.problems.length : undefined, reach_sessions: object(body.reach)?.result && object(object(body.reach)?.result)?.sessions }
    if (name === 'posthog_exec' || name === 'get_job_result') {
        const rows = body.results ?? object(body.result)?.results ?? body.rows
        const value = Array.isArray(rows) ? (Array.isArray(rows[0]) ? rows[0][0] : object(rows[0])?.events) : body.events
        return { events: value === undefined ? undefined : Number(value), rows: Array.isArray(rows) ? rows.length : undefined }
    }
    return {}
}
async function call(windowDays: number, name: string, args: Dict, page?: number): Promise<Dict | undefined> {
    const start = performance.now()
    try {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 }) as Dict
        const body = payload(result)
        const ok = result.isError !== true && body.isError !== true
        const record: Call = { window_days: windowDays, name, ...(page ? { page } : {}), ms: Math.round(performance.now() - start), ok, counts: countsFor(name, body) }
        // PostHog's execute-sql answers as text: a header line, then one line per row.
        const raw = String((result.content as Array<{text?: string}> | undefined)?.find(x => typeof x.text === 'string')?.text || '')
        if ((name === 'posthog_exec' || name === 'get_job_result') && ok && record.counts?.events === undefined && !body.job_id && raw) {
            const lines = raw.trim().split('\n')
            const first = Number(lines[1]?.split(/[,\t]/)[0])
            record.counts = { events: lines.length === 2 && Number.isFinite(first) ? first : undefined, rows: Math.max(0, lines.length - 1), bytes: raw.length, truncated_note: /truncat|limit|more rows/i.test(raw.slice(-400)) }
            Object.assign(body, { __text: raw, __counts: record.counts })
        }
        if (!ok) {
            record.error_kind = errorKind(result, body)
            record.error = String((result.content as Array<{text?: string}> | undefined)?.[0]?.text || 'MCP tool error').slice(0, 500)
        }
        if (typeof body.job_id === 'string') record.job_id = body.job_id
        calls.push(record)
        return ok ? body : undefined
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        calls.push({ window_days: windowDays, name, ...(page ? { page } : {}), ms: Math.round(performance.now() - start), ok: false, error_kind: /timeout/i.test(message) ? 'timeout' : 'transport', error: message.slice(0, 500) })
        return undefined
    }
}
async function completeJob(days: number, initial: Dict | undefined): Promise<Dict | undefined> {
    let body = initial
    for (let poll = 0; poll < 24 && typeof body?.job_id === 'string'; poll++) {
        const next = await call(days, 'get_job_result', { job_id: body.job_id })
        if (!next) return undefined
        body = next
    }
    if (typeof body?.job_id === 'string') calls.push({ window_days: days, name: 'get_job_result', ms: 0, ok: false, error_kind: 'timeout', error: 'Job still running after 24 polls.' })
    return typeof body?.job_id === 'string' ? undefined : body
}
async function sessions(days: number, dates: Dict, screen?: string): Promise<number | undefined> {
    let cursor: string | undefined
    let total = 0
    for (let page = 1; page <= 2; page++) {
        // The tool schema caps each page at 20, so two pages can return at most 40 of the requested 50.
        const body = await completeJob(days, await call(days, 'find_sessions', { client: 'SEM', ...dates, ...(screen ? { screen } : {}), limit: 20, ...(cursor ? { cursor } : {}) }, page))
        if (!body) return undefined
        total += Array.isArray(body.sessions) ? body.sessions.length : 0
        cursor = typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (!cursor) break
    }
    return total
}
async function directCount(days: number, from: string, toExclusive: string, extra = '', label = 'clickhouse_count'): Promise<number | undefined> {
    const start = performance.now()
    const query = `SELECT count() AS events FROM posthog.events WHERE team_id = ${team} AND timestamp >= toDateTime('${from} 00:00:00', 'UTC') AND timestamp < toDateTime('${toExclusive} 00:00:00', 'UTC') ${extra} FORMAT JSON`
    try {
        const url = new URL(env.CLICKHOUSE_URL || 'http://127.0.0.1:8123')
        const headers: Record<string, string> = { 'Content-Type': 'text/plain' }
        if (env.CLICKHOUSE_USER) headers['X-ClickHouse-User'] = env.CLICKHOUSE_USER
        if (env.CLICKHOUSE_PASSWORD) headers['X-ClickHouse-Key'] = env.CLICKHOUSE_PASSWORD
        const response = await fetch(url, { method: 'POST', headers, body: query, signal: AbortSignal.timeout(35_000) })
        if (!response.ok) throw new Error(`ClickHouse HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`)
        const data = await response.json() as {data?: Array<{events?: number | string}>}
        const count = Number(data.data?.[0]?.events)
        if (!Number.isFinite(count)) throw new Error('ClickHouse returned no numeric event count.')
        calls.push({ window_days: days, name: label, ms: Math.round(performance.now() - start), ok: true, counts: { events: count } })
        return count
    } catch (e) {
        calls.push({ window_days: days, name: label, ms: Math.round(performance.now() - start), ok: false, error_kind: /timeout/i.test(String(e)) ? 'timeout' : 'unavailable', error: String(e).slice(0, 500) })
        return undefined
    }
}

try {
    await client.connect(transport)
    for (const days of windows) {
        const from = new Date(+today - (days - 1) * 86_400_000).toISOString().slice(0, 10)
        const to = today.toISOString().slice(0, 10)
        const toExclusive = new Date(+today + 86_400_000).toISOString().slice(0, 10)
        const dates = { from, to }
        const resolved = await completeJob(days, await call(days, 'resolve_client', { query: 'SEM', ...dates }))
        const screenSessions = await sessions(days, dates, 'LinkListReqv')
        const allSessions = await sessions(days, dates)
        const query = `SELECT count() AS events FROM events WHERE timestamp >= toDateTime('${from} 00:00:00', 'UTC') AND timestamp < toDateTime('${toExclusive} 00:00:00', 'UTC')`
        const hogql = await completeJob(days, await call(days, 'posthog_exec', { command: `call execute-sql ${JSON.stringify({ query })}` }))
        const hogqlCount = (object(hogql?.__counts)?.events ?? countsFor('posthog_exec', hogql || {}).events) as number | undefined
        // Row cap probe: ask for 200,000 rows and record how many come back.
        const capQuery = `SELECT distinct_id, event, timestamp FROM events WHERE timestamp >= toDateTime('${from} 00:00:00', 'UTC') AND timestamp < toDateTime('${toExclusive} 00:00:00', 'UTC') LIMIT 200000`
        const cap = await completeJob(days, await call(days, 'posthog_exec', { command: `call execute-sql ${JSON.stringify({ query: capQuery })}` }))
        const capRows = object(cap?.__counts)?.rows as number | undefined
        const semDirect = await directCount(days, from, toExclusive, "AND splitByChar('|', distinct_id)[3] = 'SEM'", 'clickhouse_sem_count')
        const semMcp = object((resolved?.matches as unknown[] | undefined)?.[0])?.client_events as number | undefined
        const surveys = await call(days, 'list_surveys', { days })
        const design = await call(days, 'design_survey', { name: 'Hedge → Export check', questions: [{ type: 'rating', text: 'How was exporting Hedge Designation?' }], steps: [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], clients: ['SEM'], days, estimate: true })
        const direct = await directCount(days, from, toExclusive)
        rows.push({ days, from, to, resolved_matches: Array.isArray(resolved?.matches) ? resolved.matches.length : null, screen_sessions: screenSessions ?? null, all_sessions: allSessions ?? null, hogql_events: hogqlCount ?? null, clickhouse_events: direct ?? null, difference: hogqlCount !== undefined && direct !== undefined ? hogqlCount - direct : null, surveys: countsFor('list_surveys', surveys || {}).surveys ?? null, sem_events_mcp: semMcp ?? null, sem_events_clickhouse: semDirect ?? null, row_cap_rows: capRows ?? null, design_problems: countsFor('design_survey', design || {}).problems ?? null })
    }
} finally {
    await client.close().catch(() => {})
}
const output = resolve('run/real-mcp', `results-${stamp}.json`)
await mkdir(resolve('run/real-mcp'), { recursive: true })
await writeFile(output, JSON.stringify({ started_at: runAt.toISOString(), finished_at: new Date().toISOString(), team_id: Number(team), session_page_limit: 20, session_pages: 2, rows, calls }, null, 2) + '\n')
console.log(`Results: ${output}\n`)
console.log('| Days | SEM events (MCP) | SEM events (CH) | LinkListReqv sessions | All sessions | HogQL events | ClickHouse events | Δ | 200k-row probe | Surveys | Design problems | Errors |')
console.log('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
for (const row of rows) {
    const d = Number(row.days)
    const show = (v: unknown) => v === null || v === undefined ? '—' : String(v)
    console.log(`| ${d} | ${show(row.sem_events_mcp)} | ${show(row.sem_events_clickhouse)} | ${show(row.screen_sessions)} | ${show(row.all_sessions)} | ${show(row.hogql_events)} | ${show(row.clickhouse_events)} | ${show(row.difference)} | ${show(row.row_cap_rows)} | ${show(row.surveys)} | ${show(row.design_problems)} | ${calls.filter(c => c.window_days === d && !c.ok).length} |`)
}
