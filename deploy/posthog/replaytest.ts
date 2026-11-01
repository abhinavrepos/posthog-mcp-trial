// Session replay under load: many screens recording at the same time, then a check that every
// recording is stored complete and in order. Sends what posthog-js sends: a $snapshot event every
// couple of seconds per screen, gzipped, with rrweb data (a full page snapshot on each page view,
// then DOM changes, mouse moves, clicks and scrolls), plus the screen's normal $pageview events.
//
//   tsx deploy/posthog/replaytest.ts --screens 200 --minutes 5
//
// Uses the separate "Load test" project (see loadtest.ts). Everything it records is made up.
// Settings: POSTHOG_DIR, POSTHOG_HOST, REPLAYTEST_PROJECT (project name, default "Load test"), POSTHOG_ADMIN_EMAIL / POSTHOG_ADMIN_PASSWORD (to read the
// stored recordings back through the API).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import { config, ROOT } from '../../src/core/config.ts'

const sh = promisify(execFile)
const { values: opt } = parseArgs({
    options: {
        screens: { type: 'string', default: '200' },
        minutes: { type: 'string', default: '5' },
        'flush-seconds': { type: 'string', default: '2' },
        'drain-minutes': { type: 'string', default: '15' },
        check: { type: 'string', default: '20' }, // recordings read back in full through the API
    },
})
const SCREENS = Number(opt.screens)
const SECONDS = Number(opt.minutes) * 60
const FLUSH_MS = Number(opt['flush-seconds']) * 1000
const POSTHOG_DIR = process.env.POSTHOG_DIR || '/opt/posthog'
const HOST = config.posthog.host
const RUN = `replay-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const compose = async (args: string[], input?: string, timeout = 120_000): Promise<string> => {
    const p = sh('docker', ['compose', ...args], { cwd: POSTHOG_DIR, maxBuffer: 64 << 20, timeout })
    if (input !== undefined) {
        p.child.stdin!.write(input)
        p.child.stdin!.end()
    }
    return (await p).stdout
}
const ch = async (sql: string) => (await compose(['exec', '-T', 'clickhouse', 'clickhouse-client', '-d', 'posthog', '-q', sql])).trim()

async function project(): Promise<{ id: number; token: string }> {
    const py = `
import json
from posthog.models import Team, User
team = Team.objects.filter(name=${JSON.stringify(process.env.REPLAYTEST_PROJECT || "Load test")}).first()
if not team:
    user = User.objects.filter(email=${JSON.stringify(config.posthog.adminEmail || '')}).first() or User.objects.order_by("id").first()
    team = Team.objects.create_with_data(organization=user.organization, name=${JSON.stringify(process.env.REPLAYTEST_PROJECT || "Load test")}, initiating_user=user)
