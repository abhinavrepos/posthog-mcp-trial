// The replay clip page: paste a PostHog replay link, pick a start and a length, get an MP4.
//
// People sign in with their PostHog account (see access.ts). What they may do depends on the role
// an admin gives them on /replays/admin: watch clips, or also download and share them. Every
// action goes to the audit table. Clips live in the database (core/db.ts): the same part of the same
// recording is one file however many people ask for it, a clip nobody saved is deleted
// CLIP_RETENTION_DAYS (14) after it was last asked for, and a saved one stays until it is unsaved.
import { randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { renderClip } from '../core/clip.ts'
import { config } from '../core/config.ts'
import { all, db, one, run, tx } from '../core/db.ts'
import { clipUrl } from '../core/links.ts'
import { replayUrl } from '../core/posthog.ts'
import { recordingInfo, type RecordingInfo } from '../core/recording-info.ts'
import { downloadName, formatClock, HourlyLimit, parseReplayInput, parseStartTime } from '../core/replay-input.ts'
import { audit, can, csrfCookie, currentViewer, loadAccess, ROLE_TEXT, sessionCookie, signIn, signOut, type Role, type Viewer } from './access.ts'
import { handleAdmin } from './admin.ts'

const RETENTION_DAYS = Number(process.env.CLIP_RETENTION_DAYS || 14)
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 365)
const PER_HOUR = Number(process.env.CLIPS_PER_HOUR || 20)
const MAX_QUEUE = 20
const LENGTHS = [10, 20, 30, 45, 60, 90, 120]

// ------------------------------------------------------------------ clips in the database
export interface ClipRecord {
    name: string // file in clips/; the same session and range always give the same name
    session_id: string
    start_s: number
    end_s: number
    client?: string
    user?: string
    recording_start?: string
    download_name: string
    bytes: number
    created_by: string // who asked first
    created_at: string
    last_requested_at: string
    holders: string[] // everyone who made or saved it
    saved_by: string[]
    expires_at?: string // undefined while someone has it saved
}

const SELECT_CLIP = `SELECT c.*,
    (SELECT json_group_array(email) FROM clip_holders h WHERE h.clip_name = c.name) AS holders,
    (SELECT json_group_array(email) FROM clip_holders h WHERE h.clip_name = c.name AND h.saved_at IS NOT NULL) AS saved_by
    FROM clips c`
const DAY = 86_400_000

function fromRow(r: Record<string, unknown>): ClipRecord {
    const c: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) if (v !== null) c[k] = v
    c.holders = JSON.parse(String(r.holders))
    c.saved_by = JSON.parse(String(r.saved_by))
    if (!(c.saved_by as string[]).length) c.expires_at = new Date(Date.parse(String(r.last_requested_at)) + RETENTION_DAYS * DAY).toISOString()
    return c as unknown as ClipRecord
}

export function getClip(name: string): ClipRecord | undefined {
    const r = one<Record<string, unknown>>(`${SELECT_CLIP} WHERE c.name = ?`, name)
    return r ? fromRow(r) : undefined
}

/** Recent clips, or only the ones this person made or saved. */
export function listClips(opts: { holder?: string; limit?: number } = {}): ClipRecord[] {
    const where = opts.holder ? 'WHERE c.name IN (SELECT clip_name FROM clip_holders WHERE email = ?)' : ''
    const params = opts.holder ? [opts.holder] : []
    return all<Record<string, unknown>>(`${SELECT_CLIP} ${where} ORDER BY c.last_requested_at DESC LIMIT ?`, ...params, opts.limit ?? 200).map(fromRow)
}

/** Records that `by` has this clip. A clip that already exists is not stored again: the person is
 * added to it and its two weeks start again. */
export function storeClip(clip: { name: string; session_id: string; start_offset_s: number; end_offset_s: number }, info: Partial<RecordingInfo> | undefined, by: string): ClipRecord {
    const now = new Date().toISOString()
    const file = join(config.clip.outDir, clip.name)
    const bytes = existsSync(file) ? statSync(file).size : 0
    tx(() => {
        run(
            `INSERT INTO clips (name, session_id, start_s, end_s, client, user, recording_start, download_name, bytes, created_by, created_at, last_requested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET last_requested_at = excluded.last_requested_at, bytes = excluded.bytes`,
            clip.name, clip.session_id, clip.start_offset_s, clip.end_offset_s, info?.client ?? null, info?.user ?? null, info?.start ?? null,
            downloadName({ client: info?.client, user: info?.user, recordingStart: info?.start, startS: clip.start_offset_s, endS: clip.end_offset_s }),
            bytes, by, now, now
        )
        run('INSERT INTO clip_holders (clip_name, email, made_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', clip.name, by, now)
    })
    return getClip(clip.name)!
}

