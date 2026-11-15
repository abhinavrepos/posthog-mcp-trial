// Structured tool output (MCP 2025-11-25): structuredContent mirrors the text block exactly (after the privacy
// pass), outputSchema is advertised only where every answer path conforms, and detail=concise compacts answers.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { z } from 'zod'
const dir = mkdtempSync(join(tmpdir(), 'lens-structured-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'm.db'), TASKS_DB: join(dir, 't.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'phx_test', POSTHOG_SURVEY_API_KEY: 'test', FEATURE_SURVEYS: 'on', LENS_MCP_CALLS_PER_MINUTE: '100000', LENS_MCP_CALLS_PER_HOUR: '1000000' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { storeAggregateDaily } = await import('../src/core/aggregatedaily.ts')
const { registerTools, wrapTools, clearToolAnswers } = await import('../src/mcp/tools.ts')
const { installJobTools, FAST_TOOLS } = await import('../src/mcp/jobtools.ts')
const { registerDashboardTools } = await import('../src/mcp/dashboardtools.ts')
const { JobRunner } = await import('../src/core/jobs.ts')
const { db } = await import('../src/core/db.ts')
const A = await import('../src/core/anonymise.ts')
const { jsonResult } = await import('../src/mcp/result.ts')
const { guardResponse } = await import('../src/mcp/anonymise.ts')
const { ANALYSIS_SCHEMA_TOOLS, DETAIL_TOOLS, ANALYSIS_OUTPUT, ROWS_OUTPUT, CANDIDATES_OUTPUT } = await import('../src/mcp/structured.ts')
storeAggregateDaily(tasksDb, '2026-01-01', [])
A.syncClients([{ id: 'QZX901', name: 'Zorblax Treasury' }])
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, unknown> }
const caller = { who: 'structured', surveyRole: 'launch' as const, dashboardRole: 'share' as const, admin: true, insights: true }
async function connect(server: McpServer) {
    const client = new Client({ name: 'test', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    // listTools primes the SDK client's own outputSchema validation (Ajv) for every later callTool.
    const tools = (await client.listTools()).tools
    return { client, tools, close: async () => { await client.close(); await server.close() } }
}
const fenced = (r: Result) => { const t = r.content[0].text, m = /```json\n([\s\S]*)\n```$/.exec(t); return JSON.parse(m ? m[1] : t) }
/** structuredContent minus the `overview` (the label above the fenced JSON), which must equal that label exactly. */
const bare = (r: Result) => {
    const { overview, ...rest } = (r.structuredContent || {}) as Record<string, unknown>
    const t = r.content[0].text, i = t.indexOf('\n\n```json\n')
    if (overview !== undefined) assert.equal(overview, t.slice(0, i), 'overview equals the label above the JSON')
    else assert.ok(i < 0 || t.slice(0, i) === '', 'a label above the JSON must also be in structuredContent.overview')
    return rest
}
const ajv = new AjvJsonSchemaValidator()
const conforms = (schema: unknown, value: unknown) => { const v = ajv.getValidator(schema as never)(value); assert.ok(v.valid, `${v.errorMessage} ${JSON.stringify(value).slice(0, 300)}`) }

// Fixture answers shaped like the real tools': ranked lists with nested examples and per-day series.
const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}-${i}`)
const example = (i: number) => ({ session_id: `0190a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, '0')}`, replay_url: `https://lens.example/replays?s=${i}`, at: '2026-01-01T10:00:00Z' })
const series = (n: number) => Array.from({ length: n }, (_, i) => ({ day: new Date(Date.UTC(2025, 11, 1 + i)).toISOString().slice(0, 10), attempts: 10 + i, failed: i % 3 }))
const FIXTURES: Record<string, () => unknown> = {
    dialog_friction: () => ({ total_attempts: 4120, failed_attempts: 380, dialogs: Array.from({ length: 12 }, (_, d) => ({ dialog: `DlgDetail${d}`, name: `Dialog ${d}`, attempts: 300 - d, failed: 30 - d,
        errors: Array.from({ length: 4 }, (_, e) => ({ text: `Field ${e} is required`, count: 20 - e, example: example(e) })), clients_with_errors: ids(10, 'c'), clients_with_errors_count: 42,
        stuck_sessions: Array.from({ length: 4 }, (_, s) => example(s)), daily: series(7) })) }),
    top_pains: () => ({ comparison: { from: '2025-12-18', to: '2025-12-24' }, pains: Array.from({ length: 15 }, (_, p) => ({ kind: 'failing_dialog', dialog: `Dlg${p}`, count: 90 - p, change: 0.25,
        clients_hit: ids(10, 'c'), clients_hit_count: 31, examples: Array.from({ length: 5 }, (_, e) => example(e)) })) }),
    message_doctor: () => ({ messages_seen: 61, messages: Array.from({ length: 40 }, (_, m) => ({ template: `Value {n} out of range ${m}`, dialog: `Dlg${m % 7}`, shown: 50 - m, recovered: 20, repeated: 9, gave_up: 4,
        fields_touched: ids(12, 'field'), dialogs_opened: ids(6, 'Dlg'), examples: Array.from({ length: 4 }, (_, e) => example(e)) })) }),
    aggregate_events: () => ({ metrics: ['events', 'sessions'], bucket: 'day', group_by: ['dialog'], totals: { events: 182000, sessions: 5200 },
        rows: Array.from({ length: 50 }, (_, r) => ({ period: `2025-12-${String(1 + (r % 28)).padStart(2, '0')}`, dialog: `Dlg${r}`, events: 4000 - r * 10, sessions: 120 - r })) }),
    client_signals: () => ({ clients_compared: 150, clients: Array.from({ length: 20 }, (_, c) => ({ client: `c-${c}`, signal: 'less_use', now: { sessions: 40, active_days: 9 }, before: { sessions: 80, active_days: 14 },
        reasons: ['Sessions fell 50%', 'Active days fell 36%', 'Two users absent', 'More failed attempts'], weeks: series(12) })) }),
    workflow_completion: () => ({ workflow: { id: 'wf_1', name: 'Book a hedge', dialogs: ['A', 'B', 'C'] }, overall: { starts: 900, done: 700, failed: 80, abandoned: 120, median_s: 95 },
        funnel: [{ step: 'A', reached: 900 }, { step: 'B', reached: 800 }, { step: 'C', reached: 700 }], clients: Array.from({ length: 30 }, (_, c) => ({ client: `c-${c}`, starts: 30, done: 25, dropout_errors: ids(5, 'err'), examples: [example(c)] })), series: series(28) }),
}
const generic = (name: string) => FIXTURES[name]?.() ?? { headline: `${name} answer`, rows: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, value: i, examples: [example(i)] })) }
const value = (name: string) => name === 'resolve_client' ? [{ id: 'C1', name: 'Client one', confidence: 1 }] : name === 'find_task' ? { candidates: [{ task_id: 't', name: 'Task' }] } : generic(name)

