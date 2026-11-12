import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import { config } from '../src/core/config.ts'
import type { Viewer } from '../src/service/access.ts'
import { containerSummary, lensActivity, readStatus, systemHtml } from '../src/service/system.ts'

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

test('container totals call out unhealthy, restarting and stopped processes, excluding finished jobs', () => {
    const rows = [
        { state: 'running', level: 'ok' }, { state: 'running', health: 'unhealthy', level: 'down' },
        { state: 'restarting', level: 'down' }, { state: 'exited', level: 'down' }, { state: 'exited', level: 'info' },
    ]
    assert.deepEqual(containerSummary(rows), { expected: 4, running: 2, unhealthy: 1, restarting: 1, stopped: 1, problems: 3 })
})

test('Lens activity counts audit actions and returns only aggregate storage', () => {
    const actions = ['signin', 'signin', 'signin.failed', 'clip.created', 'clip.viewed', 'clip.viewed', 'clip.downloaded', 'clip.link_shared', 'clip.requested']
    const now = Date.parse('2026-11-10T12:00:00Z')
    const result = lensActivity(q => {
        assert.deepEqual(q, { since: '2026-11-09T12:00:00.000Z', limit: 100_000 })
        return actions.map(action => ({ action, who: 'private@example.com', details: 'not returned' }))
    }, () => ({ clips: 5, bytes: 1024, saved: 2, saved_bytes: 400, per_person: [{ email: 'private@example.com', clips: 5, saved: 2, bytes: 1024 }] }), now)
    assert.deepEqual(result.activity, { signins: 2, failed_signins: 1, clips_made: 1, clips_watched: 2, clips_downloaded: 1, share_links: 1, truncated: false })
    assert.deepEqual(result.storage, { clips: 5, bytes: 1024, saved: 2, saved_bytes: 400 })
    assert.ok(!JSON.stringify(result).includes('private'))
    const unavailable = () => { throw new Error('database unavailable') }
    assert.equal(lensActivity(unavailable, unavailable).activity, null)
    assert.equal(lensActivity(unavailable, unavailable).storage, null)
    assert.equal(lensActivity(unavailable, () => ({ clips: 0, bytes: 0, saved: 0, saved_bytes: 0, per_person: [] })).storage?.clips, 0)
})

function browser() {
    const elements = new Map<string, { innerHTML: string; textContent: string; value: string; className: string; clientWidth: number; querySelectorAll: () => never[] }>()
    const get = (id: string) => {
        if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: id === 'view' ? 'all' : '', className: '', clientWidth: 320, querySelectorAll: () => [] })
        return elements.get(id)!
    }
    const html = systemHtml(admin)
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
    const ctx = createContext({ document: { getElementById: get }, setInterval: () => {}, fetch: () => new Promise(() => {}) })
    runInContext(script, ctx)
    return { get, ctx, draw: (status: unknown) => { ctx.status = status; runInContext('draw(status)', ctx) } }
}

test('the browser escapes container names, image names, health output and ClickHouse table names', () => {
    const b = browser()
    const attack = '<img src=x onerror="alert(1)">'
    b.draw({ level: 'down', down: 1, checks: [{ group: 'Containers: posthog', name: attack, image: attack, health_output: attack, state: 'running', health: 'unhealthy', level: 'down', detail: attack }], metrics: { clickhouse: { tables: [{ database: attack, table: attack, bytes: 1, rows: 1 }] } } })
    for (const id of ['rows', 'problems', 'clickhouse']) {
        assert.ok(!b.get(id).innerHTML.includes('<img'))
        assert.ok(b.get(id).innerHTML.includes('&lt;img'))
    }
    assert.match(b.get('tiles').innerHTML, /tile failure/)
    assert.match(b.get('tiles').innerHTML, /1 unhealthy/)
    assert.match(b.get('tiles').innerHTML, /1 of 1/)
})

test('stale status warns even when the last check was healthy', () => {
    const b = browser()
    b.draw({ level: 'ok', checked_at: new Date(Date.now() - 65_000).toISOString(), checks: [] })
    assert.equal(b.get('banner').className, 'banner warn')
    assert.match(b.get('b-head').textContent, /checks have stopped/)
    assert.match(b.get('b-sub').textContent, /Updated 65 s ago/)
})

// Exercise the dependency-free collector with Docker/ClickHouse substitutes, without opening sockets.
function collector() {
    const source = readFileSync(new URL('../deploy/status/server.mjs', import.meta.url), 'utf8')
        .replace(/^import .+ from 'node:[^']+'\n/gm, '').replace(/^export /gm, '').split('\nconst MAIN =')[0]
    const ctx = createContext({ process: { env: {}, uptime: () => 12 }, console, setTimeout, clearTimeout,
        AbortSignal, os: { cpus: () => [1, 2], uptime: () => 10, loadavg: () => [1, 2, 3], hostname: () => 'test' },
        readFileSync: (path: string) => path === '/proc/stat' ? 'cpu  20 0 10 70 0 0 0 0\n' : 'MemTotal: 100 kB\nMemAvailable: 50 kB\nSwapTotal: 40 kB\nSwapFree: 10 kB',
        statfsSync: () => ({ blocks: 100, bsize: 1024, bavail: 20 }),
    })
    runInContext(source, ctx)
    return ctx
}

