// The Watchlist: replays of chosen clients read step by step (core/replaymoments.ts), kept and ranked
// (core/watchlist.ts), served to Copilot (mcp/watchtools.ts) and to the page (service/watch.ts).
// Real lab recordings with known behaviour drive it; synthetic events pin down each rule.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'watch-'))
process.env.TRIAGE_DB = join(dir, 'lens.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const M = await import('../src/core/replaymoments.ts')
const W = await import('../src/core/watchlist.ts')
const { canaryStrings } = await import('../scripts/replay-lab/canaries.ts')
after(() => { db.close(); tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })

const FIX = new URL('./fixtures/replay-lab/', import.meta.url)
const truth = JSON.parse(readFileSync(new URL('ground-truth.json', FIX), 'utf8'))
const sessions = Object.values(truth.sessions || truth) as { session_id: string; client_id: string; client_name: string; persona: string; duration_ms: number }[]
const fixture = (id: string) => readFileSync(new URL(readdirSync(FIX).find((f) => f.includes(id))!, FIX), 'utf8')
const NAMES = ['notional', 'counterparty', 'trade-date', 'rate']
const marksOf = (m: ReturnType<typeof M.momentsFromReplay>) => new Set(m.steps.flatMap((s) => s.marks))
const today = new Date().toISOString().slice(0, 10)
const week = { from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), to: today }

// ------------------------------------------------------------------ the step reader
test('lab recordings: each behaviour shows up as the right kind of moment, and smooth work shows none', () => {
    const expect: Record<string, string[]> = {
        smooth: [], idle: [], 'hesitant-circling': ['hesitation', 'circling'], 'rage-dead': ['repeated_clicks'],
        'scroll-hunting': ['scroll_hunting'], 'error-looping': ['failed_submit', 'error_loop'],
    }
    for (const s of sessions) {
        const m = M.momentsFromReplay(fixture(s.session_id), s.duration_ms, { names: NAMES })
        const got = marksOf(m)
        for (const k of expect[s.persona]) assert.ok(got.has(k as never), `${s.persona} ${s.session_id}: expected ${k}, got ${[...got]}`)
        if (!expect[s.persona].length) assert.equal(got.size, 0, `${s.persona}: ${[...got]}`)
        assert.ok(m.steps.length >= 2, s.persona)
        for (const st of m.steps) assert.ok(st.at_ms >= st.from_ms && st.at_ms <= m.duration_ms + 100, `${s.persona} step ${st.n}`)
    }
    const err = M.momentsFromReplay(fixture(sessions.find((s) => s.persona === 'error-looping')!.session_id), 70_000, { names: NAMES })
    const saves = err.steps.filter((s) => s.target === 'button#save')
    assert.equal(saves.length, 4)
    assert.deepEqual(saves.map((s) => s.marks[0]), ['failed_submit', 'error_loop', 'error_loop', 'error_loop'])
    assert.ok(saves.every((s) => s.after.error_shown && s.kind === 'submit'))
    assert.ok(err.steps.some((s) => s.target === 'field:counterparty'), 'fields are named as fields')
    const idle = M.momentsFromReplay(fixture(sessions.find((s) => s.persona === 'idle')!.session_id), 70_000, { names: NAMES })
    assert.ok(idle.active_ms < 10_000 && idle.pointer.coverage === 'sparse', JSON.stringify(idle.pointer))
})

test('privacy: no typed value, screen text, URL or coordinate leaves the reader', () => {
    for (const s of sessions) {
        const out = JSON.stringify(M.momentsFromReplay(fixture(s.session_id), s.duration_ms, { names: NAMES }))
        for (const c of canaryStrings) for (const v of [c, c.replace(/,/g, ''), c.toLowerCase()]) assert.ok(!out.includes(v), `${s.persona}: ${v}`)
        assert.doesNotMatch(out, /127\.0\.0\.1|http|persona=|"x":|"y":/)
    }
    // An unreviewed element name stays generic, however it is spelled.
    const ev = (t: number, type: number, data: unknown) => JSON.stringify(['w', { timestamp: t, type, data }])
    const page = ev(0, 2, { node: { id: 1, type: 2, tagName: 'div', attributes: {}, childNodes: [{ id: 2, type: 2, tagName: 'button', attributes: { id: 'Zanthor-Capital-desk' }, childNodes: [] }] } })
    const out = M.momentsFromReplay([page, ev(100, 3, { source: 2, type: 2, id: 2, x: 5, y: 5 }), ev(9000, 3, { source: 1, positions: [] })].join('\n'))
    assert.equal(out.steps[0].target, 'button')
    assert.doesNotMatch(JSON.stringify(out), /Zanthor/i)
})