team.session_recording_opt_in = True
team.save()
print("LT" + json.dumps({"id": team.id, "token": team.api_token}))
`
    const line = (await compose(['exec', '-T', 'web', 'python', 'manage.py', 'shell'], py, 180_000)).split('\n').find((l) => l.startsWith('LT{'))
    if (!line) throw new Error('could not set up the Load test project')
    return JSON.parse(line.slice(2))
}

// ------------------------------------------------------------------ one screen
const PAGES = ['/dashboard', '/invoices', '/invoices/new', '/clients', '/reports/revenue', '/settings']
const text = (n: number) => `Row ${n}: Invoice INV-${10000 + n} · ${(n * 37.13).toFixed(2)} EUR · due in ${n % 30} days`

/** An rrweb full snapshot of a portal page: a header, a nav and a table, about 60–120 KB of JSON. */
function fullSnapshot(path: string, ts: number) {
    let id = 1
    const el = (tagName: string, attributes: Record<string, string>, childNodes: unknown[]) => ({ type: 2, tagName, attributes, childNodes, id: ++id })
    const txt = (textContent: string) => ({ type: 3, textContent, id: ++id })
    const rows = 150 + Math.floor(Math.random() * 150)
    const doc = {
        type: 0,
        id: 1,
        childNodes: [
            { type: 1, name: 'html', publicId: '', systemId: '', id: ++id },
            el('html', { lang: 'en' }, [
                el('head', {}, [el('title', {}, [txt(`Acme Portal ${path}`)]), el('style', {}, [txt('body{font-family:sans-serif}table{width:100%}td{padding:4px}')])]),
                el('body', { class: 'portal' }, [
                    el('header', { class: 'top' }, [txt('Acme Portal')]),
                    el('nav', {}, PAGES.map((p) => el('a', { href: p }, [txt(p.slice(1))]))),
                    el('main', { id: 'main' }, [el('table', { class: 'grid' }, Array.from({ length: rows }, (_, n) => el('tr', {}, [el('td', {}, [txt(text(n))]), el('td', {}, [el('button', { class: 'btn' }, [txt('Open')])])])))]),
                ]),
            ]),
        ],
    }
    return { events: [{ type: 4, data: { href: `https://portal.example.com${path}`, width: 1440, height: 900 }, timestamp: ts }, { type: 2, data: { node: doc, initialOffset: { left: 0, top: 0 } }, timestamp: ts + 5 }], maxId: id }
}

interface Screen {
    user: string
    session: string
    window: string
    maxId: number
    buffer: unknown[]
    sent: number // rrweb events accepted by PostHog
    clicks: number
    pageAt: number
    failed: number
}

function tick(s: Screen, now: number) {
    // A new page every 30–90 seconds: page view plus a fresh full snapshot, like posthog-js.
    if (now >= s.pageAt) {
        const path = PAGES[Math.floor(Math.random() * PAGES.length)]
        const snap = fullSnapshot(path, now)
        s.buffer.push(...snap.events)
        s.maxId = snap.maxId
        s.pageAt = now + 30_000 + Math.random() * 60_000
        return path
    }
    // Between page views: mouse moves, a scroll, sometimes a click and a DOM change.
    s.buffer.push({ type: 3, data: { source: 1, positions: Array.from({ length: 8 }, (_, i) => ({ x: Math.round(Math.random() * 1440), y: Math.round(Math.random() * 900), id: 1 + Math.floor(Math.random() * s.maxId), timeOffset: -i * 50 })) }, timestamp: now - 400 })
    s.buffer.push({ type: 3, data: { source: 3, id: 1, x: 0, y: Math.round(Math.random() * 3000) }, timestamp: now - 200 })
    if (Math.random() < 0.4) {
        s.clicks++
        s.buffer.push({ type: 3, data: { source: 2, type: 2, id: 1 + Math.floor(Math.random() * s.maxId), x: 300, y: 400 }, timestamp: now - 100 })
        s.buffer.push({ type: 3, data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ parentId: 3, nextId: null, node: { type: 3, textContent: `Saved at ${new Date(now).toISOString()}`, id: ++s.maxId } }] }, timestamp: now - 50 })
    }
    return null
}

async function flush(s: Screen, token: string, page: string | null) {
    const data = s.buffer.splice(0)
    if (!data.length) return
    const body = gzipSync(
        JSON.stringify([
            {
                event: '$snapshot',
                distinct_id: s.user,
                properties: { token, $session_id: s.session, $window_id: s.window, $snapshot_data: data, $snapshot_bytes: JSON.stringify(data).length, $snapshot_source: 'web', $lib: 'web', $lib_version: '1.300.0', lt_run: RUN },
                timestamp: new Date().toISOString(),
            },
        ])
    )
    try {
        const res = await fetch(`${HOST}/s/?compression=gzip-js&ip=1&_=${Date.now()}&ver=1.300.0`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body, signal: AbortSignal.timeout(30_000) })
        await res.arrayBuffer()
        if (res.ok) s.sent += data.length
        else s.failed++
    } catch {
        s.failed++
    }
    if (page) {
        await fetch(`${HOST}/i/v0/e/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ event: '$pageview', distinct_id: s.user, properties: { token, $session_id: s.session, $window_id: s.window, $current_url: `https://portal.example.com${page}`, $pathname: page, lt_run: RUN } }),
        }).catch(() => {})
    }
}