test('analysis tools advertise outputSchema exactly where every answer path conforms; others have none', async () => {
    const c = await connect((() => { const s = new McpServer({ name: 'real', version: '1' }); registerTools(s, undefined, caller); return s })())
    try {
        const withSchema = c.tools.filter(t => t.outputSchema).map(t => t.name).sort()
        assert.deepEqual(withSchema, [...ANALYSIS_SCHEMA_TOOLS, 'resolve_client', 'find_task'].filter(n => c.tools.some(t => t.name === n)).sort())
        for (const name of ['get_job_result', 'attempt_timings', 'reval_brief', 'session_story', 'triage_ticket', 'handover_pack', 'pin_dashboard', 'list_dashboards', 'save_survey', 'draft_rescue_survey']) {
            const tool = c.tools.find(t => t.name === name)
            if (tool) assert.equal(tool.outputSchema, undefined, name)
        }
        for (const t of c.tools.filter(t => t.outputSchema)) {
            assert.equal(t.outputSchema!.type, 'object', t.name)
            const job = !!t.annotations?.readOnlyHint && !FAST_TOOLS.has(t.name)
            assert.equal(Array.isArray((t.outputSchema as { anyOf?: unknown[] }).anyOf), job, `${t.name}: job-backed tools allow the running handle`)
        }
        for (const name of DETAIL_TOOLS) { const tool = c.tools.find(t => t.name === name); if (tool) assert.deepEqual((tool.inputSchema.properties as Record<string, { enum?: string[] }>).detail?.enum, ['concise', 'full'], name) }
        assert.equal((c.tools.find(t => t.name === 'resolve_client')!.inputSchema.properties as Record<string, unknown>).detail, undefined)
        // A real normal answer: aggregate_events from the stored rollup, run in a real analysis worker.
        const r = await c.client.callTool({ name: 'aggregate_events', arguments: { from: '2026-01-01', to: '2026-01-01' } }) as Result
        assert.ok(!r.isError, JSON.stringify(r)); conforms(c.tools.find(t => t.name === 'aggregate_events')!.outputSchema, r.structuredContent)
        assert.deepEqual(bare(r), fenced(r))
    } finally { await c.close() }
})