/** Adds a clip made elsewhere (for example by the MCP tools) to the clip page. */
export async function recordClip(clip: { name: string; session_id: string; start_offset_s: number; end_offset_s: number }, by: string): Promise<void> {
    let info: RecordingInfo | undefined
    try {
        info = await recordingInfo(clip.session_id)
    } catch {}
    storeClip(clip, info, by)
}

/** Saves a clip for this person (kept until unsaved), or unsaves it (deleted two weeks later unless
 * someone else saved it). */
export function setSaved(name: string, email: string, saved: boolean): ClipRecord | undefined {
    if (!getClip(name)) return undefined
    const now = new Date().toISOString()
    tx(() => {
        run(
            'INSERT INTO clip_holders (clip_name, email, made_at, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT (clip_name, email) DO UPDATE SET saved_at = excluded.saved_at',
            name, email, now, saved ? now : null
        )
        if (!saved) run('UPDATE clips SET last_requested_at = ? WHERE name = ?', now, name)
    })
    return getClip(name)
}

export function deleteClip(name: string): boolean {
    if (!getClip(name)) return false
    rmSync(join(config.clip.outDir, name), { force: true })
    run('DELETE FROM clips WHERE name = ?', name) // clip_holders rows go with it
    return true
}

/** Deletes clips nobody saved that nobody asked for in CLIP_RETENTION_DAYS, MP4 files no clip
 * row knows about (older than the same), and activity older than AUDIT_RETENTION_DAYS. */
export function pruneOldClips(now = Date.now()): number {
    const cutoff = new Date(now - RETENTION_DAYS * DAY).toISOString()
    const expired = all<{ name: string }>(
        `SELECT name FROM clips WHERE last_requested_at < ? AND NOT EXISTS (SELECT 1 FROM clip_holders h WHERE h.clip_name = clips.name AND h.saved_at IS NOT NULL)`,
        cutoff
    )
    for (const { name } of expired) deleteClip(name)
    // A row whose file went missing is dropped; renderClip makes the file again if someone asks.
    for (const { name } of all<{ name: string }>('SELECT name FROM clips')) if (!existsSync(join(config.clip.outDir, name))) run('DELETE FROM clips WHERE name = ?', name)
    let stray = 0
    if (existsSync(config.clip.outDir)) {
        for (const f of readdirSync(config.clip.outDir)) {
            const p = join(config.clip.outDir, f)
            if (f.endsWith('.mp4') && !getClip(f) && statSync(p).mtimeMs < now - RETENTION_DAYS * DAY) {
                rmSync(p, { force: true })
                stray++
            }
        }
    }
    const oldAudit = Number(run('DELETE FROM audit WHERE t < ?', new Date(now - AUDIT_RETENTION_DAYS * DAY).toISOString()).changes)
    db.exec('PRAGMA incremental_vacuum')
    if (expired.length || stray) audit('system', 'clips.pruned', { removed: expired.length + stray, retention_days: RETENTION_DAYS })
    if (oldAudit) console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'old activity deleted', rows: oldAudit }))
    return expired.length + stray
}

/** Space the clips take, in total and per person. A clip several people hold is counted once in the
 * total and in full for each of them. */
export function storage(): { clips: number; bytes: number; saved: number; saved_bytes: number; per_person: { email: string; clips: number; saved: number; bytes: number }[] } {
    const total = one<{ clips: number; bytes: number | null }>('SELECT COUNT(*) AS clips, SUM(bytes) AS bytes FROM clips')!
    const saved = one<{ n: number; bytes: number | null }>(
        'SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM clips WHERE EXISTS (SELECT 1 FROM clip_holders h WHERE h.clip_name = clips.name AND h.saved_at IS NOT NULL)'
    )!
    const per_person = all<{ email: string; clips: number; saved: number; bytes: number }>(
        `SELECT h.email, COUNT(*) AS clips, COUNT(h.saved_at) AS saved, COALESCE(SUM(c.bytes), 0) AS bytes
         FROM clip_holders h JOIN clips c ON c.name = h.clip_name GROUP BY h.email ORDER BY bytes DESC`
    )
    return { clips: total.clips, bytes: total.bytes ?? 0, saved: saved.n, saved_bytes: saved.bytes ?? 0, per_person }
}

