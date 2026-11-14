// The answer cache for read-only chat tools: repeat questions from memory, shared concurrent runs,
// errors never kept, argument order irrelevant but nested values distinct, size bounded.
import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.FEATURE_JIRA = 'on'
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

test('pre-warm: recomputes even when an answer is kept, and keeps it until the next round', async () => {
    const { withPrewarm } = await import('../src/mcp/tools.ts')
    clearToolAnswers(); let runs = 0
    const run = async () => ({ content: [{ type: 'text', text: String(++runs) }] })
    await cachedToolCall('reval_brief', {}, run)
    await withPrewarm(20 * 60_000, () => cachedToolCall('reval_brief', {}, run))
    assert.equal(runs, 2, 'the pre-warm refreshes a kept answer')
    const realNow = Date.now
    try {
        Date.now = () => realNow() + 10 * 60_000 // ten minutes later: past the normal two minutes
        assert.equal((await cachedToolCall('reval_brief', {}, run) as any).content[0].text, '2', 'still the pre-warmed answer')
        assert.equal(runs, 2)
    } finally { Date.now = realNow }
})

test('pre-warm settings: default tools, interval, off switch, only cacheable tools', async () => {
    const { prewarmSettings, DEFAULT_PREWARM } = await import('../src/mcp/prewarm.ts')
    assert.deepEqual(prewarmSettings({}), { minutes: 15, tools: DEFAULT_PREWARM })
    assert.equal(prewarmSettings({ LENS_PREWARM_MINUTES: '0' }).minutes, 0)
    assert.deepEqual(prewarmSettings({ LENS_PREWARM_TOOLS: 'top_pains, record_verdict ,nope' }).tools, ['top_pains'])
    for (const t of DEFAULT_PREWARM) assert.ok(CACHED_TOOLS.has(t), t)
})

test('pre-warm refresh: the flag reaches the tool through the MCP transport; chat meanwhile gets the kept answer', async () => {
    const { withPrewarm } = await import('../src/mcp/tools.ts')
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    clearToolAnswers()
    let runs = 0, release!: () => void
    const slow = () => new Promise<any>((r) => { const n = ++runs; if (n === 1) return r({ content: [{ type: 'text', text: 'v1' }] }); release = () => r({ content: [{ type: 'text', text: 'v' + n }] }) })
    const server = new McpServer({ name: 't', version: '1' })
    server.registerTool('top_pains', { description: 'x' }, async () => cachedToolCall('top_pains', {}, slow) as any)
    const client = new Client({ name: 'c', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b)
    const text = (r: any) => r.content[0].text
    assert.equal(text(await client.callTool({ name: 'top_pains', arguments: {} })), 'v1')
    // The pre-warm asks through the transport: it must recompute (flag carried across), not return v1.
    const refreshing = withPrewarm(20 * 60_000, () => client.callTool({ name: 'top_pains', arguments: {} }))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(runs, 2, 'the pre-warm started a refresh')
    // Chat during the refresh: the kept answer at once, no waiting.
    const t = performance.now()
    assert.equal(text(await client.callTool({ name: 'top_pains', arguments: {} })), 'v1')
    assert.ok(performance.now() - t < 50)
    release()
    assert.equal(text(await refreshing), 'v2')
    assert.equal(text(await client.callTool({ name: 'top_pains', arguments: {} })), 'v2', 'then the refreshed answer')
    await client.close(); await server.close()
})
