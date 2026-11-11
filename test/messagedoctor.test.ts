// Made-up Reval-shaped sessions; no real users or search text.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-message-doctor-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.CLIENT_FROM_DISTINCT_ID = '3'
process.env.POSTHOG_PROJECT_ID = '123456'
process.env.POSTHOG_PERSONAL_API_KEY = 'test-only'
const { db } = await import('../src/core/db.ts')
const { parseAppEvents, toSteps, clearAppAnswers } = await import('../src/core/appevents.ts')
const { diagnoseMessages, messageDoctor } = await import('../src/core/messagedoctor.ts')
const { APP_EVENT_TOOLS, registerTools } = await import('../src/mcp/tools.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => clearAppAnswers())

const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
type E = Partial<import('../src/core/appevents.ts').RawEvent> & { s: number }
const T0 = Date.parse('2026-11-05T10:00:00Z')
const ts = (s: number) => new Date(T0 + s * 1000).toISOString()
const session = (sid: string, list: E[], client = 'RQA') => list.map(({ s, ...e }) => ({ sid, client, user: `ENV|01|${client}|USER1`, ts: ts(s), event: 'Event', dialog: '', ...e }))
const steps = (sid: string, list: E[], client?: string) => toSteps(session(sid, list, client), reg)
const open = (s: number, dialog: string, dialogName = dialog): E => ({ s, event: 'PageView', dialog, dialogName, action: 'OPEN' })
const press = (s: number, dialog = 'D', button = 'Save'): E => ({ s, dialog, dialogName: dialog, button })
const message = (s: number, text = 'Please designate a risk. Could not save FAS Link.'): E => ({ s, dialog: 'messagebox', button: JSON.stringify([text]) })
const notice = (s: number, text = 'Link Id 3508 Added'): E => ({ s, dialog: 'toast', button: JSON.stringify([text]) })
const field = (s: number, action: string, dialog = 'D', control = 'DROPDOWN'): E => ({ s, dialog, action, control })
const diagnose = (lists: E[][]) => diagnoseMessages(lists.map((list, i) => steps(`s${i}`, list)), reg)

describe('learning what people do after an error', () => {
    test('learns labelled fields, opens and whether they search, once per occurrence', () => {
        const [r] = diagnose([[
            open(0, 'D', 'Hedge Designation'), press(1), message(2),
            field(3, 'gridfloatedit-3404-inputEl'), field(3.5, 'ext-generated-grid', 'D', 'RIGHTCLICK'), field(4, ''),
            field(5, 'Hedged Item Type'), field(6, 'Hedged Item Type'), field(7, 'Standard'),
            open(8, 'Lookup', 'Advanced Trade Lookup'), open(9, 'Lookup', 'Advanced Trade Lookup'),
            field(10, 'PRIVATE SEARCH WORDS', 'menuCmb', 'SEARCH'),
            press(20), notice(21), field(22, 'After submit'),
        ]])
        assert.equal(r.occurrences, 1)
        assert.deepEqual(r.fixed_fields, [
            { label: 'Hedged Item Type', occurrences: 1, pct: 100 },
            { label: 'Standard', occurrences: 1, pct: 100 },
        ])
        assert.deepEqual(r.other_dialogs, [{ dialog: 'Lookup', name: 'Advanced Trade Lookup', occurrences: 1, pct: 100 }])
        assert.deepEqual(r.searched, { occurrences: 1, pct: 100 })
        assert.doesNotMatch(JSON.stringify(r), /PRIVATE SEARCH WORDS|gridfloatedit|ext-generated-grid|unlabelled|After submit/)
    })
    test('even a menu search label is never output', () => {
        const [r] = diagnose([[
            press(0), message(1), field(2, 'Menu', 'menuCmb', 'SEARCHTYPE'), field(3, 'PRIVATE MENU QUERY', 'menuCmb', 'SEARCH'),
        ]])
        assert.equal(r.searched.occurrences, 1)
        assert.doesNotMatch(JSON.stringify(r), /PRIVATE MENU QUERY/)
    })
    test('search text repeated in an error is redacted in templates and examples', () => {
        const [r] = diagnose([[press(0), message(1, 'Lookup failed for search text: PRIVATE SEARCH WORDS')]])
        assert.equal(r.template, 'Lookup failed for search text: …')
        assert.equal(r.examples.gave_up?.message, 'Lookup failed for search text: …')
        assert.doesNotMatch(JSON.stringify(r), /PRIVATE SEARCH WORDS/)
    })
    test('actions end after five minutes or another dialog submits', () => {
        const results = diagnose([
            [press(0), message(1), field(300, 'Before cutoff'), field(302, 'Too late')],
            [press(0), message(1), open(2, 'Other'), field(3, 'Before leaving'), press(4, 'Other'), field(5, 'After leaving')],
        ])
        assert.deepEqual(results[0].fixed_fields.map((f) => [f.label, f.pct]), [['Before cutoff', 50], ['Before leaving', 50]])
        assert.equal(results[0].gave_up, 2)
    })
    test('keeps only the top five fields and three dialogs, using occurrence percentages', () => {
        const actions: E[] = [press(0), message(1)]
        for (let i = 0; i < 8; i++) actions.push(field(2 + i, `Field ${i}`), open(12 + i, `D${i}`))
        const [r] = diagnose([actions, [press(0), message(1), field(2, 'Field 7'), open(3, 'D7')]])
        assert.equal(r.fixed_fields.length, 5)
        assert.deepEqual(r.fixed_fields[0], { label: 'Field 7', occurrences: 2, pct: 100 })
        assert.equal(r.fixed_fields[1].pct, 50)
        assert.equal(r.other_dialogs.length, 3)
        assert.equal(r.other_dialogs[0].dialog, 'D7')
    })
})

describe('outcomes after a message', () => {
    test('ignores completed, queued and nothing-found messages', () => {
        assert.deepEqual(diagnose([[press(0), notice(1), press(2), notice(3, 'Report has been queued'), press(4), message(5, 'No trades found')]]), [])
    })
    test('recovery, failed again and give-up, with median measured to the successful reply', () => {
        const [r] = diagnose([
            [press(0), message(1), field(10, 'Risk'), press(20), message(21), field(30, 'Risk'), press(60), notice(61)],
            [press(0), message(1)],
        ])
        assert.equal(r.occurrences, 3)
        assert.equal(r.sessions, 2)
        assert.equal(r.clients, 1)
        assert.deepEqual([r.recovered, r.failed_again, r.gave_up], [2, 1, 1])
        assert.deepEqual([r.recovered_pct, r.failed_again_pct, r.gave_up_pct], [66.7, 33.3, 33.3])
        assert.equal(r.median_recovery_s, 50)
        assert.deepEqual(r.fixed_fields, [{ label: 'Risk', occurrences: 2, pct: 66.7 }])
        assert.equal(r.examples.recovered?.at, ts(1))
        assert.equal(r.examples.failed_again?.session_id, 's0')
        assert.equal(r.examples.gave_up?.session_id, 's1')
    })
    test('same dialog and button required; an accepted job is a recovery', () => {
        const [r] = diagnose([
            [press(0), message(1), press(10), notice(11, 'The report has been scheduled')],
            [press(0), message(1), press(10, 'D', 'Export'), notice(11)],
            [press(0), message(1), press(10, 'Other'), notice(11)],
            [press(0), message(1), notice(11)], // an unsolicited toast is not a successful submit
        ])
        assert.deepEqual([r.recovered, r.gave_up], [1, 2])
        assert.equal(r.median_recovery_s, 10)
    })
    test('recovery cutoff uses completion time, and later retries still prevent give-up', () => {
        const [r] = diagnose([
            [press(0), message(1), press(899), notice(901)], // exactly 15 min
            [press(0), message(1), press(899), notice(902)],
            [press(0), message(1), press(1000), message(1001)],
        ])
        assert.equal(r.recovered, 1)
        assert.equal(r.median_recovery_s, 900)
        assert.equal(r.failed_again, 1)
        assert.equal(r.gave_up, 1) // only the final error in the third session
    })
    test('a different error on retry is not failed-again for the first template', () => {
        const r = diagnose([[press(0), message(1, 'First problem'), press(10), message(11, 'Second problem')]])
        assert.equal(r.find((m) => m.template === 'First problem')!.failed_again, 0)
        assert.equal(r.find((m) => m.template === 'First problem')!.gave_up, 0)
        assert.equal(r.find((m) => m.template === 'Second problem')!.gave_up, 1)
    })
    test('does not learn from a different person or session', () => {
        const original = steps('a', [press(0), message(1)])
        const another = steps('b', [field(2, 'Other field'), press(3), notice(4)])
        for (const s of another) s.i += 10
        const [r] = diagnoseMessages([[...original, ...another]], reg)
        assert.deepEqual(r.fixed_fields, [])
        assert.equal(r.recovered, 0)
        assert.equal(r.gave_up, 1)
        const mixed = steps('a', [press(0), message(1), field(2, 'Other person'), press(3), notice(4)])
        for (const s of mixed.slice(2)) s.raw.user = 'USER2'
        assert.equal(diagnoseMessages([mixed], reg)[0].recovered, 0)
        assert.deepEqual(diagnoseMessages([mixed], reg)[0].fixed_fields, [])
    })
    test('unattributed errors stay visible but do not claim give-up or recovery', () => {
        const [r] = diagnose([[message(1)]])
        assert.equal(r.dialog, '')
        assert.equal(r.gave_up, 0)
        assert.equal(r.median_recovery_s, null)
    })
})

describe('grouping and misleading-message flags', () => {
    test('trade numbers group by template but different dialogs stay separate', () => {
        const r = diagnoseMessages([
            steps('a', [press(0), message(1, 'Trade Id 4348 could not be saved')], 'C1'),
            steps('b', [press(0), message(1, 'Trade Id 9999 could not be saved')], 'C2'),
            steps('c', [press(0, 'Other'), message(1, 'Trade Id 4444 could not be saved')], 'C2'),
        ], reg)
        assert.equal(r.length, 2)
        assert.equal(r[0].template, 'Trade Id # could not be saved')
        assert.equal(r[0].occurrences, 2)
        assert.equal(r[0].clients, 2)
        assert.equal(r[0].examples.gave_up?.message, 'Trade Id 4348 could not be saved')
    })
    test('points elsewhere learns the real field labels, with a numbered reason', () => {
        const [r] = diagnose(Array.from({ length: 3 }, () => [press(0), message(1), field(2, 'Hedged Item Type'), field(3, 'Standard')]))
        assert.deepEqual(r.flags.map((f) => f.flag), ['points elsewhere', 'dead end'])
        assert.match(r.flags[0].reason, /0\/2.*3\/3/)
        assert.match(r.flags[1].reason, /3\/3 \(100%\)/)
        const [small] = diagnose([[press(0), message(1), field(2, 'Standard')], [press(0), message(1)]])
        assert.deepEqual(small.flags, [])
    })
    test('fine at 80%; a message naming the fixed field does not point elsewhere', () => {
        const [r] = diagnose(Array.from({ length: 5 }, (_, i) => [
            press(0, 'D', 'Run'), message(1, 'From Trade Id cannot be greater than To Trade Id.'), field(2, 'To Trade Id'),
            ...(i < 4 ? [press(10, 'D', 'Run'), notice(11)] : []),
        ]))
        assert.equal(r.recovered_pct, 80)
        assert.deepEqual(r.flags.map((f) => f.flag), ['fine'])
        assert.match(r.flags[0].reason, /4\/5 \(80%\)/)
    })
    test('compares stemmed words, ignores stop words, and any top-field overlap suffices', () => {
        const [stemmed] = diagnose(Array.from({ length: 3 }, () => [press(0), message(1, 'Risks are required'), field(2, 'Risk'), field(3, 'Standard')]))
        assert.ok(!stemmed.flags.some((f) => f.flag === 'points elsewhere'))
        const [stop] = diagnose(Array.from({ length: 3 }, () => [press(0), message(1, 'From the report'), field(2, 'From Date')]))
        assert.ok(stop.flags.some((f) => f.flag === 'points elsewhere'))
    })
    test('dead-end threshold includes exactly half; flags can overlap high recovery', () => {
        const [dead] = diagnose(Array.from({ length: 4 }, (_, i) => [press(0), message(1), ...(i < 2 ? [press(2, 'D', 'Export'), notice(3)] : [])]))
        assert.equal(dead.gave_up_pct, 50)
        assert.ok(dead.flags.some((f) => f.flag === 'dead end'))
        const [both] = diagnose(Array.from({ length: 3 }, () => [press(0), message(1), field(2, 'Standard'), press(3), notice(4)]))
        assert.deepEqual(both.flags.map((f) => f.flag), ['points elsewhere', 'fine'])
    })
    test('warnings first, then clients hit', () => {
        const r = diagnoseMessages([
            ...Array.from({ length: 3 }, (_, i) => steps(`bad${i}`, [press(0), message(1, 'Blocked')])),
            ...Array.from({ length: 4 }, (_, i) => steps(`ok${i}`, [press(0), message(1, 'Required'), press(2), notice(3)], `C${i}`)),
            ...Array.from({ length: 3 }, (_, i) => steps(`broad${i}`, [press(0), message(1, 'Broad problem')], `C${i}`)),
        ], reg)
        assert.deepEqual(r.map((m) => m.template), ['Broad problem', 'Blocked', 'Required'])
    })
    test('scope filters error occurrences, not their following events; labels resolve dialog names', () => {
        const input = steps('s', [open(0, 'D', 'Hedge Designation'), press(1), message(2), press(40), notice(41)])
        const r = diagnoseMessages([input], reg, { from: new Date(ts(2)), to: new Date(ts(3)), dialog: 'hedge', message: 'RISK', clientId: 'RQA' }, { get: () => 'Hedge Designation' })
        assert.equal(r[0].recovered, 1)
        assert.equal(diagnoseMessages([input], reg, { to: new Date(ts(2)) }).length, 0)
        assert.equal(diagnoseMessages([input], reg, { clientId: 'OTHER' }).length, 0)
    })
    test('counts repeated occurrences in one session separately and does not mutate the steps', () => {
        const input = steps('s', [press(0), message(1), press(2), message(3)])
        const before = JSON.stringify(input)
        const [r] = diagnoseMessages([input], reg)
        assert.equal(r.occurrences, 2)
        assert.equal(r.sessions, 1)
        assert.equal(JSON.stringify(input), before)
    })
})

// Exercise the query orchestration through the real HogQL client, with no PostHog connection.
type Query = { query: string; values: Record<string, unknown> }
const response = (rows: Record<string, unknown>[]) => {
    const columns = [...new Set(rows.flatMap(Object.keys))]
    return new Response(JSON.stringify({ columns, results: rows.map((r) => columns.map((c) => r[c])) }))
}

describe('bounded message-doctor queries', () => {
    test('bound client values, fetch full sessions, filter after attribution, attach replay examples', async (t) => {
        const client = "RQA' OR 1=1 --"
        const rows = session('s', [open(0, 'D', 'Hedge Designation'), { ...press(1), dialogName: 'Hedge Designation' }, message(2), field(3, 'Standard'), press(40), notice(41)], client)
        const seen: Query[] = []
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query as Query
            seen.push(q)
            if (q.query.includes('SELECT') && q.query.includes(' AS dialog')) assert.doesNotMatch(q.query, /ORDER BY/)
            assert.match(q.query, /LIMIT \d+/)
            assert.ok(!q.query.includes(client))
            if (q.query.includes('GROUP BY sid')) return response([{ sid: 's', last: ts(2) }])
            if (q.query.includes('raw_session_replay_events')) return response([{ session_id: 's', start: ts(-20), end: ts(50) }])
            return response([...rows].reverse())
        })
        const r = await messageDoctor({ from: new Date(ts(2)), to: new Date(ts(3)), clientId: client, dialog: 'hedge', message: 'risk' })
        assert.equal(r.messages[0].recovered, 1)
        assert.equal(r.messages[0].median_recovery_s, 39)
        assert.match(r.messages[0].examples.recovered!.replay_url!, /\/replay\/s\?t=12/)
        assert.equal(r.rows_read, rows.length + 1)
        assert.equal(r.query_rows.events, rows.length)
        assert.equal(r.sessions_read, 1)
        assert.equal(r.truncated, false)
        assert.equal(seen[0].values.client, client)
        assert.equal(seen[1].values.history, ts(-58))
        assert.ok(Date.parse(String(seen[1].values.observed)) > Date.parse(ts(41)))
        assert.deepEqual(seen[1].values.ids, ['s'])
        assert.match(seen[0].query, /CASE WHEN match/)
        assert.match(seen[0].query, /JSONExtractString/)
    })
    test('session selection cap, fixed batch size, empty result and unavailable recordings', async (t) => {
        const batches: number[] = []
        let empty = false
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query as Query
            if (q.query.includes('GROUP BY sid')) return response(empty ? [] : Array.from({ length: 1000 }, (_, i) => ({ sid: `s${i}`, last: ts(1) })))
            if (q.query.includes('raw_session_replay_events')) throw new Error('No replay access')
            const ids = q.values.ids as string[]
            batches.push(ids.length)
            return response(ids.flatMap((sid) => session(sid, [press(0), message(1)])))
        })
        const r = await messageDoctor({ from: new Date(ts(0)), to: new Date(ts(3)) })
        assert.equal(r.truncated, true)
        assert.equal(r.sessions_read, 1000)
        assert.equal(batches.length, 40)
        assert.ok(batches.every((n) => n === 25))
        assert.equal(r.replay_links, 'unavailable')
        empty = true
        clearAppAnswers()
        const none = await messageDoctor({ from: new Date(ts(0)), to: new Date(ts(3)) })
        assert.deepEqual(none.messages, [])
        assert.equal(none.rows_read, 0)
    })
    test('splits capped batches and omits an oversized session instead of inventing give-ups', async (t) => {
        const huge = session('huge', [press(0), message(1)])[0]
        const healthy = session('small', [press(0), message(1), press(3), notice(4)])
        const seen: string[][] = []
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const q = JSON.parse(String(init.body)).query as Query
            if (q.query.includes('GROUP BY sid')) return response([{ sid: 'huge', last: ts(1) }, { sid: 'small', last: ts(1) }])
            if (q.query.includes('raw_session_replay_events')) return response([])
            const ids = q.values.ids as string[]
            seen.push(ids)
            return response(ids.includes('huge') ? Array.from({ length: 50_000 }, () => huge) : healthy)
        })
        const r = await messageDoctor({ from: new Date(ts(0)), to: new Date(ts(3)) })
        assert.deepEqual(seen, [['huge', 'small'], ['huge'], ['small']])
        assert.equal(r.rows_read, 100_006)
        assert.equal(r.query_rows.capped_event_batches, 2)
        assert.deepEqual(r.omitted_sessions, ['huge'])
        assert.equal(r.sessions_read, 1)
        assert.equal(r.messages[0].gave_up, 0)
        assert.equal(r.messages[0].recovered, 1)
        assert.equal(r.truncated, true)
    })
})

test('message_doctor is registered with the promised question and inputs', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const server = new McpServer({ name: 'test', version: '0' })
    const client = new Client({ name: 'test', version: '0' })
    registerTools(server)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try {
        const tool = (await client.listTools()).tools.find((t) => t.name === 'message_doctor')!
        assert.ok(APP_EVENT_TOOLS.includes(tool.name))
        assert.ok(tool.description!.startsWith("Which of Reval's error messages leave people stuck, and what do they do to recover?"))
        assert.deepEqual(Object.keys(tool.inputSchema.properties!), ['client', 'dialog', 'message', 'when'])
        assert.equal(tool.annotations?.readOnlyHint, true)
    } finally {
        await client.close()
        await server.close()
    }
})