const ev = (t: number, type: number, data: unknown, w = 'w') => JSON.stringify([w, { timestamp: t, type, data }])
const node = (id: number, tagName: string, attributes: Record<string, string> = {}, childNodes: unknown[] = []) => ({ id, type: 2, tagName, attributes, childNodes })
const form = () => ev(0, 2, { node: node(1, 'form', {}, [node(2, 'button', { 'data-action': 'save', type: 'submit' }, [node(3, 'span')]), node(4, 'input', { 'data-field': 'notional' }), node(5, 'button', { 'data-action': 'cancel' })]) })
const move = (t: number, id: number, x: number, y: number) => ev(t, 3, { source: 1, positions: [{ id, x, y, timeOffset: 0 }] })
const click = (t: number, id: number) => ev(t, 3, { source: 2, type: 2, id, x: 10, y: 10 })
const change = (t: number) => ev(t, 3, { source: 0, adds: [{ parentId: 1, node: node(900 + t, 'div') }] })

test('rules: resting on a control, leaving and coming back, hovering another control, slow and failed answers', () => {
    const net = (t: number, ms: number, status: number) => ev(t, 6, { plugin: 'rrweb/network@1', payload: { requests: [{ name: 'https://x/api/trade/save', method: 'POST', initiatorType: 'fetch', timestamp: t, startTime: 0, endTime: ms, responseStatus: status }] } })
    const lines = [form(),
        move(100, 5, 300, 300), move(200, 5, 302, 300), move(2600, 2, 10, 10), // over Cancel 2.4 s, then onto Save
        move(2700, 1, 100, 100), move(3000, 3, 12, 12), // off Save, back onto its label (inside Save)
        click(5000, 3), net(5050, 6200, 500), change(11_300), // rested ~2 s, server 6.2 s with 500
        ev(20_000, 3, { source: 1, positions: [] })]
    const m = M.momentsFromReplay(lines.join('\n'), undefined, { names: ['notional'] })
    const s = m.steps[0]
    assert.equal(s.target, 'button#save'); assert.equal(s.kind, 'submit')
    assert.equal(s.lead.dwell_ms, 2000)
    assert.equal(s.lead.returns, 1)
    assert.deepEqual(s.lead.hovered, [{ target: 'button#cancel', ms: 2500 }])
    assert.equal(s.after.request_ms, 6200); assert.equal(s.after.status, '5xx')
    assert.deepEqual(s.marks, ['failed_submit', 'slow_response', 'hover_no_click'])
    assert.match(M.stepLine(s), /rested on it 2\.0 s · came back to it once · hovered button#cancel 2\.5 s without clicking · server 6\.2 s, 5xx/)

    // A click the page never answers; three fast clicks are one step.
    const dead = M.momentsFromReplay([form(), click(100, 5), click(3000, 2), click(3300, 2), click(3600, 2), ev(9000, 3, { source: 1, positions: [] })].join('\n'))
    assert.deepEqual(dead.steps.map((x) => [x.target, x.clicks, x.marks]), [['button#cancel', 1, ['no_response']], ['button#save', 3, ['repeated_clicks', 'no_response']], ['end of recording', 0, []]])
    // A page change within a second is an answer; a field click is never "did nothing".
    const ok = M.momentsFromReplay([form(), click(100, 5), change(600), click(2000, 4), ev(9000, 3, { source: 1, positions: [] })].join('\n'))
    assert.deepEqual(ok.steps.map((x) => [x.after.page, x.marks]), [['changed', []], ['not checked', []], ['not checked', []]])
})

test('rules: windows keep their own nodes; malformed lines and empty recordings do not throw', () => {
    assert.deepEqual(M.momentsFromReplay('').steps, [])
    assert.deepEqual(M.momentsFromReplay('not json\n{}\n[1,2]').steps, [])
    const two = M.momentsFromReplay([form(), ev(10, 2, { node: node(1, 'div', {}, [node(2, 'a')]) }, 'other'), click(100, 2), click(3000, 2), ev(5000, 3, { source: 1, positions: [] })].join('\n'))
    assert.equal(two.steps[0].target, 'button#save')
    const lines = [form()]
    for (let i = 0; i < 20_000; i++) lines.push(move(100 + i * 50, 1, i % 400, (i * 7) % 300))
    const t0 = performance.now(); M.momentsFromReplay(lines.join('\n')); assert.ok(performance.now() - t0 < 3000, 'fast enough for a long recording')
    // Many clicks with many pointer samples: each step reads only its own slice.
    const busy = [form()]
    for (let i = 0; i < 10_000; i++) busy.push(move(100 + i * 100, 2, i % 50, 5), click(150 + i * 100, i % 2 ? 2 : 5))
    const t1 = performance.now(); const b = M.momentsFromReplay(busy.join('\n')); assert.ok(performance.now() - t1 < 3000, `10,000 clicks: ${Math.round(performance.now() - t1)} ms`)
    assert.ok(b.steps.length > 9000)
})

test('review fixes: returns, pauses, windows, hidden alerts, expiring toasts, bursts', () => {
    const end = ev(20_000, 3, { source: 1, positions: [] })
    // Save → away → Save → Save is one return, not two.
    const r = M.momentsFromReplay([form(), move(100, 2, 1, 1), move(200, 5, 50, 50), move(300, 2, 2, 2), move(400, 3, 3, 3), click(500, 2), end].join('\n')).steps[0]
    assert.equal(r.lead.returns, 1)
    // Nine seconds of stillness after the previous click, then a quick move and a click: a pause from the previous step.
    const p = M.momentsFromReplay([form(), click(100, 5), change(150), move(9100, 2, 5, 5), click(9300, 2), end].join('\n')).steps[1]
    assert.equal(p.lead.longest_pause_ms, 9000); assert.ok(p.marks.includes('long_pause'))
    // A server error in another window does not belong to this click.
    const net = (t: number, w: string) => ev(t, 6, { plugin: 'rrweb/network@1', payload: { requests: [{ name: 'https://x/api/save', method: 'POST', initiatorType: 'fetch', timestamp: t, startTime: 0, endTime: 100, responseStatus: 500 }] } }, w)
    const w = M.momentsFromReplay([form(), ev(5, 2, { node: node(1, 'div') }, 'B'), click(100, 2), net(200, 'B'), change(300), end].join('\n')).steps[0]
    assert.equal(w.after.status, null); assert.deepEqual(w.marks, [])
    // A hidden alert template is not an error; one that becomes visible is.
    const hiddenAlert = (t: number, id: number, extra = {}) => ev(t, 3, { source: 0, adds: [{ parentId: 1, node: node(id, 'div', { role: 'alert', 'aria-hidden': 'true', ...extra }) }] })
    assert.equal(M.momentsFromReplay([form(), click(100, 2), hiddenAlert(300, 50), end].join('\n')).steps[0].after.error_shown, false)
    const shown = M.momentsFromReplay([form(), click(100, 2), hiddenAlert(300, 50), ev(400, 3, { source: 0, attributes: [{ id: 50, attributes: { 'aria-hidden': null } }] }), end].join('\n')).steps[0]
    assert.equal(shown.after.error_shown, true); assert.deepEqual(shown.marks, ['failed_submit'])
    // A toast expiring by itself just after a click is not the page answering it.
    const toast = M.momentsFromReplay([form(), ev(50, 3, { source: 0, adds: [{ parentId: 1, node: node(60, 'div') }] }), click(1000, 5), ev(1900, 3, { source: 0, removes: [{ parentId: 1, id: 60 }] }), end].join('\n')).steps[0]
    assert.deepEqual(toast.marks, ['no_response'])
    // A burst is judged from its first click: the request it started still counts.
    const burst = M.momentsFromReplay([form(), click(100, 2), net(150, 'w'), click(500, 2), click(900, 2), click(1300, 2), end].join('\n')).steps[0]
    assert.equal(burst.clicks, 4); assert.equal(burst.after.status, '5xx'); assert.equal(burst.at_ms, 100)
})

// ------------------------------------------------------------------ the list, reading and ranking
const seedNames = () => { for (const s of sessions) tasksDb.prepare('INSERT OR REPLACE INTO client_names VALUES (?,?)').run(s.client_id, s.client_name) }
const read = (_clients: string[]) => W.processWatchlist(100, {
    candidates: async (cs) => ({ list: sessions.filter((s) => cs.includes(s.client_id)).map((s, i) => ({ session_id: s.session_id, client: s.client_id, user: `user${i % 3}@client.example`, start: new Date(Date.now() - (i + 1) * 3_600_000).toISOString() })), found: new Map(cs.map((c) => [c, sessions.filter((s) => s.client_id === c).length])) }),
    jsonl: async (id) => fixture(id), durationMs: async () => 70_000, names: async () => NAMES,
})

test('watchlist: add, read, rank, repeat, pause, remove', async () => {
    seedNames()
    assert.throws(() => W.changeWatch('NOPE', 'add', 'pm@x'), /Unknown client/)
    assert.throws(() => W.changeWatch('LAB5', 'pause', 'pm@x'), /not on the watchlist/)
    assert.deepEqual(await read([]), { read: 0, skipped: 0, waiting: 0 })
    for (const c of ['LAB1', 'LAB4', 'LAB5']) W.changeWatch(c, 'add', 'pm@x')
    const r = await read(['LAB1', 'LAB4', 'LAB5'])
    assert.equal(r.read, 6)
    const list = W.watchlist()
    assert.deepEqual(list.map((c) => [c.client, c.found, c.read, c.waiting, c.paused]), [['LAB1', 2, 2, 0, false], ['LAB4', 2, 2, 0, false], ['LAB5', 2, 2, 0, false]])
    // Read sessions are not read again.
    assert.equal((await read(['LAB1', 'LAB4', 'LAB5'])).read, 0)

    const h = W.highlights(week)
    assert.equal(h.total, 4, 'the smooth sessions are not highlights')
    assert.deepEqual(h.items.map((x) => x.client), ['LAB5', 'LAB5', 'LAB4', 'LAB4'], 'errors rank above repeated clicks')
    assert.equal(h.items[0].severity, 'high')
    assert.match(h.items[0].headline, /Fixed, retried and failed again on the Save button/)
    assert.match(h.items[0].moment.clip_page, /\/replays\?url=/)
    assert.equal(h.coverage.sessions_read, 6); assert.equal(h.coverage.with_highlights, 4)
    assert.equal(W.highlights({ ...week, kinds: ['repeated_clicks'] }).total, 2)
    assert.equal(W.highlights({ ...week, client: 'LAB1' }).total, 0)

    const p = W.repeatedProblems(week)
    const loop = p.find((x) => x.mark === 'error_loop' && x.target === 'button#save')!
    assert.equal(loop.sessions, 2); assert.equal(loop.clients, 1); assert.equal(loop.examples.length, 2)
    assert.ok(p.every((x) => x.sessions >= 2))

    const d = W.sessionDetail(h.items[0].session_id)!
    assert.ok(d.steps.length >= 8 && d.steps.every((s) => s.line && s.clip_page))
    assert.equal(W.sessionDetail(h.items[0].session_id, { onlyMarked: true })!.steps.length, 4)
    assert.equal(W.sessionDetail('not-a-watched-session'), undefined)
    const dg = W.watchDigest('LAB5', week)
    assert.match(dg.summary, /on the Save button in 2 of 2 sessions/)

    // Paused clients are not read; removing deletes what was kept.
    W.changeWatch('LAB4', 'pause', 'pm@x')
    assert.equal(W.watchlist().find((c) => c.client === 'LAB4')!.paused, true)
    let asked: string[] = []
    await W.processWatchlist(5, { candidates: async (cs) => { asked = cs; return { list: [], found: new Map() } } })
    assert.deepEqual(asked, ['LAB1', 'LAB5'])
    W.changeWatch('LAB5', 'remove', 'pm@x')
    assert.equal((tasksDb.prepare("SELECT count(*) AS n FROM watch_sessions WHERE client='LAB5'").get() as { n: number }).n, 0)
    assert.equal(W.sessionDetail(h.items[0].session_id), undefined)
    assert.equal(W.highlights(week).total, 2, 'LAB4 is paused but kept; its two sessions stay readable')
})

test('reading: failures wait and retry, too-short recordings are skipped, a removed client is not stored', async () => {
    seedNames()
    W.changeWatch('LAB2', 'add', 'pm@x')
    const one = (id: string) => ({ list: [{ session_id: id, client: 'LAB2', user: 'u', start: new Date().toISOString() }], found: new Map([['LAB2', 1]]) })
    let r = await W.processWatchlist(5, { candidates: async () => one('broken'), jsonl: async () => { throw new Error('PostHog busy') }, durationMs: async () => 1, names: async () => [] })
    assert.deepEqual(r, { read: 0, skipped: 1, waiting: 0 })
    assert.ok(tasksDb.prepare("SELECT 1 FROM watch_retries WHERE session_id='broken'").get())
    r = await W.processWatchlist(5, { candidates: async () => one('short'), jsonl: async () => [form(), click(100, 2)].join('\n'), durationMs: async () => 1000, names: async () => [] })
    assert.ok(tasksDb.prepare("SELECT 1 FROM watch_skips WHERE session_id='short'").get())
    await assert.rejects(W.processWatchlist(5, { candidates: async () => { throw new Error('HogQL down') } }), /HogQL down/)
    assert.equal(W.watchlist().find((c) => c.client === 'LAB2')!.last_error, 'PostHog did not answer the last check for new replays.')
    // Removed while its replay was being read: nothing is kept.
    await W.processWatchlist(5, { candidates: async () => one(sessions.find((s) => s.client_id === 'LAB2')!.session_id), jsonl: async (id) => { W.changeWatch('LAB2', 'remove', 'pm@x'); return fixture(id) }, durationMs: async () => 70_000, names: async () => NAMES })
    assert.equal((tasksDb.prepare("SELECT count(*) AS n FROM watch_sessions WHERE client='LAB2'").get() as { n: number }).n, 0)
})

// ------------------------------------------------------------------ Copilot
async function chat(role: 'view' | 'share', insights = true) {
    const { wrapTools } = await import('../src/mcp/tools.ts')
    const { registerDashboardTools } = await import('../src/mcp/dashboardtools.ts')
    const server = new McpServer({ name: 't', version: '1' })
    wrapTools(server, false, undefined, { work: (_n: string, _a: unknown, _w: unknown, execute: () => Promise<unknown>) => ({ promise: execute() }) } as never)
    registerDashboardTools(server, { who: 'pm', email: 'pm@x', dashboardRole: role, surveyRole: 'none', admin: false, insights })
    const client = new Client({ name: 't', version: '0' }); const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; structuredContent?: any; isError?: boolean }; return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent, isError: r.isError } }
    return { client, call, close: async () => { await client.close(); await server.close() } }
}

