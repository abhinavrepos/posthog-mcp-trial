import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { signalsFromReplay } from '../src/core/replaysignals.ts'
import { canaryStrings } from '../scripts/replay-lab/canaries.ts'

const dir = new URL('./fixtures/replay-lab/', import.meta.url)
const truth = JSON.parse(readFileSync(new URL('ground-truth.json', dir), 'utf8')) as {
    sessions: Record<string, { persona: string; session_id: string; duration_ms: number; expected: Record<string, number> }>
}
const fixtures = readdirSync(dir).filter(f => f.endsWith('.jsonl'))
test('every real recording has ground truth and every ground-truth session has a recording', () => {
    assert.deepEqual(fixtures.sort(), Object.values(truth.sessions).map(t => `${t.persona}-${t.session_id}.jsonl`).sort())
})
for (const t of Object.values(truth.sessions)) test(`real replay: ${t.persona} ${t.session_id}`, () => {
    const raw = readFileSync(new URL(`${t.persona}-${t.session_id}.jsonl`, dir), 'utf8')
    // The idle recording contains no events after typing. Use observed session
    // duration, not an invented heartbeat or the persona's expected idle minimum.
    const s = signalsFromReplay(raw, t.duration_ms, { names: ['notional', 'rate', 'trade date', 'tradedate', 'counterparty', 'save', 'preview'] }), e = t.expected
    assert.ok(e.rage_click_bursts ? s.rage_clicks.length >= e.rage_click_bursts : s.rage_clicks.length === 0, 'rage')
    if (e.dead_target_clicks) assert.ok(s.dead_clicks.length >= 1, 'dead clicks')
    if (t.persona === 'smooth' || t.persona === 'error-looping') assert.equal(s.dead_clicks.length, 0, 'responsive clicks')
    assert.ok(e.error_submissions ? s.errors_shown.length >= Math.min(2, e.error_submissions) : s.errors_shown.length === 0, 'errors')
    const loops = s.error_loops.reduce((sum, l) => sum + l.count, 0)
    assert.ok(e.error_retries ? loops >= 1 : loops === 0, 'error loops')
    if (e.hesitations) assert.ok(s.hesitations.length >= 1, 'hesitations')
    if (e.circling_bursts_min) assert.ok(s.cursor.circling_bursts >= e.circling_bursts_min, 'circling')
    if (e.hunting_bursts_min) assert.ok(s.scroll.hunting_bursts >= e.hunting_bursts_min, 'hunting')
    if (e.idle_ms_min) assert.ok(s.idle_ms >= e.idle_ms_min * 0.8, 'idle')
    assert.equal(s.active_ms + s.idle_ms, s.duration_ms)
    const out = JSON.stringify(s)
    for (const c of canaryStrings) for (const variant of [c, c.replace(/,/g, ''), c.toLowerCase(), encodeURIComponent(c)]) {
        assert.ok(!out.includes(variant), 'canary must not survive in signals')
    }
})