test('structuredContent of every tool with an outputSchema validates for a normal answer and a job handle', async () => {
    const real = await connect((() => { const s = new McpServer({ name: 'real', version: '1' }); registerTools(s, undefined, caller); return s })())
    const schemas = new Map(real.tools.filter(t => t.outputSchema).map(t => [t.name, t]))
    await real.close()
    const fake = (runner?: InstanceType<typeof JobRunner>, who = caller.who) => {
        const s = new McpServer({ name: 'fake', version: '1' })
        installJobTools(s, wrapTools(s, true, { ...caller, who }, runner ? { runner, budgetMs: 1, work: () => ({ promise: new Promise(() => {}) }) } : { work: (_n, _a, _w, execute) => ({ promise: execute() }) }))
        const marker = (name: string) => name === 'resolve_client' ? ROWS_OUTPUT : name === 'find_task' ? CANDIDATES_OUTPUT : ANALYSIS_OUTPUT
        for (const [name, t] of schemas) s.registerTool(name, { inputSchema: { when: z.string().optional() }, outputSchema: marker(name), annotations: t.annotations }, async () => jsonResult(`${name}:`, value(name)))
        return s
    }
    clearToolAnswers()
    const normal = await connect(fake())
    try {
        for (const [name, t] of schemas) {
            const r = await normal.client.callTool({ name, arguments: {} }) as Result
            assert.ok(!r.isError, `${name}: ${JSON.stringify(r).slice(0, 400)}`)
            conforms(t.outputSchema, r.structuredContent); assert.deepEqual(bare(r), fenced(r), name)
            if (ANALYSIS_SCHEMA_TOOLS.has(name)) { assert.ok(r.structuredContent!.window && r.structuredContent!.coverage, name) }
            if (DETAIL_TOOLS.has(name)) {
                const concise = await normal.client.callTool({ name, arguments: { detail: 'concise' } }) as Result
                conforms(t.outputSchema, concise.structuredContent); assert.deepEqual(bare(concise), fenced(concise), name)
            }
        }
    } finally { await normal.close() }
    const m = new DatabaseSync(':memory:'), runner = new JobRunner(m, { concurrency: 1 })
    try {
        let handles = 0
        for (const [name, t] of schemas) {
            if (!t.annotations?.readOnlyHint || FAST_TOOLS.has(name)) continue
            // One person per tool (each may hold four outstanding jobs). With one runner slot, every job after
            // the first waits in the runner's queue, so both started and waiting handles are covered.
            const jobs = await connect(fake(runner, `handle-${name}`))
            try {
                const r = await jobs.client.callTool({ name, arguments: {} }) as Result
                assert.equal(r.content.length, 1, 'a handle is one text block, unchanged')
                assert.equal(r.structuredContent?.status, 'running', `${name}: ${JSON.stringify(r).slice(0, 600)}`); assert.match(String(r.structuredContent?.job_id), /^[0-9a-f]{32}$/)
                conforms(t.outputSchema, r.structuredContent); assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text)); handles++
                const poll = await jobs.client.callTool({ name: 'get_job_result', arguments: { job_id: r.structuredContent!.job_id } }) as Result
                assert.equal(poll.structuredContent?.status, 'running')
            } finally { await jobs.close() }
        }
        assert.ok(handles >= 20, `job handles checked: ${handles}`)
    } finally { runner.close(); m.close() }
})

