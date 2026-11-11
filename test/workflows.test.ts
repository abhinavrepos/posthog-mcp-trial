// Made-up Reval-shaped sessions; no recorded or customer data.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-workflows-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.POSTHOG_PROJECT_ID = 'test-project'
process.env.POSTHOG_PERSONAL_API_KEY = 'test-key'
const { clearPosthogCache } = await import('../src/core/posthog.ts')
beforeEach(() => clearPosthogCache())
const { db } = await import('../src/core/db.ts')
const { parseAppEvents, toSteps } = await import('../src/core/appevents.ts')
const { discoverWorkflowChains, workflowEpisodes, workflowCompletion, validateWorkflow, workflowId, workflowDialogsFromId } = await import('../src/core/workflows.ts')
const { resolveWorkflowDialogs, completionWorkflow, workflowCompletionReport, workflowSessions, discoverWorkflows } = await import('../src/core/workflowqueries.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
type RawEvent = import('../src/core/appevents.ts').RawEvent
type E = Partial<RawEvent> & { s: number }
const T0 = Date.parse('2026-11-05T10:00:00Z')
const session = (sid: string, client: string, list: E[]) => list.map(({ s, ...e }) => ({ sid, client, user: `${client}|USER1`, ts: new Date(T0 + s * 1000).toISOString(), event: 'Event', dialog: '', ...e }))
const steps = (sid: string, client: string, list: E[]) => toSteps(session(sid, client, list), reg)
const open = (s: number, dialog: string, dialogName = dialog): E => ({ s, event: 'PageView', dialog, dialogName, action: 'OPEN' })
const press = (s: number, dialog: string, button = 'Save'): E => ({ s, dialog, button })
const message = (s: number, text = 'Please select Trade Type'): E => ({ s, dialog: 'messagebox', button: JSON.stringify([text]) })
const notice = (s: number, text = 'Trade Id 4348 Updated'): E => ({ s, dialog: 'toast', button: JSON.stringify([text]) })
const menu = (s: number): E => ({ s, dialog: 'menuCmb', control: 'MENU', action: 'Trades' })
const workflow = validateWorkflow({ name: 'Import a swap', dialogs: ['A', 'B', 'C'], done: { dialog: 'C', outcome: 'completed' } })
const win = { from: new Date(T0), to: new Date(T0 + 1000_000) }

describe('workflow discovery', () => {
    test('finds a planted chain across sessions, names it, ignores UI noise and reports support/outcomes/errors', () => {
        const planted = [0, 1, 2, 3].map((i) => steps(`s${i}`, i < 2 ? 'RQA' : 'C26', [menu(0), open(1, 'A', 'Import'), open(2, 'A'), open(3, 'menuCmb'), open(4, 'toast'), open(5, 'B', 'Trade Import Status'), message(6, 'No trades found for search text: PRIVATE SEARCH'), open(7, 'C', 'IR Swap'),
            press(8, 'C'), message(9), press(10, 'C'), notice(11, i === 3 ? 'The report has been scheduled' : 'Trade Id 4348 Updated')]))
        const noise = steps('noise', 'OTHER', [open(0, 'X'), open(1, 'Y'), menu(2), open(3, 'Z'), press(4, 'Z'), notice(5)])
        const found = discoverWorkflowChains([...planted, noise], reg)
        assert.equal(found.length, 1)
        const c = found[0]
        assert.equal(c.name, "Import → Trade Import Status → IR Swap → Save → 'Trade Id … Updated'")
        assert.equal(c.id, workflowId(['A', 'B', 'C']))
        assert.deepEqual(c.dialogs, ['A', 'B', 'C'])
        assert.deepEqual([c.sessions, c.clients, c.users, c.occurrences, c.done, c.completed, c.accepted, c.score], [4, 2, 2, 4, 4, 3, 1, 8])
        assert.equal(c.median_time_s, 10)
        assert.equal(c.p90_time_s, 10)
        assert.deepEqual(c.top_error, { text: 'Please select Trade Type', template: 'Please select Trade Type', count: 4 })
    })
    test('session support is distinct, not repeated episodes; no submit means no candidate', () => {
        const repeated = steps('same', 'X', [open(0, 'A'), open(1, 'B'), press(2, 'B'), notice(3), menu(4), open(5, 'A'), open(6, 'B'), press(7, 'B'), notice(8)])
        assert.deepEqual(discoverWorkflowChains([repeated], reg), [])
        assert.deepEqual(discoverWorkflowChains([steps('1', 'X', [open(0, 'A'), open(1, 'B')]), steps('2', 'X', [open(0, 'A'), open(1, 'B')])], reg), [])
    })
    test('containment removes a short chain at 80% support, but keeps it below 80%', () => {
        const mine = (long: number) => discoverWorkflowChains(Array.from({ length: 5 }, (_, i) => steps(`s${i}`, 'X', [
            ...(i < long ? [open(0, 'A')] : []), open(1, 'B'), open(2, 'C'), press(3, 'C'), notice(4)])), reg)
        assert.deepEqual(mine(4).map((c) => c.dialogs), [['A', 'B', 'C']])
        assert.deepEqual(mine(3).map((c) => c.dialogs), [['B', 'C'], ['A', 'B', 'C']])
    })
    test('collapses consecutive opens only; keeps a return to a previous dialog; caps chains at four', () => {
        const all = [1, 2].map((i) => steps(`${i}`, 'X', [open(0, 'A'), open(1, 'A'), open(2, 'B'), open(3, 'A'), open(4, 'C'), open(5, 'D'), press(6, 'D'), notice(7)]))
        assert.deepEqual(discoverWorkflowChains(all, reg).map((c) => c.dialogs), [['B', 'A', 'C', 'D']])
    })
    test('rank uses sessions times clients and limit follows ranking', () => {
        const all = [0, 1, 2].flatMap((i) => [steps(`a${i}`, 'X', [open(0, 'A'), open(1, 'B'), press(2, 'B'), notice(3)]),
            steps(`c${i}`, `${i}`, [open(0, 'C'), open(1, 'D'), press(2, 'D'), notice(3)])])
        assert.deepEqual(discoverWorkflowChains(all, reg, { limit: 1 })[0].dialogs, ['C', 'D'])
    })
    test('identity survives renamed dialogs and success messages; failures alone have no success suffix', () => {
        const mine = (title: string, result?: string) => discoverWorkflowChains([1, 2].map((i) => steps(`s${i}`, 'X', [
            open(0, 'A', title), open(1, 'B', 'Hedge Designation'), press(2, 'B'), result ? notice(3, result) : message(3)])), reg)[0]
        const before = mine('Search', 'Link Id 3508 Added'), after = mine('Trades', 'Trade Id 4348 Updated')
        assert.equal(before.id, after.id)
        assert.notEqual(before.name, after.name)
        assert.equal(before.name, "Search → Hedge Designation → Save → 'Link Id … Added'")
        const failed = mine('Search')
        assert.equal(failed.name, 'Search → Hedge Designation')
        assert.equal(failed.id, before.id)
        assert.equal(failed.done, 0)
    })
})

describe('episode boundaries', () => {
    test('search/menu and exactly ten minutes idle split; fields do not', () => {
        const all = steps('s', 'X', [open(0, 'A'), { s: 1, dialog: 'A', control: 'TEXTFIELD', action: 'Trade Id' }, open(600, 'B'), open(1200, 'C'), menu(1201), open(1202, 'D'), { s: 1203, dialog: 'menuCmb', control: 'SEARCH', action: 'PRIVATE SEARCH' }, open(1204, 'E')])
        assert.deepEqual(workflowEpisodes([all], reg).map((ep) => ep.opens.map((s) => s.dialog)), [['A', 'B'], ['C'], ['D'], ['E']])
    })
    test('a reply outside the episode cannot complete its previous submit', () => {
        const all = steps('s', 'X', [open(0, 'A'), open(1, 'B'), open(2, 'C'), press(3, 'C'), open(603, 'X'), notice(604)])
        const metrics = workflowCompletion([all], workflow, reg).overall
        assert.equal(metrics.done, 0)
        assert.equal(metrics.abandoned, 1)
    })
})

const completed = steps('done', 'RQA', [open(0, 'A'), open(1, 'A'), open(2, 'B'), open(3, 'C'), press(4, 'C'), message(5), press(8, 'C'), notice(10), press(12, 'C'), message(13)])
const abandoned = steps('lost', 'RQA', [open(20, 'A'), open(22, 'B'), press(24, 'B'), message(25), press(27, 'B'), message(28)])
const queued = steps('queued', 'C26', [open(30, 'A'), open(31, 'X'), open(32, 'B'), open(33, 'C'), press(34, 'C'), notice(35, 'The async report has been scheduled')])
const early = steps('early', 'C26', [open(40, 'B'), open(41, 'A'), open(42, 'C'), press(43, 'C'), notice(44)])

describe('workflow completion', () => {
    test('counts episodes, ordered funnel, failures, retries, time and abandonment per client and overall', () => {
        const r = workflowCompletion([completed, abandoned, queued, early], workflow, reg, win)
        const m = r.overall
        assert.equal(m.started, 4)
        assert.deepEqual(m.steps.map((s) => s.reached), [4, 3, 2])
        assert.deepEqual([m.done, m.abandoned, m.failed_attempts, m.retries], [1, 3, 3, 2])
        assert.deepEqual([m.completed, m.accepted, m.median_time_s, m.p90_time_s], [1, 1, 10, 10])
        assert.equal(m.completion_rate, 0.25)
        assert.equal(m.biggest_drop?.dialog, 'A') // three equal drops: earliest step wins
        assert.equal(m.examples.length, 3)
        assert.deepEqual(r.clients.map((c) => [c.client, c.started, c.done]), [['C26', 2, 0], ['RQA', 2, 1]])
    })
    test('queued is not completed; accepted and either definitions explicitly allow it', () => {
        for (const [outcome, done] of [['completed', 1], ['accepted', 1], ['either', 2]] as const) {
            assert.equal(workflowCompletion([completed, queued], { ...workflow, done: { dialog: 'C', outcome } }, reg).overall.done, done)
        }
        const single = workflowCompletion([queued], workflow, reg).overall
        assert.equal(single.done, 0)
        assert.equal(single.accepted, 1)
        assert.equal(single.median_time_s, null)
    })
    test('button restriction, episode reset and first-open cohort/window edges', () => {
        const all = steps('s', 'X', [open(-10, 'A'), open(0, 'A'), open(1, 'B'), open(2, 'C'), press(3, 'C'), notice(4), menu(10), open(11, 'A'), open(12, 'B'), open(13, 'C'), press(14, 'C'), notice(15)])
        const m = workflowCompletion([all], workflow, reg, { from: new Date(T0), to: new Date(T0 + 12000) }).overall
        assert.deepEqual([m.started, m.done, m.median_time_s], [1, 1, 4]) // finishes after the window
        assert.equal(workflowCompletion([completed], { ...workflow, done: { dialog: 'C', buttons: ['Run'], outcome: 'completed' } }, reg).overall.done, 0)
        assert.equal(workflowCompletion([completed], { ...workflow, done: { dialog: 'C', buttons: ['save'], outcome: 'completed' } }, reg).overall.done, 1)
    })
    test('top error belongs to the largest abandoned step; errors grouped without trade ids', () => {
        const a = [1, 2].map((i) => steps(`${i}`, 'X', [open(0, 'A'), open(1, 'B'), press(2, 'B'), message(3, `Trade Id ${4000 + i} cannot be saved`)]))
        const m = workflowCompletion([...a, early], workflow, reg).overall
        assert.deepEqual(m.biggest_drop, { dialog: 'B', name: 'B', abandoned: 2, top_error: { text: 'Trade Id 4001 cannot be saved', template: 'Trade Id # cannot be saved', count: 2 } })
        assert.ok(!JSON.stringify(m).includes('PRIVATE SEARCH'))
    })
    test('multiple episodes in a session are separate starts, examples are up to 3 distinct sessions', () => {
        const s = steps('s', 'X', [open(0, 'A'), menu(1), open(2, 'A')])
        assert.equal(workflowCompletion([s], workflow, reg).overall.started, 2)
        assert.equal(workflowCompletion([s], workflow, reg).overall.examples.length, 1)
    })
    test('durations use the outcome timestamp, conventional median and nearest-rank p90', () => {
        const all = [5, 10, 20, 40].map((seconds, i) => steps(`time${i}`, 'X', [open(0, 'A'), open(1, 'B'), open(2, 'C'), press(seconds - 1, 'C'), notice(seconds)]))
        const m = workflowCompletion(all, workflow, reg).overall
        assert.equal(m.median_time_s, 15)
        assert.equal(m.p90_time_s, 40)
        const d = discoverWorkflowChains(all, reg)[0]
        assert.equal(d.median_time_s, 15)
        assert.equal(d.p90_time_s, 40)
    })
    test('retry timeout is five minutes, and an unconfirmed submit never counts as done', () => {
        const a = steps('s', 'X', [open(0, 'A'), open(1, 'B'), open(2, 'C'), press(3, 'C'), message(4), press(304, 'C')])
        const m = workflowCompletion([a], workflow, reg).overall
        assert.deepEqual([m.done, m.abandoned, m.failed_attempts, m.retries], [0, 1, 1, 0])
    })
    test('empty results have zero counts, null durations and no invented dropout error', () => {
        const m = workflowCompletion([], workflow, reg).overall
        assert.deepEqual([m.started, m.done, m.abandoned, m.median_time_s, m.p90_time_s, m.biggest_drop], [0, 0, 0, null, null, undefined])
    })
})

describe('workflow definitions', () => {
    test('validates names, dialog identifiers, length, done dialog/outcome and buttons', () => {
        for (const bad of [null, { ...workflow, name: '' }, { ...workflow, name: 'a'.repeat(1025) }, { ...workflow, dialogs: [] },
            { ...workflow, dialogs: Array(11).fill('A') }, { ...workflow, dialogs: ["A') OR 1=1"] }, { ...workflow, dialogs: ['IR Swap'] },
            { ...workflow, done: { dialog: 'X', outcome: 'completed' } }, { ...workflow, done: { dialog: 'C', outcome: 'queued' } },
            { ...workflow, done: { dialog: 'C', outcome: 'completed', buttons: [' '] } }]) assert.throws(() => validateWorkflow(bad))
        assert.equal(validateWorkflow({ ...workflow, name: '  Import a swap  ' }).name, 'Import a swap')
        assert.equal(validateWorkflow({ ...workflow, name: 'a'.repeat(1024), dialogs: [...Array(9).fill('A'), 'C'] }).dialogs.length, 10)
    })
    test('resolves exact observed names and aliases, rejects ambiguity and does not guess partial names', () => {
        const names = new Map([['DlgA', { name: 'IR Swap' }], ['DlgB', { name: 'Import' }]])
        assert.deepEqual(resolveWorkflowDialogs(['IR Swap', 'DlgB', 'Import'], reg, names), ['DlgA', 'DlgB', 'DlgB'])
        assert.throws(() => resolveWorkflowDialogs(['IR Sw'], reg, names), /No dialog/)
        assert.throws(() => resolveWorkflowDialogs(['IR Swap'], reg, new Map([...names, ['DlgC', { name: 'IR Swap' }]])), /Ambiguous/)
        assert.deepEqual(resolveWorkflowDialogs(['Swap'], { ...reg, aliases: { DlgA: 'Swap' } }, new Map()), ['DlgA'])
    })
    test('completion requires exactly one of discovered workflow or dialogs', async () => {
        await assert.rejects(completionWorkflow({ ...win }), /either/)
        await assert.rejects(completionWorkflow({ ...win, workflow: 'x', dialogs: ['A'] }), /either/)
        await assert.rejects(completionWorkflow({ ...win, workflow: '', dialogs: ['A'] }), /either/)
        await assert.rejects(completionWorkflow({ ...win, workflow: 'wf_bad' }), /Invalid discovered/)
        await assert.rejects(completionWorkflow({ ...win, workflow: ' ' }), /Give a discovered/)
        await assert.rejects(completionWorkflow({ ...win, workflow: workflowId(['menuCmb', 'C']) }), /task dialogs/)
    })
    test('ids encode only the ordered dialog chain and need no observed sessions to resolve', async () => {
        const id = workflowId(['A', 'B', 'C'])
        assert.deepEqual(workflowDialogsFromId(id), ['A', 'B', 'C'])
        assert.notEqual(id, workflowId(['B', 'A', 'C']))
        for (const bad of ['wf_bad', workflowId(["A') OR 1=1"]), id + '='])
            assert.throws(() => workflowDialogsFromId(bad), /Invalid discovered/)
        const w = await completionWorkflow({ ...win, workflow: id })
        assert.deepEqual(w.dialogs, ['A', 'B', 'C'])
        assert.equal(w.id, id)
        assert.equal(w.done.outcome, 'either')
    })
})

function response(rows: Record<string, unknown>[]) {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    return new Response(JSON.stringify({ columns, results: rows.map((r) => columns.map((c) => r[c])) }))
}

describe('bounded workflow queries', () => {
    test('selects only sessions opening workflow dialogs, binds values, batches ids and flags the session cap', async (t) => {
        const seen: { query: string; values: Record<string, unknown> }[] = []
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query
            seen.push(q)
            return seen.length === 1 ? response(Array.from({ length: 2000 }, (_, i) => ({ sid: `s${i}` }))) : response([])
        })
        const clientId = "X' OR 1=1 --"
        const r = await workflowSessions({ ...win, clientId }, ['A', 'B'])
        assert.equal(seen.length, 41)
        assert.match(seen[0].query, /event = \{screen\}.*IN \{open\}/s)
        assert.match(seen[0].query, /LIMIT 2000/)
        assert.deepEqual(seen[0].values.dialogs, ['A', 'B'])
        assert.equal(seen[0].values.client, clientId)
        assert.ok(seen.every((q) => !q.query.includes(clientId)))
        for (const q of seen.slice(1)) { assert.equal((q.values.sids as string[]).length, 50); assert.match(q.query, /IN \{sids\}.*LIMIT 50000/s); assert.match(q.query, /SELECT uuid FROM events/); assert.doesNotMatch(q.query, /ORDER BY sid, ts/); assert.doesNotMatch(q.query, /properties\.\$session_id/) }
        assert.equal(r.truncated, true)
    })
    test('event row cap is disclosed', async (t) => {
        let n = 0
        const row = session('s', 'X', [open(0, 'A')])[0]
        t.mock.method(globalThis, 'fetch', async () => ++n === 1 ? response([{ sid: 's' }]) : response(Array(50000).fill(row)))
        const r = await workflowSessions(win, ['A'])
        assert.equal(r.rows_read, 50000)
        assert.equal(r.truncated, true)
    })
    test('report compares equal windows, keeps previous-only clients and attaches only recorded replay links', async (t) => {
        const rows = [...session('now', 'RQA', [open(0, 'A'), open(1, 'B'), open(2, 'C'), press(3, 'C'), notice(4)]),
            ...session('lost', 'C26', [open(10, 'A')]), ...session('unrecorded', 'C26', [open(20, 'A')]),
            ...session('before', 'OLD', [open(-100, 'A'), open(-99, 'B'), open(-98, 'C'), press(-97, 'C'), notice(-96)])]
        const seen: { query: string; values: Record<string, unknown> }[] = []
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query; seen.push(q)
            if (q.query.includes('raw_session_replay_events')) return response([{ session_id: 'lost', start: new Date(T0).toISOString(), end: new Date(T0 + 50000).toISOString() }])
            if (q.query.includes('GROUP BY sid')) return response(['now', 'lost', 'unrecorded', 'before'].map((sid) => ({ sid })))
            return response(rows)
        })
        const r = await workflowCompletionReport({ ...win, definition: workflow })
        assert.equal(r.overall.now.started, 3)
        assert.equal(r.overall.before.started, 1)
        assert.equal(r.overall.trend.started_change, 2)
        assert.equal(r.overall.trend.completion_rate_change, 1 / 3 - 1)
        assert.equal(+new Date(r.window.from) - +new Date(r.previous_window.from), +win.to - +win.from)
        assert.equal(r.clients.find((c) => c.client === 'OLD')?.now.started, 0)
        assert.match(r.overall.now.examples.find((e) => e.session_id === 'lost')?.replay_url || '', /\/replay\/lost/)
        assert.equal(r.overall.now.examples.find((e) => e.session_id === 'unrecorded')?.replay_url, undefined)
        assert.equal(seen.filter((q) => q.query.includes('FROM events')).length, 2)
    })
    test('ad hoc completion resolves single-word dialog names and defaults to completed', async (t) => {
        t.mock.method(globalThis, 'fetch', async () => response([{ dialog: 'DlgImport', names: ['Import'], opens: 1 }, { dialog: 'DlgSwap', names: ['IR Swap'], opens: 1 }]))
        const w = await completionWorkflow({ ...win, dialogs: ['Import', 'IR Swap'] })
        assert.deepEqual(w.dialogs, ['DlgImport', 'DlgSwap'])
        assert.deepEqual(w.done, { dialog: 'DlgSwap', outcome: 'completed' })
    })
    test('discovery automatically names chains; completion accepts the id or exact name', async (t) => {
        let n = 0
        t.mock.method(globalThis, 'fetch', async () => ++n % 2 === 1 ? response([{ sid: 's1' }, { sid: 's2' }]) : response([1, 2].flatMap((i) => session(`s${i}`, 'X', [open(0, 'A'), open(1, 'B'), press(2, 'B'), notice(3)]))))
        const r = await discoverWorkflows(win)
        assert.equal(r.discovered.length, 1)
        const found = r.discovered[0]
        assert.equal(found.name, "A → B → Save → 'Trade Id … Updated'")
        for (const input of [found.id, found.name.toUpperCase()]) {
            const w = await completionWorkflow({ ...win, workflow: input })
            assert.deepEqual(w.dialogs, found.dialogs)
            assert.equal(w.done.outcome, 'either')
        }
    })
    test('names resolve beyond the default discovery limit and unknown names fail clearly', async (t) => {
        const rows = Array.from({ length: 16 }, (_, n) => [1, 2].flatMap((i) => session(`s${n}-${i}`, 'X', [
            open(0, `A${n}`, `Start ${n}`), open(1, `B${n}`, `Finish ${n}`), press(2, `B${n}`), notice(3)]))).flat()
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query
            return q.query.includes('GROUP BY sid') ? response([...new Set(rows.map((r) => r.sid))].map((sid) => ({ sid }))) : response(rows)
        })
        const all = await discoverWorkflows({ ...win, limit: 50 })
        const w = await completionWorkflow({ ...win, workflow: all.discovered[15].name })
        assert.deepEqual(w.dialogs, all.discovered[15].dialogs)
        await assert.rejects(completionWorkflow({ ...win, workflow: 'missing' }), /No discovered workflow/)
    })
    test('ambiguous automatic names require an id instead of choosing silently', async (t) => {
        const rows = ['A', 'C'].flatMap((first) => [1, 2].flatMap((i) => session(`${first}${i}`, 'X', [
            open(0, first, 'Start'), open(1, 'B', 'Finish'), press(2, 'B'), notice(3)])))
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query
            return q.query.includes('GROUP BY sid') ? response([...new Set(rows.map((r) => r.sid))].map((sid) => ({ sid }))) : response(rows)
        })
        await assert.rejects(completionWorkflow({ ...win, workflow: "Start → Finish → Save → 'Trade Id … Updated'" }), /Ambiguous workflow/)
    })
})


describe('workflow answer reuse', () => {
    test('identical discovery flights share reads and cached results cannot be mutated by callers', async (t) => {
        let calls = 0
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            calls++
            const q = JSON.parse(String(init.body)).query
            if (q.query.includes('GROUP BY sid')) return response([{ sid: 's1' }, { sid: 's2' }])
            return response([1, 2].flatMap((i) => session(`s${i}`, 'X', [open(0, 'A'), open(1, 'B'), press(2, 'B'), notice(3)])))
        })
        const [a, b] = await Promise.all([discoverWorkflows(win), discoverWorkflows(win)])
        assert.deepEqual(a, b)
        assert.equal(calls, 2)
        a.discovered.length = 0
        assert.equal((await discoverWorkflows(win)).discovered.length, 1)
        assert.equal(calls, 2)
    })
})