// ------------------------------------------------------------------ jobs
interface Job {
    id: string
    state: 'queued' | 'rendering' | 'done' | 'failed'
    owner: string
    session_id: string
    start_s: number
    length_s: number
    info: RecordingInfo
    created_at: number
    started_at?: number
    finished_at?: number
    error?: string
    clip?: ClipRecord
}
const jobs = new Map<string, Job>()
const queue: Job[] = []
let busy = false
const limit = new HourlyLimit(PER_HOUR)

async function work() {
    if (busy) return
    busy = true
    try {
        for (let job = queue.shift(); job; job = queue.shift()) {
            job.state = 'rendering'
            job.started_at = Date.now()
            try {
                const clip = await renderClip({ sessionId: job.session_id, startOffsetS: job.start_s, durationS: job.length_s })
                const record = storeClip(clip, job.info, job.owner)
                job.clip = record
                job.state = 'done'
                audit(job.owner, 'clip.created', { session_id: job.session_id, clip: clip.name, cached: clip.cached, render_s: clip.render_s, shared_with: record.holders.length - 1 })
            } catch (e) {
                const msg = (e as Error).message
                job.state = 'failed'
                job.error = /No usable sandbox|Failed to launch/.test(msg)
                    ? 'The clip renderer could not start on the server.'
                    : /no stored snapshots/i.test(msg)
                      ? 'This recording is still being saved. Try again in a minute.'
                      : msg.split('\n')[0].slice(0, 200)
                console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'clip job failed', job: job.id, error: msg.slice(0, 1000) }))
            }
            job.finished_at = Date.now()
        }
    } finally {
        busy = false
    }
}

function jobView(job: Job) {
    return {
        id: job.id,
        state: job.state,
        position: job.state === 'queued' ? queue.indexOf(job) + 1 : 0,
        error: job.error,
        elapsed_s: Math.round(((job.finished_at || Date.now()) - (job.started_at || job.created_at)) / 1000),
        clip: job.clip ? clipView(getClip(job.clip.name) || job.clip, job.owner) : undefined,
    }
}

function clipView(c: ClipRecord, viewer?: string) {
    return {
        ...c,
        saved: !!viewer && c.saved_by.includes(viewer),
        range: `${formatClock(c.start_s)}–${formatClock(c.end_s)}`,
        video_url: `/replays/video/${encodeURIComponent(c.name)}`,
        download_url: `/replays/download/${encodeURIComponent(c.name)}`,
        replay_url: replayUrl(c.session_id, c.start_s),
    }
}

// ------------------------------------------------------------------ HTTP helpers
function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let data = ''
    for await (const c of req) {
        data += c
        if (data.length > 20_000) throw new Error('body too large')
    }
    return JSON.parse(data || '{}')
}

/** Streams an MP4 with Range support, inline or as a download. */
export function streamMp4(req: IncomingMessage, res: ServerResponse, file: string, opts: { download?: string; cache?: string } = {}) {
    const size = statSync(file).size
    const headers: Record<string, string> = {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'cache-control': opts.cache || 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
    }
    if (opts.download) headers['content-disposition'] = `attachment; filename="${opts.download.replace(/[^A-Za-z0-9._-]/g, '_')}"`
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''))
    if (range && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start > end || start >= size) {
            res.writeHead(416, { 'content-range': `bytes */${size}` })
            return res.end()
        }
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
        return createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    createReadStream(file).pipe(res)
}

const SAFE_NAME = /^[A-Za-z0-9-]+_\d+-\d+\.mp4$/

