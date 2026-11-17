import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RawEvent, Step } from '../src/core/appevents.ts'
const dir = mkdtempSync(join(tmpdir(), 'lens-analysis-'))
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.POSTHOG_PROJECT_ID = 'test'
process.env.POSTHOG_PERSONAL_API_KEY = 'test'
const { required, toSteps, frictionByDialog, dialogFriction, clientSignalsReport } = await import('../src/core/appevents.ts')
const { storeAttempts, tasksDb, forgetAnswers } = await import('../src/core/tasks.ts')
const { historyFriction, historyDiscovery, historyCompletion, analysisCoverage, completeDayWindow } = await import('../src/core/analysishistory.ts')
const { discoverWorkflowChains, workflowCompletion, validateWorkflow } = await import('../src/core/workflows.ts')
const { discoverWorkflows, workflowCompletionReport, completionWorkflow } = await import('../src/core/workflowqueries.ts')
const { liveEvents } = await import('../src/core/liveevents.ts')
const reg = required(), DAY = 86400000
const from = new Date('2026-10-10'), to = new Date('2026-10-12'), q = { from, to }
const def = validateWorkflow({ name: 'A to B', dialogs: ['DlgA', 'DlgB'], done: { dialog: 'DlgB', outcome: 'either' } })
after(() => { tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })
function session(day: string, sid: string, client: string, duration = 5) {
    const raw = (s: number, dialog: string, event = reg.events.screen, extra: Partial<RawEvent> = {}): RawEvent => ({ sid, client, user: `${client}|same-person`,
        ts: new Date(Date.parse(day) + 36000000 + s * 1000).toISOString(), dialog, event, action: 'OPEN', ...extra })
    return toSteps([raw(0, 'DlgA'), raw(1, 'DlgB'), raw(2, 'DlgB', reg.events.interaction, { button: 'Save' }),
        raw(3, 'messagebox', reg.events.interaction, { button: '["Invalid date"]' }), raw(4, 'DlgB', reg.events.interaction, { button: 'Save' }),
        raw(duration, 'toast', reg.events.interaction, { button: '["Trade Id 4348 Updated"]' })], reg)
}
function put(day: string, sessions: Step[][]) { storeAttempts(day, [], { finalized: true, analysisSessions: sessions, sessions: sessions.length }) }
function opens(sessions: Step[][]) {
    const result = new Map<string, { opens: number }>()
    for (const ss of sessions) for (const s of ss) if (s.kind === 'open') result.set(s.dialog, { opens: (result.get(s.dialog)?.opens || 0) + 1 })
    return result
}

test('multi-day history equals full-session friction, discovery and completion beyond both old caps', async (t) => {
    put('2026-10-07', []); put('2026-10-08', []); put('2026-10-09', [])
    const all: Step[][] = []
    for (const day of ['2026-10-10', '2026-10-11']) {
        const ss = Array.from({ length: 6001 }, (_, i) => session(day, `${day}-${i}`, i < 3000 ? 'X' : 'Y', 5 + i % 20))
        put(day, ss); all.push(...ss)
    }
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('History must not fetch events') })
    assert.equal(analysisCoverage(q, true).complete, true)
    assert.deepEqual(historyFriction(q), frictionByDialog(all, reg, opens(all)))
    assert.deepEqual(historyDiscovery(q), discoverWorkflowChains(all, reg, { window: q }))
    assert.deepEqual(historyCompletion(q, def), workflowCompletion(all, def, reg, q))
    const f = await dialogFriction(q), d = await discoverWorkflows(q), c = await workflowCompletionReport({ ...q, definition: def })
    assert.equal(f.source, 'history'); assert.equal(d.source, 'history'); assert.equal(c.source, 'history')
    assert.equal(f.dialogs.find((x) => x.dialog === 'DlgB')!.attempts, 24004)
    assert.equal(d.discovered[0].sessions, 12002)
    assert.equal(d.discovered[0].users, 2)
    assert.equal(c.overall.now.started, 12002)
    assert.equal(c.overall.now.done, 12002)
    // No independent history answer cache survives replacement or forgetAnswers.
    put('2026-10-11', []); forgetAnswers()
    assert.equal(historyDiscovery(q)![0].sessions, 6001)
})

