import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { dayIn, includesToday, liveNow, parsePresenceQuery, presenceReport, presenceSessions, timedEvents, validTimeZone, type PresenceQuery, type PresenceSettings } from '../src/core/presence.ts'

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
    test('splits time into active and idle, in seconds, and passes the settings as values', async () => {
        const q = parse({ from: '2026-10-30', to: '2026-10-31', tz: 'Asia/Kolkata', gap: '30' }) as PresenceQuery
        const { run, calls } = fake([
            { match: /count\(\) AS actions/, rows: [{ clients: 2, people: 3, sessions: 4, actions: 50, open_ms: 3_600_400, active_ms: 1_200_400 }] },
            { match: /GROUP BY day, hour/, rows: [{ day: '2026-10-31', hour: 9, people: 2, open_ms: 60_000, active_ms: 30_000 }] },
            { match: /GROUP BY day ORDER BY day/, rows: [{ day: '2026-10-31', clients: 2, people: 3, sessions: 4, open_ms: 3_600_400, active_ms: 1_200_400 }] },
            { match: /GROUP BY client/, rows: [{ client: 'acme', client_name: 'Acme', people: 2, sessions: 3, first: '2026-10-31 08:00:00', last: '2026-10-31 10:00:00', open_ms: 2_000_000, active_ms: 2_500_000 }] },
        ])
        const r = await presenceReport(q, SETTINGS, run)
        assert.deepEqual(r.totals, { clients: 2, people: 3, sessions: 4, actions: 50, open_s: 3600, active_s: 1200, idle_s: 2400 })
        assert.deepEqual(r.hours, [{ day: '2026-10-31', hour: 9, people: 2, open_s: 60, active_s: 30, idle_s: 30 }])
        // Active can never be more than the time in the app.
        assert.equal(r.clients[0].active_s, 2000)
        assert.equal(r.clients[0].idle_s, 0)
        assert.equal(r.people, undefined, 'people only for one client')
        assert.equal(calls.length, 4)
        for (const c of calls) {
            assert.equal(c.values.gap_ms, 30_000)
            assert.equal(c.values.tz, 'Asia/Kolkata')
            assert.deepEqual(c.values.ignore, ['$feature_flag_called'])
        }
    })

    test('one client adds its people; the client list still covers every client', async () => {
        const q = parse({ tz: 'UTC', client: 'acme' }) as PresenceQuery
        const { run, calls } = fake([{ match: /GROUP BY user/, rows: [{ user: 'a@acme.example', sessions: 2, first: '2026-11-01 08:00:00', last: '2026-11-01 09:00:00', open_ms: 120_000, active_ms: 90_000 }] }])
        const r = await presenceReport(q, SETTINGS, run)
        assert.deepEqual(r.people, [{ user: 'a@acme.example', sessions: 2, first: '2026-11-01T08:00:00.000Z', last: '2026-11-01T09:00:00.000Z', open_s: 120, active_s: 90, idle_s: 30 }])
        const clientList = calls.find((c) => /GROUP BY client/.test(c.query))!
        assert.ok(!clientList.query.includes('{client}'), 'the client list is not filtered to the picked client')
        assert.ok(calls.filter((c) => !/GROUP BY client/.test(c.query)).every((c) => c.query.includes('client = {client}')))
    })

    test('an empty period is all zeros, not an error', async () => {
        const r = await presenceReport(parse({ tz: 'UTC' }) as PresenceQuery, SETTINGS, fake([]).run)
        assert.deepEqual(r.totals, { clients: 0, people: 0, sessions: 0, actions: 0, open_s: 0, active_s: 0, idle_s: 0 })
        assert.deepEqual(r.days, [])
    })

    test('the session log', async () => {
        const { run, calls } = fake([{ match: /GROUP BY sid/, rows: [{ sid: 's1', user: 'a@acme.example', client: 'acme', client_name: 'Acme', start: '2026-11-01 08:00:00', end: '2026-11-01 08:06:50', actions: 5, open_ms: 410_000, active_ms: 160_000 }] }])
        const s = await presenceSessions(parse({ tz: 'UTC', client: 'acme' }) as PresenceQuery, SETTINGS, 1000, run)
        assert.deepEqual(s, [{ session_id: 's1', user: 'a@acme.example', client_id: 'acme', client_name: 'Acme', start: '2026-11-01T08:00:00.000Z', end: '2026-11-01T08:06:50.000Z', actions: 5, open_s: 410, active_s: 160, idle_s: 250 }])
        assert.equal(calls[0].values.limit, 1000)
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
            return []
        }
        const q = parse({ tz: 'UTC', client: 'acme', from: '2026-08-04', to: '2026-11-01' }) as PresenceQuery
        await presenceReport(q, SETTINGS, run)
        await presenceSessions(q, SETTINGS, 1000, run)
        await liveNow('UTC', 60, SETTINGS, NOW, run)
        assert.equal(seen.length, 9)
        for (const query of seen) assert.match(query, /LIMIT (\d+|\{limit\})\s*$/, query.slice(0, 80))
        // 92 days of 24 hours must fit.
        const hours = seen.find((x) => /GROUP BY day, hour/.test(x))!
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
    })
})
