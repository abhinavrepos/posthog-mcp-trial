/** Wire-compatible rrweb recordings, following deploy/posthog/replaytest.ts. No packages to install. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statfsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'

const ROOT = dirname(fileURLToPath(import.meta.url))
type RR = { type: number; timestamp: number; data: Record<string, unknown> }
type Capture = { uuid: string; event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }
type Status = 'pending' | 'sending' | 'sent'
type Session = {
    session_id: string; window_id: string; client: string; user: string; distinct_id: string
    screens: string[]; outcome: string; rrweb: RR[]; events: Capture[]
    snapshotStatus: Status; eventsStatus: Status; verified: boolean; replay_url: string
}
type Manifest = { version: 1; seed: number; team: number; host: string; created: string; sessions: Session[] }
const rows = (file: string): string[][] => readFileSync(join(ROOT, file), 'utf8').trim().split('\n').map(l => l.split('\t'))
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))
const uuid = (value: string): string => {
    const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
    hex[12] = '4'; hex[16] = '8'
    const s = hex.join('')
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}
export function rng(seed: number): () => number {
    let n = seed >>> 0
    return () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n / 4294967296 }
}

/** Valid rrweb node references: interaction targets and mutated text nodes belong to this snapshot. */
export function snapshot(screen: string, ts: number): { events: RR[]; button: number; status: number; body: number } {
    let id = 1
    const txt = (textContent: string) => ({ type: 3, id: ++id, textContent })
    const el = (tagName: string, attributes: Record<string, string>, childNodes: unknown[]) => ({ type: 2, id: ++id, tagName, attributes, childNodes })
    const statusNode = txt('Ready'); const button = el('button', { id: 'save' }, [txt('Save')])
    const body = el('body', {}, [
        el('header', {}, [txt('REVAL 27.0.0 | Treasury & Risk')]),
        el('nav', {}, [txt('Deals · Cash · Accounting · Reports')]),
        el('h1', {}, [txt(screen)]),
        el('table', {}, Array.from({ length: 20 }, (_, i) => el('tr', {}, [el('td', {}, [txt(`Trade ${1001 + i}`)]), el('td', {}, [txt(`${(12345.67 * (i + 1)).toFixed(2)} USD`)])]))),
        button, el('p', { role: 'status' }, [statusNode]),
    ])
    const doc = { type: 0, id: 1, childNodes: [
        { type: 1, id: ++id, name: 'html', publicId: '', systemId: '' },
        el('html', { lang: 'en' }, [el('head', {}, [el('title', {}, [txt(screen)]), el('style', {}, [txt('body{font:16px Arial;background:#f5f7fa;color:#182638;margin:32px}header{background:#183b57;color:white;padding:18px}td{padding:6px 28px}button{padding:12px 28px}h1{color:#183b57}')])]), body]),
    ] }
    return { events: [
        { type: 4, timestamp: ts, data: { href: `https://reval.example/screens/${encodeURIComponent(screen)}`, width: 1440, height: 900 } },
        { type: 2, timestamp: ts + 1, data: { node: doc, initialOffset: { left: 0, top: 0 } } },
    ], button: button.id, status: statusNode.id, body: body.id }
}