test('Copilot: the watch tools follow the replay-insights grant and sharing rights, and answer step by step', async () => {
    seedNames()
    tasksDb.exec('DELETE FROM watch_clients; DELETE FROM watch_sessions; DELETE FROM watch_skips; DELETE FROM watch_retries')
    const none = await chat('share', false)
    const noneTools = (await none.client.listTools()).tools.map((t) => t.name)
    assert.ok(!noneTools.some((t) => t.startsWith('watch') || t === 'session_moments' || t === 'repeated_problems'), 'no grant, no watch tools')
    await none.close()
    const viewer = await chat('view')
    const viewTools = (await viewer.client.listTools()).tools.map((t) => t.name)
    assert.ok(['watch_highlights', 'session_moments', 'repeated_problems'].every((t) => viewTools.includes(t)) && !viewTools.includes('watch_client'))
    await viewer.close()

    const c = await chat('share')
    assert.match((await c.call('watch_highlights')).text, /watchlist is empty/)
    assert.match((await c.call('watch_client', { client: 'Lab Error Co', action: 'add' })).text, /Lab Error Co added to the watchlist/)
    assert.match((await c.call('watch_client', { client: 'Lab', action: 'add' })).text, /Which client did you mean/)
    await read(['LAB5'])
    const h = await c.call('watch_highlights', { client: 'LAB5', when: 'last 7 days' })
    assert.match(h.text, /Lab Error Co: Fixed, retried and failed again on the Save button in 2 of 2 sessions/)
    assert.equal(h.data.highlights.length, 2)
    assert.equal(h.data.watchlist[0].status, 'active')
    const id = h.data.highlights[0].session_id
    const steps = await c.call('session_moments', { session_id: id, only_marked: true })
    assert.match(steps.text, /\[Submit failed\] The Save button: error shown/)
    assert.match(steps.text, /\[Fixed, retried and failed again\]/)
    assert.equal(steps.data.steps.length, 4)
    assert.ok(steps.data.steps.every((s: any) => s.replay_url && s.offset_s >= 0))
    assert.match((await c.call('session_moments', { session_id: 'someone-elses-session' })).text, /only sessions of watched clients/)
    assert.match((await c.call('repeated_problems', { when: 'last 7 days' })).text, /Fixed, retried and failed again on the Save button: 2 sessions, 1 client/)
    assert.match((await c.call('watch_highlights', { client: 'Lab Rage Co' })).text, /not on the watchlist/)
    const all = JSON.stringify([h, steps])
    for (const v of canaryStrings) assert.ok(!all.includes(v), v)
    assert.match((await c.call('watch_client', { client: 'LAB5', action: 'remove' })).text, /removed from the watchlist/)
    await c.close()
})

