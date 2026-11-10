// Server calls from a recording's network timing, tied to attempts. Made-up recording lines in the
// shape PostHog's recorder writes (rrweb plugin events, "rrweb/network@1").
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { parseAppEvents, renderStory, toSteps, type RawEvent } from '../src/core/appevents.ts'
import { attemptTimings, clockShift, parseNetwork, pathTemplate } from '../src/core/replaynet.ts'

const reg = parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
const T0 = Date.parse('2026-11-05T10:00:00Z')
const req = (name: string, start_s: number, ms: number, extra: Record<string, unknown> = {}) => ({ name, method: 'POST', initiatorType: 'xmlhttprequest', timeOrigin: T0, startTime: start_s * 1000, endTime: start_s * 1000 + ms, ...extra })
const line = (requests: unknown[], ts = T0) => JSON.stringify(['win1', { type: 6, timestamp: ts, data: { plugin: 'rrweb/network@1', payload: { requests } } }])

describe('reading network timing from a recording', () => {
    const jsonl = [
        JSON.stringify(['win1', { type: 3, timestamp: T0, data: { source: 2 } }]),
        line([
            req('https://reval.example/reval/api/report/run?user=JDOPS&trade=4348', 10, 18_000, { status: 200 }),
            req('https://reval.example/static/app.js', 10, 300, { initiatorType: 'script', method: 'GET' }),
            req('https://ph.example/i/v0/e/?ip=1', 11, 50),
        ]),
        line([req('https://reval.example/reval/api/fas-link/3508/save', 40, 900, { status: 500 })]),
        '{not json',
    ].join('\n')
    const calls = parseNetwork(jsonl)
    test('keeps the app calls, drops scripts and PostHog calls', () => {
        assert.equal(calls.length, 2)
        assert.deepEqual(calls.map((c) => c.path), ['/reval/api/report/run', '/reval/api/fas-link/:id/save'])
    })
    test('timing and status', () => {
        assert.equal(calls[0].start, T0 + 10_000)
        assert.equal(calls[0].ms, 18_000)
        assert.equal(calls[1].status, 500)
    })
    test('no query strings, ids or bodies survive', () => {
        const all = JSON.stringify(parseNetwork(line([req('https://x/api/trade/50758?user=JDOPS', 1, 10, { requestBody: 'secret', responseBody: 'secret' })])))
        assert.ok(!/JDOPS|50758|secret/.test(all), all)
        assert.equal(pathTemplate('/api/user/GARCIAJ01/x'), '/api/user/:id/x')
    })
    test('a request reported twice counts once', () => {
        assert.equal(parseNetwork(line([req('https://x/api/a', 1, 10), req('https://x/api/a', 1.01, 10)])).length, 1)
    })
})

describe('attempts and their calls', () => {
    const ev = (s: number, e: Partial<RawEvent>): RawEvent => ({ sid: 's', ts: new Date(T0 + s * 1000).toISOString(), event: 'Event', dialog: 'D', dialogName: 'Accrual Report Parameters', ...e })
    const events = [
        ev(9.8, { button: 'Run' }),
        ev(28.5, { dialog: 'toast', button: '["The async report has been scheduled"]' }),
        ev(39.9, { dialog: 'F', dialogName: 'Hedge Designation', button: 'Save' }),
        ev(41, { dialog: 'messagebox', button: '["Please designate a risk. Could not save FAS Link."]' }),
    ]
    const steps = toSteps(events, reg)
    const calls = parseNetwork([line([req('https://x/api/report/run', 10, 18_000, { status: 200 })]), line([req('https://x/api/fas/1234/save', 40, 900, { status: 500 })])].join('\n'))
    const t = attemptTimings(steps, calls)
    test('each attempt gets the calls it started', () => {
        assert.equal(t.length, 2)
        assert.equal(Math.round(t[0].wait_ms / 1000), 18)
        assert.deepEqual(t[1].http_errors, [{ call: 'POST /api/fas/:id/save', status: 500 }])
    })
    test('the story says how long and what failed', () => {
        const text = renderStory(steps, reg, { timings: new Map(t.map((x) => [x.step, x])) }).lines.join('\n')
        assert.match(text, /pressed \[Run\] → queued \(waited 18 s, POST \/api\/report\/run\)/)
        assert.match(text, /pressed \[Save\] → FAILED \(waited 1\.0 s, POST \/api\/fas\/:id\/save, HTTP 500 on POST \/api\/fas\/:id\/save\)/)
    })
    test('the browser clock can be off: the shift lines them up', () => {
        const skewed = events.map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) - 108_000).toISOString(), ctime: Date.parse(e.ts) }))
        const st = toSteps(skewed, reg)
        assert.equal(attemptTimings(st, calls).length, 0, 'without the shift nothing matches')
        assert.equal(clockShift(skewed), 108_000)
        assert.equal(attemptTimings(st, calls, clockShift(skewed)).length, 2)
    })
})
