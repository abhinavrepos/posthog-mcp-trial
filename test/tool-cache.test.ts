// The answer cache for read-only chat tools: repeat questions from memory, shared concurrent runs,
// errors never kept, argument order irrelevant but nested values distinct, size bounded.
import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.LENS_TOOL_CACHE_SECONDS = '120'
const { cachedToolCall, clearToolAnswers, CACHED_TOOLS } = await import('../src/mcp/tools.ts')

test('a repeated question is answered from memory; answers are copies', async () => {
    clearToolAnswers(); let runs = 0
    const run = async () => ({ content: [{ type: 'text', text: 'n=' + ++runs }] })
    const a = await cachedToolCall('top_pains', { days: 7 }, run) as any
    const b = await cachedToolCall('top_pains', { days: 7 }, run) as any
    assert.equal(runs, 1); assert.deepEqual(a, b)
    b.content[0].text = 'changed'
    assert.equal((await cachedToolCall('top_pains', { days: 7 }, run) as any).content[0].text, 'n=1', 'callers cannot change the kept answer')
})

test('identical questions at the same time share one run', async () => {
    clearToolAnswers(); let runs = 0
    const run = () => new Promise((r) => setTimeout(() => r({ content: [{ type: 'text', text: String(++runs) }] }), 30))
    await Promise.all(Array.from({ length: 10 }, () => cachedToolCall('reval_brief', {}, run)))
    assert.equal(runs, 1)
})

test('key order does not matter, nested values do', async () => {
    clearToolAnswers(); let runs = 0
    const run = async () => ({ content: [{ type: 'text', text: String(++runs) }] })
    await cachedToolCall('dialog_friction', { client: 'A', window: { days: 7, tz: 'UTC' } }, run)
    await cachedToolCall('dialog_friction', { window: { tz: 'UTC', days: 7 }, client: 'A' }, run)
    assert.equal(runs, 1)
    await cachedToolCall('dialog_friction', { client: 'A', window: { days: 30, tz: 'UTC' } }, run)
    assert.equal(runs, 2, 'a different nested value is a different question')
})

test('errors are never kept, so the next ask tries again', async () => {
    clearToolAnswers(); let runs = 0
    const run = async () => (++runs === 1 ? { isError: true, content: [{ type: 'text', text: 'PostHog busy' }] } : { content: [{ type: 'text', text: 'ok' }] })
    assert.equal((await cachedToolCall('client_signals', {}, run) as any).isError, true)
    assert.equal((await cachedToolCall('client_signals', {}, run) as any).content[0].text, 'ok')
    await assert.rejects(cachedToolCall('message_doctor', {}, async () => { throw new Error('boom') }), /boom/)
    assert.equal((await cachedToolCall('message_doctor', {}, async () => ({ content: [] })) as any).content.length, 0)
})

test('only read-only analysis tools are cached; nothing that writes or depends on who asks', () => {
    for (const t of ['reval_brief', 'top_pains', 'dialog_friction']) assert.ok(CACHED_TOOLS.has(t))
    for (const t of ['record_verdict', 'correct_ticket_link', 'refresh_releases', 'triage_ticket', 'get_replay_link', 'launch_survey', 'list_surveys', 'task_map', 'pin_dashboard', 'release_outcomes', 'list_releases'])
        assert.ok(!CACHED_TOOLS.has(t), t)
})