test('analysis day replacement rolls back atomically and old task coverage does not imply new-table coverage', () => {
    put('2026-09-01', [session('2026-09-01', 'original', 'X')])
    const w = { from: new Date('2026-09-01'), to: new Date('2026-09-02') }
    const before = historyFriction(w)
    assert.throws(() => storeAttempts('2026-09-01', [], { finalized: true, analysisSessions: [], summary: {
        ops: [{ day: 'wrong-day', client: 'X', dialog: 'DlgA', op: 'Save', family: 'productive', submits: 1, completed: 1, accepted: 0, errors: 0, empty: 0 }],
        errors: [], users: [], clients: [],
    } }), /stored day/)
    assert.deepEqual(historyFriction(w), before)
    storeAttempts('2026-09-01', [], { finalized: true })
    assert.equal(analysisCoverage(w).complete, false)
    assert.equal(historyFriction(w), undefined)
})

test('support and containment run across days, not independently per day', () => {
    const a = session('2026-09-10', 'one', 'X'), b = session('2026-09-11', 'two', 'X')
    put('2026-09-09', []); put('2026-09-10', [a]); put('2026-09-11', [b])
    assert.equal(discoverWorkflowChains([a], reg).length, 0)
    const w = { from: new Date('2026-09-10'), to: new Date('2026-09-12') }
    assert.deepEqual(historyDiscovery(w), discoverWorkflowChains([a, b], reg, { window: w }))
})

test('compact episodes retain field-bridged activity and cross-midnight starts', () => {
    const ss = session('2026-09-20', 'bridge', 'X', 1200)
    // Fields keep this episode alive between the retry and reply; deleting them must not re-split it.
    const fields = [400, 800].map((n) => ({ ...ss[0], i: 4 + n, kind: 'field' as const, ts: new Date(Date.parse(ss[0].ts) + n * 1000).toISOString() }))
    ss.at(-1)!.i = 2000
    ss.splice(5, 0, ...fields)
    put('2026-09-19', []); put('2026-09-20', [ss])
    const w = { from: new Date('2026-09-20'), to: new Date('2026-09-21') }
    assert.deepEqual(historyCompletion(w, def), workflowCompletion([ss], def, reg, w))
    const cross = session('2026-09-21', 'cross', 'X')
    // Owned by previous-day ingestion, but this workflow starts after midnight.
    put('2026-09-20', [cross]); put('2026-09-21', [])
    const cw = { from: new Date('2026-09-21'), to: new Date('2026-09-22') }
    assert.deepEqual(historyCompletion(cw, def), workflowCompletion([cross], def, reg, cw))
})

const response = (rows: Record<string, unknown>[]) => { const columns = [...new Set(rows.flatMap(Object.keys))]; return new Response(JSON.stringify({ columns, results: rows.map((r) => columns.map((c) => r[c])) }), { status: 200 }) }
test('live fallback reads every timestamp/uuid page with no population cap', async (t) => {
    const rows = Array.from({ length: 60005 }, (_, i) => ({ sid: `s${String(i).padStart(8, '0')}`, ts: from.toISOString(), event: reg.events.screen,
        dialog: 'DlgA', action: 'OPEN', event_uuid: String(i) }))
    let page = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { query, values } = JSON.parse(String(init.body)).query
        assert.match(query, /timestamp >= \{from\} AND timestamp < \{to\}/)
        if (query.startsWith('SELECT count()')) return response([{ n: rows.length }])
        assert.match(query, /cursor_sid/); assert.match(query, /toString\(uuid\)/)
        assert.doesNotMatch(query, /ORDER BY (?:sid, ts|last DESC)/)
        assert.equal(values.from, from.toISOString()); assert.equal(values.to, to.toISOString())
        return response(rows.slice(page++ * 10000, page * 10000))
    })
    assert.equal((await liveEvents(q)).length, rows.length)
    assert.equal(page, 7)
})