// ------------------------------------------------------------------ the page
test('page: who may open it and who may change the list', async () => {
    const { handleWatch, watchHtml, canOpenWatch, canManageWatch } = await import('../src/service/watch.ts')
    const pm = { email: 'pm@x', name: 'PM', role: 'watch', posthog_admin: false, in_replay_project: true, insights: true, dashboards: 'view' } as never
    const lead = { ...(pm as object), email: 'lead@x', dashboards: 'share' } as never
    const plain = { ...(pm as object), insights: false } as never
    assert.equal(canOpenWatch(plain), false); assert.equal(canOpenWatch(pm), true)
    assert.equal(canManageWatch(pm), false); assert.equal(canManageWatch(lead), true)
    const call = async (v: never, method: string, path: string, body?: unknown) => {
        let status = 0, out = ''
        const res = { writeHead: (s: number) => { status = s }, end: (t: string) => { out = t } } as never
        const req = Object.assign((async function* () { if (body) yield Buffer.from(JSON.stringify(body)) })(), { method, headers: {} }) as never
        await handleWatch(req, res, new URL('http://x' + path), v)
        return { status, body: JSON.parse(out) }
    }
    assert.equal((await call(plain, 'GET', '/replays/watch/api/state')).status, 403)
    const st = await call(pm, 'GET', '/replays/watch/api/state')
    assert.equal(st.status, 200); assert.equal(st.body.canManage, false)
    assert.equal((await call(pm, 'POST', '/replays/watch/api/change', { client: 'LAB1', action: 'add' })).status, 403)
    assert.equal((await call(lead, 'POST', '/replays/watch/api/change', { client: 'LAB1', action: 'add' })).status, 200)
    assert.equal((await call(lead, 'POST', '/replays/watch/api/change', { client: 'LAB1', action: 'explode' })).status, 400)
    assert.equal((await call(lead, 'GET', '/replays/watch/api/session?id=nope')).status, 404)
    const hl = await call(pm, 'GET', '/replays/watch/api/highlights?days=30&kind=bogus')
    assert.equal(hl.status, 200); assert.ok(Array.isArray(hl.body.items) && Array.isArray(hl.body.problems))
    const html = watchHtml(pm)
    assert.match(html, /<h1>Watchlist<\/h1>/); assert.match(html, /aria-current="page"[^>]*>.*Watchlist/s)
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'no outside assets')
})

