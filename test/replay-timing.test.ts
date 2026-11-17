import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TRIAGE_ENV_FILE = '/tmp/lens-replay-timing-absent.env'
const { config } = await import('../src/core/config.ts')
const { recordingInfo } = await import('../src/core/recording-info.ts')
const { findIncidents, recordingSpans } = await import('../src/core/incidents.ts')
const base = Date.parse('2026-11-01T10:00:00Z')
const iso = (ms: number) => new Date(base + ms).toISOString()
const reply = (rows: Record<string, unknown>[]) => {
    const columns = Object.keys(rows[0] || {})
    return Response.json({ columns, results: rows.map(r => columns.map(k => r[k])) })
}

test('recording moments use browser clock shift and do not exclude large skew from the query', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        if (url.includes('session_recordings')) return Response.json({ start_time: iso(0), end_time: iso(60000), recording_duration: 60 })
        const { query } = JSON.parse(String(init.body))
        assert.match(query.query, /properties\.\$time/)
        assert.match(query.query, /properties\.\$session_id.*\{sid\}/)
        assert.doesNotMatch(query.query, /AND timestamp [<>]/, 'a browser-clock recording cannot bound server timestamps')
        return reply([
            { event: '$pageview', timestamp: iso(-120000), ctime: base / 1000, path: '/trade' },
            { event: '$exception', timestamp: iso(-80000), ctime: (base + 40000) / 1000, etype: 'Error' },
            { event: '$rageclick', timestamp: iso(-70000), ctime: null, elements_chain: 'button' },
        ])
    })
    const info = await recordingInfo('s')
    assert.deepEqual(info.moments.map(m => m.offset_s), [0, 40, 50])
})

test('incident links apply per-session clock shifts without changing event timestamps', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
        const { query } = JSON.parse(String(init.body))
        if (query.query.includes('raw_session_replay_events')) return reply(['a', 'b'].map(session_id => ({ session_id, start: iso(0), end: iso(60000) })))
        return reply([
            { session_id: 'a', event: '$exception', timestamp: iso(10000), ctime: (base + 40000) / 1000 },
            { session_id: 'a', event: '$dead_click', timestamp: iso(15000), ctime: null },
            { session_id: 'b', event: '$exception', timestamp: iso(50000), ctime: (base + 20000) / 1000 },
        ])
    })
    const incidents = await findIncidents({ clientId: 'lab', from: new Date(iso(-120000)), to: new Date(iso(120000)) })
    assert.deepEqual(incidents.map(i => i.recording?.offset_s), [40, 45, 20])
    assert.equal(incidents[0].timestamp, iso(10000))
    assert.ok(!JSON.stringify(incidents).includes('ctime'))
})


test('task recording lookups batch session ids within the metadata row limit', async () => {
    const ids = Array.from({ length: 50001 }, (_, i) => `s${i}`)
    const batches: number[] = []
    const spans = await recordingSpans(ids, async (_query, values) => {
        const batch = values!.ids as string[]
        batches.push(batch.length)
        return batch.map(session_id => ({ session_id, start: iso(0), end: iso(60000) }))
    })
    assert.deepEqual(batches, [50000, 1])
    assert.equal(spans.size, ids.length)
})

test('a failed recording-span lookup does not fail task ingestion', async () => {
    const src = (await import('node:fs')).readFileSync('src/core/tasks.ts', 'utf8')
    assert.match(src, /recordingSpans\(\[\.\.\.by\.keys\(\)\], q\)\.catch\(\(\) => new Map/)
})
