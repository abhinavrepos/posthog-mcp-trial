import assert from 'node:assert/strict'
import test from 'node:test'

// Outage drill 2026-11-17 against a live lab: what Copilot is told when PostHog hangs, answers garbage,
// or Signal restarts mid-job. Each used to give advice that sent the PM the wrong way.
process.env.TRIAGE_ENV_FILE = '/tmp/lens-outage-messages-absent.env'
const { config } = await import('../src/core/config.ts')
const { toolError } = await import('../src/mcp/toolerror.ts')
const { hogql, resetPosthogBreaker } = await import('../src/core/posthog.ts')
const text = (r: ReturnType<typeof toolError>) => r.result.content[0].text

test('a restart mid-job tells Copilot to call the tool again, not to page an administrator', () => {
    const r = toolError(new Error('Server restarted before this job completed. Submit the tool again.'), 'get_job_result')
    assert.equal(r.kind, 'restarted')
    assert.match(text(r), /Signal restarted .* Call the original tool again/)
    assert.doesNotMatch(text(r), /administrator/)
})

test('PostHog not answering at all is not reported as "the window is too large"', () => {
    const e = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    const r = toolError(e, 'find_client_incidents')
    assert.equal(r.kind, 'capacity')
    assert.match(text(r), /PostHog did not answer in time\. Retry once/)
})

test('a non-JSON answer from PostHog is "unavailable", not an internal error', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => Object.assign(config.posthog, old))
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('<html>oops', { status: 200, headers: { 'content-type': 'text/html' } }) })
    const e = await hogql('SELECT 1', {}, { retries: 0 }).catch(e => e)
    assert.match(String(e.message), /unreadable answer/)
    assert.equal(calls, 1)
    const r = toolError(e, 'error_blast_radius')
    assert.equal(r.kind, 'unavailable')
    assert.match(text(r), /PostHog is unavailable or busy/)
})

test('after three timeouts in a row Signal stops waiting on PostHog for 30 s; an answer resets the count', async t => {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: 'test', personalApiKey: 'test' })
    t.after(() => { Object.assign(config.posthog, old); resetPosthogBreaker() })
    resetPosthogBreaker()
    let calls = 0, hang = true
    t.mock.method(globalThis, 'fetch', async () => {
        calls++
        if (hang) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        return Response.json({ columns: ['n'], results: [[1]] })
    })
    // two timeouts, then an answer: the count resets
    for (let i = 0; i < 2; i++) await hogql('SELECT 1', {}, { retries: 0 }).catch(() => {})
    hang = false; assert.deepEqual(await hogql('SELECT 1', {}, { retries: 0 }), [{ n: 1 }]); hang = true
    for (let i = 0; i < 2; i++) await hogql('SELECT 1', {}, { retries: 0 }).catch(() => {})
    assert.equal(calls, 5, 'not tripped yet')
    await hogql('SELECT 1', {}, { retries: 0 }).catch(() => {}) // third in a row: open
    const t0 = Date.now()
    const e = await hogql('SELECT 1', {}, { retries: 0 }).catch(e => e)
    assert.equal(calls, 6, 'no request sent while open'); assert.ok(Date.now() - t0 < 50)
    const r = toolError(e, 'aggregate_events')
    assert.equal(r.kind, 'unavailable'); assert.match(text(r), /PostHog is unavailable or busy/)
})
