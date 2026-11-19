// Lens's background jobs on the System page: plain reasons, a log line when a job starts failing or
// recovers (not one per round), levels that escalate, and the status service turning them into checks.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { jobFailed, jobOk, jobStates, plainReason, registerJob, resetJobs } from '../src/core/jobhealth.ts'

test('reasons are plain words, never query text, URLs or addresses', () => {
    assert.equal(plainReason(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'PostHog did not answer in time')
    assert.equal(plainReason(new Error('fetch failed: connect ECONNREFUSED 10.0.0.5:8000')), 'PostHog is unreachable')
    assert.equal(plainReason(Object.assign(new Error('Request failed'), { status: 401 })), "PostHog refused Lens's API key")
    assert.equal(plainReason(new Error('PostHog HTTP 502 for query')), 'PostHog returned an error (HTTP 502)')
    assert.equal(plainReason(new Error('Worker terminated due to reaching memory limit: JS heap out of memory')), 'ran out of memory')
    assert.equal(plainReason(new Error('SQLITE_FULL: database or disk is full')), 'the disk is full')
    const other = plainReason(new Error("Unexpected token in SELECT 'Zanthor Capital' FROM events at https://ph.internal/api?k=1 for a@b.com\nstack"))
    assert.doesNotMatch(other, /Zanthor|https|a@b\.com|stack/)
})

test('levels escalate with failures, recover cleanly, and log only on change', () => {
    resetJobs()
    const lines: string[] = [], orig = console.log
    console.log = (s: string) => { lines.push(s) }
    try {
        const t0 = Date.now()
        registerJob('task_history', 'Task history', 10 * 60_000)
        assert.equal(jobStates()[0].level, 'waiting')
        assert.equal(jobStates(t0 + 31 * 60_000)[0].level, 'warn', 'nothing finished in three rounds')
        jobOk('task_history', '400 days processed')
        assert.deepEqual([jobStates()[0].level, jobStates()[0].detail], ['ok', '400 days processed'])
        const e = new Error('fetch failed: ECONNREFUSED')
        jobFailed('task_history', e)
        assert.equal(jobStates()[0].level, 'warn')
        jobFailed('task_history', e); jobFailed('task_history', e)
        const s = jobStates()[0]
        assert.equal(s.level, 'down'); assert.match(s.reason!, /^PostHog is unreachable \(failing for .*, 3 rounds\)$/)
        assert.equal(lines.filter((l) => /job failed/.test(l)).length, 1, 'one line when it starts failing, not one per round')
        jobOk('task_history', 'back')
        assert.equal(jobStates()[0].level, 'ok')
        assert.ok(lines.some((l) => /"msg":"job recovered".*"failures":3/.test(l)))
        // A job that stops succeeding without an error is a warning.
        assert.equal(jobStates(Date.now() + 31 * 60_000)[0].level, 'warn')
        jobFailed('unknown_job', e) // never registered: ignored
        assert.equal(jobStates().length, 1)
    } finally { console.log = orig; resetJobs() }
})

test('the status service shows each Lens job as its own check, worst first', async (t) => {
    const health = 'http://lens.test/health', previous = process.env.STATUS_HTTP
    const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
        if (url.endsWith('/refused')) throw new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } })
        if (url.endsWith('/timeout')) throw new DOMException('Timed out', 'TimeoutError')
        if (url.endsWith('/unavailable')) return new Response('', { status: 503 })
        assert.equal(url, health)
        return Response.json({ ok: true, features: { lens_mcp: true }, jobs: [
            { key: 'watchlist', label: 'Watchlist reader', level: 'down', reason: 'PostHog is unreachable (failing for 40 min, 4 rounds)', last_ok_at: new Date(Date.now() - 50 * 60_000).toISOString() },
            { key: 'task_history', label: 'Task history', level: 'ok', reason: null, detail: '412 days processed', last_ok_at: new Date().toISOString() },
        ] })
    })
    process.env.STATUS_HTTP = ['Lens|Triage service|'+health, 'PostHog|Refused|http://lens.test/refused',
        'PostHog|Timeout|http://lens.test/timeout', 'PostHog|Unavailable|http://lens.test/unavailable'].join(',')
    try {
        // Load these settings even when another test already imported the collector.
        const { checkHttp } = await import(new URL('../deploy/status/server.mjs?jobhealth-test', import.meta.url).href)
        const rows = await checkHttp() as { group: string; name: string; level: string; detail: string }[]
        assert.equal(fetch.mock.callCount(), 4)
        assert.deepEqual(rows.slice(0, 3).map((r) => [r.group, r.name, r.level]), [['Lens', 'Triage service', 'ok'], ['Lens jobs', 'Watchlist reader', 'down'], ['Lens jobs', 'Task history', 'ok']])
        assert.match(rows[0].detail, /^Health endpoint returned HTTP 200 in \d+ ms$/)
        assert.match(rows[1].detail, /^PostHog is unreachable \(failing for 40 min, 4 rounds\) · last success 50 min ago$/)
        assert.match(rows[2].detail, /^412 days processed · last success \d+ s ago$/)
        assert.equal(rows[3].detail, 'Health endpoint refused the connection')
        assert.equal(rows[4].detail, 'Health endpoint did not respond within 8 s')
        assert.match(rows[5].detail, /^Health endpoint returned HTTP 503 in \d+ ms$/)
    } finally { if (previous == null) delete process.env.STATUS_HTTP; else process.env.STATUS_HTTP = previous }
})

test('missing settings are named plainly', () => {
    assert.equal(plainReason(new Error('PostHog is not configured: set POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY in .secrets.env')), 'PostHog settings are missing: POSTHOG_PROJECT_ID, POSTHOG_PERSONAL_API_KEY')
    assert.equal(plainReason(new Error('Something odd happened')), 'Something odd happened')
})