test('observed titles resolve from history, and complete live friction totals exceed 50k rows', async (t) => {
    const ss = ['one', 'two'].map((id) => session('2026-08-20', id, 'X'))
    for (const s of ss.flat()) if (s.kind === 'open') s.name = s.dialog === 'DlgA' ? 'Start task' : 'Finish task'
    put('2026-08-19', []); put('2026-08-20', ss)
    const w = { from: new Date('2026-08-20'), to: new Date('2026-08-21') }
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('Names should use history') })
    assert.deepEqual((await completionWorkflow({ ...w, dialogs: ['Start task', 'Finish task'] })).dialogs, ['DlgA', 'DlgB'])
    const names = new Map([['DlgA', 'Start task'], ['DlgB', 'Finish task']])
    assert.deepEqual(historyDiscovery(w), discoverWorkflowChains(ss, reg, { window: w, names }))
    assert.deepEqual(historyCompletion(w, def), workflowCompletion(ss, def, reg, w, names))
    const rows = Array.from({ length: 60005 }, (_, i) => ({ sid: `session${i}`, ts: '2026-08-25T12:00:00Z', event: reg.events.screen,
        dialog: 'DlgA', action: 'OPEN', event_uuid: String(i) }))
    let n = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => String(JSON.parse(String(init.body)).query.query).startsWith('SELECT count()')
        ? response([{ n: rows.length }]) : response(rows.slice(n++ * 10000, n * 10000)))
    const r = await dialogFriction({ from: new Date('2026-08-25'), to: new Date('2026-08-26') })
    assert.equal(r.source, 'live'); assert.equal(r.truncated, false)
    assert.equal(r.dialogs[0].opens, rows.length); assert.equal(r.dialogs[0].sessions, rows.length)
})

test('unprocessed, partial-day and truncated days cannot masquerade as history; relative windows align', () => {
    const today = new Date().toISOString().slice(0, 10)
    put(today, [])
    assert.equal(analysisCoverage({ from: new Date(today), to: new Date(+new Date(today) + DAY) }).complete, false)
    assert.equal(analysisCoverage({ from: new Date(+from + 1), to }).complete, false)
    storeAttempts('2026-08-01', [], { analysisSessions: [], truncated: true, finalized: true })
    assert.equal(analysisCoverage({ from: new Date('2026-08-01'), to: new Date('2026-08-02') }).complete, false)
    const aligned = completeDayWindow(q, 'last 2 days')
    assert.equal(+aligned.from % DAY, 0); assert.equal(+aligned.to % DAY, 0)
    assert.equal(+aligned.to - +aligned.from, 2 * DAY)
    assert.deepEqual(completeDayWindow(q, 'today'), q)
})

test('client counts and disappeared-user counts are exact while identities are bounded examples', async (t) => {
    const seen: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body)).query; seen.push(query)
        if (query.includes('quiet_count')) return response([{ client: 'X', quiet_count: 550, quiet_users: ['X|example'] }])
        return response([{ client: 'X', last_seen: from.toISOString(), n_sessions: 10, b_sessions: 20, n_user_count: 50, b_user_count: 600 }])
    })
    const r = await clientSignalsReport({ from: new Date('2026-06-01'), to: new Date('2026-06-03') })
    assert.equal(r.clients[0].now.user_count, 50); assert.equal(r.clients[0].before.user_count, 600)
    assert.equal(r.clients[0].quiet_user_count, 550); assert.deepEqual(r.clients[0].quiet_users, ['example'])
    assert.match(r.clients[0].signals.join(' '), /550 of 600/)
    assert.match(seen[0], /uniqExactIf/); assert.doesNotMatch(seen.join(' '), /\buniq(?:If)?\(|groupUniqArrayIf\(500\)/)
})