// ------------------------------------------------------------------ reading recordings back
async function login(): Promise<{ cookie: string }> {
    const res = await fetch(`${HOST}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: config.posthog.adminEmail, password: config.posthog.adminPassword }), redirect: 'manual' })
    if (!res.ok) throw new Error(`PostHog login → ${res.status}`)
    return { cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
}
/** Every rrweb event PostHog stored for one recording, through the same API the replay player uses. */
async function storedEvents(teamId: number, session: string, cookie: string): Promise<{ type: number; timestamp: number }[]> {
    const base = `${HOST}/api/environments/${teamId}/session_recordings/${session}/snapshots`
    const meta = (await (await fetch(`${base}?blob_v2=true`, { headers: { cookie } })).json()) as { sources?: { source: string; blob_key: string }[] }
    const blobs = (meta.sources || []).filter((x) => x.source === 'blob_v2')
    if (!blobs.length) return []
    const keys = blobs.map((b) => Number(b.blob_key)).sort((a, b) => a - b)
    const res = await fetch(`${base}?source=blob_v2&start_blob_key=${keys[0]}&end_blob_key=${keys.at(-1)}&blob_v2=true`, { headers: { cookie } })
    const out: { type: number; timestamp: number }[] = []
    for (const line of (await res.text()).split('\n')) {
        if (!line.trim()) continue
        const row = JSON.parse(line)
        const ev = Array.isArray(row) ? row[1] : row.data ?? row
        if (Array.isArray(ev)) out.push(...ev)
        else out.push(ev)
    }
    return out
}

async function main() {
    const p = await project()
    log(`Run ${RUN}: ${SCREENS} screens recording for ${SECONDS}s, flushing every ${FLUSH_MS / 1000}s, project ${p.id}`)
    const start = Date.now()
    const screens: Screen[] = Array.from({ length: SCREENS }, (_, i) => ({ user: `lt-viewer-${i}@client${i % 120}.example`, session: randomUUID(), window: randomUUID(), maxId: 0, buffer: [], sent: 0, clicks: 0, pageAt: 0, failed: 0 }))
    const restartsBefore = (await sh('docker', ['inspect', '-f', '{{.Name}} {{.RestartCount}}', ...(await compose(['ps', '-q'])).trim().split('\n')])).stdout

    // Every screen runs on its own clock, offset so they don't all flush in the same instant.
    await Promise.all(
        screens.map(async (s, i) => {
            await sleep((i / SCREENS) * FLUSH_MS)
            while (Date.now() - start < SECONDS * 1000) {
                const page = tick(s, Date.now())
                await flush(s, p.token, page)
                await sleep(FLUSH_MS * (0.8 + Math.random() * 0.4))
            }
        })
    )
    const sent = screens.reduce((n, s) => n + s.sent, 0)
    const failed = screens.reduce((n, s) => n + s.failed, 0)
    log(`Recording done: ${sent} rrweb events accepted, ${failed} failed requests. Waiting for PostHog to store them…`)

    // Replays are written in blocks a few minutes after the session goes quiet; wait for all of them.
    const ids = screens.map((s) => `'${s.session}'`).join(',')
    const drainStart = Date.now()
    let rows: { session_id: string; events: number; clicks: number; bytes: number; first: string; last: string }[] = []
    let lastTotal = -1
    let stableSince = Date.now()
    while (Date.now() - drainStart < Number(opt['drain-minutes']) * 60_000) {
        const out = await ch(
            `SELECT session_id, sum(event_count), sum(click_count), sum(size), min(min_first_timestamp), max(max_last_timestamp) FROM session_replay_events WHERE team_id = ${p.id} AND session_id IN (${ids}) GROUP BY session_id FORMAT TSV`
        )
        rows = out.split('\n').filter(Boolean).map((l) => { const [session_id, e, c, b, f, la] = l.split('\t'); return { session_id, events: Number(e), clicks: Number(c), bytes: Number(b), first: f, last: la } })
        const total = rows.reduce((n, r) => n + r.events, 0)
        if (total !== lastTotal) stableSince = Date.now()
        lastTotal = total
        if (rows.length === SCREENS && total >= sent) break
        if (Date.now() - stableSince > 180_000) break
        await sleep(10_000)
    }
    const drainSeconds = Math.round((Date.now() - drainStart) / 1000)
    const byId = new Map(rows.map((r) => [r.session_id, r]))
    const incomplete = screens.filter((s) => (byId.get(s.session)?.events || 0) !== s.sent)

    // Read some recordings back in full, as the player would, and check them.
    const { cookie } = await login()
    const sample = [...screens].sort(() => Math.random() - 0.5).slice(0, Number(opt.check))
    const checks = []
    for (const s of sample) {
        const evs = await storedEvents(p.id, s.session, cookie).catch((e) => { log('read failed', s.session, (e as Error).message); return [] })
        const ordered = evs.every((e, i) => i === 0 || e.timestamp >= evs[i - 1].timestamp - 1000)
        const playable = evs.length > 1 && evs[0].type === 4 && evs[1].type === 2
        checks.push({ session: s.session, sent: s.sent, stored: evs.length, starts_with_full_snapshot: playable, in_order: ordered, ok: evs.length === s.sent && playable && ordered })
    }
    const restartsAfter = (await sh('docker', ['inspect', '-f', '{{.Name}} {{.RestartCount}}', ...(await compose(['ps', '-q'])).trim().split('\n')])).stdout
    const before = new Map(restartsBefore.trim().split('\n').map((l) => l.split(' ') as [string, string]))
    const restarted = restartsAfter.trim().split('\n').map((l) => l.split(' ')).filter(([n, c]) => before.get(n) !== c).map(([n, c]) => `${n.replace('/posthog-', '')}: ${before.get(n) ?? 'new'} → ${c}`)
    const warnings = await ch(`SELECT type, count() FROM ingestion_warnings WHERE team_id = ${p.id} AND timestamp > now() - INTERVAL 1 HOUR GROUP BY type FORMAT TSV`).catch(() => '')

    const report = {
        run: RUN,
        screens: SCREENS,
        seconds: SECONDS,
        rrweb_events_accepted: sent,
        failed_requests: failed,
        recordings_stored: `${rows.length} of ${SCREENS}`,
        rrweb_events_stored: rows.reduce((n, r) => n + r.events, 0),
        recordings_incomplete: incomplete.length,
        incomplete_examples: incomplete.slice(0, 5).map((s) => ({ session: s.session, sent: s.sent, stored: byId.get(s.session)?.events || 0 })),
        stored_mb: Math.round(rows.reduce((n, r) => n + r.bytes, 0) / 1e6),
        drain_seconds: drainSeconds,
        read_back: `${checks.filter((c) => c.ok).length} of ${checks.length} complete, in order and starting with a full snapshot`,
        read_back_failures: checks.filter((c) => !c.ok),
        ingestion_warnings: warnings,
        container_restarts: restarted,
    }
    mkdirSync(join(ROOT, 'run/loadtest'), { recursive: true })
    writeFileSync(join(ROOT, 'run/loadtest', `${RUN}.json`), JSON.stringify({ ...report, checks }, null, 2))
    console.log(JSON.stringify(report, null, 2))
    const ok = failed === 0 && rows.length === SCREENS && incomplete.length === 0 && checks.every((c) => c.ok) && restarted.length === 0
    log(ok ? 'PASS: every recording stored complete and playable' : 'FAIL: see the report above')
    process.exit(ok ? 0 : 1)
}

main().catch((e) => {
    console.error(e)
    process.exit(2)
})
