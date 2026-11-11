// Made-up Reval data only. All orchestration sources are replaced; no live services.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-brief-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { db } = await import('../src/core/db.ts')
const { toSteps, appEvents } = await import('../src/core/appevents.ts')
const { briefContributions, briefFindings, briefSources, briefWindow, composeBrief, confidentClient, detectBriefKind, exampleSummary, oneUserDominates, rankBriefFindings, revalBrief } = await import('../src/core/brief.ts')
import type { BriefFinding, BriefResults } from '../src/core/brief.ts'
import type { ClientSignals, DialogFriction, FrictionResult, Pain, RawEvent, SessionStoryResult } from '../src/core/appevents.ts'
import type { ClientMatch } from '../src/core/resolve.ts'
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const window = { from: '2026-10-27T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z', label: 'last 14 days' }
const before = { from: '2026-10-13T12:00:00.000Z', to: window.from }
const client: ClientMatch = { id: 'ACME', name: 'ACME Treasury', confidence: 1, via: 'name', events_90d: 500 }
const names = new Map([
    ['DlgHedge', { name: 'Hedge Designation', opens: 10, sessions: 8, clients: 2 }], ['DlgTemplate', { name: 'Hedge Designation Template Selection', opens: 8, sessions: 6, clients: 2 }], ['DlgSwap', { name: 'IR Swap', opens: 5, sessions: 4, clients: 1 }],
])
const pain = (overrides: Partial<Pain> = {}): Pain => ({
    rank: 1, dialog: 'DlgHedge', name: 'Hedge Designation', headline: 'Made-up headline',
    main_error: 'Please designate a risk. Could not save FAS Link.', clients_hit: ['ACME', 'BETA'],
    failed_attempts: 7, attempts: 18, stuck_sessions: 2, retry_loops: 3, trend: 'worse',
    before: { clients_hit: 1, failed_attempts: 1, attempts: 16 },
    example: { session_id: 'fake-session-1', at: window.from }, score: 42, ...overrides,
})
const friction = (overrides: Partial<DialogFriction> = {}): DialogFriction => ({
    dialog: 'DlgHedge', name: 'Hedge Designation', opens: 18, sessions: 8, clients: 2, attempts: 18,
    outcomes: { completed: 8, accepted: 1, error: 7, empty: 0, none: 2 }, failure_rate: 0.39,
    sessions_with_errors: 5, clients_with_errors: ['ACME', 'BETA'], retry_loops: 3, stuck_sessions: 2,
    errors: [{ text: 'Please designate a risk. Could not save FAS Link.', count: 7, sessions: 5, clients: ['ACME', 'BETA'], messages: [], example: { session_id: 'fake-session-1', ts: window.from, message: 'Please designate a risk. Could not save FAS Link.' } }], ...overrides,
})
const frictionResult = (dialogs = [friction()]): FrictionResult => ({ window, dialogs, rows_read: 100, truncated: false, note: '' })
const signal = (overrides: Partial<ClientSignals> = {}): ClientSignals => ({
    client: 'ACME', now: { sessions: 8, users: ['u1', 'u2'], days: 3, dialogs: 4, attempts: 18, errors: 9, failure_rate: 0.5 },
    before: { sessions: 20, users: ['u1', 'u2', 'u3'], days: 6, dialogs: 9, attempts: 16, errors: 1, failure_rate: 0.06 },
    last_seen: window.to, quiet_users: ['u3'], signals: ['sessions down 60% (20 → 8)'], weight: 3, ...overrides,
})
const story: SessionStoryResult = {
    session_id: 'fake-session-1', client: 'ACME', user: 'u1', start: window.from, end: window.to,
    summary: '3 attempts, 2 failed.', story: ['opened an unrelated dialog', 'pressed Save → FAILED', '✘ ERROR: Please designate a risk. Could not save FAS Link.', 'changed Hedged Item Type', 'many more unrelated actions'],
    errors: [{ at: '+0:20', dialog: 'Hedge Designation', text: 'Please designate a risk. Could not save FAS Link.', replay_url: 'https://example.test/replay/fake-session-1?t=10' }],
    replay_url: 'https://example.test/replay/fake-session-1', network: 'no recording', truncated: false,
}
const results = (overrides: Partial<BriefResults> = {}): BriefResults => ({
    route: { kind: 'general' }, window,
    pains: { window, pains: [pain()], clients_needing_attention: [], note: '' }, stories: [story],
    links: { 'fake-session-1': story.replay_url! }, ...overrides,
})
function data(text: string) {
    assert.ok(text.includes('<!-- data -->\n```json\n'))
    return JSON.parse(text.split('<!-- data -->\n```json\n')[1].split('\n```')[0]) as {
        kind: string; findings: { kind: string; title: string; numbers: Record<string, number>; clients: string[]; evidence_ids: string[]; one_user?: { count: number; total: number } }[]
    }
}