// ------------------------------------------------------------------ routes
/** Handles /replays*. Returns false when the path is not ours. */
export async function handleReplays(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname
    if (!p.startsWith('/replays')) return false

    // Cross-site forms cannot set custom headers, so this blocks CSRF on every POST.
    if ((req.method === 'POST' || req.method === 'DELETE') && req.headers['x-clip-page'] !== '1') {
        json(res, 403, { error: 'Missing page header.' })
        return true
    }

    if (p === '/replays/login' && req.method === 'POST') {
        const body = await readJson(req)
        // No proxy sits in front of this service, so the socket address is the client. A forwarded-for
        // header would let anyone dodge the sign-in limit.
        const ip = String(req.socket.remoteAddress || '')
        const email = String(body.email || '').trim().toLowerCase()
        const out = await signIn(ip, email, String(body.password || ''))
        if (!out.session) {
            audit(email || 'unknown', 'signin.failed', { ip })
            json(res, 401, { error: out.error })
            return true
        }
        // The cookie is PostHog's own session cookie, so this also signs the browser in to PostHog.
        const cookies = [`sessionid=${out.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600`]
        if (out.csrf) cookies.push(`posthog_csrftoken=${out.csrf}; Path=/; SameSite=Lax; Max-Age=1209600`)
        res.setHeader('set-cookie', cookies)
        audit(email, 'signin', { ip })
        json(res, 200, { ok: true })
        return true
    }
    if (p === '/replays/logout' && req.method === 'POST') {
        const session = sessionCookie(req)
        const who = (await currentViewer(req))?.email || 'unknown'
        if (session) await signOut(session, csrfCookie(req))
        res.setHeader('set-cookie', ['sessionid=; Path=/; Max-Age=0', 'posthog_csrftoken=; Path=/; Max-Age=0'])
        audit(who, 'signout')
        json(res, 200, { ok: true })
        return true
    }

    const viewer = await currentViewer(req)
    if (p === '/replays' || p === '/replays/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(!viewer ? loginHtml() : can(viewer.role, 'watch') ? pageHtml(viewer) : noAccessHtml(viewer))
        return true
    }
    if (!viewer) {
        json(res, 401, { error: 'Sign in first.' })
        return true
    }
    if (p.startsWith('/replays/admin')) return handleAdmin(req, res, url, viewer)
    if (!can(viewer.role, 'watch')) {
        json(res, 403, { error: 'You do not have access to replay clips. Ask an admin.' })
        return true
    }
    const need = (role: Role): boolean => {
        if (can(viewer.role, role)) return true
        json(res, 403, { error: `This needs the "${ROLE_TEXT[role]}" role. Ask an admin.` })
        return false
    }

    if (p === '/replays/api/inspect' && req.method === 'POST') {
        const body = await readJson(req)
        const input = parseReplayInput(String(body.input || ''))
        if (!input) {
            json(res, 400, { error: 'That is not a PostHog replay link or session id.' })
            return true
        }
        try {
            const info = await recordingInfo(input.sessionId)
            audit(viewer.email, 'recording.inspected', { session_id: input.sessionId })
            json(res, 200, { info, suggested_start_s: input.startS ?? Math.max(0, (info.moments.find((m) => m.kind !== 'page')?.offset_s ?? 0) - 5) })
        } catch (e) {
            json(res, 404, { error: /404/.test((e as Error).message) ? 'No recording with that id in this project.' : (e as Error).message.slice(0, 200) })
        }
        return true
    }

    if (p === '/replays/api/clips' && req.method === 'POST') {
        const body = await readJson(req)
        const input = parseReplayInput(String(body.input || ''))
        const start = typeof body.start === 'number' ? body.start : parseStartTime(String(body.start ?? ''))
        const length = Number(body.length)
        if (!input || start === undefined || !LENGTHS.includes(length)) {
            json(res, 400, { error: 'Give a replay link, a start time like 1:23, and a length.' })
            return true
        }
        if (queue.length >= MAX_QUEUE) {
            json(res, 429, { error: 'The clip queue is full. Try again in a minute.' })
            return true
        }
        if (!limit.take(viewer.email)) {
            json(res, 429, { error: `You can make ${PER_HOUR} clips an hour. Try again later.` })
            return true
        }
        let info: RecordingInfo
        try {
            info = await recordingInfo(input.sessionId)
        } catch {
            json(res, 404, { error: 'No recording with that id in this project.' })
            return true
        }
        if (start >= info.duration_s) {
            json(res, 400, { error: `The recording is only ${formatClock(info.duration_s)} long.` })
            return true
        }
        const job: Job = { id: randomUUID(), state: 'queued', owner: viewer.email, session_id: input.sessionId, start_s: Math.floor(start), length_s: Math.max(3, Math.min(length, Math.ceil(info.duration_s - start))), info, created_at: Date.now() }
        jobs.set(job.id, job)
        queue.push(job)
        audit(viewer.email, 'clip.requested', { session_id: job.session_id, start_s: job.start_s, length_s: job.length_s })
        void work()
        json(res, 202, jobView(job))
        return true
    }

    if (p === '/replays/api/me' && req.method === 'GET') {
        json(res, 200, { email: viewer.email, role: viewer.role, role_text: ROLE_TEXT[viewer.role], share_links: loadAccess().allow_share_links })
        return true
    }

    let m = /^\/replays\/api\/jobs\/([0-9a-f-]{36})$/.exec(p)
    if (m && req.method === 'GET') {
        const job = jobs.get(m[1])
        if (!job || job.owner !== viewer.email) json(res, 404, { error: 'No such job.' })
        else json(res, 200, jobView(job))
        return true
    }

    if (p === '/replays/api/clips' && req.method === 'GET') {
        json(res, 200, { clips: listClips({ holder: viewer.email, limit: 100 }).map((c) => clipView(c, viewer.email)), retention_days: RETENTION_DAYS })
        return true
    }
    m = /^\/replays\/api\/clips\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') {
        const record = getClip(decodeURIComponent(m![1]))
        if (!record) json(res, 404, { error: 'This clip no longer exists.' })
        else json(res, 200, clipView(record, viewer.email))
        return true
    }
    m = /^\/replays\/api\/clips\/([^/]+)\/save$/.exec(p)
    if (m && req.method === 'POST') {
        const saved = (await readJson(req)).saved !== false
        const record = setSaved(decodeURIComponent(m[1]), viewer.email, saved)
        if (!record) json(res, 404, { error: 'This clip no longer exists.' })
        else {
            audit(viewer.email, saved ? 'clip.saved' : 'clip.unsaved', { clip: record.name })
            json(res, 200, clipView(record, viewer.email))
        }
        return true
    }

    m = /^\/replays\/api\/share\/([^/]+)$/.exec(p)
    if (m && req.method === 'POST') {
        if (!need('download')) return true
        if (!loadAccess().allow_share_links) {
            json(res, 403, { error: 'Share links are turned off by an admin.' })
            return true
        }
        const name = decodeURIComponent(m[1])
        if (!SAFE_NAME.test(name) || !getClip(name)) {
            json(res, 404, { error: 'No such clip.' })
            return true
        }
        audit(viewer.email, 'clip.link_shared', { clip: name })
        json(res, 200, { url: clipUrl(name), expires_hours: config.service.clipLinkTtlHours })
        return true
    }

    m = /^\/replays\/(video|download)\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') {
        const name = decodeURIComponent(m[2])
        const record = getClip(name)
        const file = join(config.clip.outDir, name)
        if (!SAFE_NAME.test(name) || !record || !existsSync(file)) {
            json(res, 404, { error: 'No such clip.' })
            return true
        }
        if (m[1] === 'download' && !need('download')) return true
        if (m[1] === 'download') audit(viewer.email, 'clip.downloaded', { clip: name })
        else if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit(viewer.email, 'clip.viewed', { clip: name })
        streamMp4(req, res, file, { download: m[1] === 'download' ? record.download_name : undefined, cache: 'private, no-store' })
        return true
    }

    json(res, 404, { error: 'Not found.' })
    return true
}