test('a masked email, amount and client codename are masked identically in text and structuredContent', async () => {
    A.setAnonymise({ mode: 'private', lens: true })
    try {
        const s = new McpServer({ name: 'privacy', version: '1' })
        wrapTools(s, false, caller, { work: (_n, _a, _w, execute) => ({ promise: execute() }) })
        const payload = { clients: [{ client: 'QZX901', client_name: 'Zorblax Treasury', note: 'ben.okafor@brightwater.example asked about 250000', examples: [{ text: 'Zorblax Treasury notional 250000' }] }] }
        s.registerTool('top_pains', { inputSchema: { when: z.string().optional() }, annotations: { readOnlyHint: true } }, async () => jsonResult('Pains for Zorblax Treasury:', payload))
        s.registerTool('resolve_client', { inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } }, async () => jsonResult('Matches:', [{ id: 'QZX901', name: 'Zorblax Treasury', email: 'ben.okafor@brightwater.example' }]))
        const c = await connect(s)
        try {
            const codename = A.codenameOf('QZX901')!
            for (const [name, args] of [['top_pains', {}], ['top_pains', { detail: 'concise' }], ['resolve_client', { query: 'x' }]] as const) {
                clearToolAnswers()
                const r = await c.client.callTool({ name, arguments: args }) as Result
                assert.ok(!r.isError, JSON.stringify(r))
                const text = r.content[0].text, structured = JSON.stringify(r.structuredContent)
                for (const leak of [/QZX901/i, /Zorblax/i, /ben\.okafor/, /brightwater/, /250000/]) { assert.doesNotMatch(text, leak); assert.doesNotMatch(structured, leak) }
                assert.ok(text.includes(codename) && structured.includes(codename), `${name}: codename in both`)
                if (name === 'top_pains') { assert.match(text, /<amount>/); assert.match(structured, /<amount>/); assert.match(text, /\[person\]/); assert.match(structured, /\[person\]/) }
                assert.deepEqual(bare(r), name === 'resolve_client' ? { rows: fenced(r) } : fenced(r))
                // The HTTP/stdio transport guard walks the whole message, structuredContent included.
                const guarded = guardResponse(r)
                assert.deepEqual(bare(guarded), name === 'resolve_client' ? { rows: fenced(guarded) } : fenced(guarded))
            }
        } finally { await c.close() }
    } finally { A.setAnonymise({ mode: 'standard' }) }
})

