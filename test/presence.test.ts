import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { actionLabel, dayIn, includesToday, liveNow, parsePresenceQuery, personDay, presenceReport, presenceSessions, timedEvents, validTimeZone, type PresenceQuery, type PresenceSettings } from '../src/core/presence.ts'

const SETTINGS: PresenceSettings = { gap_s: 60, live_minutes: 5, ignore_events: ['$feature_flag_called'] }
const NOW = new Date('2026-11-01T20:00:00Z') // already 2 November in India, still 1 November in New York
const parse = (q: Record<string, string>) => parsePresenceQuery(new URLSearchParams(q), SETTINGS, NOW)

describe('the page parameters', () => {
    test('defaults: today in the viewer timezone, the default active time', () => {
        assert.deepEqual(parse({ tz: 'Asia/Kolkata' }), { from: '2026-11-02', to: '2026-11-02', tz: 'Asia/Kolkata', gap_s: 60 })
        assert.deepEqual(parse({ tz: 'America/New_York' }), { from: '2026-11-01', to: '2026-11-01', tz: 'America/New_York', gap_s: 60 })
        assert.deepEqual(parse({}), { from: '2026-11-01', to: '2026-11-01', tz: 'UTC', gap_s: 60 })
    })

    test('a range, a client, a person and another active time', () => {
        assert.deepEqual(parse({ from: '2026-10-01', to: '2026-10-31', tz: 'Europe/London', gap: '120', client: ' acme ', user: 'a@b.c' }), {
            from: '2026-10-01',
            to: '2026-10-31',
            tz: 'Europe/London',
            gap_s: 120,
            client: 'acme',
            user: 'a@b.c',
        })
    })

    test('refuses bad input', () => {
        const bads: Record<string, string>[] = [
            { tz: 'Mars/Olympus' },
            { tz: "UTC'); DROP TABLE events; --" },
            { from: '2026-13-45' },
            { from: '1 Nov 2026' },
            { from: '2026-11-02', to: '2026-11-01' },
            { from: '2026-01-01', to: '2026-12-31' }, // over 92 days
            { gap: '4' },
            { gap: '1801' },
            { gap: '1.5' },
            { gap: 'abc' },
            { client: 'x'.repeat(201) },
        ]
        for (const bad of bads) {
            assert.ok('error' in parse(bad), JSON.stringify(bad))
        }
    })

    test('timezone aliases browsers send are accepted', () => {
        for (const tz of ['UTC', 'Asia/Kolkata', 'Asia/Calcutta', 'Europe/London', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5']) assert.ok(validTimeZone(tz), tz)
        for (const tz of ['', 'Nowhere', '../etc/passwd', 'UTC OR 1=1']) assert.ok(!validTimeZone(tz), tz)
    })

    test('the calendar day depends on the timezone', () => {
        assert.equal(dayIn(NOW, 'UTC'), '2026-11-01')
        assert.equal(dayIn(NOW, 'Asia/Kolkata'), '2026-11-02')
        assert.equal(dayIn(NOW, 'Pacific/Auckland'), '2026-11-02')
        assert.equal(dayIn(NOW, 'America/Los_Angeles'), '2026-11-01')
    })

    test('a range is "live" while it includes today', () => {
        const q = parse({ tz: 'UTC' }) as PresenceQuery
        assert.ok(includesToday(q, NOW))
        assert.ok(!includesToday({ ...q, from: '2026-10-01', to: '2026-10-31' }, NOW))
    })
})

describe('the query', () => {
    test('filters only when asked, and never puts values into the text', () => {
        const q = parse({ tz: 'UTC', client: "acme' OR 1=1 --", user: 'x@y.z' }) as PresenceQuery
        const sql = timedEvents(q)
        assert.match(sql, /client = \{client\}/)
        assert.match(sql, /user = \{user\}/)
        const inner = sql.slice(sql.indexOf('FROM events'), sql.indexOf(') WHERE day'))
        assert.match(inner, /client = \{client\}/)
        assert.match(inner, /user = \{user\}/)
        assert.match(inner, /timestamp >= toDateTime\(\{from\}, \{tz\}\)/)
        assert.match(sql.slice(sql.indexOf(') WHERE day')), /day <= toDate\(\{to\}\)$/)
        assert.ok(!sql.includes('acme'), 'the client is bound, not pasted')
        assert.ok(!sql.includes('x@y.z'))
        const all = timedEvents({ ...q, client: undefined, user: undefined })
        assert.ok(!all.includes('{client}') && !all.includes('{user}'))
        // The gap is per session, capped at PostHog's 30-minute session limit, and automatic events are left out.
        assert.match(sql, /PARTITION BY properties\.\$session_id/)
        assert.match(sql, /1800000/)
        assert.match(sql, /event NOT IN \{ignore\}/)
    })
})

// A stand-in for PostHog: answers each query by what it selects.
function fake(answers: { match: RegExp; rows: Record<string, unknown>[] }[]) {
    const calls: { query: string; values: Record<string, unknown> }[] = []
    const run = async (query: string, values: Record<string, unknown> = {}) => {
        calls.push({ query, values })
        return answers.find((a) => a.match.test(query))?.rows ?? []
    }
    return { run, calls }
}

describe('the report', () => {
    // Two hours of the same session, a second session, another day and another client.
    const rows = [
        { client: 'acme', user: 'a', sid: 's1', day: '2026-10-30', hour: 9, actions: 2, first: '2026-10-30 09:00:00', last: '2026-10-30 09:59:00', open_ms: 60_400, active_ms: 30_200 },
        { client: 'acme', user: 'a', sid: 's1', day: '2026-10-30', hour: 10, actions: 1, first: '2026-10-30 10:00:00', last: '2026-10-30 10:00:00', open_ms: 400, active_ms: 400 },
        { client: 'acme', user: 'b', sid: 's2', day: '2026-10-30', hour: 9, actions: 3, first: '2026-10-30 09:30:00', last: '2026-10-30 09:40:00', open_ms: 120_000, active_ms: 60_000 },
        { client: 'acme', user: 'a', sid: 's3', day: '2026-10-31', hour: 9, actions: 1, first: '2026-10-31 09:00:00', last: '2026-10-31 09:00:00', open_ms: 0, active_ms: 0 },
        { client: 'beta', user: 'a', sid: 's4', day: '2026-10-31', hour: 11, actions: 2, first: '2026-10-31 11:00:00', last: '2026-10-31 11:01:00', open_ms: 60_000, active_ms: 30_000 },
    ]
    const answers = [
        { match: /GROUP BY client, user, sid, day, hour/, rows },
        { match: /argMax/, rows: [{ client: 'acme', client_name: 'Acme' }, { client: 'beta', client_name: 'Beta' }] },
    ]

    test('derives every report section from grouped rows with one window and at most two sequential queries', async () => {
        const q = parse({ from: '2026-10-30', to: '2026-10-31', tz: 'Asia/Kolkata', gap: '30' }) as PresenceQuery
        const { run, calls } = fake(answers)
        let running = false
        const r = await presenceReport(q, SETTINGS, async (sql, values) => {
            assert.equal(running, false, 'queries must be sequential')
            running = true
            await Promise.resolve()
            const result = await run(sql, values)
            running = false
            return result
        })
        assert.deepEqual(r.totals, { clients: 2, people: 2, sessions: 4, actions: 9, open_s: 241, active_s: 121, idle_s: 120 })
        assert.deepEqual(r.days, [
            { day: '2026-10-30', clients: 1, people: 2, sessions: 2, open_s: 181, active_s: 91, idle_s: 90 },
            { day: '2026-10-31', clients: 2, people: 1, sessions: 2, open_s: 60, active_s: 30, idle_s: 30 },
        ])
        assert.deepEqual(r.hours, [
            { day: '2026-10-30', hour: 9, people: 2, open_s: 180, active_s: 90, idle_s: 90 },
            { day: '2026-10-30', hour: 10, people: 1, open_s: 0, active_s: 0, idle_s: 0 },
            { day: '2026-10-31', hour: 9, people: 1, open_s: 0, active_s: 0, idle_s: 0 },
            { day: '2026-10-31', hour: 11, people: 1, open_s: 60, active_s: 30, idle_s: 30 },
        ])
        assert.deepEqual(r.clients, [
            { client_id: 'acme', client_name: 'Acme', people: 2, sessions: 3, first: '2026-10-30T09:00:00.000Z', last: '2026-10-31T09:00:00.000Z', open_s: 181, active_s: 91, idle_s: 90 },
            { client_id: 'beta', client_name: 'Beta', people: 1, sessions: 1, first: '2026-10-31T11:00:00.000Z', last: '2026-10-31T11:01:00.000Z', open_s: 60, active_s: 30, idle_s: 30 },
        ])
        assert.equal(r.people, undefined)
        assert.equal(calls.length, 2)
        assert.equal(calls.filter(c => /leadInFrame/.test(c.query)).length, 1)
        assert.ok(!calls[0].query.includes('client_name'))
        for (const c of calls) {
            assert.equal(c.values.gap_ms, 30_000)
            assert.equal(c.values.tz, 'Asia/Kolkata')
            assert.deepEqual(c.values.ignore, ['$feature_flag_called'])
        }
    })

    test('client and person selections leave the client list complete and count distinct sessions', async () => {
        const q = parse({ from: '2026-10-30', to: '2026-10-31', tz: 'UTC', client: 'acme' }) as PresenceQuery
        const { run, calls } = fake(answers)
        const r = await presenceReport(q, SETTINGS, run)
        assert.deepEqual(r.people, [
            { user: 'b', sessions: 1, first: '2026-10-30T09:30:00.000Z', last: '2026-10-30T09:40:00.000Z', open_s: 120, active_s: 60, idle_s: 60 },
            { user: 'a', sessions: 2, first: '2026-10-30T09:00:00.000Z', last: '2026-10-31T09:00:00.000Z', open_s: 61, active_s: 31, idle_s: 30 },
        ])
        assert.equal(r.totals.sessions, 3)
        assert.equal(r.totals.clients, 1)
        assert.equal(r.clients.length, 2)
        assert.equal(calls.length, 2)
        const person = await presenceReport({ ...q, user: 'a' }, SETTINGS, run)
        assert.deepEqual(person.totals, { clients: 1, people: 1, sessions: 2, actions: 4, open_s: 61, active_s: 31, idle_s: 30 })
        assert.deepEqual(person.clients, r.clients)
        assert.deepEqual(person.people, [r.people![1]])
    })

    test('clamps active time to open time and falls back to the client id for a missing name', async () => {
        const { run } = fake([{ match: /GROUP BY client, user, sid/, rows: [{ ...rows[0], open_ms: 2000, active_ms: 2500 }] }])
        const r = await presenceReport(parse({ tz: 'UTC', client: 'acme' }) as PresenceQuery, SETTINGS, run)
        assert.equal(r.clients[0].client_name, 'acme')
        for (const t of [r.totals, ...r.days, ...r.hours, ...r.clients, ...r.people!]) {
            assert.equal(t.active_s, 2)
            assert.equal(t.idle_s, 0)
        }
        assert.equal(r.truncated, undefined)
        assert.equal(r.warning, undefined)
    })

    test('the safety limit returns a bounded partial report and says so', async () => {
        const { run, calls } = fake([{ match: /GROUP BY client, user, sid/, rows: Array(200_001).fill(rows[0]) }])
        const r = await presenceReport(parse({ tz: 'UTC' }) as PresenceQuery, SETTINGS, run)
        assert.equal(r.truncated, true)
        assert.match(r.warning!, /partial.*shorter/)
        assert.equal(r.totals.actions, 400_000)
        assert.equal(calls.length, 2)
        assert.match(calls[0].query, /LIMIT 200001$/)
    })

    test('an empty period is all zeros, not an error', async () => {
        const r = await presenceReport(parse({ tz: 'UTC' }) as PresenceQuery, SETTINGS, fake([]).run)
        assert.deepEqual(r.totals, { clients: 0, people: 0, sessions: 0, actions: 0, open_s: 0, active_s: 0, idle_s: 0 })
        assert.deepEqual(r.days, [])
    })

    test('the session log', async () => {
        const { run, calls } = fake([{ match: /argMax\(toString/, rows: [{ client: 'acme', client_name: 'Acme' }] }, { match: /GROUP BY sid/, rows: [{ sid: 's1', user: 'a@acme.example', client: 'acme', start: '2026-11-01 08:00:00', end: '2026-11-01 08:06:50', actions: 5, open_ms: 410_000, active_ms: 160_000 }] }])
        const s = await presenceSessions(parse({ tz: 'UTC', client: 'acme' }) as PresenceQuery, SETTINGS, 1000, run)
        assert.deepEqual(s, [{ session_id: 's1', user: 'a@acme.example', client_id: 'acme', client_name: 'Acme', start: '2026-11-01T08:00:00.000Z', end: '2026-11-01T08:06:50.000Z', actions: 5, open_s: 410, active_s: 160, idle_s: 250 }])
        assert.equal(calls[0].values.limit, 1000)
        assert.match(calls[0].query.slice(calls[0].query.indexOf('FROM events'), calls[0].query.indexOf(') WHERE day')), /client = \{client\}/)
        assert.ok(!calls[0].query.includes('client_name'), 'no names through the window sort')
        assert.deepEqual(calls[1].values.clients, ['acme'])
    })
})

describe('row limits', () => {
    // PostHog's query API returns only 100 rows when a query has no LIMIT of its own: a week of hours
    // (168 rows) was cut off before this test existed.
    test('every query sets its own LIMIT', async () => {
        const seen: string[] = []
        const run = async (query: string) => {
            seen.push(query)
            if (/toIntervalMinute/.test(query)) return [{ client: 'acme', client_name: 'Acme', user: 'a@acme.example', sid: 's1', last_seen: '2026-11-01 19:59:30' }]
            if (/GROUP BY sid ORDER BY start DESC/.test(query)) return [{ sid: 's1', user: 'a@acme.example', client: 'acme', start: '2026-11-01 09:00:00', end: '2026-11-01 09:10:00', actions: 3, open_ms: 1, active_ms: 1 }]
            return []
        }
        const q = parse({ tz: 'UTC', client: 'acme', from: '2026-08-04', to: '2026-11-01' }) as PresenceQuery
        await presenceReport(q, SETTINGS, run)
        await presenceSessions(q, SETTINGS, 1000, run)
        await liveNow('UTC', 60, SETTINGS, NOW, run)
        await personDay({ ...q, to: q.from, user: 'a@acme.example' }, SETTINGS, run)
        assert.equal(seen.length, 10)
        for (const query of seen) assert.match(query, /LIMIT (\d+|\{limit\})\s*$/, query.slice(0, 80))
        // 92 days of 24 hours must fit.
        const hours = seen.find((x) => /GROUP BY client, user, sid, day, hour/.test(x))!
        assert.ok(Number(/LIMIT (\d+)\s*$/.exec(hours)![1]) >= 92 * 24)
    })
})

describe('live now', () => {
    test('nobody live: one query, no follow-ups', async () => {
        const { run, calls } = fake([])
        assert.deepEqual(await liveNow('UTC', 60, SETTINGS, NOW, run), { minutes: 5, people: [] })
        assert.equal(calls.length, 1)
        assert.equal(calls[0].values.minutes, 5)
    })

    test("joins each live person to today's time and their session start", async () => {
        const { run, calls } = fake([
            { match: /toIntervalMinute/, rows: [
                { client: 'acme', client_name: 'Acme', user: 'a@acme.example', sid: 's1', last_seen: '2026-11-01 19:59:30' },
                { client: 'beta', client_name: 'Beta', user: 'b@beta.example', sid: 's2', last_seen: '2026-11-01 19:58:00' },
            ] },
            { match: /user IN \{users\}/, rows: [{ client: 'acme', user: 'a@acme.example', first: '2026-11-01 08:00:00', open_ms: 7_200_000, active_ms: 3_600_000 }] },
            { match: /IN \{sids\}/, rows: [{ sid: 's1', start: '2026-11-01 19:00:00' }] },
        ])
        const r = await liveNow('UTC', 60, SETTINGS, NOW, run)
        assert.equal(r.people.length, 2)
        assert.deepEqual(r.people[0], {
            client_id: 'acme',
            client_name: 'Acme',
            user: 'a@acme.example',
            session_id: 's1',
            last_seen: '2026-11-01T19:59:30.000Z',
            session_start: '2026-11-01T19:00:00.000Z',
            today: { first: '2026-11-01T08:00:00.000Z', open_s: 7200, active_s: 3600, idle_s: 3600 },
        })
        // No time found yet today (e.g. the first action just arrived): zeros, and the session starts at the last action.
        assert.deepEqual(r.people[1].today, { first: '2026-11-01T19:58:00.000Z', open_s: 0, active_s: 0, idle_s: 0 })
        assert.equal(r.people[1].session_start, '2026-11-01T19:58:00.000Z')
        const todayCall = calls.find((c) => /user IN \{users\}/.test(c.query))!
        assert.deepEqual(todayCall.values.users, ['a@acme.example', 'b@beta.example'])
        assert.equal(todayCall.values.from, '2026-11-01')
        assert.match(todayCall.query.slice(todayCall.query.indexOf('FROM events'), todayCall.query.indexOf(') WHERE day')), /user IN \{users\}/)
    })
})

describe("one person's day", () => {
    test('actions get short, readable names', () => {
        assert.equal(actionLabel('$pageview', '', '', '/invoices'), 'Opened /invoices')
        assert.equal(actionLabel('$autocapture', 'click', 'button.btn:text="Approve batch"nth-child="2";div.toolbar', '/payments'), 'Clicked "Approve batch"')
        assert.equal(actionLabel('$autocapture', 'change', 'input:attr__id="amount"', ''), 'Changed a field')
        assert.equal(actionLabel('$autocapture', 'submit', 'form:attr__id="f"', ''), 'Submitted something')
        assert.equal(actionLabel('$autocapture', 'click', 'span:text="' + 'x'.repeat(60) + '"', ''), 'Clicked "' + 'x'.repeat(39) + '…"')
        assert.equal(actionLabel('$autocapture', 'click', 'a:text="Say \\"hi\\""', ''), 'Clicked "Say "hi""')
        assert.equal(actionLabel('$autocapture', 'click', '', ''), 'Clicked something')
        assert.equal(actionLabel('invoice_export_started', '', '', '/invoices'), 'Invoice export started')
        assert.equal(actionLabel('$rageclick', 'click', '', ''), 'Clicked repeatedly')
        assert.equal(actionLabel('$some_new_event', '', '', ''), 'Some new event')
    })

    test('builds the day: actions in order, sessions with their recordings, totals', async () => {
        const q = { ...(parse({ tz: 'UTC', from: '2026-11-01', client: 'acme' }) as PresenceQuery), user: 'a@acme.example' }
        const { run, calls } = fake([
            { match: /argMax\(toString/, rows: [{ client: 'acme', client_name: 'Acme' }] },
            { match: /ORDER BY ts LIMIT/, rows: [
                { ts: '2026-11-01 09:00:00', sid: 's1', client: 'acme', client_name: 'Acme', event: '$pageview', etype: '', chain: '', screen: '/dashboard', gap: 30_000 },
                { ts: '2026-11-01 09:00:30', sid: 's1', client: 'acme', client_name: 'Acme', event: '$autocapture', etype: 'click', chain: 'button:text="Run"', screen: '/dashboard', gap: 600_000 },
                { ts: '2026-11-01 09:10:30', sid: 's1', client: 'acme', client_name: 'Acme', event: 'report_loaded', etype: '', chain: '', screen: '/dashboard', gap: 0 },
                { ts: '2026-11-01 14:00:00', sid: 's2', client: 'acme', client_name: 'Acme', event: '$pageview', etype: '', chain: '', screen: '/invoices', gap: 0 },
            ] },
            { match: /GROUP BY sid ORDER BY start DESC/, rows: [
                { sid: 's2', user: 'a@acme.example', client: 'acme', client_name: 'Acme', start: '2026-11-01 14:00:00', end: '2026-11-01 14:00:00', actions: 1, open_ms: 0, active_ms: 0 },
                { sid: 's1', user: 'a@acme.example', client: 'acme', client_name: 'Acme', start: '2026-11-01 09:00:00', end: '2026-11-01 09:10:30', actions: 3, open_ms: 630_000, active_ms: 90_000 },
            ] },
            { match: /raw_session_replay_events/, rows: [{ session_id: 's1', start: '2026-11-01 08:59:58' }] },
        ])
        const d = await personDay(q, SETTINGS, run, 5000)
        const detail = calls.find((c) => /ORDER BY ts LIMIT/.test(c.query))!
        assert.deepEqual(detail.values.sids, ['s2', 's1'], 'actions only for this person\'s sessions')
        assert.ok(calls.indexOf(detail) > calls.findIndex((c) => /GROUP BY sid/.test(c.query)), 'sessions first, then actions')
        assert.deepEqual(d.actions.map((a) => [a.t.slice(11, 19), a.label, a.gap_s, a.last]), [
            ['09:00:00', 'Opened /dashboard', 30, false],
            ['09:00:30', 'Clicked "Run"', 600, false],
            ['09:10:30', 'Report loaded', 0, true],
            ['14:00:00', 'Opened /invoices', 0, true],
        ])
        assert.deepEqual(d.sessions.map((x) => [x.session_id, x.recording_start]), [['s1', '2026-11-01T08:59:58.000Z'], ['s2', undefined]])
        assert.deepEqual(d.totals, { sessions: 2, actions: 4, first: '2026-11-01T09:00:00.000Z', last: '2026-11-01T14:00:00.000Z', longest_pause_s: 600, open_s: 630, active_s: 90, idle_s: 540 })
        assert.equal(d.client_name, 'Acme')
        assert.equal(d.truncated, false)
        // The person and the client are bound values, and the recording lookup only asks for this person's sessions.
        const main = calls.find((c) => /ORDER BY ts LIMIT/.test(c.query))!
        assert.match(main.query.slice(main.query.indexOf('FROM events'), main.query.indexOf(') WHERE day')), /user = \{user\}/)
        assert.equal(main.values.user, 'a@acme.example')
        assert.equal(main.values.limit, 5001)
        assert.deepEqual(calls.find((c) => /raw_session_replay_events/.test(c.query))!.values.ids, ['s2', 's1'])
    })

    test('two actions in the same second are not "the last action"', async () => {
        const at = (t: string, gap: number) => ({ ts: t, sid: 's1', client: 'acme', client_name: 'Acme', event: '$autocapture', etype: 'click', chain: '', screen: '', gap })
        const { run } = fake([
            { match: /ORDER BY ts LIMIT/, rows: [at('2026-11-01 09:00:00.100', 300), at('2026-11-01 09:00:00.400', 5000), at('2026-11-01 09:00:05.400', 0)] },
            { match: /GROUP BY sid ORDER BY start DESC/, rows: [{ sid: 's1', user: 'a', client: 'acme', start: '2026-11-01 09:00:00.100', end: '2026-11-01 09:00:05.400', actions: 3, open_ms: 5300, active_ms: 5300 }] },
        ])
        const d = await personDay({ ...(parse({ tz: 'UTC' }) as PresenceQuery), user: 'a' }, SETTINGS, run)
        assert.deepEqual(d.actions.map((a) => [a.gap_s, a.last]), [[0, false], [5, false], [0, true]])
    })

    test('a very busy day is cut at the limit, and says so', async () => {
        const rows = Array.from({ length: 4 }, (_, i) => ({ ts: `2026-11-01 09:00:0${i}`, sid: 's1', client: 'acme', client_name: 'Acme', event: 'x', etype: '', chain: '', screen: '', gap: 1000 }))
        const { run } = fake([{ match: /ORDER BY ts LIMIT/, rows }, { match: /GROUP BY sid ORDER BY start DESC/, rows: [{ sid: 's1', user: 'a@acme.example', client: 'acme', start: '2026-11-01 09:00:00', end: '2026-11-01 09:00:03', actions: 4, open_ms: 3000, active_ms: 3000 }] }])
        const d = await personDay({ ...(parse({ tz: 'UTC' }) as PresenceQuery), user: 'a@acme.example' }, SETTINGS, run, 3)
        assert.equal(d.actions.length, 3)
        assert.equal(d.truncated, true)
    })

    test('a day with nothing in it', async () => {
        const d = await personDay({ ...(parse({ tz: 'UTC' }) as PresenceQuery), user: 'nobody@acme.example' }, SETTINGS, fake([]).run)
        assert.deepEqual(d.totals, { sessions: 0, actions: 0, first: undefined, last: undefined, longest_pause_s: 0, open_s: 0, active_s: 0, idle_s: 0 })
        assert.deepEqual(d.actions, [])
    })
})