// ------------------------------------------------------------------ pages
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `:root{--bg:#f5f6f8;--card:#fff;--ink:#1c2230;--muted:#636b7c;--line:#e0e3ea;--accent:#1d4ed8;--accent-ink:#fff;--err:#b42318;--ok:#067647;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1b1f29;--ink:#e7e9ee;--muted:#9aa2b2;--line:#2c3240;--accent:#6b8afd;--accent-ink:#0b1020;--err:#f97066;--ok:#47cd89;--chip:#252c3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:18px;padding:10px 20px;border-bottom:1px solid var(--line);background:var(--card);flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px;color:var(--ink);text-decoration:none;letter-spacing:.01em}
.brand .mark{width:18px;height:18px;border-radius:50%;background:conic-gradient(from 210deg,var(--accent),#1baf7a,var(--accent));box-shadow:inset 0 0 0 4px var(--card)}
.brand .tag{font-weight:500;font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
nav{display:flex;gap:4px;flex:1}nav a{color:var(--muted);text-decoration:none;font-weight:600;padding:7px 11px;border-radius:7px}nav a:hover{color:var(--ink);background:var(--bg)}
nav a[aria-current=page]{color:var(--accent);background:var(--chip)}.hdr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}header button{padding:5px 10px}
@media (max-width:700px){nav{order:3;flex-basis:100%}.who{display:none}}.muted{color:var(--muted)}.small{font-size:13px}main{max-width:980px;margin:0 auto;padding:20px 16px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 12px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
input,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:9px 11px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.row>div{flex:1;min-width:140px}
button,.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-weight:600;border-radius:7px;padding:9px 14px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:default}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:6px 0 12px}.facts div{background:var(--bg);border-radius:7px;padding:8px 10px}
.facts b{overflow-wrap:anywhere}.facts span{display:block;font-size:12px;color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{text-align:left;border:1px solid var(--line);background:var(--chip);color:var(--ink);font-weight:500;padding:5px 9px;border-radius:999px;font-size:13px}
.chip.error{border-color:var(--err)}.chip .t{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:4px}
.err{color:var(--err)}.ok{color:var(--ok)}video{width:100%;border-radius:8px;background:#000;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.table-wrap{overflow-x:auto}.hidden{display:none}code{background:var(--bg);padding:1px 5px;border-radius:4px}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;display:inline-block}@keyframes s{to{transform:rotate(1turn)}}`