test('review fixes: re-adding during a read, retries on removal, filters, no identity in answers', async () => {
    seedNames()
    tasksDb.exec('DELETE FROM watch_clients; DELETE FROM watch_sessions; DELETE FROM watch_skips; DELETE FROM watch_retries')
    W.changeWatch('LAB4', 'add', 'pm@x')
    const id = sessions.find((s) => s.client_id === 'LAB4')!.session_id
    const one = { list: [{ session_id: id, client: 'LAB4', user: 'u', start: new Date().toISOString() }], found: new Map([['LAB4', 1]]) }
    // Removed and added again while its replay was being read: the old read is dropped, the new entry reads it fresh.
    await W.processWatchlist(5, { candidates: async () => one, jsonl: async (sid) => { W.changeWatch('LAB4', 'remove', 'pm@x'); await new Promise((r) => setTimeout(r, 5)); W.changeWatch('LAB4', 'add', 'pm@x'); return fixture(sid) }, durationMs: async () => 70_000, names: async () => NAMES })
    assert.equal(W.watchlist()[0].read, 0)
    // A failed read leaves a retry; removing the client clears it, so adding it again reads at once.
    await W.processWatchlist(5, { candidates: async () => one, jsonl: async () => { throw new Error('busy') }, durationMs: async () => 70_000, names: async () => NAMES })
    assert.ok(tasksDb.prepare('SELECT 1 FROM watch_retries WHERE session_id=?').get(id))
    W.changeWatch('LAB4', 'remove', 'pm@x')
    assert.equal(tasksDb.prepare('SELECT 1 FROM watch_retries WHERE session_id=?').get(id), undefined)
    W.changeWatch('LAB4', 'add', 'pm@x'); W.changeWatch('LAB5', 'add', 'pm@x')
    await read(['LAB4', 'LAB5'])
    // A kind filter ranks and headlines by that kind only.
    const slowOnly = W.highlights({ ...week, kinds: ['no_response'] })
    assert.ok(slowOnly.items.length && slowOnly.items.every((h) => h.marks.every((k) => k === 'no_response') && /did nothing/.test(h.headline)), JSON.stringify(slowOnly.items.map((h) => h.headline)))
    // to_s counts the click time, not the start of its lead-up.
    const sid = W.highlights({ ...week, client: 'LAB5' }).items[0].session_id
    assert.ok(W.sessionDetail(sid, { to_s: 2 })!.steps.every((s) => s.at_ms <= 2000))
    assert.throws(() => W.sessionDetail(sid, { from_s: 5, to_s: 1 }), /must not be before/)
    const c = await chat('share')
    assert.match((await c.call('watch_highlights', { client: 'Nobody Holdings' })).text, /No client matches "Nobody Holdings"/)
    assert.match((await c.call('session_moments', { session_id: sid, from_s: 9, to_s: 1 })).text, /must not be before/)
    const y = await c.call('watch_highlights', { when: 'yesterday' })
    assert.equal(y.data.window.from, y.data.window.to, 'yesterday is one day')
    assert.notEqual(y.data.window.to, today, 'and not today')
    const all = JSON.stringify([await c.call('watch_highlights', {}), await c.call('session_moments', { session_id: sid })])
    assert.doesNotMatch(all, /"person"|added_by|user_hash|pm@x/)
    await c.close()
})

test('candidates: ownership and "finished" come from the whole session; ids are quoted', async () => {
    let sql = ''
    const out = await W.watchCandidates(["LAB1", "x') OR 1=1 --"], { hogql: async (q: string) => { sql = q; return [{ session_id: 's1', client: 'LAB1', user: 'u', start: '2026-11-18T10:00:00Z', end: '2026-11-18T10:05:00Z' }, { session_id: 's2', client: 'OTHER', user: 'u', start: '2026-11-18T10:00:00Z' }] } } as never)
    assert.deepEqual(out.list.map((c) => c.session_id), ['s1'])
    assert.match(sql, /HAVING max\(timestamp\) < now\(\) - INTERVAL 30 MINUTE AND clients = 1/)
    assert.match(sql, /\$session_id IN \(SELECT \$session_id FROM events WHERE .* IN \('LAB1','x\\'\) OR 1=1 --'\)\)/)
})