export function generate(team: number, host: string, seed: number, now: number, count = 60): Manifest {
    const random = rng(seed)
    const clients = rows('clients.tsv').slice(0, 10)
    const users = rows('users.tsv')
    const screens = rows('screens.tsv').slice(0, 16) // Deal List and fifteen treasury screens
    const sessions: Session[] = []
    for (let i = 0; i < count; i++) {
        const [source, client] = clients[i % clients.length]
        const handles = users.filter(r => r[0] === source)
        const user = handles[i === 0 ? 0 : Math.floor(random() * handles.length)][2]
        const distinct_id = `C1DEV|01|${client}|${user}`
        const session_id = uuid(`reval:${seed}:${team}:${i}`)
        const window_id = uuid(`${session_id}:window`)
        const outcome = ['success', 'retry', 'error', 'abandoned'][Math.floor(random() * 4)]
        const start = now - 600_000 + i * 1200
        const s: Session = { session_id, window_id, client, user, distinct_id, screens: [], outcome, rrweb: [], events: [], snapshotStatus: 'pending', eventsStatus: 'pending', verified: false, replay_url: `${host}/project/${team}/replay/${session_id}` }
        let ts = start
        const event = (name: string, dialog: string, screen: string, action: string, action_name: string, control_type: string) => {
            s.events.push({ uuid: uuid(`${session_id}:event:${s.events.length}`), event: name, distinct_id, timestamp: new Date(ts).toISOString(), properties: {
                $session_id: session_id, $window_id: window_id, $current_url: `https://reval.example/screens/${dialog}`, $lib: 'web', $lib_version: '1.300.0',
                dialog_id: dialog, dialog_name: screen, tab_name: screen, title: 'REVAL 27.0.0', action, action_name, control_type,
            } })
        }
        const nScreens = 1 + Math.floor(random() * 3)
        for (let j = 0; j < nScreens; j++) {
            const [dialog, screen] = screens[j === 0 ? i % screens.length : Math.floor(random() * screens.length)]
            s.screens.push(screen)
            const snap = snapshot(screen, ts)
            s.rrweb.push(...snap.events)
            event('PageView', dialog, screen, 'OPEN', screen, 'window')
            ts += 2000
            const steps = 3 + Math.floor(random() * 5)
            for (let k = 0; k < steps; k++) {
                s.rrweb.push({ type: 3, timestamp: ts, data: { source: 1, positions: [{ x: 170 + Math.floor(random() * 600), y: 220 + Math.floor(random() * 260), id: snap.button, timeOffset: 0 }] } })
                ts += 1000
                if (outcome !== 'abandoned' || k < steps - 1) {
                    s.rrweb.push({ type: 3, timestamp: ts, data: { source: 2, type: 2, id: snap.button, x: 240, y: 540 } })
                    const action = k === steps - 1 ? 'Save' : ['Refresh', 'Validate', 'Calculate', 'Open'][Math.floor(random() * 4)]
                    event('Event', dialog, screen, 'CLICK', action, 'button')
                    ts += 100
                    let message = `${action} completed`
                    let kind = 'toast'
                    if ((outcome === 'error' && k === steps - 1) || (outcome === 'retry' && k === steps - 2)) {
                        kind = 'messagebox'; message = ['Report could not be booked: missing rate', 'Trade validation failed: settlement account required', 'Market data unavailable; please retry'][Math.floor(random() * 3)]
                    } else if (outcome === 'retry' && k === steps - 1) message = 'Retry completed: trade booked'
                    else if (k === steps - 1) message = `Trade Id ${1001 + i} Updated`
                    s.rrweb.push({ type: 3, timestamp: ts, data: { source: 0, texts: [{ id: snap.status, value: message }], attributes: [], adds: [], removes: [] } })
                    event(kind === 'toast' ? 'toast' : 'Event', kind, screen, 'OPEN', message, kind)
                }
                ts += 2000 + Math.floor(random() * 1800)
            }
            if (outcome !== 'abandoned') event('PageView', dialog, screen, 'CLOSE', screen, 'window')
            ts += 1500
        }
        sessions.push(s)
    }
    return { version: 1, seed, team, host, created: new Date(now).toISOString(), sessions }
}