export const PAGE_CSS = () => CSS

export const APP_NAME = process.env.APP_NAME || 'PostHog Lens'
export const APP_TAG = process.env.APP_TAG ?? 'for ION'
export type Section = 'Releases' | 'Replay clips' | 'Admin'

/** The header on every page: the product name, the sections this person may open, and sign out. */
export function headerHtml(v: Viewer | undefined, section: Section): string {
    const brand = `<a class="brand" href="/"><span class="mark" aria-hidden="true"></span>${esc(APP_NAME)}${APP_TAG ? `<span class="tag">${esc(APP_TAG)}</span>` : ''}</a>`
    if (!v) return `<header>${brand}</header>`
    const tabs = (
        [
            ['Releases', '/releases', 'insights'],
            ['Replay clips', '/replays', 'watch'],
            ['Admin', '/replays/admin', 'admin'],
        ] as const
    )
        .filter(([, , need]) => can(v.role, need))
        .map(([name, href]) => `<a href="${href}"${name === section ? ' aria-current="page"' : ''}>${name}</a>`)
        .join('')
    return `<header>${brand}<nav>${tabs}</nav><span class="hdr"><span class="muted small who">${esc(v.email)} · ${esc(ROLE_TEXT[v.role])}</span><button class="ghost small" id="signout" type="button">Sign out</button></span></header>
<script>document.getElementById('signout').onclick=()=>fetch('/replays/logout',{method:'POST',headers:{'x-clip-page':'1'}}).then(()=>location.href='/')</script>`
}