// Sources that were not expected to be called fail, rather than accidentally reaching PostHog.
function sources(overrides: Partial<typeof briefSources> = {}): typeof briefSources {
    const unexpected = async (): Promise<never> => { throw new Error('unexpected source') }
    return { resolveClient: async () => [], dialogNames: async () => names,
        topPains: unexpected, clientSignalsReport: unexpected, dialogFriction: unexpected,
        slowAttempts: unexpected, findTrade: unexpected, sessionStory: unexpected,
        recordingSpans: async () => new Map(), contributions: async () => ({ counts: {}, clientCounts: {}, truncated: false }), ...overrides }
}

describe('deterministic brief routing', () => {
    test('trade ids in questions win, including link/id and optional separators', () => {
        for (const question of ['what happened to trade 4348', 'link id: 004348', 'id #123', 'TRADE 123456789012345'])
            assert.equal(detectBriefKind({ question }, [client], names).kind, 'trade', question)
        assert.equal(detectBriefKind({ trade: '12', client: 'ACME' }, [client]).target, '12')
        for (const question of ['trade 12', 'trade 1234567890123456', 'trade 123abc', '4348']) assert.equal(detectBriefKind({ question }).kind, 'general')
    })
    test('only confident, unambiguous known clients are accepted', () => {
        assert.equal(detectBriefKind({ question: 'how is ACME Treasury doing?' }, [client], names).clientId, 'ACME')
        assert.equal(detectBriefKind({ question: 'hedge designation' }, [{ ...client, confidence: 0.9 }], names).kind, 'dialog')
        assert.equal(confidentClient([client, { ...client, id: 'OTHER', confidence: 0.95 }]), undefined)
        assert.equal(confidentClient([client, { ...client, id: 'OTHER', confidence: 0.9 }])?.id, 'ACME')
        assert.equal(detectBriefKind({ client: 'explicit' }).kind, 'client')
        assert.equal(detectBriefKind({ client: 'ACME', dialog: 'DlgSwap' }, [client]).kind, 'client')
    })
    test('dialog names/codes use whole words, ignore case, and prefer the longest match', () => {
        assert.equal(detectBriefKind({ question: 'is hedge designation a problem?' }, [], names).target, 'DlgHedge')
        assert.equal(detectBriefKind({ question: 'look at DLGHEDGE' }, [], names).target, 'DlgHedge')
        assert.equal(detectBriefKind({ question: 'hedge designation template selection' }, [], names).target, 'DlgTemplate')
        for (const question of ['IR Swapper', 'DlgHedgeExtra', 'brief me']) assert.equal(detectBriefKind({ question }, [], names).kind, 'general')
        assert.equal(detectBriefKind({ dialog: 'explicit' }).kind, 'dialog')
    })
    test('defaults and supplied time phrases use the shared timezone-aware parser', () => {
        const now = new Date(window.to)
        assert.equal(briefWindow({}, 'general', now).from.toISOString(), window.from)
        assert.equal(briefWindow({}, 'client', now).label, 'last 14 days')
        assert.equal((now.getTime() - briefWindow({}, 'trade', now).from.getTime()) / 86400000, 30)
        assert.equal(briefWindow({ question: 'brief me last week' }, 'general', now).label, 'the last 7 days')
        assert.equal(briefWindow({ when: 'yesterday', timezone: 'America/New_York' }, 'dialog', now).from.toISOString(), '2026-11-09T05:00:00.000Z')
    })
})

