import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-authorization-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const access = await import('../src/service/access.ts')
const { canConnect } = await import('../src/service/connect.ts')
const { config } = await import('../src/core/config.ts')
const { clipUrl, verifyClipLink } = await import('../src/core/links.ts')
const { db } = await import('../src/core/db.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const tools = readFileSync('src/mcp/tools.ts', 'utf8')

// Evaluate the real handlers with fake downstream work, without Chrome, PostHog or service workers.
function callback(start: string, end: string, deps: Record<string, unknown>, source = tools) {
    const code = source.slice(source.indexOf(start), source.indexOf(end)).replace(/\n    \)\s*$/, '')
    return new Function(...Object.keys(deps), 'return ' + stripTypeScriptTypes(code))(...Object.values(deps))
}

test('Connect and personal keys accept the same clip, survey and dashboard roles', () => {
    access.setAccessSettings({ default_role: 'none' }, 'test')
    for (const role of ['none', 'watch', 'download', 'admin'] as const) {
        for (const surveys of ['none', 'view', 'edit', 'launch'] as const) {
            for (const dashboards of ['none', 'view', 'share'] as const) {
                const email = `${role}-${surveys}-${dashboards}@test.com`
                access.setPerson(email, role, 'test')
                access.setSurveyRole(email, surveys, 'test')
                access.setDashboardRole(email, dashboards, 'test')
                const viewer = { email, role, surveys, dashboards, posthog_admin: false }
                const { token } = access.createMcpToken(viewer, 'test')
                const expected = role !== 'none' || surveys !== 'none' || dashboards !== 'none'
                assert.equal(canConnect(viewer as never), expected)
                assert.equal(!!access.chatCaller(token, ''), expected)
                if (dashboards !== 'none' && role === 'none' && surveys === 'none') {
                    access.setDashboardRole(email, 'none', 'test')
                    assert.equal(access.chatCaller(token, ''), undefined, 'removing the last role invalidates the key')
                }
            }
        }
    }
})


test('existing signed links stop streaming when sharing is disabled and resume when enabled', async () => {
    const source = readFileSync('src/service/server.ts', 'utf8')
    let streamed = 0
    const handler = callback('async function serveClip', '\nfunction featureState', {
        basename, join, config, verifyClipLink, loadAccess: access.loadAccess,
        existsSync: () => true, getClip: () => undefined, audit: () => {},
        streamMp4: () => { streamed++ }, send: (_res: unknown, status: number) => status,
    }, source)
    config.service.clipLinkSecret = 'test-secret'
    const url = new URL(clipUrl('session_0-30.mp4'), 'http://test')
    for (const enabled of [true, false, true]) {
        access.setAccessSettings({ allow_share_links: enabled }, 'test')
        const before = streamed
        const result = await handler({ headers: {} }, {}, url)
        assert.equal(streamed - before, enabled ? 1 : 0)
        if (!enabled) assert.equal(result, 403)
    }
    url.searchParams.set('c', '1')
    assert.equal(await handler({ headers: {} }, {}, url), 403)
    url.searchParams.delete('c')
    url.searchParams.set('sig', 'bad')
    assert.equal(await handler({ headers: {} }, {}, url), 403)
})


test('clip signatures bind comment visibility and generated comment links validate', () => {
    const previous = config.service.clipLinkSecret
    config.service.clipLinkSecret = 'comment-signature-test'
    try {
        for (const comments of [false, true]) {
            const url = new URL(clipUrl('session_0-30.mp4', Date.now(), comments), 'http://test')
            assert.equal(url.searchParams.get('c') === '1', comments)
            const verify = (c: boolean) => verifyClipLink('session_0-30.mp4', url.searchParams.get('exp'), url.searchParams.get('sig'), config.service.clipLinkSecret, Date.now(), c)
            assert.equal(verify(comments), true)
            assert.equal(verify(!comments), false)
        }
    } finally { config.service.clipLinkSecret = previous }
})