// Every direct HogQL call is audited, including calls inside Promise.all (not only `await hogql`).
test('all remaining core HogQL calls have a timestamp scope or a documented session lookup', () => {
    const inherited: Record<string, string> = { 'impact.ts': 'base has timestamp; failure-rate query has its own bound', 'usage.ts': 'scope has timestamp', 'aggregate.ts': 'scope has timestamp' }
    for (const file of readdirSync('src/core').filter((f) => f.endsWith('.ts'))) {
        const source = readFileSync(`src/core/${file}`, 'utf8')
        for (const m of source.matchAll(/(?:await\s+)?(?:deps\.)?hogql\(\s*`([\s\S]*?)`/g)) {
            const query = m[1]
            if (/timestamp\s*(?:>=|>|<|<=)/i.test(query)) continue
            if (file === 'incidents.ts' && query.includes('raw_session_replay_events')) {
                assert.match(source, /Query audit exception: replay metadata keyed by explicit session ids/); continue
            }
            if (file === 'recording-info.ts') {
                assert.match(source, /Session-scoped: server-time bounds would discard moments/);
                assert.match(query, /properties\.\$session_id.*\{sid\}/); assert.match(query, /LIMIT 500/); continue
            }
            assert.ok(inherited[file] && /\$\{(?:base|scope)\}/.test(query), `${file}: query needs a timestamp bound or audit reason: ${query}`)
        }
    }
})

test('indexed containment equals the prior pairwise Set-support function on generated repeated and bounded episodes', async () => {
    const { discoveryCandidates, finishDiscovery } = await import('../src/core/workflows.ts')
    let state = 17
    const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296)
    const all: Step[][] = []
    for (const date of ['2026-07-10', '2026-07-11', '2026-07-12']) {
        const ss: Step[][] = []
        for (let n = 0; n < 80; n++) {
            const steps: Step[] = []
            const seed = session(date, `${date}-${n}`, n % 2 ? 'X' : 'Y')
            for (let k = 0; k < 15; k++) {
                const d = `Dlg${'ABC'[Math.floor(random() * 3)]}`
                const base = k * 8
                for (const original of seed) {
                    const s = structuredClone(original)
                    s.i = steps.length; s.ts = new Date(Date.parse(date) + 36000000 + (base + original.i) * 1000).toISOString()
                    s.raw.ts = s.ts; s.dialog = original.dialog === 'DlgA' ? d : original.dialog
                    if (s.cause !== undefined) s.cause += k * seed.length
                    steps.push(s)
                }
                if (k === 7) steps.push({ ...structuredClone(seed[0]), i: steps.length, kind: 'menu', ts: new Date(Date.parse(steps.at(-1)!.ts) + 1000).toISOString() })
            }
            ss.push(steps)
        }
        put(date, ss); all.push(...ss)
    }
    all.sort((a,b) => a[0].ts.slice(0,10).localeCompare(b[0].ts.slice(0,10)) || a[0].raw.client!.localeCompare(b[0].raw.client!) || a[0].raw.sid.localeCompare(b[0].raw.sid))
    put('2026-07-09', [])
    const w = { from: new Date('2026-07-10'), to: new Date('2026-07-13') }
    const candidates = discoveryCandidates(all, reg, { window: w }), frequent = candidates.filter((c) => c.sessions.size >= 2)
    const pairwise = frequent.filter((c) => !frequent.some((long) => long.dialogs.length > c.dialogs.length && long.sessions.size >= .8 * c.sessions.size && long.dialogs.some((_, i) => c.dialogs.every((d, j) => long.dialogs[i+j] === d))))
    assert.deepEqual(finishDiscovery(candidates, reg, { limit: Infinity }).map((c) => JSON.stringify(c.dialogs)).sort(), pairwise.map((c) => JSON.stringify(c.dialogs)).sort())
    assert.deepEqual(historyDiscovery(w, Infinity), discoverWorkflowChains(all, reg, { window: w, limit: Infinity }))
    assert.deepEqual(historyFriction(w), frictionByDialog(all, reg, opens(all)))
    for (const clientId of ['X','Y']) assert.deepEqual(historyDiscovery({ ...w, clientId }, Infinity), discoverWorkflowChains(all.filter((s) => s[0].raw.client === clientId), reg, { window: w, limit: Infinity }))
    for (const dialogs of [['DlgA', 'DlgB'], ['DlgA', 'DlgC', 'DlgB'], ['DlgB', 'DlgA', 'DlgB']]) {
        const definition = validateWorkflow({ name: 'Generated', dialogs, done: { dialog: dialogs.at(-1)!, outcome: 'either', buttons: ['Save'] } })
        assert.deepEqual(historyCompletion(w, definition), workflowCompletion(all, definition, reg, w))
    }
})

test('final-dialog submit qualification means support is not a universal subset of prefix support', async () => {
    const { discoveryCandidates } = await import('../src/core/workflows.ts')
    const s = session('2026-07-15', 'prefix', 'X')
    // A, C, B with a submit only on B: A,C,B qualifies; A,C does not.
    const c = { ...structuredClone(s[0]), i: 1, dialog: 'DlgC', ts: new Date(Date.parse(s[0].ts) + 500).toISOString() }
    for (const step of s.slice(1)) { step.i++; if (step.cause !== undefined) step.cause++ }
    s.splice(1, 0, c)
    const candidates = discoveryCandidates([s], reg)
    assert.ok(candidates.some((c) => c.dialogs.join(',') === 'DlgA,DlgC,DlgB'))
    assert.ok(!candidates.some((c) => c.dialogs.join(',') === 'DlgA,DlgC'))
})