describe('ranking and one-user concentration', () => {
    test('counts only actual failures and accepted is not completed for blocked work', () => {
        const session = (sid: string, user: string, outcome: 'accepted' | 'completed'): RawEvent[] => [
            { sid, user, ts: '2026-11-01T10:00:00Z', event: 'Event', dialog: 'DlgHedge', button: 'Save' },
            { sid, user, ts: '2026-11-01T10:00:01Z', event: 'Event', dialog: 'messagebox', button: '["Please designate a risk."]' },
            { sid, user, ts: '2026-11-01T10:00:02Z', event: 'Event', dialog: 'DlgHedge', button: 'Run' },
            { sid, user, ts: '2026-11-01T10:00:03Z', event: 'Event', dialog: 'toast', button: outcome === 'accepted' ? '["Report has been scheduled"]' : '["Trade Id 4348 Updated"]' },
            { sid, user, ts: '2026-11-01T10:00:04Z', event: 'Event', dialog: 'DlgHedge', button: 'Run' }, // no message is not a failure
        ]
        const c = briefContributions([toSteps(session('s1', 'u1', 'accepted'), appEvents()!), toSteps(session('s2', 'u2', 'completed'), appEvents()!)])
        assert.deepEqual(c.DlgHedge, { total: 2, largest: 1, users: 2, blocked_users: 1 })
        assert.equal(oneUserDominates(c.DlgHedge), false)
        assert.equal(oneUserDominates({ total: 3, largest: 2, users: 2, blocked_users: 1 }), true)
    })
    test('breadth and independent blocked users beat a single noisy user', () => {
        const make = (title: string, clients: string[], blocked: number, users: number, total: number): BriefFinding => ({
            kind: 'dialog', title, numbers: {}, clients, evidence: [], detail: '', next: '', blocked, repeats: total,
            dominance: { total, largest: users === 1 ? total : total / users, users, blocked_users: users },
        })
        const noise = make('noise', ['A'], 100, 1, 1000)
        const blocked = make('blocked', ['A'], 2, 2, 2)
        const broad = make('broad', ['A', 'B'], 1, 1, 1)
        assert.deepEqual(rankBriefFindings([noise, blocked, broad]).map((f) => f.title), ['broad', 'blocked', 'noise'])
        const output = composeBrief(results({ contributions: { DlgHedge: { total: 7, largest: 5, users: 2, blocked_users: 1 } } }))
        assert.match(output, /One user accounts for 5 of 7 failed attempts/)
        assert.deepEqual(data(output).findings[0].one_user, { count: 5, total: 7 })
    })
})

