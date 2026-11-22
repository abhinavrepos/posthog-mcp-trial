import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-survey-sync-'))
Object.assign(process.env, {
    TRIAGE_ENV_FILE: join(dir, 'none.env'),
    TRIAGE_DB: join(dir, 'main.db'),
    POSTHOG_HOST: 'http://posthog.test',
    POSTHOG_PROJECT_ID: '1',
    LENS_POSTHOG_SETTINGS_API_KEY: 'phx_settings',
    LENS_SURVEY_SYNC: 'on',
    FEATURE_SURVEYS: 'off',
})
const { db, getSetting } = await import('../src/core/db.ts')
const { runSurveySync, surveySyncJobState } = await import('../src/service/surveysync.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

const url = 'http://posthog.test/api/projects/1/'
const snapshot = () => getSetting(`survey_sync_previous:${url}`, null)
const at = '2026-01-01T00:00:00.000Z'

beforeEach(() => db.exec("DELETE FROM settings WHERE key LIKE 'survey_sync_%'"))

function posthog(initial: boolean | null) {
    let value = initial
    const calls: Request[] = []
    const patches: Array<boolean | null> = []
    const savedAtPatch: unknown[] = []
    const fake = {
        calls, patches, savedAtPatch,
        patchStatus: 200,
        getStatus: 200,
        showSurveys: () => { value = true },
        fetch: (async (input, init): Promise<Response> => {
            const request = new Request(input, init)
            calls.push(request)
            if (request.method === 'GET') {
                return fake.getStatus === 200 ? Response.json({ surveys_opt_in: value })
                    : Response.json({ detail: 'Project access denied.' }, { status: fake.getStatus })
            }
            const body = await request.json() as { surveys_opt_in: boolean | null }
            assert.deepEqual(Object.keys(body), ['surveys_opt_in'])
            patches.push(body.surveys_opt_in)
            savedAtPatch.push(snapshot())
            if (fake.patchStatus !== 200) return new Response('Try again later', { status: fake.patchStatus })
            value = body.surveys_opt_in
            return Response.json({ surveys_opt_in: value })
        }) satisfies typeof fetch,
    }
    return fake
}

test('surveys off saves the previous value and patches only surveys_opt_in', async () => {
    const ph = posthog(true)
    await runSurveySync({ fetch: ph.fetch, now: () => new Date(at) })
    const saved = { previous: true, turned_off_at: at }
    assert.deepEqual(ph.savedAtPatch, [saved])
    assert.deepEqual(snapshot(), saved)
    assert.deepEqual(ph.calls.map((r) => [r.method, r.url, r.headers.get('authorization')]), [
        ['GET', url, 'Bearer phx_settings'],
        ['PATCH', url, 'Bearer phx_settings'],
    ])
    assert.match(surveySyncJobState().detail ?? '', /Synced off · Last run/)
    assert.deepEqual(ph.patches, [false])
})

test('surveys already false leaves PostHog and rollback state alone', async () => {
    const ph = posthog(false)
    await runSurveySync({ fetch: ph.fetch, env: { LENS_REPLAY_RETENTION_API_KEY: 'phx_fallback' } })
    assert.deepEqual(ph.calls.map((r) => r.method), ['GET'])
    assert.equal(ph.calls[0]?.headers.get('authorization'), 'Bearer phx_fallback')
    assert.equal(snapshot(), null)
})

test('re-asserting off preserves the original value and timestamp', async () => {
    const ph = posthog(null)
    await runSurveySync({ fetch: ph.fetch, now: () => new Date(at) })
    ph.showSurveys()
    await runSurveySync({ fetch: ph.fetch })
    assert.deepEqual(ph.patches, [false, false])
    assert.deepEqual(snapshot(), { previous: null, turned_off_at: at })
})

for (const previous of [true, null] as const) {
    test(`surveys on restores previous ${previous} and clears the snapshot`, async () => {
        const ph = posthog(previous)
        await runSurveySync({ fetch: ph.fetch })
        await runSurveySync({ fetch: ph.fetch, enabled: true })
        assert.deepEqual(ph.patches, [false, previous])
        assert.equal(snapshot(), null)
        assert.match(surveySyncJobState().detail ?? '', /^Restored/)
    })
}

test('surveys on without a saved value makes no PostHog call', async () => {
    const ph = posthog(false)
    await runSurveySync({ fetch: ph.fetch, enabled: true })
    assert.deepEqual(ph.calls, [])
})

test('no key makes no PostHog call and reports not configured', async () => {
    const ph = posthog(true)
    const key = process.env.LENS_POSTHOG_SETTINGS_API_KEY
    const fallback = process.env.LENS_REPLAY_RETENTION_API_KEY
    delete process.env.LENS_POSTHOG_SETTINGS_API_KEY
    delete process.env.LENS_REPLAY_RETENTION_API_KEY
    try {
        await runSurveySync({ fetch: ph.fetch })
        assert.deepEqual(ph.calls, [])
        assert.match(surveySyncJobState().detail ?? '', /^Not configured/)
    } finally {
        if (key !== undefined) process.env.LENS_POSTHOG_SETTINGS_API_KEY = key
        if (fallback !== undefined) process.env.LENS_REPLAY_RETENTION_API_KEY = fallback
    }
})

test('403 records the PostHog message and retries on the next run', async () => {
    const ph = posthog(true)
    ph.getStatus = 403
    await runSurveySync({ fetch: ph.fetch, now: () => new Date(at) })
    const job = surveySyncJobState()
    assert.equal(job.level, 'warn')
    assert.equal(job.last_error_at, at)
    assert.match(job.detail ?? '', /Error · Last run .*Last error .*PostHog HTTP 403: Project access denied\./)
    assert.equal(snapshot(), null)
    ph.getStatus = 200
    await runSurveySync({ fetch: ph.fetch })
    assert.equal(surveySyncJobState().level, 'ok')
    assert.deepEqual(ph.patches, [false])
})

test('LENS_SURVEY_SYNC=off makes no PostHog call even with a snapshot to restore', async () => {
    const ph = posthog(true)
    await runSurveySync({ fetch: ph.fetch })
    await runSurveySync({ fetch: ph.fetch, enabled: true, env: { ...process.env, LENS_SURVEY_SYNC: 'off' } })
    assert.equal(ph.calls.length, 2)
    assert.ok(snapshot())
})

test('failed PATCH keeps the snapshot committed before the request', async () => {
    const ph = posthog(true)
    ph.patchStatus = 503
    await runSurveySync({ fetch: ph.fetch, now: () => new Date(at) })
    const saved = { previous: true, turned_off_at: at }
    assert.deepEqual(ph.savedAtPatch, [saved])
    assert.deepEqual(snapshot(), saved)
    assert.match(surveySyncJobState().detail ?? '', /PostHog HTTP 503: Try again later/)
})
