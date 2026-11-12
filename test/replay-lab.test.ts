import assert from 'node:assert/strict'
import test from 'node:test'
import { planSessions, PROFILES } from '../scripts/replay-lab/planner.ts'
import { canaryStrings } from '../scripts/replay-lab/canaries.ts'
import { renderPage, startServer } from '../scripts/replay-lab/serve.ts'
// Also brings the CLI into the project typecheck without running browsers on import.
import { main } from '../scripts/replay-lab/run.ts'

test('each client keeps a distinct, deterministic profile across sessions', () => {
    const clients = ['LAB1', 'LAB2', 'LAB3', 'LAB4', 'LAB5', 'LAB6']
    const plans = planSessions(18, clients)
    assert.deepEqual(plans, planSessions(18, clients))
    for (let i = 0; i < plans.length; i++) {
        assert.equal(plans[i].persona, PROFILES[i % 6][0])
        assert.equal(plans[i].clientId, clients[i % 6])
        assert.ok(plans[i].durationMs >= 60_000 && plans[i].durationMs <= 120_000)
    }
    assert.equal(new Set(plans.slice(0, 6).map(p => p.clientName)).size, 6)
})
test('planner rejects invalid session counts and client sets', () => {
    for (const count of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => planSessions(count, ['LAB1']))
    for (const clients of [[], ['A', 'A'], [''], ['bad/id'], ['A', 'B', 'C', 'D', 'E', 'F', 'G']]) assert.throws(() => planSessions(1, clients))
})
test('error persona edits the same field before all four submissions', () => {
    const plan = planSessions(6, ['A', 'B', 'C', 'D', 'E', 'F'])[4]
    const submits = plan.actions.filter(a => a.kind === 'click' && a.selector === '#save')
    const edits = plan.actions.filter(a => a.kind === 'type' && a.selector === '#counterparty')
    assert.equal(submits.length, 4)
    assert.equal(edits.length, 4)
    for (let i = 0; i < plan.actions.length; i++) {
        const action = plan.actions[i]
        if (action.kind === 'click' && action.selector === '#save') assert.equal(plan.actions[i - 1].kind, 'type')
    }
    assert.equal(plan.expected.error_retries, 3)
    assert.equal(plan.expected.error_submissions, 4)
})
test('rage, dead, hunting, hesitation and idle plans carry their intended counts', () => {
    const plans = planSessions(6, ['A', 'B', 'C', 'D', 'E', 'F'])
    assert.ok(plans[3].actions.some(a => a.kind === 'click' && a.selector === '#save' && a.count === 4 && a.gapMs * 3 < 1000))
    assert.ok(plans[3].actions.some(a => a.kind === 'click' && a.selector === '#dead'))
    const wheels = plans[2].actions.filter(a => a.kind === 'wheel')
    assert.equal(wheels.length - 1, plans[2].expected.scroll_reversals)
    assert.ok(wheels.every((a, i) => i === 0 || a.deltaY * wheels[i - 1].deltaY < 0))
    assert.ok(plans[1].actions.some(a => a.kind === 'circle' && a.ms >= 8000))
    assert.ok(plans[5].actions.some(a => a.kind === 'wait' && a.ms >= plans[5].expected.idle_ms_min))
    assert.equal(plans[0].expected.rage_clicks, 0)
    assert.equal(canaryStrings.length, 5)
})
test('CLI validates concurrency before starting services', async () => {
    await assert.rejects(main(['--concurrency', '0']), /positive integer/)
})
test('server requires explicit PostHog credentials', async () => {
    await assert.rejects(startServer({}), /POSTHOG_HOST/)
})
test('server escapes injected config without interpreting replacement patterns', () => {
    const html = renderPage('<script>window.LAB_CONFIG = __LAB_CONFIG__;</script>', 'https://posthog.invalid', '</script>$&')
    assert.ok(html.includes('https://posthog.invalid'))
    assert.ok(html.includes('\\u003c/script>$&'))
    assert.ok(!html.includes('__LAB_CONFIG__'))
    for (const canary of canaryStrings) assert.ok(html.includes(canary))
})