describe('pure brief composition', () => {
    test('renders denominators, comparison, clients, linked evidence, summary, concrete next step and data', () => {
        const output = composeBrief(results())
        assert.match(output, /^# Reval brief/)
        assert.match(output, /7 of 18 attempts failed, against 1 of 16 in the 14 days before/)
        assert.match(output, /Clients hit: ACME, BETA/)
        assert.match(output, /Evidence: \[fake-session-1\]\(https:\/\/example.test\/replay\/fake-session-1\)/)
        assert.match(output, /changed Hedged Item Type/)
        assert.doesNotMatch(output, /many more unrelated actions/)
        assert.match(output, /Next step: Check whether/)
        assert.match(output, /A queued report is not a finished one\. No message is not a failure\./)
        assert.equal(data(output).findings[0].numbers.failed, 7)
        assert.equal(data(output).findings[0].numbers.before_attempts, 16)
        assert.deepEqual(data(output).findings[0].evidence_ids, ['fake-session-1'])
        assert.ok(output.length <= 4000)
        assert.equal(exampleSummary(story).split(' / ').length, 3)
    })
    test('preserves client message denominators without claiming every error is a failed attempt', () => {
        const output = composeBrief(results({ signals: { now: window, before, clients: [signal()], quiet_clients: 0, note: '' }, question: 'what changed after release 26.10?' }))
        assert.match(output, /9 error messages in 18 attempts, against 1 in 16/)
        assert.match(output, /Less use is a warning sign, not proof a client will leave/)
        assert.match(output, /associated, not proven caused/)
        assert.match(output, /Client error messages are not necessarily failed attempts/)
        assert.ok(data(output).findings.some((f) => f.kind === 'client'))
    })
    test('does not invent previous counts when the previous report failed', () => {
        const output = composeBrief(results({ pains: undefined, friction: frictionResult(), previous: undefined }))
        assert.match(output, /previous-period counts unavailable/)
        assert.equal(data(output).findings[0].numbers.before_failed, null)
    })
    test('reports sparse, capped and missing recording evidence honestly', () => {
        const output = composeBrief(results({ pains: undefined, stories: [], links: {}, friction: { ...frictionResult([friction({ attempts: 2 })]), truncated: true }, timings: { sessions_read: 0, sessions_without_network: 0, attempts: [], note: '' } }))
        assert.match(output, /Little data/)
        assert.match(output, /row cap was reached/)
        assert.match(output, /no recording/)
        assert.match(output, /No usable recording timings/)
        assert.match(output, /Evidence: fake-session-1/)
        assert.match(composeBrief(results({ pains: undefined })), /does not prove there were no problems/)
    })
    test('includes at most three findings, plus signals, inside 4,000 characters with valid JSON', () => {
        const r = results({ pains: { window, pains: [pain(), pain({ dialog: 'DlgSwap', name: 'IR Swap' }), pain({ dialog: 'DlgImport', name: 'Import' })], clients_needing_attention: [], note: '' },
            signals: { now: window, before, clients: [signal(), signal({ client: 'BETA' }), signal({ client: 'GAMMA' })], quiet_clients: 0, note: '' } })
        const output = composeBrief(r)
        assert.ok(output.length <= 4000, `${output.length} characters`)
        assert.ok(data(output).findings.length <= 3)
        assert.ok(data(output).findings.some((f) => f.kind === 'client'))
        assert.match(output, /Example:/)
        const huge = composeBrief(results({ pains: { window, pains: [pain({ clients_hit: Array.from({ length: 200 }, (_, i) => `client-${i}-${'x'.repeat(100)}`), main_error: 'x'.repeat(9000) })], clients_needing_attention: [], note: '' } }))
        assert.ok(huge.length <= 4000, `${huge.length} characters`)
        assert.equal(data(huge).findings[0].numbers.attempts, 18)
    })
    test('trade outcomes keep queued/none distinct and expose bounded lookup limits', () => {
        const output = composeBrief(results({ route: { kind: 'trade', target: '4348' }, pains: undefined,
            trade: { id: '4348', note: '', sessions: [{ session_id: 'fake-session-1', client: 'ACME', user: 'u1', first_seen: window.from, how: ['searched for it'], errors_after: [], attempts_after: ['error', 'accepted', 'none'].map((outcome) => ({ at: window.from, dialog: 'IR Swap', button: 'Run', outcome: outcome as 'error' | 'accepted' | 'none' })) }] } }))
        assert.match(output, /1 of 3 returned attempts failed; 0 completed and 1 queued/)
        assert.match(output, /Previous period not queried/)
        assert.match(output, /unnamed errors are associated/)
        assert.equal(data(output).kind, 'trade')
        assert.equal(data(output).findings[0].numbers.queued, 1)
    })
})

describe('brief investigation with stubbed sources', () => {
    test('trade defaults to 30 days and resolves a client filter without unrelated reports', async () => {
        let checked = false
        const output = await revalBrief({ question: 'trade 4348 for ACME Treasury' }, sources({
            resolveClient: async () => [client],
            findTrade: async (q) => {
                assert.equal(q.id, '4348'); assert.equal(q.clientId, 'ACME')
                assert.equal((q.to.getTime() - q.from.getTime()) / 86400000, 30)
                checked = true
                return { id: q.id, sessions: [], note: '' }
            },
        }), new Date(window.to))
        assert.ok(checked)
        assert.equal(data(output).kind, 'trade')
        assert.doesNotMatch(output, /unavailable/)
    })
    test('client calls period signals, current/previous friction, and just one example', async () => {
        const queries: { from: Date; to: Date; clientId?: string }[] = []
        let stories = 0
        const output = await revalBrief({ question: 'how is ACME Treasury doing?' }, sources({
            resolveClient: async () => [client],
            clientSignalsReport: async (q) => { assert.equal(q.clientId, 'ACME'); return { now: window, before, clients: [signal()], quiet_clients: 0, note: '' } },
            dialogFriction: async (q) => { queries.push(q); return frictionResult() },
            sessionStory: async (sid) => { assert.equal(sid, story.session_id); stories++; return story },
        }), new Date(window.to))
        assert.equal(data(output).kind, 'client')
        assert.equal(queries.length, 2)
        assert.equal(queries[1].from.toISOString(), before.from)
        assert.equal(queries[1].to.toISOString(), before.to)
        assert.ok(queries.every((q) => q.clientId === 'ACME'))
        assert.equal(stories, 1)
        await assert.rejects(revalBrief({ client: 'unknown' }, sources()), /No unambiguous client/)
    })
    test('dialog samples at most six recordings and quietly handles absent recordings', async () => {
        let sample = 0
        const output = await revalBrief({ question: 'is hedge designation a problem?' }, sources({
            dialogFriction: async (q) => { assert.equal(q.dialog, 'DlgHedge'); return frictionResult() },
            slowAttempts: async (q) => { sample = q.sessions!; return { sessions_read: 0, sessions_without_network: 0, attempts: [], note: '' } },
            sessionStory: async () => story,
        }), new Date(window.to))
        assert.equal(data(output).kind, 'dialog')
        assert.equal(sample, 6)
        assert.match(output, /No usable recording timings/)
        assert.doesNotMatch(output, /Attempt timings unavailable/)
    })
    test('general asks for at most three pains and retains useful partial results on query failure', async () => {
        const output = await revalBrief({}, sources({
            topPains: async (q) => { assert.equal(q.max, 3); return results().pains! },
            sessionStory: async () => story,
        }), new Date(window.to))
        assert.equal(data(output).kind, 'general')
        assert.match(output, /Client signals unavailable/)
        assert.match(output, /7 of 18 attempts/)
        assert.equal(briefFindings(results()).length, 1)
    })
})

describe('brief caching and narrow concentration reads', () => {
    test('default brief skips routing vocabulary, shares work and returns the same composed answer', async (t) => {
        const { clearPosthogCache } = await import('../src/core/posthog.ts')
        clearPosthogCache(); t.after(clearPosthogCache)
        let pains = 0
        const fake = sources({
            dialogNames: async () => { throw new Error('default brief must not query dialog names') },
            topPains: async () => { pains++; return results().pains! },
            clientSignalsReport: async () => ({ now: window, before, clients: [], quiet_clients: 0, note: '' }),
            sessionStory: async () => story,
        })
        for (const key of Object.keys(fake) as (keyof typeof briefSources)[]) t.mock.method(briefSources, key, fake[key])
        const [a, b] = await Promise.all([revalBrief({}, briefSources, new Date(window.to)), revalBrief({}, briefSources, new Date(window.to))])
        assert.equal(a, b)
        assert.equal(pains, 1)
        assert.doesNotMatch(a, /unavailable/)
        assert.equal(await revalBrief({}, briefSources, new Date(window.to)), a)
        assert.equal(pains, 1)
    })
    test('concentration reads bound dates, sort keys, and preserve failed-attempt/user counts', async (t) => {
        const { clearPosthogCache } = await import('../src/core/posthog.ts')
        const { config } = await import('../src/core/config.ts')
        const old = { ...config.posthog }
        Object.assign(config.posthog, { projectId: 'brief-test', personalApiKey: 'test-key' })
        clearPosthogCache()
        t.after(() => { Object.assign(config.posthog, old); clearPosthogCache() })
        const rows: RawEvent[] = [
            { sid: 'one', ts: window.from, event: 'PageView', client: 'ACME', user: 'u', dialog: 'DlgHedge', action: 'OPEN' },
            { sid: 'one', ts: '2026-10-27T12:00:01Z', event: 'Event', client: 'ACME', user: 'u', dialog: 'DlgHedge', action: '', button: 'Save' },
            { sid: 'one', ts: '2026-10-27T12:00:02Z', event: 'Event', client: 'ACME', user: 'u', dialog: 'messagebox', action: '', button: 'Cannot save' },
        ]
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
            const { query, values } = JSON.parse(String(init.body)).query
            assert.match(query, /timestamp >= \{from\} AND timestamp < \{to\}/)
            assert.match(query, /SELECT uuid FROM events/)
            assert.match(query, /ORDER BY \$session_id, timestamp, uuid LIMIT 50000\s*\) LIMIT 50000/)
            assert.doesNotMatch(query, /properties\.\$session_id|ORDER BY sid, ts/)
            assert.equal(values.from, window.from)
            const columns = ['sid', 'ts', 'event', 'client', 'user', 'dialog', 'action', 'button'] as const
            return new Response(JSON.stringify({ columns, results: [...rows].reverse().map((r) => columns.map((c) => r[c])) }))
        })
        const got = await briefSources.contributions(new Date(window.from), new Date(window.to))
        assert.deepEqual(got.counts, briefContributions([toSteps(rows, appEvents()!)]))
        assert.deepEqual(got.clientCounts.ACME, { total: 1, largest: 1, users: 1, blocked_users: 0 })
        assert.equal(got.truncated, false)
    })
})