export function loginHtml(section: Section = 'Replay clips'): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(undefined, section)}<main style="max-width:440px"><div class="card"><h2>Sign in</h2>
<p class="small muted">Use your PostHog account. Signing in here also signs you in to PostHog in this browser.</p>
<form id="f"><p><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></p>
<p><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></p>
<p><button id="go">Sign in</button></p><p id="msg" class="small err"></p></form>
<p class="small muted">Use two-factor login, or already signed in to PostHog? <a href="${esc(config.posthog.publicHost)}/login" target="_blank" rel="noopener">Sign in on PostHog</a>, then <a href="/replays">reload this page</a>.</p></div></main>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const b=document.getElementById('go');b.disabled=true;document.getElementById('msg').textContent='';
try{const r=await fetch('/replays/login',{method:'POST',headers:{'content-type':'application/json','x-clip-page':'1'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});
const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Sign in failed.');location.href=location.pathname+location.search}catch(err){document.getElementById('msg').textContent=err.message}finally{b.disabled=false}}</script></body></html>`
}

function noAccessHtml(v: Viewer): string {
    if (can(v.role, 'insights')) {
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay clips · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(v, 'Replay clips')}<main style="max-width:560px"><div class="card"><h2>Replay clips are not part of your access</h2>
<p>You can see <a href="/releases">release insights</a>. Replays can show client data, so watching them needs the "Watch clips" role from an admin.</p></div></main></body></html>`
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No access · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(v, 'Replay clips')}<main style="max-width:560px"><div class="card"><h2>You don't have access to replay clips</h2>
<p>You're signed in as <b>${esc(v.email)}</b>, but no admin has given you access yet. Replays can show client data, so access is given person by person.</p>
<p class="muted small">Ask a PostHog admin to give you a role on the admin page: "Release insights only", or "Watch clips" for replays too.</p></div></main></body></html>`
}

function pageHtml(v: Viewer): string {
    const bookmarklet = `javascript:(()=>{window.open(${JSON.stringify(config.service.publicUrl + '/replays?url=')}+encodeURIComponent(location.href))})()`
    const boot = JSON.stringify({ lengths: LENGTHS, ttl: config.service.clipLinkTtlHours, retention: RETENTION_DAYS, perHour: PER_HOUR, canDownload: can(v.role, 'download'), shareLinks: can(v.role, 'download') && loadAccess().allow_share_links }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay clips · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(v, 'Replay clips')}<main>

<div class="card"><h2>1. Which replay?</h2>
<label for="input">PostHog replay link or session id</label>
<div class="row"><div style="flex:4"><input id="input" placeholder="${esc(config.posthog.publicHost)}/project/${esc(config.posthog.projectId)}/replay/…" autocomplete="off"></div>
<div style="flex:0"><button id="check">Check</button></div></div>
<p id="inspect-msg" class="small"></p>
<div id="info" class="hidden">
<div class="facts"><div><span>Client</span><b id="f-client"></b></div><div><span>User</span><b id="f-user"></b></div><div><span>Recorded</span><b id="f-when"></b></div><div><span>Length</span><b id="f-len"></b></div></div>
<label>Key moments (click one to start the clip just before it)</label><div id="moments" class="chips"></div>
<p class="small muted" id="pages"></p></div></div>

<div class="card" id="make" aria-disabled="true"><h2>2. Make the clip</h2>
<div class="row"><div><label for="start">Start at (m:ss)</label><input id="start" value="0:00"></div>
<div><label for="length">Length</label><select id="length"></select></div>
<div style="flex:0"><button id="go" disabled>Make clip</button></div></div>
<p id="job-msg" class="small"></p>
<div id="result" class="hidden"><video id="video" controls preload="metadata" controlslist="nodownload" oncontextmenu="return CFG.canDownload"></video>
<div class="row" style="align-items:center"><button class="ghost" id="save" type="button">Save this</button><a class="btn" id="dl">Download MP4</a><button class="ghost" id="share">Copy share link</button><a class="btn ghost" id="open" target="_blank" rel="noopener">Open in PostHog</a></div>
<p id="keep-msg" class="small muted"></p><p id="share-msg" class="small muted"></p></div></div>

<div class="card"><h2>Your clips</h2><div class="table-wrap"><table><thead><tr><th>Made</th><th>Client</th><th>User</th><th>Part</th><th>Kept until</th><th></th></tr></thead><tbody id="recent"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>
<p class="small muted" id="retention"></p></div>

<div class="card"><h2>Get MP4 from PostHog in one click</h2>
<p class="small">Drag this button to your bookmarks bar. While you watch a replay in PostHog, click it to open the replay here.</p>
<p><a class="btn ghost" href="${esc(bookmarklet)}">Get MP4</a></p></div>
</main>
<script>
const CFG=${boot};const $=id=>document.getElementById(id);
const clock=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,'0');return h?h+':'+String(m).padStart(2,'0')+':'+x:m+':'+x};
const when=iso=>new Date(iso).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1',...(opts.headers||{})}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
CFG.lengths.forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l+' seconds';if(l===30)o.selected=true;$('length').appendChild(o)});
$('retention').textContent='Clips are deleted '+CFG.retention+' days after they were last made, unless you click Save. Share links expire after '+Math.round(CFG.ttl/24)+' days. Every view and download is logged.';
const day=iso=>new Date(iso).toLocaleDateString([], {dateStyle:'medium'});
const keepText=c=>c.saved?'You saved this clip. It stays until you unsave it.':c.saved_by.length?'Saved by someone else, so it is kept.':'Deleted on '+day(c.expires_at)+' unless someone saves it.';
async function toggleSave(c){const r=await api('/replays/api/clips/'+encodeURIComponent(c.name)+'/save',{method:'POST',body:JSON.stringify({saved:!c.saved})});return r}
let info=null,cur=null;
function txt(el,t,cls){el.textContent=t;el.className='small '+(cls||'')}
async function check(){const input=$('input').value.trim();if(!input)return;txt($('inspect-msg'),'Checking…','muted');$('info').classList.add('hidden');$('go').disabled=true;
 try{const r=await api('/replays/api/inspect',{method:'POST',body:JSON.stringify({input})});info=r.info;
  $('f-client').textContent=info.client||'unknown';$('f-user').textContent=info.user||'unknown';$('f-when').textContent=when(info.start);$('f-len').textContent=clock(info.duration_s);
  const box=$('moments');box.innerHTML='';const shown=info.moments.filter(m=>m.kind!=='page').slice(0,30);
  if(!shown.length){box.innerHTML='<span class="muted small">No errors or frustrated clicks in this recording.</span>'}
  shown.forEach(m=>{const b=document.createElement('button');b.type='button';b.className='chip'+(m.kind==='error'?' error':'');b.innerHTML='<span class="t"></span>';b.querySelector('.t').textContent=clock(m.offset_s);b.append(m.kind+' '+m.label);b.onclick=()=>{$('start').value=clock(Math.max(0,m.offset_s-5))};box.appendChild(b)});
  $('pages').textContent=info.pages.length?'Pages: '+info.pages.join(' → '):'';
  $('start').value=clock(r.suggested_start_s);$('info').classList.remove('hidden');$('go').disabled=false;txt($('inspect-msg'),'')
 }catch(e){txt($('inspect-msg'),e.message,'err')}}