test('container collection keeps 40 containers independent and records detail and samples', async () => {
    const ctx = collector()
    ctx.fakeDocker = async (path: string) => {
        if (path.startsWith('/containers/json')) return Array.from({ length: 40 }, (_, i) => ({ Id: String(i), Names: ['/posthog-worker-' + i], Labels: { 'com.docker.compose.project': 'posthog' } }))
        if (path === '/containers/1/json') throw new Error('inspect failed')
        if (path.endsWith('/json')) return { State: { Status: 'running', StartedAt: '2026-11-10T00:00:00Z', OOMKilled: false, Health: { Status: 'unhealthy', Log: [{ Output: 'x'.repeat(400) }] } }, HostConfig: { Memory: 1000 }, Config: { Image: 'registry/repo:v1' } }
        if (path.includes('/2/stats')) throw new Error('stats failed')
        return { cpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 100 }, memory_stats: { usage: 500, stats: { inactive_file: 100 } }, networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } }, blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 30 }, { op: 'Write', value: 40 }] }, pids_stats: { current: 3 } }
    }
    runInContext('docker = fakeDocker', ctx)
    const rows = await runInContext('checkContainers()', ctx)
    assert.equal(rows.length, 40)
    assert.equal(rows.find((r: {name: string}) => r.name === 'worker-1').level, 'warn')
    const row = rows.find((r: {name: string}) => r.name === 'worker-0')
    assert.equal(row.mem_bytes, 400)
    assert.equal(row.mem_limit_pct, 40)
    assert.equal(row.network_rx_bytes, 10)
    assert.equal(row.block_write_bytes, 40)
    assert.equal(row.pids, 3)
    assert.equal(row.health_output.length, 300)
    assert.equal(row.image, 'repo:v1')
    assert.equal(row.history.length, 1)
    assert.equal(rows.find((r: {name: string}) => r.name === 'worker-2').mem_bytes, undefined)
})

test('ClickHouse and Docker caches isolate failures and do not repeat expensive queries', async () => {
    const ctx = collector()
    const calls: string[] = []
    ctx.fakeCH = async (sql: string) => {
        calls.push(sql)
        if (sql.includes('system.merges')) throw new Error('merges unavailable')
        if (sql.includes('max(n)')) return [[1001]]
        if (sql.includes('GROUP BY database, table ORDER')) return [['posthog', 'events', 100, 200]]
        if (sql.includes('system.processes')) return [[2]]
        return [[1]]
    }
    let diskCalls = 0
    ctx.fakeDocker = async (path: string) => {
        if (path === '/version') return { Version: 'test' }
        diskCalls++
        return { LayersSize: 100, Containers: [{ SizeRw: 20 }], Volumes: [{ UsageData: { Size: 30 } }], BuildCache: [{ Size: 40 }] }
    }
    runInContext('clickhouse = fakeCH; docker = fakeDocker', ctx)
    const rows = await runInContext('collectHealth()', ctx)
    assert.equal(rows[0].level, 'down')
    assert.equal(runInContext('ch.merges', ctx), null)
    assert.equal(runInContext('ch.running_queries', ctx), 2)
    assert.equal(runInContext('dockerDisk.volumes_bytes', ctx), 30)
    await runInContext('collectHealth()', ctx)
    assert.equal(diskCalls, 1)
    assert.equal(calls.filter(sql => sql.includes('max(n)')).length, 1)
    assert.equal(calls.filter(sql => sql.includes('GROUP BY database, table ORDER')).length, 1)
    runInContext("track('worker', 'ok', { group: 'Containers', name: 'worker' }); track('worker', 'down', { group: 'Containers', name: 'worker' }); track('worker', 'ok', { group: 'Containers', name: 'worker' })", ctx)
    assert.equal(runInContext('changes.length', ctx), 2)
    assert.equal(runInContext('changes[0].level', ctx), 'ok')
})


test('all chart views render populated histories, including load above 100 and zero events', () => {
    const b = browser(), now = Date.now()
    b.draw({ level: 'ok', checked_at: new Date(now).toISOString(), checks: [{ group: 'Containers: posthog', name: 'worker', state: 'running', level: 'ok', history: [[now-15000, 1, 20], [now, 2, 30]] }], metrics: { extras_at: now, events_by_hour: [], events_by_minute: [], history: [[now-15000, 2, 40, 50, 110], [now, 3, 42, 51, 120]] } })
    for (const id of ['c-events', 'c-minutes', 'c-cpu', 'c-mem', 'c-disk', 'c-load']) {
        assert.match(b.get(id).innerHTML, /<svg/)
        assert.ok(!b.get(id).innerHTML.includes('NaN'))
    }
    assert.match(b.get('rows').innerHTML, /CPU over the last hour/)
    assert.match(b.get('rows').innerHTML, /Memory over the last hour/)
})
