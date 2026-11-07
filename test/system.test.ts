import assert from 'node:assert/strict'
import { test } from 'node:test'

import { config } from '../src/core/config.ts'
import type { Viewer } from '../src/service/access.ts'
import { readStatus, systemHtml } from '../src/service/system.ts'

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
const admin = { email: 'admin@example.com', role: 'admin' } as Viewer

test('the System page passes on what the status service says', async () => {
    const r = await readStatus(answer(200, { level: 'ok', checks: [] }))
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { level: 'ok', checks: [] })
})

test('the System page reports a status service that is down, without details from it', async () => {
    assert.equal((await readStatus(answer(500, { secret: 'x' }))).status, 502)
    const r = await readStatus((async () => { throw new Error('connect refused at 10.0.0.1') }) as unknown as typeof fetch)
    assert.equal(r.status, 502)
    assert.deepEqual(r.body, { error: 'The status service is not answering.' })
})

test('the password goes to the status service only when one is set', async () => {
    const saved = config.service.statusPassword
    const seen: (string | undefined)[] = []
    const spy = (async (_u: string, o: { headers: Record<string, string> }) => {
        seen.push(o.headers.authorization)
        return new Response('{}')
    }) as unknown as typeof fetch
    try {
        config.service.statusPassword = ''
        await readStatus(spy)
        config.service.statusPassword = 'pw'
        await readStatus(spy)
    } finally {
        config.service.statusPassword = saved
    }
    assert.equal(seen[0], undefined)
    assert.equal(seen[1], `Basic ${Buffer.from('lens:pw').toString('base64')}`)
})

test('the page has the System tab and its script survives the HTML template', () => {
    const html = systemHtml(admin)
    assert.match(html, /href="\/replays\/system"[^>]*aria-current="page"/)
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
    assert.doesNotThrow(() => new Function(script))
})
