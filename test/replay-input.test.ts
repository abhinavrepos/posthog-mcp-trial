import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { downloadName, formatClock, HourlyLimit, parseReplayInput, parseStartTime } from '../src/core/replay-input.ts'

const ID = '01a1910b-d34e-7b0c-9716-e5c2017950cf'

describe('replay input', () => {
    test('replay links, playlist links and bare ids all give the session; ?t= gives the start', () => {
        assert.deepEqual(parseReplayInput(`http://ph.example/project/1/replay/${ID}?t=42`), { sessionId: ID, startS: 42 })
        assert.deepEqual(parseReplayInput(`http://ph.example/project/1/replay/home?sessionRecordingId=${ID}`), { sessionId: ID })
        assert.deepEqual(parseReplayInput(`  ${ID.toUpperCase()} `), { sessionId: ID })
    })
    test('other links and junk are refused', () => {
        assert.equal(parseReplayInput('http://ph.example/project/1/insights/abc'), undefined)
        assert.equal(parseReplayInput('not a link'), undefined)
        assert.equal(parseReplayInput(`javascript:alert(1)//${ID}`), undefined)
    })
    test('start times in the forms people type', () => {
        assert.equal(parseStartTime('1:23'), 83)
        assert.equal(parseStartTime('1:02:03'), 3723)
        assert.equal(parseStartTime('83s'), 83)
        assert.equal(parseStartTime('12.9'), 12)
        assert.equal(parseStartTime('1:75'), undefined)
        assert.equal(parseStartTime('soon'), undefined)
        assert.equal(formatClock(3723), '1:02:03')
        assert.equal(formatClock(83), '1:23')
    })
    test('download names say whose clip it is', () => {
        assert.equal(
            downloadName({ client: 'Brightwater Logistics', user: 'ben.okafor@brightwater.example', recordingStart: '2026-10-31T08:16:47Z', startS: 2, endS: 32 }),
            'replay_brightwater-logistics_ben-okafor_2026-10-31_0m02s-0m32s.mp4'
        )
    })
    test('the hourly limit counts per person and frees up after an hour', () => {
        const l = new HourlyLimit(2)
        assert.equal(l.take('a', 0), true)
        assert.equal(l.take('a', 1), true)
        assert.equal(l.take('a', 2), false)
        assert.equal(l.take('b', 2), true)
        assert.equal(l.take('a', 3_600_001), true)
    })
})
