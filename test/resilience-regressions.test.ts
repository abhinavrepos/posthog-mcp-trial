import assert from 'node:assert/strict'
import test from 'node:test'

process.env.TRIAGE_ENV_FILE = '/tmp/lens-resilience-absent.env'
const { config } = await import('../src/core/config.ts')
const { hogql, resetPosthogBreaker } = await import('../src/core/posthog.ts')
const { toolError } = await import('../src/mcp/toolerror.ts')

function configured(t: import('node:test').TestContext) {
    const old = { ...config.posthog }
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: '7', personalApiKey: 'secret-test-key' })
    t.after(() => { Object.assign(config.posthog, old); resetPosthogBreaker() })
    resetPosthogBreaker()
}

test('a successful HTTP answer with invalid query shape is unavailable, never empty data', async t => {
    configured(t)
    for (const body of [{}, { columns: ['n'], results: 'bad' }, { columns: ['n'], results: [null] }]) {
        t.mock.method(globalThis, 'fetch', async () => Response.json(body))
        const error = await hogql('SELECT 1', {}, { retries: 0 }).catch(e => e)
        assert.match(error.message, /unreadable answer/)
        const result = toolError(error, 'resolve_client')
        assert.equal(result.kind, 'unavailable')
        assert.doesNotMatch(result.result.content[0].text, /secret-test-key|TypeError|\.ts:/)
        t.mock.restoreAll()
    }
})

test('429 is retried as before; when retries run out, Retry-After is actionable advice', async t => {
    configured(t)
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
        calls++
        return new Response('busy', { status: 429, headers: { 'Retry-After': '60' } })
    })
    const error = await hogql('SELECT 1').catch(e => e)
    assert.ok(calls >= 2, `retried as thin-lens always did (${calls} calls)`)
    assert.match(toolError(error, 'find_sessions').result.content[0].text, /retry after 60 seconds/i)
})

test('SQLite storage failures give a plain storage message, without file paths or SQL', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_CORRUPT']) {
        const error = Object.assign(new Error('database failed at /srv/lens/private.db with secret-token'), { code })
        const result = toolError(error, 'pin_graph')
        assert.equal(result.kind, 'unavailable')
        assert.match(result.result.content[0].text, /Lens storage is unavailable/)
        assert.doesNotMatch(result.result.content[0].text, /private\.db|secret-token|SQLITE_/)
    }
})

test('malformed survey list is unavailable, never an invented empty list', async t => {
    configured(t)
    const old = { ...config.surveys }
    Object.assign(config.surveys, { enabled: true })
    Object.assign(config.posthog, { surveyApiKey: 'survey-secret' })
    t.after(() => Object.assign(config.surveys, old))
    const { listSurveys, invalidateSurveyCache } = await import('../src/core/surveys.ts')
    invalidateSurveyCache()
    t.mock.method(globalThis, 'fetch', async () => Response.json({ nonsense: [] }))
    await assert.rejects(listSurveys(), /unreadable answer/)
})

test('survey permission and project errors name the setting to check without echoing upstream details', async () => {
    const { PostHogError } = await import('../src/core/posthog.ts')
    for (const [status, expected] of [[403, /survey key.*scope/i], [404, /project id/i]] as const) {
        const result = toolError(new PostHogError('PostHog surveys secret-token /srv/keyfile', status), 'list_surveys')
        assert.equal(result.kind, 'unavailable')
        assert.match(result.result.content[0].text, expected)
        assert.doesNotMatch(result.result.content[0].text, /secret-token|\/srv\//)
    }
})