test('cross-midnight repeated chains deduplicate support while fractional durations remain exact', () => {
    put('2026-07-19', [])
    const a = session('2026-07-20', 'cross-repeat', 'X'), b = session('2026-07-21', 'cross-repeat', 'X')
    for (const s of b) { s.i += a.length; if (s.cause !== undefined) s.cause += a.length; s.ts = new Date(Date.parse(s.ts) + 123).toISOString() }
    b.at(-1)!.ts = new Date(Date.parse(b.at(-1)!.ts) + 321).toISOString()
    const combined = [...a, ...b], second = session('2026-07-21', 'other-repeat', 'Y')
    put('2026-07-20', [combined]); put('2026-07-21', [second])
    const w = { from: new Date('2026-07-20'), to: new Date('2026-07-22') }
    assert.deepEqual(historyDiscovery(w), discoverWorkflowChains([combined, second], reg, { window: w }))
    assert.deepEqual(historyCompletion(w, def), workflowCompletion([combined, second], def, reg, w))
})

test('completion report caps clients with exact omitted totals and stays below 30k characters', async (t) => {
    put('2026-06-18', []); put('2026-06-19', []); put('2026-06-20', [])
    const ss = Array.from({ length: 150 }, (_, i) => session('2026-06-21', `capped-${i}`, `Client-${i}`))
    put('2026-06-21', ss)
    t.mock.method(globalThis, 'fetch', async () => response([]))
    const result = await workflowCompletionReport({ from: new Date('2026-06-21'), to: new Date('2026-06-22'), definition: def })
    assert.ok(result.clients.length <= 8)
    assert.equal(result.clients_rest.clients, 150 - result.clients.length)
    assert.equal(result.clients_rest.now.started + result.clients.reduce((n,c) => n + c.now.started, 0), 150)
    assert.equal(result.clients_rest.now.done + result.clients.reduce((n,c) => n + c.now.done, 0), 150)
    assert.ok(JSON.stringify(result).length < 30000)
})

test('discovery retains title fallback when a chain finishes outside its start window', () => {
    put('2026-06-24', [])
    const ss = ['outside-one','outside-two'].map((id) => session('2026-06-25', id, 'X'))
    for (const s of ss.flat()) {
        s.ts = new Date(Date.parse(s.ts) + 14*3600000 - 500).toISOString()
        if (s.kind === 'open') s.name = s.dialog === 'DlgA' ? 'Inside start' : 'Outside finish'
    }
    put('2026-06-25', ss)
    const w = { from: new Date('2026-06-25'), to: new Date('2026-06-26') }
    assert.deepEqual(historyDiscovery(w), discoverWorkflowChains(ss, reg, { window: w }))
})

test('a live window too large to read refuses with a way forward, before reading any events', async (t) => {
    const queries: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        const sql = String(JSON.parse(String(init.body)).query.query); queries.push(sql)
        return response([{ n: 5_000_000 }])
    })
    await assert.rejects(liveEvents({ from: new Date('2026-09-01'), to: new Date('2026-10-01') }), /5,000,000 events[\s\S]*Ask for a window ending on or before/)
    assert.equal(queries.length, 1)
    assert.match(queries[0], /SELECT count\(\) AS n FROM events WHERE timestamp >= \{from\} AND timestamp < \{to\}/)
})

