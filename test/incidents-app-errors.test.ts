import assert from 'node:assert/strict'
import test from 'node:test'

// The app's own error messages are client incidents too (replay check 2026-11-17: a client who saw
// "Invalid trade" four times had "0 trouble events", because only PostHog's own trouble events were read).
process.env.TRIAGE_ENV_FILE = '/tmp/lens-incidents-app-errors-absent.env'
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { config } = await import('../src/core/config.ts')
const { findIncidents, bestPerSession } = await import('../src/core/incidents.ts')
const base = Date.parse('2026-11-17T19:42:00Z')
const iso = (ms: number) => new Date(base + ms).toISOString()
const reply = (rows: Record<string, unknown>[]) => {
    const columns = Object.keys(rows[0] || {})
    return Response.json({ columns, results: rows.map(r => columns.map(k => r[k])) })
}

test('Reval messagebox errors are found, templated, ranked with exceptions and linked to the replay', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    let sql = '', values: Record<string, unknown> = {}
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body))
        if (query.query.includes('raw_session_replay_events')) return reply([{ session_id: 's1', start: iso(0), end: iso(70000) }])
        if (query.query.includes('quantileExact')) return reply([{ sid: 's1', shift: 0, n: 10 }]) // session clock gap
        sql = query.query; values = query.values
        return reply([
            { session_id: 's1', event: 'Event', timestamp: iso(9000), ctime: null, app_message: 'Invalid trade 7,314,159.26 / CAD 2,718,281 / Zanthor Capital / TRD-90210-77', elements_chain: '' },
            { session_id: 's1', event: '$rageclick', timestamp: iso(2000), ctime: null, app_message: '', elements_chain: 'button:attr__id="save"' },
        ])
    })
    const incidents = await findIncidents({ clientId: 'LAB5', from: new Date(iso(-3600000)), to: new Date(iso(3600000)) })
    assert.match(sql, /event = \{app_event\} AND toString\(properties\.dialog_id\) IN \{app_dialogs\}/)
    assert.equal(values.app_event, 'Event')
    assert.deepEqual(values.app_dialogs, ['messagebox'])
    const app = incidents.find(i => i.kind === 'app_error')!
    assert.ok(app, 'the messagebox error is an incident')
    assert.equal(app.recording?.offset_s, 9)
    // a template: no raw amounts, trade ids or counterparty
    assert.doesNotMatch(app.error_message || '', /7,314,159|2,718,281|TRD-90210-77/)
    assert.match(app.error_message || '', /Invalid trade/)
    // one row per session: the error outranks the rage click
    assert.equal(bestPerSession(incidents)[0].kind, 'app_error')
})

test('asking only for PostHog kinds leaves app errors out', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    let sql = ''
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body)); if (query.query.includes('app_message') || query.query.includes('$rageclick')) sql ||= query.query
        return reply([])
    })
    await findIncidents({ clientId: 'LAB5', from: new Date(iso(-1)), to: new Date(iso(1)), kinds: ['rageclick'] })
    assert.doesNotMatch(sql, /app_dialogs/)
})

test('the clock gap comes from the session\'s ordinary events, not the trouble row (rage click sent at burst end)', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body))
        if (query.query.includes('raw_session_replay_events')) return reply([{ session_id: 's1', start: iso(11397), end: iso(75140) }])
        if (query.query.includes('quantileExact')) { assert.match(query.query, /NOT IN \('\$rageclick'/); return reply([{ sid: 's1', shift: 8589, n: 40 }]) }
        // the lab's real numbers: server 19:42:04.807, the rage click's own browser time 11.6 s later
        return reply([{ session_id: 's1', event: '$rageclick', timestamp: iso(4807), ctime: (base + 16420) / 1000, app_message: '', elements_chain: 'button:attr__id="save"' }])
    })
    const [i] = await findIncidents({ clientId: 'LAB4', from: new Date(iso(-3600000)), to: new Date(iso(3600000)), kinds: ['rageclick'] })
    assert.ok(Math.abs(i.recording!.offset_s - 2.0) < 0.1, `offset ${i.recording!.offset_s}`) // was 5.0
})