function save(file: string, manifest: Manifest) {
    writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
}
async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    return res
}
export function decodeSnapshots(text: string): RR[] {
    const out: RR[] = []
    for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const row: unknown = JSON.parse(line)
        const ev: unknown = Array.isArray(row) ? row[1] : (row as { data?: unknown }).data ?? row
        if (Array.isArray(ev)) out.push(...ev as RR[])
        else out.push(ev as RR)
    }
    return out
}
export function complete(expected: RR[], actual: RR[]): boolean {
    // Compare the multiset as well as total count: duplicate blobs cannot hide missing events.
    const key = (e: RR) => `${e.type}:${e.timestamp}`
    const a = expected.map(key).sort(), b = actual.map(key).sort()
    return a.length === b.length && a.every((v, i) => v === b[i]) && actual.some(e => e.type === 2)
}
async function stored(host: string, team: number, session: string, headers: Record<string, string>): Promise<RR[]> {
    const base = `${host}/api/environments/${team}/session_recordings/${session}/snapshots`
    // Recording metadata existence is checked separately from the snapshot blobs.
    await request(`${host}/api/environments/${team}/session_recordings/${session}/`, { headers })
    const meta = await (await request(`${base}?blob_v2=true`, { headers })).json() as { sources?: { source: string; blob_key: string }[] }
    const keys = (meta.sources ?? []).filter(s => s.source === 'blob_v2').map(s => Number(s.blob_key)).sort((a, b) => a - b)
    if (!keys.length) return []
    if (keys.some(k => !Number.isSafeInteger(k))) throw new Error('Unexpected blob_v2 key format')
    return decodeSnapshots(await (await request(`${base}?source=blob_v2&start_blob_key=${keys[0]}&end_blob_key=${keys.at(-1)}&blob_v2=true`, { headers })).text())
}
async function auth(host: string): Promise<Record<string, string>> {
    if (process.env.POSTHOG_PERSONAL_API_KEY) return { authorization: `Bearer ${process.env.POSTHOG_PERSONAL_API_KEY}` }
    const email = process.env.POSTHOG_ADMIN_EMAIL, password = process.env.POSTHOG_ADMIN_PASSWORD
    if (!email || !password) throw new Error('Set POSTHOG_PERSONAL_API_KEY or POSTHOG_ADMIN_EMAIL and POSTHOG_ADMIN_PASSWORD')
    const res = await request(`${host}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' })
    const cookies = res.headers.getSetCookie()
    if (!cookies.length) throw new Error('Login returned no cookies')
    return { cookie: cookies.map(c => c.split(';')[0]).join('; ') }
}
function checkDisk() {
    const path = process.env.POSTHOG_DIR || '/opt/posthog'
    const fs = statfsSync(path, { bigint: true })
    if (fs.bavail * fs.bsize < 25n * 1024n ** 3n) throw new Error(`STOP: less than 25 GiB free on ${path}`)
}
async function main() {
    const { values } = parseArgs({ options: { team: { type: 'string' }, seed: { type: 'string', default: '270001' }, 'drain-minutes': { type: 'string', default: '20' } } })
    const team = Number(values.team), seed = Number(values.seed), drain = Number(values['drain-minutes'])
    if (!Number.isSafeInteger(team) || team < 1 || !Number.isSafeInteger(seed) || !(drain > 0)) throw new Error('Usage: record-replays.ts --team TEAM_ID [--seed INTEGER] [--drain-minutes 20]')
    const token = process.env.POSTHOG_PROJECT_API_TOKEN
    if (!token) throw new Error('Set POSTHOG_PROJECT_API_TOKEN from project.sh')
    const host = (process.env.POSTHOG_HOST || 'http://localhost').replace(/\/$/, '')
    const file = join(ROOT, 'replays-manifest.json')
    let lock: number
    try { lock = openSync(`${file}.lock`, 'wx') } catch { throw new Error('Replay writer lock exists. If the previous process died, confirm it has stopped, then remove replays-manifest.json.lock.') }
    try {
        checkDisk()
        const headers = await auth(host) // Validate credentials before any capture writes.
        let manifest: Manifest
        try { manifest = JSON.parse(readFileSync(file, 'utf8')) as Manifest }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; manifest = generate(team, host, seed, Date.now()); save(file, manifest) }
        if (manifest.team !== team || manifest.host !== host || manifest.seed !== seed || manifest.version !== 1) throw new Error('Existing manifest belongs to another project/host/seed. Refusing to append or overwrite it.')
        // Check that this token belongs to the selected team, without needing Docker.
        const project = await (await request(`${host}/api/projects/${team}/`, { headers })).json() as { api_token?: string; name?: string }
        if (project.api_token !== token || project.name !== 'Reval replica') throw new Error('Team must be named Reval replica and its api_token must match POSTHOG_PROJECT_API_TOKEN')
        console.log(`Recording/resuming ${manifest.sessions.length} sessions in team ${team}; manifest ${file}`)
        for (const s of manifest.sessions) {
            for (const kind of ['snapshotStatus', 'eventsStatus'] as const) {
                if (s[kind] === 'sent') continue
                if (s[kind] === 'sending') {
                    // A lost HTTP response is ambiguous. Never blindly resend a capture batch.
                    if (kind === 'snapshotStatus' && complete(s.rrweb, await stored(host, team, s.session_id, headers))) {
                        s[kind] = 'sent'; save(file, manifest); continue
                    }
                    throw new Error(`${s.session_id} ${kind}: previous send has uncertain delivery. Wait for ingestion and rerun. For normal events, reconcile UUIDs in PostHog before setting this manifest status to sent (all present) or pending (all absent). Partial delivery requires restoring only missing events; never resend the whole batch.`)
                }
                checkDisk()
                s[kind] = 'sending'; save(file, manifest)
                const payload: Capture[] = kind === 'snapshotStatus' ? [{ uuid: uuid(`${s.session_id}:snapshot`), event: '$snapshot', distinct_id: s.distinct_id, timestamp: new Date(s.rrweb[0].timestamp).toISOString(), properties: {
                    token, $session_id: s.session_id, $window_id: s.window_id, $snapshot_data: s.rrweb, $snapshot_bytes: Buffer.byteLength(JSON.stringify(s.rrweb)), $snapshot_source: 'web', $lib: 'web', $lib_version: '1.300.0',
                } }] : s.events.map(e => ({ ...e, properties: { ...e.properties, token } }))
                const url = kind === 'snapshotStatus' ? `${host}/s/?compression=gzip-js&ip=1&ver=1.300.0` : `${host}/i/v0/e/?compression=gzip-js&ip=1&ver=1.300.0`
                await (await request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: gzipSync(JSON.stringify(payload)) })).arrayBuffer()
                s[kind] = 'sent'; save(file, manifest)
                console.log(`${s.session_id}: ${kind} accepted`)
            }
        }
        const deadline = Date.now() + drain * 60_000
        // Verify ALL sessions on every invocation, including previously completed ones.
        const pending = new Set(manifest.sessions.map(s => s.session_id))
        while (pending.size && Date.now() < deadline) {
            for (const s of manifest.sessions.filter(s => pending.has(s.session_id))) {
                try {
                    const events = await stored(host, team, s.session_id, headers)
                    if (complete(s.rrweb, events)) {
                        s.verified = true; pending.delete(s.session_id); save(file, manifest)
                        console.log(`VERIFIED ${s.session_id}: ${events.length} rrweb events, complete`)
                    } else console.log(`Waiting ${s.session_id}: ${events.length}/${s.rrweb.length} rrweb events`)
                } catch (e) { console.log(`Waiting ${s.session_id}: ${(e as Error).message}`) }
            }
            if (pending.size) await pause(10_000)
        }
        console.log('session_id\tclient\tuser\tscreens\toutcome\treplay URL')
        for (const s of manifest.sessions) console.log([s.session_id, s.client, s.user, s.screens.join(' → '), s.outcome, s.replay_url].join('\t'))
        if (pending.size) throw new Error(`${pending.size} recordings incomplete after ${drain} minutes; rerun to verify without resending accepted captures`)
        console.log(`PASS: all ${manifest.sessions.length} recordings exist and contain every expected rrweb event`)
    } finally { closeSync(lock); unlinkSync(`${file}.lock`) }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    main().catch(e => { console.error(e); process.exitCode = 1 })
}
