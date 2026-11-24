import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleReplays, headerHtml, loginHtml, PAGE_CSS } from '../src/service/replays.ts'
import { surveysHtml } from '../src/service/surveyspage.ts'
import { systemHtml } from '../src/service/system.ts'
import type { Viewer } from '../src/service/access.ts'

const admin = { email: 'admin@example.com', name: 'Admin Example', role: 'admin', posthog_admin: true, in_replay_project: true, system: true, surveys: 'launch', dashboards: 'share', insights: true, session: 'session' } as Viewer

test('Volt theme is local, dark by default, and has an explicit light variant', () => {
    const css = PAGE_CSS()
    assert.match(css, /\[data-theme=dark\].*--bg:#0a0a0b/s)
    assert.match(css, /\[data-theme=light\].*--bg:#fafafa/s)
    assert.match(css, /@font-face\{font-family:Geist;src:url\('\/replays\/assets\/fonts\/Geist-Variable\.woff2'\)/)
    assert.match(css, /--focus:#8ab4ff/)
    assert.doesNotMatch(css, /fonts\.googleapis/)
})

test('grouped sidebar retains all navigation, account, and sign-out hooks', () => {
    const html = headerHtml(admin, 'System')
    for (const label of ['Monitor', 'Engage', 'Manage', 'Replay clips', 'Watchlist', 'Live', 'Surveys', 'Chat', 'System', 'Admin']) assert.ok(html.includes(label), label)
    assert.match(html, /id="signout"/)
    assert.match(html, /href="#main"/)
    assert.match(html, /href="\/replays\/system" aria-current="page"/)
})

test('sign-in keeps its PostHog fields and submit behavior in the split page', () => {
    const html = loginHtml()
    for (const hook of ['id="f"', 'id="email"', 'id="pw"', 'id="go"', 'id="signin-status"', 'id="msg"', 'id="reload-lens"', 'class="login-brand"']) assert.ok(html.includes(hook), hook)
    assert.match(html, /fetch\('\/replays\/login'/)
})

test('font route is public, fixed, and cacheable for GET and HEAD', async () => {
    const path = '/replays/assets/fonts/Geist-Variable.woff2'
    const expected = readFileSync(new URL('../assets/fonts/Geist-Variable.woff2', import.meta.url))
    for (const method of ['GET', 'HEAD']) {
        let status = 0, headers: Record<string, string | number> = {}, body: Buffer | undefined
        const res = { writeHead: (s: number, h: Record<string, string | number>) => { status = s; headers = h }, end: (b?: Buffer) => { body = b } } as unknown as ServerResponse
        const req = { method, headers: {} } as IncomingMessage
        assert.equal(await handleReplays(req, res, new URL(path, 'http://lens.test')), true)
        assert.equal(status, 200)
        assert.equal(headers['content-type'], 'font/woff2')
        assert.equal(headers['content-length'], expected.length)
        assert.match(String(headers['cache-control']), /immutable/)
        if (method === 'GET') assert.deepEqual(body, expected)
        else assert.equal(body, undefined)
    }
})

test('survey and system detail tabs keep their original content and executable scripts', () => {
    for (const html of [surveysHtml(admin), systemHtml(admin)]) {
        assert.match(html, /role="tablist"|system-tabs|survey-detail-tabs/)
        const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
        assert.doesNotThrow(() => new Function(script))
    }
})
