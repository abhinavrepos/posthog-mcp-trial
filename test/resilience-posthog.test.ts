import assert from 'node:assert/strict'
import test from 'node:test'

// Resilience drill: PostHog answering in every broken way Lens has met (or could meet) in the field, against a
// stand-in fetch. What a job reports on the System page (plainReason) and what Copilot is told (toolError) must
// be plain, actionable, and never carry the key, a stack trace or a path on disk.
process.env.TRIAGE_ENV_FILE = '/tmp/lens-resilience-posthog-absent.env'
const { config } = await import('../src/core/config.ts')
const { hogql, posthogQuery, resetPosthogBreaker } = await import('../src/core/posthog.ts')
const { toolError } = await import('../src/mcp/toolerror.ts')
const { plainReason } = await import('../src/core/jobhealth.ts')

const KEY = 'phx_resilienceSECRETkey0123456789'
const text = (r: ReturnType<typeof toolError>) => r.result.content[0].text
function standIn(t: test.TestContext, answer: () => Promise<Response> | Response) {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: '7', personalApiKey: KEY })
    t.after(() => { Object.assign(config.posthog, old); resetPosthogBreaker() })
    resetPosthogBreaker()
    t.mock.method(globalThis, 'fetch', async () => answer())
}
const fail = (query = () => hogql('SELECT 1', {}, { retries: 0 })) => query().then(() => assert.fail('expected a failure'), (e: unknown) => e as Error & { status?: number })
// The message as task history stores it and as it comes back from a worker thread: the status is only in the text.
const stored = (e: Error) => new Error(e.message)
function clean(s: string) {
    assert.doesNotMatch(s, new RegExp(KEY)); assert.doesNotMatch(s, /\n\s+at |\/root\/|\/opt\/|node_modules/)
}

test('PostHog answering 200 with JSON that is not a query result is "an answer Lens could not read", not an internal error', async t => {
    for (const body of ['{}', 'null', '{"error":"proxy says no"}', '{"columns":["n"],"results":[1]}']) {
        standIn(t, () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
        const e = await fail()
        assert.equal(e.status, 502, body)
        assert.equal(plainReason(e), 'PostHog sent an answer Lens could not read')
        const r = toolError(e, 'aggregate_events')
        assert.equal(r.kind, 'unavailable', body); assert.match(text(r), /PostHog is unavailable or busy/)
        const chart = await posthogQuery({ kind: 'TrendsQuery' }).then(() => 'ok', () => 'failed')
        assert.equal(chart, 'ok', 'aggregate query nodes keep their own answer shape')
    }
})

test('a stored or worker-relayed PostHog error keeps its meaning on the System page', async t => {
    const cases: [number, unknown, RegExp][] = [
        [401, { type: 'authentication_error', code: 'authentication_failed', detail: 'Invalid personal API key.' }, /^PostHog refused Lens's API key$/],
        [403, { type: 'authentication_error', code: 'permission_denied', detail: 'You do not have permission to perform this action.' }, /^PostHog refused Lens's API key$/],
        [403, { type: 'authentication_error', code: 'permission_denied', detail: "API key missing required scope 'query:read'" }, /^PostHog refused Lens's API key: it lacks the query:read scope$/],
        [404, { type: 'invalid_request', code: 'not_found', detail: 'Not found.' }, /^PostHog has no such project for Lens: check POSTHOG_PROJECT_ID$/],
        [500, { type: 'server_error', code: 'error', detail: 'A server error occurred.' }, /^PostHog returned an error \(HTTP 500\)$/],
        [429, { type: 'throttled_error', code: 'throttled', detail: 'Request was throttled. Expected available in 31 seconds.' }, /^PostHog is rate-limiting Lens$/],
    ]
    for (const [status, body, want] of cases) {
        standIn(t, () => Response.json(body, { status, headers: status === 429 ? { 'retry-after': '31' } : {} }))
        const e = await fail()
        assert.match(plainReason(e), want, `live ${status}`)
        assert.match(plainReason(stored(e)), want, `stored ${status}`)
        clean(plainReason(stored(e)))
    }
})

test('ClickHouse down while PostHog answers is named as ClickHouse, not "PostHog is unreachable"', async t => {
    for (const detail of ['Code: 210. DB::NetException: Connection refused (clickhouse:9000). (NETWORK_ERROR) (version 24.8.4.13 (official build))',
        'Code: 209. DB::NetException: Timeout exceeded while reading from socket (clickhouse:9000, 30000 ms). (SOCKET_TIMEOUT)']) {
        standIn(t, () => Response.json({ type: 'server_error', code: 'CHQueryErrorNetworkError', detail }, { status: 500 }))
        const e = await fail()
        assert.equal(plainReason(e), "PostHog's ClickHouse (event store) is not answering")
        assert.equal(plainReason(stored(e)), "PostHog's ClickHouse (event store) is not answering")
        assert.equal(toolError(e, 'aggregate_events').kind, 'unavailable')
    }
    // A plain connection failure to PostHog itself is still "unreachable".
    assert.equal(plainReason(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), 'PostHog is unreachable')
})

test('Copilot is told when retrying cannot help: wrong key, missing scope, wrong project; and how long a rate limit lasts', async t => {
    const cases: [number, unknown, RegExp][] = [
        [401, { detail: 'Invalid personal API key.' }, /PostHog refused Lens's API key\. Retrying will not help; a Lens administrator must check POSTHOG_PERSONAL_API_KEY/],
        [403, { detail: "API key missing required scope 'query:read'" }, /lacks the query:read scope\. Retrying will not help/],
        [404, { detail: 'Not found.' }, /PostHog has no such project for Lens\. Retrying will not help; a Lens administrator must check POSTHOG_PROJECT_ID/],
        [429, { detail: 'Request was throttled. Expected available in 31 seconds.' }, /PostHog is rate-limiting Lens: retry in about 31 seconds\./],
    ]
    for (const [status, body, want] of cases) {
        standIn(t, () => Response.json(body, { status }))
        const e = await fail()
        for (const error of [e, stored(e)]) {
            const r = toolError(error, 'client_experience')
            assert.equal(r.kind, 'unavailable', `${status}`)
            assert.match(text(r), want); clean(text(r))
            assert.doesNotMatch(text(r), /resolve_client|\/api\/projects/, 'not "the item was not found", and no API path')
        }
    }
    // A 404 for one recording is still "not found": only the query endpoint means the project is wrong.
    assert.equal(toolError(new Error('PostHog GET /api/projects/7/session_recordings/abc/ → 404: Not found.'), 'session_moments').kind, 'not_found')
})

test('every broken answer gives a plain System-page reason and a tool error without the key, a stack or a path', async t => {
    const answers: (() => Promise<Response> | Response)[] = [
        () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:80'), { code: 'ECONNREFUSED' }) }) },
        () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') },
        () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
        () => new Response('{"columns":["n"],"results":[[1', { status: 200 }),
        () => new Response(`upstream error for Bearer ${KEY}`, { status: 503 }),
    ]
    for (const answer of answers) {
        standIn(t, answer)
        const e = await fail()
        for (const error of [e, stored(e)]) {
            const reason = plainReason(error), r = toolError(error, 'aggregate_events')
            clean(reason); clean(text(r))
            assert.notEqual(r.kind, 'internal', reason)
            assert.doesNotMatch(reason, /→|\/api\//, reason)
        }
    }
})