test('detail=concise is smaller, keeps window, coverage and headline numbers, and counts what it omitted', async () => {
    const s = new McpServer({ name: 'concise', version: '1' })
    wrapTools(s, true, caller, { work: (_n, _a, _w, execute) => ({ promise: execute() }) })
    for (const name of Object.keys(FIXTURES)) s.registerTool(name, { inputSchema: { when: z.string().optional() }, annotations: { readOnlyHint: true } }, async () => jsonResult(`${name}:`, FIXTURES[name]()))
    const day = (offset: number) => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10)
    const counts = { attempts: 10, done: 8, failed: 1, abandoned: 1, users: 2, median_s: 60, p90_s: 100 }
    const task = { task_id: 't_Hedge', name: 'Book a hedge', dialog: 'Hedge', attempts_90d: 100, clients_90d: 3 }
    registerDashboardTools(s, { who: 'pm@x.com', email: 'pm@x.com', dashboardRole: 'share', surveyRole: 'launch', admin: true, insights: true }, {
        ingestStatus: () => ({ days_done: 28, first_day: '2026-01-01', last_day: '2026-02-01', behind_days: 0, attempts: 100, last_run: null, last_error: null, running: false }),
        findTasks: () => [task],
        flowTime: async (p) => ({ coverage: { complete: true, unprocessed: [] }, params: { ...p, granularity: 'day' as const }, task, summary: { ...counts, done_rate: .8 }, all_clients: { median_s: 30, p90_s: 70, done_rate: .9 },
            series: Array.from({ length: 90 }, (_, i) => ({ period: day(i), median_s: 50 + i, p90_s: 90, attempts: 10 })), series_all: [],
            paths: Array.from({ length: 14 }, (_, i) => ({ path: ['Hedge', `Step ${i}`, 'Done'], share: .07, median_s: 60, examples: [example(i)] })), slowest: [], top_errors: Array.from({ length: 12 }, (_, i) => ({ text: `Error ${i}`, count: 12 - i })),
            data_through: '2026-03-31', note: 'Fixture.' }) as never,
    })
    clearToolAnswers()
    const c = await connect(s)
    const rows: string[] = []
    try {
        for (const [name, args] of [...Object.keys(FIXTURES).map(n => [n, {}] as const), ['flow_time', { task: 'hedge', period: 'last_90_days' }] as const]) {
            const full = await c.client.callTool({ name, arguments: args }) as Result
            const concise = await c.client.callTool({ name, arguments: { ...args, detail: 'concise' } }) as Result
            const explicit = await c.client.callTool({ name, arguments: { ...args, detail: 'full' } }) as Result
            assert.ok(!full.isError && !concise.isError, JSON.stringify(concise).slice(0, 400))
            const stamp = (s: string) => s.replace(/"computed_at":"[^"]+"/g, '"computed_at":"T"')
            assert.equal(stamp(explicit.content[0].text), stamp(full.content[0].text), `${name}: full is the default`)
            const f = full.content[0].text.length, k = concise.content[0].text.length
            rows.push(`${name}: ${f} -> ${k} chars (${Math.round(100 * k / f)}%)`)
            assert.ok(k < f * 0.8, `${name}: ${k} vs ${f}`)
            const sc = concise.structuredContent!
            assert.equal(sc.detail, 'concise'); assert.deepEqual(sc.window, full.structuredContent!.window); assert.deepEqual(JSON.parse(stamp(JSON.stringify(sc.coverage))), JSON.parse(stamp(JSON.stringify(full.structuredContent!.coverage))))
            assert.deepEqual(sc.limits, full.structuredContent!.limits)
            const omitted = sc.omitted as Record<string, number>
            assert.ok(Object.keys(omitted).length && Object.values(omitted).every(n => Number.isInteger(n) && n > 0), `${name}: ${JSON.stringify(omitted)}`)
            // Headline numbers are unchanged; every list holds at most 10 rows.
            for (const [key, v] of Object.entries(full.structuredContent!)) if (typeof v === 'number' || typeof v === 'string') assert.equal(sc[key], v, `${name}.${key}`)
            const lists = (v: unknown): number[] => Array.isArray(v) ? [v.length, ...v.flatMap(lists)] : v && typeof v === 'object' ? Object.entries(v).filter(([key]) => !['coverage', 'limits'].includes(key)).flatMap(([, x]) => lists(x)) : []
            assert.ok(Math.max(0, ...lists(sc)) <= 10, name)
        }
        const df = (await c.client.callTool({ name: 'dialog_friction', arguments: { detail: 'concise' } }) as Result).structuredContent!
        assert.equal(df.total_attempts, 4120)
        assert.equal(df.omitted_rows_by_path, undefined, 'fixture stays under the size cap')
        assert.deepEqual(df.omitted, { dialogs: 2, 'dialogs[].errors': 10, 'dialogs[].errors[].example': 30, 'dialogs[].clients_with_errors': 70, 'dialogs[].stuck_sessions': 10, 'dialogs[].stuck_sessions[].replay_url': 30, 'dialogs[].daily': 70 })
        assert.equal((df.dialogs as { clients_with_errors_count: number }[])[0].clients_with_errors_count, 42)
        console.log(rows.join('\n'))
    } finally { await c.close() }
})