$('check').onclick=check;$('input').addEventListener('keydown',e=>{if(e.key==='Enter')check()});$('input').addEventListener('paste',()=>setTimeout(check,50));
$('go').onclick=async()=>{$('go').disabled=true;$('result').classList.add('hidden');txt($('job-msg'),'Queued…','muted');
 try{let j=await api('/replays/api/clips',{method:'POST',body:JSON.stringify({input:$('input').value.trim(),start:$('start').value,length:Number($('length').value)})});
  while(j.state==='queued'||j.state==='rendering'){$('job-msg').innerHTML='<span class="spin"></span> '+(j.state==='queued'?'Waiting in queue (position '+j.position+')':'Making the clip… '+j.elapsed_s+' s (usually 10 to 30 s)');await new Promise(r=>setTimeout(r,1500));j=await api('/replays/api/jobs/'+j.id)}
  if(j.state==='failed')throw new Error(j.error||'The clip could not be made.');
  show(j.clip);txt($('job-msg'),'Ready.','ok');loadRecent()
 }catch(e){txt($('job-msg'),e.message,'err')}finally{$('go').disabled=false}};
function show(c){$('dl').classList.toggle('hidden',!CFG.canDownload);$('share').classList.toggle('hidden',!CFG.shareLinks);$('video').src=c.video_url+'#t=1';$('dl').href=c.download_url;$('open').href=c.replay_url;$('share').dataset.name=c.name;cur=c;$('save').textContent=c.saved?'Saved ✓ (unsave)':'Save this';txt($('keep-msg'),keepText(c),'muted');$('share-msg').textContent='';$('result').classList.remove('hidden');$('result').scrollIntoView({behavior:'smooth',block:'nearest'})}
$('share').onclick=async()=>{try{const r=await api('/replays/api/share/'+encodeURIComponent($('share').dataset.name),{method:'POST'});await navigator.clipboard.writeText(r.url).catch(()=>{});$('share-msg').textContent='Link copied. Anyone with it can watch this clip for '+Math.round(r.expires_hours/24)+' days: '+r.url}catch(e){$('share-msg').textContent=e.message}};
$('save').onclick=async()=>{if(!cur)return;$('save').disabled=true;try{const c=await toggleSave(cur);cur=c;$('save').textContent=c.saved?'Saved ✓ (unsave)':'Save this';txt($('keep-msg'),keepText(c),c.saved?'ok':'muted');loadRecent()}catch(e){txt($('keep-msg'),e.message,'err')}finally{$('save').disabled=false}};
async function loadRecent(){try{const r=await api('/replays/api/clips');const tb=$('recent');tb.innerHTML='';
 if(!r.clips.length){tb.innerHTML='<tr><td colspan="6" class="muted">No clips yet.</td></tr>';return}
 r.clips.forEach(c=>{const tr=document.createElement('tr');[when(c.created_at),c.client||'',(c.user||'').replace(/@.*/,''),c.range,c.saved?'Saved':c.expires_at?day(c.expires_at):'Saved by someone else'].forEach(t=>{const td=document.createElement('td');td.textContent=t;tr.appendChild(td)});
  const td=document.createElement('td');td.style.whiteSpace='nowrap';const w=document.createElement('button');w.className='ghost';w.textContent='Watch';w.onclick=()=>show(c);
  const k=document.createElement('button');k.className='ghost';k.textContent=c.saved?'Unsave':'Save';k.onclick=async()=>{k.disabled=true;try{const n=await toggleSave(c);if(cur&&cur.name===n.name)show(n);loadRecent()}catch(e){alert(e.message)}};
  td.append(w,' ',k);tr.appendChild(td);tb.appendChild(tr)})}catch(e){$('recent').innerHTML='<tr><td colspan="6" class="err"></td></tr>';$('recent').querySelector('td').textContent=e.message}}
loadRecent();
const qs=new URLSearchParams(location.search);const pre=qs.get('url');if(pre){$('input').value=pre;check()}
const one=qs.get('clip');if(one){api('/replays/api/clips/'+encodeURIComponent(one)).then(show).catch(e=>txt($('job-msg'),e.message,'err'))}
</script></body></html>`
}
