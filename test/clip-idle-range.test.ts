import assert from 'node:assert/strict'
import test from 'node:test'

// Replay check 2026-11-17, idle persona: the recording spans 1.4 s (the recorder sends nothing while the page
// does not change) but the person stayed 70 s. A clip of that stretch is the still page, not "beyond the end".
process.env.TRIAGE_ENV_FILE = '/tmp/lens-clip-idle-absent.env'
const { config } = await import('../src/core/config.ts')
const { clipRange } = await import('../src/core/clip.ts')
const start = '2026-11-17T19:42:11.486Z'
const reply = (rows: Record<string, unknown>[]) => {
    const columns = Object.keys(rows[0] || {})
    return Response.json({ columns, results: rows.map(r => columns.map(k => r[k])) })
}

function mock(t: import('node:test').TestContext, lastEvent: string | null) {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        if (String(url).includes('session_recordings')) return Response.json({ start_time: start, end_time: '2026-11-17T19:42:12.872Z', recording_duration: 1 })
        return reply([{ last: lastEvent }])
    })
}

test('an idle stretch after the last snapshot is clipped for its real length', async t => {
    mock(t, '2026-11-17T19:43:21.500Z') // the session's last event, 70 s after the recording started
    assert.deepEqual(await clipRange({ sessionId: 'idle', startOffsetS: 5, durationS: 10 }), { sessionId: 'idle', startOffsetS: 5, durationS: 10 })
    const tail = await clipRange({ sessionId: 'idle', startOffsetS: 50, durationS: 30 }) // clamped to the session's end
    assert.equal(tail.startOffsetS, 50); assert.ok(Math.abs(tail.durationS - 20) < 0.1, String(tail.durationS))
    await assert.rejects(clipRange({ sessionId: 'idle', startOffsetS: 75, durationS: 10 }), /beyond recording end/)
})

test('without events the recording length still bounds the clip', async t => {
    mock(t, null)
    await assert.rejects(clipRange({ sessionId: 'idle', startOffsetS: 5, durationS: 10 }), /beyond recording end/)
    assert.equal((await clipRange({ sessionId: 'idle', startOffsetS: 0, durationS: 30 })).durationS, 1)
})
