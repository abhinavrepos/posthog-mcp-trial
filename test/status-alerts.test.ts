// The status page's alerts: when a check alerts, when it is fixed, and what reaches the chat channel.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// @ts-expect-error plain JavaScript module without types
import { alertChanges, alertMessage, alertBody } from '../deploy/status/server.mjs'

const MIN = 60_000
const row = (name: string, level: string, detail = '') => ({ group: 'Machine', name, level, detail })
const since = (entries: [string, string, number][]) => new Map(entries.map(([k, level, at]) => [k, { level, at }]))

test('a problem alerts only after it lasted the set minutes, then once', () => {
    const now = 100 * MIN
    const alerted = new Map()
    let c = alertChanges([row('Memory', 'warn')], since([['Machine/Memory', 'warn', now - 2 * MIN]]), alerted, now, 5 * MIN)
    assert.equal(c.firing.length, 0, 'a two-minute blip says nothing')
    c = alertChanges([row('Memory', 'warn')], since([['Machine/Memory', 'warn', now - 6 * MIN]]), alerted, now, 5 * MIN)
    assert.deepEqual(c.firing.map((f: any) => f.key), ['Machine/Memory'])
    alerted.set('Machine/Memory', { level: 'warn', group: 'Machine', name: 'Memory' })
    c = alertChanges([row('Memory', 'warn')], since([['Machine/Memory', 'warn', now - 60 * MIN]]), alerted, now, 5 * MIN)
    assert.equal(c.firing.length + c.fixed.length, 0, 'not repeated every round')
    c = alertChanges([row('Memory', 'down')], since([['Machine/Memory', 'down', now - 6 * MIN]]), alerted, now, 5 * MIN)
    assert.equal(c.firing.length, 1, 'warning -> down alerts again')
    c = alertChanges([row('Memory', 'ok')], since([['Machine/Memory', 'ok', now]]), alerted, now, 5 * MIN)
    assert.deepEqual(c.fixed.map((f: any) => f.key), ['Machine/Memory'], 'fixed is said once')
})

test('info rows never alert; a check that disappears counts as fixed; down-only mode skips warnings', () => {
    const now = 100 * MIN
    assert.equal(alertChanges([row('Uptime', 'info')], since([['Machine/Uptime', 'info', 0]]), new Map(), now, 0).firing.length, 0)
    const gone = alertChanges([], new Map(), new Map([['Containers/capture', { level: 'down', group: 'Containers', name: 'capture' }]]), now, 0)
    assert.equal(gone.fixed[0].row.detail, 'no longer checked')
    assert.equal(alertChanges([row('Disk', 'warn')], since([['Machine/Disk', 'warn', 0]]), new Map(), now, 0, ['down']).firing.length, 0)
})

test('messages: one per round, readable, in Teams, Slack and plain formats', () => {
    const m = alertMessage([row('Memory', 'warn', '1.5 GB available of 21.5 GB (7%)')], [row('Disk', 'ok')], 'Lens (vm1)', 'https://status.example')
    assert.equal(m.head, 'Lens (vm1): 1 problem, 1 fixed')
    assert.match(m.text, /🟠 Machine: Memory \(1\.5 GB available/)
    assert.match(m.text, /🟢 Machine: Disk \(back to normal\)/)
    assert.match(m.text, /Status page: https:\/\/status\.example/)
    const teams = alertBody(m, 'teams')
    assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive')
    assert.equal(teams.attachments[0].content.body[0].text, m.head)
    assert.deepEqual(alertBody(m, 'slack'), { text: m.text })
})

test('test-alert really posts to the webhook, and fails clearly when it cannot', async () => {
    const got: any[] = []
    let code = 200
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.writeHead(code).end() }) })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`
    const run = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn(process.execPath, [fileURLToPath(new URL('../deploy/status/server.mjs', import.meta.url)), 'test-alert'], { env: { PATH: process.env.PATH!, ...env } })
        let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
        p.on('close', (c) => resolve({ code: c, out }))
    })
    try {
        let r = await run({ STATUS_ALERT_WEBHOOK: url })
        assert.equal(r.code, 0, r.out)
        assert.match(got[0].text, /Alerts work/)
        code = 500
        r = await run({ STATUS_ALERT_WEBHOOK: url })
        assert.equal(r.code, 1); assert.match(r.out, /not sent: HTTP 500/)
        r = await run({})
        assert.equal(r.code, 1); assert.match(r.out, /not set/)
    } finally { srv.close() }
})

test('review fixes: flapping warning/down still alerts; a failed collector is not a recovery', () => {
    const now = 100 * MIN
    // the unbroken bad period started 10 min ago, even though the level changed a minute ago
    assert.equal(alertChanges([row('Memory', 'down')], since([['Machine/Memory', 'down', now - 10 * MIN]]), new Map(), now, 5 * MIN).firing.length, 1)
    const alerted = new Map([['Containers: posthog/capture', { level: 'warn', group: 'Containers: posthog', name: 'capture' }]])
    const blind = alertChanges([{ group: 'Containers', name: 'Docker', level: 'down', detail: 'cannot read the container list' }], new Map(), alerted, now, 5 * MIN)
    assert.equal(blind.fixed.length, 0, 'capture is unknown, not fixed')
})
