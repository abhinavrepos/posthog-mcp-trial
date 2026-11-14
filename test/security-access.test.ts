import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-security-access-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const access = await import('../src/service/access.ts')
const { db } = await import('../src/core/db.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

test('personal tokens stop when the owner loses both clip and survey access', () => {
    access.setPerson('removed@example.com', 'watch', 'test')
    const { token } = access.createMcpToken({ email: 'removed@example.com', posthog_admin: false }, 'test')
    assert.ok(access.chatCaller(token, ''))
    access.removePerson('removed@example.com', 'test')
    assert.equal(access.chatCaller(token, ''), undefined)
    access.setSurveyRole('removed@example.com', 'view', 'test')
    assert.ok(access.chatCaller(token, ''), 'survey access alone permits connecting')
    access.setSurveyRole('removed@example.com', 'none', 'test')
    assert.equal(access.chatCaller(token, ''), undefined)
})

test('page identity resolution removes stored PostHog admin authority from active tokens', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes('/@me/')
        ? { email: 'demoted@example.com', organizations: [{ id: 'org', membership_level: 1 }] }
        : { organization: 'org' }))
    try {
        access.setPerson('demoted@example.com', 'watch', 'test')
        const { token } = access.createMcpToken({ email: 'demoted@example.com', posthog_admin: true }, 'test')
        assert.equal(access.chatCaller(token, '')?.admin, true)
        const viewer = await access.currentViewer({ headers: { cookie: 'sessionid=demoted-session' } } as IncomingMessage)
        assert.equal(viewer?.posthog_admin, false)
        assert.equal(access.listMcpTokens('demoted@example.com')[0]?.posthog_admin, false)
        assert.equal(access.chatCaller(token, '')?.admin, false)
    } finally { globalThis.fetch = original }
})

test('only failures count; email and IP budgets are independent and success cannot reset IP failures', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async (_input, init) => {
        calls++
        const { password } = JSON.parse(String(init?.body))
        return password === 'valid'
            ? new Response('{}', { headers: { 'set-cookie': 'sessionid=valid-session' } })
            : new Response('{}', { status: 401 })
    }
    try {
        for (let i = 0; i < 25; i++) assert.ok((await access.signIn('success-ip', 'valid@example.com', 'valid')).session)
        for (let i = 0; i < 10; i++) await access.signIn('email-ip-' + i, ' Guessed@Example.com ', 'wrong')
        const before = calls
        assert.match((await access.signIn('new-ip', 'guessed@example.com', 'wrong')).error!, /Too many/)
        assert.equal(calls, before)
        for (let i = 0; i < 20; i++) {
            await access.signIn('office', 'victim' + i + '@example.com', 'wrong')
            if (i < 19) assert.ok((await access.signIn('office', 'valid@example.com', 'valid')).session)
        }
        const full = calls
        assert.match((await access.signIn('office', 'another@example.com', 'wrong')).error!, /Too many/)
        assert.equal(calls, full)
        assert.ok((await access.signIn('other-office', 'another@example.com', 'valid')).session)
    } finally { globalThis.fetch = original }
})

test('failure counters expire and each map is bounded', async () => {
    const { readFileSync } = await import('node:fs')
    const { stripTypeScriptTypes } = await import('node:module')
    const source = readFileSync('src/service/access.ts', 'utf8')
    const counters = source.slice(source.indexOf('const attempts ='), source.indexOf('/** Signs in with a PostHog'))
    const api = new Function(stripTypeScriptTypes(counters) + '\nreturn { attempts, emailAttempts, recentFailures, countAttempt }')()
    for (let i = 0; i < 10_010; i++) api.countAttempt('ip-' + i, 'email-' + i)
    assert.equal(api.attempts.size, 10_000)
    assert.equal(api.emailAttempts.size, 10_000)
    api.attempts.set('old-ip', [Date.now() - 600_001])
    assert.deepEqual(api.recentFailures(api.attempts, 'old-ip'), [])
})

test('a PostHog-admin flag on a key counts only while a recent sign-in confirmed it', () => {
    const { token, id } = access.createMcpToken({ email: 'phadmin@example.com', posthog_admin: true }, 'test')
    assert.equal(access.chatCaller(token, '')?.admin, true)                       // just made: confirmed now
    const old = new Date(Date.now() - (access.ADMIN_FLAG_DAYS + 1) * 86_400_000).toISOString()
    db.prepare('UPDATE mcp_tokens SET created_at = ?, posthog_admin_seen_at = ? WHERE id = ?').run(old, old, id)
    const caller = access.chatCaller(token, '')
    assert.notEqual(caller?.admin, true, 'an unconfirmed flag no longer makes an admin')  // falls back to their Lens role
})

test('sign-in attempts are counted when they start, so parallel guesses cannot all get through', async () => {
    const original = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return new Response('{"detail":"Wrong"}', { status: 400 }) }
    try {
        const results = await Promise.all(Array.from({ length: 30 }, () => access.signIn('203.0.113.9', 'target@example.com', 'guess')))
        assert.ok(calls <= 10, `${calls} guesses reached PostHog`)
        assert.ok(results.filter(r => /Too many/.test(r.error || '')).length >= 20)
    } finally { globalThis.fetch = original }
})