test('vertical dialog index avoids unrelated payloads and backfills legacy episodes without changing results', async () => {
    const { brotliCompressSync,brotliDecompressSync } = await import('node:zlib')
    const { indexWorkflowDay } = await import('../src/core/analysishistory.ts')
    const owner='2026-05-10', window={from:new Date(owner),to:new Date('2026-05-11')}
    put('2026-05-09',[])
    const relevant=session(owner,'a','X')
    const unrelated=session(owner,'z','Y').map(s=>({...s,dialog:s.dialog==='DlgA'?'DlgZ':s.dialog==='DlgB'?'DlgQ':s.dialog}))
    put(owner,[relevant,unrelated])
    const expected=historyCompletion(window,def)
    const code=tasksDb.prepare("SELECT id FROM analysis_dictionary WHERE value='DlgZ'").get()!.id
    const original=tasksDb.prepare('SELECT value FROM workflow_episodes_daily WHERE day=? AND client=?').get(owner,'@dialog:'+code)!.value
    tasksDb.prepare('UPDATE workflow_episodes_daily SET value=? WHERE day=? AND client=?').run(Buffer.from('not a compressed blob'),owner,'@dialog:'+code)
    assert.deepEqual(historyCompletion(window,def),expected,'unrelated dialogs are never decompressed')
    tasksDb.prepare('UPDATE workflow_episodes_daily SET value=? WHERE day=? AND client=?').run(original,owner,'@dialog:'+code)
    const decode=(v:unknown)=>JSON.parse(brotliDecompressSync(v as Uint8Array).toString())
    const headers=decode(tasksDb.prepare("SELECT value FROM workflow_episodes_daily WHERE day=? AND client='@header'").get(owner)!.value) as [string,string,number,number][]
    const rows=new Map<number,(number|string)[][]>()
    for(const r of tasksDb.prepare("SELECT value FROM workflow_episodes_daily WHERE day=? AND client LIKE '@dialog:%'").all(owner))for(const [id,csv] of decode(r.value) as [number,string][]) {
        if(!rows.has(id))rows.set(id,[])
        rows.get(id)!.push(...csv.split(';').map(r=>r.split(',').map((v,i)=>i===2||i===4?v:Number(v))))
    }
    const groups=new Map<string,unknown[]>()
    headers.forEach(([client,sid,n,base],id)=>{if(!groups.has(client))groups.set(client,[]);groups.get(client)!.push([sid,n,[base,...rows.get(id)!.sort((a,b)=>Number(a[0])-Number(b[0]))]])})
    tasksDb.prepare('DELETE FROM workflow_episodes_daily WHERE day=?').run(owner)
    tasksDb.prepare('DELETE FROM workflow_episode_index_days WHERE day=?').run(owner)
    tasksDb.prepare('INSERT INTO workflow_episodes_daily VALUES (?,?,?)').run(owner,'',brotliCompressSync(Buffer.from(JSON.stringify([...groups]))))
    assert.deepEqual(historyCompletion(window,def),expected)
    indexWorkflowDay(owner)
    assert.deepEqual(historyCompletion(window,def),expected)
    assert.ok(tasksDb.prepare("SELECT 1 FROM workflow_episodes_daily WHERE day=? AND client='@header'").get(owner))
})


function rankedHistory() {
    const day = '2026-08-12', window = { from: new Date(day), to: new Date('2026-08-13') }
    const sessions = Array.from({ length: 16 }, (_, n) => [1, 2].map(i =>
        toSteps(session(day, `rank-${n}-${i}`, 'RANK').map(s => ({ ...s.raw,
            dialog: s.raw.dialog === 'DlgA' ? `DlgA${n}` : s.raw.dialog === 'DlgB' ? `DlgB${n}` : s.raw.dialog })), reg))).flat()
    put(day, sessions)
    return window
}

test('history discovery discloses ranking omissions before its response cap', async () => {
    const { analyticalResult } = await import('../src/mcp/historyresult.ts')
    const result = await discoverWorkflows(rankedHistory())
    assert.equal(result.source, 'history')
    assert.equal(result.total_workflows, 16)
    assert.equal(result.discovered.length, 15)
    assert.equal(result.truncated, true)
    assert.equal(result.limits.returned_rows, 15)
    assert.equal(result.limits.omitted_rows, 1)
    const output = analyticalResult('discover_workflows', {}, { _lensJson: { label: 'Workflows', value: result } }) as any
    assert.equal(output._lensJson.value.limits.omitted_rows, 1)
})

test('top pains discloses ranking omissions before its response cap', async (t) => {
    const { topPains } = await import('../src/core/appevents.ts')
    const { analyticalResult } = await import('../src/mcp/historyresult.ts')
    const window = rankedHistory()
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ columns: [], results: [] })))
    const result = await topPains({ ...window, compare: 'none', max: 5 })
    assert.equal(result.source, 'history')
    assert.equal(result.total_pains, 16)
    assert.equal(result.pains.length, 5)
    assert.equal(result.truncated, true)
    assert.equal(result.limits!.returned_rows, 5)
    assert.equal(result.limits!.omitted_rows, 11)
    const output = analyticalResult('top_pains', {}, { _lensJson: { label: 'Pains', value: result } }) as any
    assert.equal(output._lensJson.value.limits.omitted_rows, 11)
    const all = await topPains({ ...window, compare: 'none', max: 50 })
    assert.equal(all.limits!.omitted_rows, 0)
    assert.equal(all.truncated, false)
})
