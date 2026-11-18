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

import { ClipQueueError } from '../core/clip-queue.ts'
import { cleanRenderWork, clipRange, pruneCache, renderClip } from '../core/clip.ts'
import { addComment, captionedFile, checkComment, commentCounts, cues, DEFAULT_DURATION, deleteComment, DURATIONS, getComment, listComments, MAX_TEXT, removeVariants, toVtt, updateComment, variantOf } from '../core/comments.ts'
import { config, surveysActive } from '../core/config.ts'
import { all, db, one, run, tx } from '../core/db.ts'
import { clipUrl } from '../core/links.ts'
import { replayUrl } from '../core/posthog.ts'
import { recordingInfo, type RecordingInfo } from '../core/recording-info.ts'
import { downloadName, formatClock, HourlyLimit, parseReplayInput, parseStartTime } from '../core/replay-input.ts'
import { audit, can, canSeeSystem, canUseDashboards, canUseSurveys, csrfCookie, currentViewer, loadAccess, ROLE_TEXT, sessionCookie, signIn, signOut, type Role, type Viewer } from './access.ts'
import { handleAdmin } from './admin.ts'
import { codenameRedirect, handlePrivacy } from './privacy.ts'
import { handleLive, liveHtml } from './live.ts'
import { handleSystem } from './system.ts'
import { handleSurveys } from './surveyspage.ts'
import { canConnect, handleConnect } from './connect.ts'
import { handleDashboards } from './dashboards.ts'
import { appEvents } from '../core/appevents.ts'

const RETENTION_DAYS = Number(process.env.CLIP_RETENTION_DAYS || 14)
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS || 365)
const PER_HOUR = Number(process.env.CLIPS_PER_HOUR || 20)
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
export function listClips(opts: { holder?: string; limit?: number; offset?: number } = {}): ClipRecord[] {
    const where = opts.holder ? 'WHERE c.name IN (SELECT clip_name FROM clip_holders WHERE email = ?)' : ''
    const params = opts.holder ? [opts.holder] : []
    return all<Record<string, unknown>>(`${SELECT_CLIP} ${where} ORDER BY c.last_requested_at DESC, c.name ASC LIMIT ? OFFSET ?`, ...params, opts.limit ?? 200, opts.offset ?? 0).map(fromRow)
}

/** Records that `by` has this clip. A clip that already exists is not stored again: the person is
 * added to it and its two weeks start again. */
export function storeClip(clip: { name: string; session_id: string; start_offset_s: number; end_offset_s: number }, info: Partial<RecordingInfo> | undefined, by: string): ClipRecord {
    const now = new Date().toISOString()
    const file = join(config.clip.outDir, clip.name)
    const bytes = existsSync(file) ? statSync(file).size : 0
    const previous = getClip(clip.name)
    if (previous && (previous.start_s !== clip.start_offset_s || previous.end_s !== clip.end_offset_s)) removeVariants(clip.name)
    tx(() => {
        run(
            `INSERT INTO clips (name, session_id, start_s, end_s, client, user, recording_start, download_name, bytes, created_by, created_at, last_requested_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (name) DO UPDATE SET last_requested_at = excluded.last_requested_at, bytes = excluded.bytes, start_s = excluded.start_s, end_s = excluded.end_s, download_name = excluded.download_name`,
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
    rmSync(join(config.clip.outDir, name + '.json'), { force: true })
    removeVariants(name)
    run('DELETE FROM clips WHERE name = ?', name) // clip_holders and clip_comments rows go with it
    return true
}

/** Deletes clips nobody saved that nobody asked for in CLIP_RETENTION_DAYS, MP4 files no clip
 * row knows about (older than the same), and activity older than AUDIT_RETENTION_DAYS. */
export function pruneOldClips(now = Date.now()): number {
    pruneCache(join(config.clip.cacheDir, 'snapshots'), undefined, now)
    cleanRenderWork(now)
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
            const owner = variantOf(f)
            if (owner && getClip(owner)) continue // a burned-in copy of a clip that still exists
            if (f.endsWith('.mp4') && !getClip(f) && statSync(p).mtimeMs < now - RETENTION_DAYS * DAY) {
                rmSync(p, { force: true })
                rmSync(p + '.json', { force: true })
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
export interface ReplayJob {
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
const jobs = new Map<string, ReplayJob>()
export function pruneJobs<T extends { finished_at?: number }>(entries: Map<string, T>, now = Date.now(), cap = 1000): void {
    for (const [id, job] of entries) if (job.finished_at !== undefined && now - job.finished_at >= 3_600_000) entries.delete(id)
    for (const [id, job] of entries) {
        if (entries.size <= cap) break
        if (job.finished_at !== undefined) entries.delete(id)
    }
}
setInterval(() => pruneJobs(jobs), 60_000).unref()
const queue: ReplayJob[] = []
const limit = new HourlyLimit(PER_HOUR)

/** Submit each job once; the shared clip limiter decides when it actually starts. */
export function createReplayWorker(queue: ReplayJob[], deps: {
    render: typeof renderClip; store: typeof storeClip; audit: typeof audit; prune: () => void
}) {
    const submitted = new Set<ReplayJob>()
    return function work() {
        for (const job of [...queue]) {
            if (submitted.has(job)) continue
            submitted.add(job)
            void (async () => {
                try {
                    const clip = await deps.render({ sessionId: job.session_id, startOffsetS: job.start_s, durationS: job.length_s }, job.owner, () => {
                        job.state = 'rendering'
                        job.started_at = Date.now()
                        const index = queue.indexOf(job)
                        if (index >= 0) queue.splice(index, 1)
                    })
                    const record = deps.store(clip, job.info, job.owner)
                    job.start_s = clip.start_offset_s
                    job.length_s = clip.video_duration_s
                    job.clip = record
                    job.state = 'done'
                    deps.audit(job.owner, 'clip.created', { session_id: job.session_id, clip: clip.name, cached: clip.cached, render_s: clip.render_s, shared_with: record.holders.length - 1 })
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
                deps.prune()
                const index = queue.indexOf(job)
                if (index >= 0) queue.splice(index, 1)
                submitted.delete(job)
            })()
        }
    }
}
const work = createReplayWorker(queue, { render: renderClip, store: storeClip, audit, prune: () => pruneJobs(jobs) })

export function jobView(job: ReplayJob, queued = queue) {
    return {
        id: job.id,
        state: job.state,
        position: job.state === 'queued' ? queued.indexOf(job) + 1 : 0,
        error: job.error,
        elapsed_s: Math.round(((job.finished_at || Date.now()) - (job.started_at || job.created_at)) / 1000),
        clip: job.clip ? clipView(getClip(job.clip.name) || job.clip, job.owner) : undefined,
    }
}

function clipView(c: ClipRecord, viewer?: string, counts?: Map<string, number>) {
    return {
        ...c,
        comments: (counts ?? commentCounts()).get(c.name) ?? 0,
        saved: !!viewer && c.saved_by.includes(viewer),
        range: `${formatClock(c.start_s)}–${formatClock(c.end_s)} (${Number((c.end_s - c.start_s).toFixed(3))} s)`,
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
    req.setEncoding?.('utf8')
    let data = ''
    for await (const c of req) {
        data += c
        if (data.length > 20_000) throw new Error('body too large')
    }
    return JSON.parse(data || '{}')
}

/** Streams an MP4 with Range support, inline or as a download. */
export function streamMp4(req: IncomingMessage, res: ServerResponse, file: string, opts: { download?: string; cache?: string } = {}) {
    const fail = (error: NodeJS.ErrnoException) => {
        if (res.headersSent) { res.destroy(); return }
        for (const name of ['content-length', 'content-range', 'content-disposition']) res.removeHeader(name)
        res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' })
        res.end(error.code === 'ENOENT' ? 'Clip not found' : 'Clip unavailable')
    }
    let size: number
    try { size = statSync(file).size } catch (error) { fail(error as NodeJS.ErrnoException); return }
    const send = (status: number, headers: Record<string, string>, range?: { start: number; end: number }) => {
        const stream = createReadStream(file, range)
        stream.on('error', fail)
        // Opening can race retention or caption replacement; commit headers only after it succeeds.
        stream.once('open', () => { res.writeHead(status, headers); stream.pipe(res) })
        res.once('close', () => stream.destroy())
    }
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
        return send(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }, { start, end })
    }
    send(200, { ...headers, 'content-length': String(size) })
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
    if (!viewer && (p === '/replays/system' || p === '/replays/system/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(loginHtml('System'))
        return true
    }
    if (!viewer && (p === '/replays/connect' || p === '/replays/connect/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(loginHtml('Chat'))
        return true
    }
    if (!viewer && (p === '/replays/dashboards' || p.startsWith('/replays/dashboards/')) && !p.includes('/api/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(loginHtml('Dashboards'))
        return true
    }
    if (!viewer && (p === '/replays/surveys' || p === '/replays/surveys/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(loginHtml('Surveys'))
        return true
    }
    if (p === '/replays/live' || p === '/replays/live/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(!viewer ? loginHtml('Live') : can(viewer.role, 'watch') ? liveHtml(viewer) : noAccessHtml(viewer))
        return true
    }
    if (!viewer) {
        json(res, 401, { error: 'Sign in first.' })
        return true
    }
    // Links from an AI carry codenames where clients go (client anonymisation): open the real client.
    if (codenameRedirect(req, res, url)) return true
    if (p === '/replays/codenames' || p.startsWith('/replays/codenames/') || p.startsWith('/replays/admin/privacy')) return handlePrivacy(req, res, url, viewer)
    if (p.startsWith('/replays/admin')) return handleAdmin(req, res, url, viewer)
    if (p === '/replays/system' || p.startsWith('/replays/system/')) return handleSystem(req, res, url, viewer)
    if (p === '/replays/surveys' || p.startsWith('/replays/surveys/')) return handleSurveys(req, res, url, viewer)
    if (p === '/replays/connect' || p.startsWith('/replays/connect/')) return handleConnect(req, res, url, viewer)
    if (p === '/replays/dashboards' || p.startsWith('/replays/dashboards/')) return handleDashboards(req, res, url, viewer)
    if (!can(viewer.role, 'watch')) {
        json(res, 403, { error: 'You do not have access to replay clips. Ask an admin.' })
        return true
    }
    if (p.startsWith('/replays/live/')) return handleLive(req, res, url, viewer)
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
            // The recorder pauses on a still page; later session events can extend the clip range.
            try { await clipRange({ sessionId: input.sessionId, startOffsetS: start, durationS: length }) }
            catch (e) {
                if ((e as { status?: number }).status !== 400) throw e
                json(res, 400, { error: `The recording is only ${formatClock(info.duration_s)} long.` })
                return true
            }
        }
        const job: ReplayJob = { id: randomUUID(), state: 'queued', owner: viewer.email, session_id: input.sessionId, start_s: Math.floor(start), length_s: length, info, created_at: Date.now() }
        pruneJobs(jobs, Date.now(), 999)
        jobs.set(job.id, job)
        queue.push(job)
        audit(viewer.email, 'clip.requested', { session_id: job.session_id, start_s: job.start_s, length_s: job.length_s })
        work()
        // Shared admission rejects synchronously, before a handle is exposed.
        if (job.error === new ClipQueueError().message) {
            jobs.delete(job.id)
            json(res, 429, { error: job.error })
            return true
        }
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
        const counts = commentCounts()
        json(res, 200, { clips: listClips({ holder: viewer.email, limit: Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 100))), offset: Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))) }).map((c) => clipView(c, viewer.email, counts)), retention_days: RETENTION_DAYS })
        return true
    }
    m = /^\/replays\/api\/clips\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') {
        const record = getClip(decodeURIComponent(m![1]))
        if (!record) json(res, 404, { error: 'This clip no longer exists.' })
        else json(res, 200, clipView(record, viewer.email))
        return true
    }
    m = /^\/replays\/api\/clips\/([^/]+)\/comments(?:\/(\d+)|(\.vtt))?$/.exec(p)
    if (m) {
        const record = getClip(decodeURIComponent(m[1]))
        if (!record) {
            json(res, 404, { error: 'This clip no longer exists.' })
            return true
        }
        const length = record.end_s - record.start_s
        const view = () => {
            const list = listComments(record.name)
            const admin = can(viewer.role, 'admin')
            return {
                comments: list.map((c) => ({ ...c, mine: c.author === viewer.email, can_edit: c.author === viewer.email || admin })),
                cues: cues(list, length),
                length_s: length,
                durations: DURATIONS,
                default_duration: DEFAULT_DURATION,
                max_text: MAX_TEXT,
            }
        }
        if (m[3] && req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'no-store' })
            res.end(toVtt(cues(listComments(record.name), length)))
            return true
        }
        if (!m[2] && req.method === 'GET') {
            json(res, 200, view())
            return true
        }
        if (!m[2] && req.method === 'POST') {
            const ok = checkComment(await readJson(req), length)
            if ('error' in ok) return (json(res, 400, ok), true)
            const added = addComment(record.name, ok, viewer.email)
            if ('error' in added) return (json(res, 400, added), true)
            audit(viewer.email, 'clip.comment_added', { clip: record.name, at_s: added.at_s })
            json(res, 200, view())
            return true
        }
        if (m[2] && (req.method === 'POST' || req.method === 'DELETE')) {
            const c = getComment(record.name, Number(m[2]))
            if (!c) return (json(res, 404, { error: 'That comment no longer exists.' }), true)
            if (c.author !== viewer.email && !can(viewer.role, 'admin')) return (json(res, 403, { error: 'Only whoever wrote a comment, or an admin, can change it.' }), true)
            if (req.method === 'DELETE') {
                deleteComment(c.id)
                if (!listComments(record.name).length) removeVariants(record.name)
                audit(viewer.email, 'clip.comment_deleted', { clip: record.name, at_s: c.at_s, author: c.author })
            } else {
                const ok = checkComment(await readJson(req), length)
                if ('error' in ok) return (json(res, 400, ok), true)
                updateComment(c.id, ok)
                audit(viewer.email, 'clip.comment_edited', { clip: record.name, at_s: ok.at_s, author: c.author })
            }
            json(res, 200, view())
            return true
        }
        json(res, 405, { error: 'Not allowed.' })
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
        const withComments = (await readJson(req).catch(() => ({}) as Record<string, unknown>)).comments !== false && listComments(name).length > 0
        audit(viewer.email, 'clip.link_shared', { clip: name, comments: withComments })
        json(res, 200, { url: clipUrl(name, Date.now(), withComments), expires_hours: config.service.clipLinkTtlHours, comments: withComments })
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
        let out = file
        if (m[1] === 'download' && url.searchParams.get('comments') !== '0') {
            try {
                out = await captionedFile(name, record.end_s - record.start_s)
            } catch (e) {
                console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'burning comments failed', clip: name, error: (e as Error).message.slice(0, 500) }))
                json(res, 500, { error: 'The comments could not be added to the video. Download it without comments, or try again.' })
                return true
            }
        }
        if (m[1] === 'download') audit(viewer.email, 'clip.downloaded', { clip: name, comments: out !== file })
        else if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit(viewer.email, 'clip.viewed', { clip: name })
        streamMp4(req, res, out, { download: m[1] === 'download' ? record.download_name : undefined, cache: 'private, no-store' })
        return true
    }

    json(res, 404, { error: 'Not found.' })
    return true
}

// ------------------------------------------------------------------ pages
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// The Lens shell and page templates share the same theme and component tokens.
const CSS = `:root{
  color-scheme:light;
  --bg:#f8f9fb;--side-bg:#f2f4f8;--card:#fff;--ink:#202736;--muted:#505c6e;--faint:#586477;
  --line:#dde2ea;--line-strong:#cbd3df;--control:#7b8799;--chip:#e9edf4;--hover:#eef1f6;
  --accent:#2858af;--accent-ink:#fff;--accent-soft:#e7efff;
  --ok:#25634e;--ok-bg:#e7f3ed;--warn:#7d4c14;--warn-bg:#fff3de;--err:#a32f43;--err-bg:#fcecef;
  --space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;
  --r-sm:6px;--r:12px;--r-pill:999px;
  --text-small:12px;--text-body:14px;--text-section:18px;--text-title:30px;--text-metric:28px;
  --title-leading:1.2;--section-leading:1.35;
  --shadow:0 1px 2px rgb(30 43 68 / .06);--pop:0 12px 32px rgb(30 43 68 / .18);
  --scrim:rgb(10 17 29 / .55);--page:1440px;--hh:56px;--side:216px;
}
@media(prefers-color-scheme:dark){:root{
  color-scheme:dark;
  --bg:#15181e;--side-bg:#191d25;--card:#20252e;--ink:#eef1f7;--muted:#b2bdcd;--faint:#a9b4c6;
  --line:#343d4b;--line-strong:#4b5668;--control:#748297;--chip:#2a313d;--hover:#292f3a;
  --accent:#9dbbff;--accent-ink:#14223f;--accent-soft:#283855;
  --ok:#9dd7bf;--ok-bg:#233931;--warn:#edbe7d;--warn-bg:#382d20;--err:#ffa0ad;--err-bg:#402630;
  --shadow:0 1px 2px rgb(0 0 0 / .2);--pop:0 12px 32px rgb(0 0 0 / .45);
}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:var(--text-body)/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;font-feature-settings:'tnum' 1;font-variant-numeric:tabular-nums}
header{display:flex;align-items:center;gap:16px;background:var(--card);border-bottom:1px solid var(--line);padding:0 24px;height:var(--hh)}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;white-space:nowrap;flex:none;line-height:1}
.brand .mark{width:28px;height:28px;flex:none;display:block}.brand .names{display:grid;gap:2px;min-width:0}.brand .word{font-weight:700;font-size:16px;line-height:20px;letter-spacing:-.015em}.brand .tag{font-weight:500;font-size:12px;line-height:16px;color:var(--muted)}
.ico{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
nav{display:flex;gap:2px;min-width:0}nav a{display:flex;align-items:center;gap:var(--space-3);color:var(--muted);text-decoration:none;font-weight:500;font-size:13.5px;height:36px;padding:0 10px;border-radius:var(--r-sm);white-space:nowrap}nav a:hover{text-decoration:none}
nav a:hover{color:var(--ink);background:var(--chip)}nav a[aria-current=page]{color:var(--accent);background:var(--accent-soft);font-weight:600}
.hdr{position:relative;flex:none;min-width:0}.acct>summary{list-style:none;display:flex;align-items:center;gap:10px;cursor:pointer;color:var(--ink);font-size:13px;padding:6px 8px;border-radius:var(--r-sm)}.acct>summary::-webkit-details-marker{display:none}
.acct>summary:hover{background:var(--chip)}.who-short{display:grid;min-width:0;line-height:1.25}.who-short b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.who-short span{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avatar{display:inline-grid;place-items:center;width:30px;height:30px;flex:none;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:11.5px;letter-spacing:.02em}
.acct-menu{position:absolute;z-index:30;width:248px;background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--pop);padding:14px;display:grid;gap:4px}
.acct-menu .who{font-weight:600;overflow-wrap:anywhere}.acct-menu button{margin-top:8px;justify-content:center}
@media(min-width:900px){body:has(header.shell){padding-left:var(--side)}
header.shell{position:fixed;inset:0 auto 0 0;width:var(--side);height:auto;flex-direction:column;align-items:stretch;gap:0;padding:var(--space-5) var(--space-3) var(--space-3);border-bottom:0;border-right:1px solid var(--line);background:var(--side-bg);z-index:20}
header.shell .brand{gap:8px;padding:0 8px 24px}header.shell nav{flex-direction:column;flex:1;overflow-y:auto}header.shell .hdr{margin-top:auto;border-top:1px solid var(--line);padding-top:10px}
header.shell .acct-menu{left:0;bottom:calc(100% + 6px)}body:has(header.shell) .skip:focus{position:fixed;top:12px;left:calc(var(--side) + 16px);z-index:50;border:1px solid var(--line);border-radius:var(--r-sm);box-shadow:var(--pop)}.shell-only{display:block}}
@media(max-width:899px){header.shell{position:sticky;top:0;z-index:20;gap:12px;padding:0 16px}header.shell nav{flex:1;overflow-x:auto;scrollbar-width:none}header.shell nav::-webkit-scrollbar{display:none}
header.shell nav a{padding:6px 8px;gap:6px}header.shell .ico{width:16px;height:16px}.acct .who-short{display:none}header.shell .acct-menu{right:0;top:calc(100% + 8px)}}
.muted{color:var(--muted)}.small{font-size:var(--text-small)}main{min-width:0;max-width:var(--page);margin:0 auto;padding:var(--space-6) var(--space-6) calc(2 * var(--space-6))}
.card{border:0;border-radius:var(--r);padding:var(--space-5) 0;margin-bottom:var(--space-4);min-width:0}:is(main,.tabpanel)>.card+.card{border-top:1px solid var(--line);border-radius:0}.card .card{box-shadow:none;border:0;padding:0;background:transparent}
h1{margin:0 0 var(--space-5)}h2{margin:0 0 var(--space-3)}h3{font-size:var(--text-body);line-height:1.5;font-weight:600}
p,.card,main{overflow-wrap:normal}.who,.rq-owner,code,pre,#share-msg,#pages{overflow-wrap:anywhere}.card>p{margin:0 0 12px}.card>p:last-child{margin-bottom:0}details>summary{cursor:pointer;color:var(--muted);font-size:13px;line-height:20px}details.card>summary{width:100%}details[open]>summary{margin-bottom:var(--space-3)}details>summary:hover{color:var(--ink)}
label{display:block;font-size:12px;line-height:16px;font-weight:500;color:var(--muted);margin-bottom:4px}
label input:not([type=checkbox]):not([type=radio]),label select,label textarea{display:block;margin-top:6px}
input,select,textarea{width:100%;font:inherit;color:inherit;background:var(--card);border:1px solid var(--control);border-radius:var(--r-sm);padding:7px 10px;min-height:36px;max-width:100%}
input[type=checkbox],input[type=radio]{width:auto;min-height:0;accent-color:var(--accent)}textarea{resize:vertical}
input:hover,select:hover,textarea:hover{border-color:var(--line-strong)}input:focus,select:focus,textarea:focus{border-color:var(--accent);outline:2px solid var(--accent);outline-offset:2px}
.row{display:flex;gap:var(--space-3);flex-wrap:wrap;align-items:flex-end}.row>div{flex:1;min-width:140px}
[hidden]{display:none!important}button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-weight:500;font-size:13px;border-radius:var(--r-sm);padding:var(--space-2) var(--space-3);min-height:36px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none;white-space:nowrap}
button.secondary,.btn.secondary{background:var(--card);color:var(--ink);border-color:var(--control)}button.ghost,.btn.ghost{background:transparent;color:var(--ink);border-color:transparent}
button.ghost:hover,.btn.ghost:hover,button.secondary:hover,.btn.secondary:hover{background:var(--chip)}button.danger{background:var(--card);color:var(--err);border-color:var(--err)}
button:hover:not(:disabled),.btn:hover{background-image:linear-gradient(rgb(0 0 0 / .04),rgb(0 0 0 / .04))}button:disabled{opacity:.65;cursor:not-allowed}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:6px 0 12px}.facts div{padding:8px 0;min-width:0}
.facts b{overflow-wrap:anywhere}.facts span{display:block;font-size:12px;color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{text-align:left;border:1px solid var(--line);background:var(--chip);color:var(--ink);font-weight:500;padding:3px 9px;border-radius:var(--r-pill);font-size:12.5px;min-height:0}
.chip.error{border-color:var(--err)}.chip .t{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:4px}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;padding:1px 8px;border-radius:var(--r-pill);background:var(--chip);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.err{background:var(--err-bg);color:var(--err)}.badge.info{background:var(--accent-soft);color:var(--accent)}
.err{color:var(--err)}.ok{color:var(--ok)}video{width:100%;border-radius:8px;background:#000;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;line-height:18px;vertical-align:bottom;background:transparent}tbody tr:hover{background:var(--hover)}td{font-size:13px;line-height:20px}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}td.empty-state,tbody>tr:only-child>td[colspan]{padding:24px;text-align:center!important;color:var(--muted);vertical-align:middle}tbody>tr:only-child>td[colspan].err{color:var(--err)}tbody>tr:only-child:has(>td[colspan]):hover{background:transparent}
.table-wrap{overflow-x:auto;max-width:100%;position:relative}th{overflow-wrap:normal!important;word-break:keep-all}main>*{min-width:0}.who{overflow-wrap:anywhere}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}main td a,main li a,main h3 a{color:var(--ink);font-weight:500}main td a:hover,main li a:hover,main h3 a:hover{color:var(--accent)}.hidden{display:none}code{background:var(--chip);padding:1px 5px;border-radius:4px;font-size:12.5px}
.narrow>*{max-width:860px}.narrow>.wide-ok{max-width:none}
.tabs,.tab-group{display:flex;flex-wrap:wrap;gap:var(--space-1);align-items:center;min-width:0}
.tabs{width:fit-content;max-width:100%;margin:0 0 var(--space-5);padding:var(--space-1);border-radius:var(--r);background:var(--chip)}
body main .tabs :is(a,button){flex:none;display:inline-flex;align-items:center;min-height:36px;padding:var(--space-2) var(--space-3);margin:0;border:0;border-radius:var(--r-pill);background:transparent;color:var(--muted);font-size:13px;line-height:20px;text-decoration:none;white-space:nowrap}
body main .tabs :is(a,button):hover{background:var(--hover);color:var(--ink)}
body main .tabs :is([aria-selected=true],[aria-current=page]){background:var(--card);box-shadow:var(--shadow);color:var(--accent);font-weight:600}
.page-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 20px}.page-head h1{margin:0}.page-head p{margin:4px 0 0;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin:0 0 24px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 20px;min-width:0;text-decoration:none;color:inherit;display:block}a.kpi:hover{border-color:var(--line-strong);text-decoration:none;background:var(--hover)}
.kpi .l{display:flex;min-height:32px;align-items:flex-start;gap:6px;font-size:12px;line-height:16px;color:var(--muted);font-weight:500}.kpi .v{display:block;font-size:var(--text-metric);line-height:32px;font-weight:600;letter-spacing:-.02em;margin-top:8px}.kpi .s{display:block;font-size:12px;line-height:16px;color:var(--faint);margin-top:4px}.kpi.crit .v{color:var(--err)}.kpi.warn .v{color:var(--warn)}.kpi .dot{flex:0 0 6px;width:6px;height:6px;margin-top:5px;border-radius:50%;background:currentColor}.kpi .dot{display:none}
.alert{background:var(--err-bg);border:1px solid color-mix(in srgb,var(--err) 35%,transparent);color:var(--err);border-radius:var(--r);padding:10px 14px;margin:8px 0}
.note{background:var(--warn-bg);border:1px solid color-mix(in srgb,var(--warn) 30%,transparent);color:var(--warn);border-radius:var(--r);padding:10px 14px;margin:8px 0}
.player{position:relative;background:#000;border-radius:8px;overflow:hidden;margin:8px 0}.player video{display:block;width:100%;margin:0;border-radius:0}
.cap{position:absolute;left:4%;right:4%;bottom:15%;text-align:center;pointer-events:none}
.cap span{display:inline-block;max-width:100%;background:rgba(0,0,0,.82);color:#fff;font-weight:700;font-size:clamp(17px,3.3vw,34px);line-height:1.3;padding:.35em .65em;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 2px 12px rgba(0,0,0,.35)}
.player:fullscreen{display:flex;align-items:center;border-radius:0}.player:fullscreen video{height:100%;object-fit:contain}.player:fullscreen .cap span{font-size:clamp(24px,3.4vw,60px)}
.fs{position:absolute;top:8px;right:8px;padding:5px 10px;background:rgba(0,0,0,.55);border:0;color:#fff;font-size:13px}
.comments{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}.comments h3{font-size:14px;margin:0 0 4px}
.cm{display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--line)}.cm .at{flex:none;font-variant-numeric:tabular-nums;padding:2px 8px;font-size:13px}
.cm .tx{min-width:0;flex:1;white-space:pre-wrap;overflow-wrap:anywhere}.cm .by{font-size:12px;color:var(--muted)}.cm.on{background:var(--chip)}.cm button{padding:2px 8px;font-size:13px;min-height:0}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;display:inline-block}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.skip{position:absolute;left:-9999px;top:0;color:var(--accent);font-weight:600}.skip:focus{position:static;display:block;padding:8px 20px;background:var(--chip);border-bottom:1px solid var(--line);outline-offset:-3px;border-radius:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pager:empty{display:none}.pager{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:12px;font-size:12.5px;color:var(--muted)}.pager .pg{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.pager button,.pager .pg>span{padding:4px 10px;min-height:30px;white-space:nowrap;font-size:12.5px}.pager button{background:var(--card);color:var(--ink);border-color:var(--line-strong)}.pager select{width:auto;padding:3px 8px;min-height:30px}

@media(max-width:600px){table:has(>tbody>tr:only-child>td[colspan]) thead{display:none}header.shell{height:auto;flex-wrap:wrap;padding:10px 16px;row-gap:8px}header.shell nav{order:3;flex-basis:100%}main{padding:var(--space-5) var(--space-4) calc(2 * var(--space-5))}.row>div{max-width:100%;min-width:min(140px,100%)}.cm{flex-wrap:wrap}.cm>div{min-width:0}.facts{grid-template-columns:repeat(2,minmax(0,1fr))}.pager .pg{gap:4px}.pager button,.pager .pg>span{padding:4px 7px}}
main svg{max-width:100%}main a{overflow-wrap:anywhere}main :is(pre,code){overflow-wrap:anywhere}main pre{white-space:pre-wrap}
main.login-page{width:min(440px,calc(100% - 32px));max-width:none;padding:0;margin:64px auto}.login-page>.card{padding:var(--space-6);margin:0;background:var(--card);box-shadow:var(--shadow)}.login-page h1{font-size:22px;line-height:28px;margin:0 0 8px}.login-page .card>p{font-size:14px;line-height:20px;margin:0 0 24px}.login-page #f{display:grid;gap:16px}.login-page #f>p{margin:0}.login-page #f label{margin-bottom:6px}.login-page #email,.login-page #pw{height:40px}.login-page #go{width:100%;min-height:40px}.login-page .card>details{margin-top:24px;padding-top:16px;border-top:1px solid var(--line)}.login-page .card>details>summary{font-size:13px;line-height:20px}.login-page #msg:empty{display:none}
.clips-page.narrow>*{max-width:none}.clips-page .row>button{flex:0 0 auto}#make>.row{display:grid;grid-template-columns:160px 240px auto;justify-content:start;align-items:end;gap:12px}#inspect-msg:empty,#job-msg:empty,#recent-msg:empty{display:none}.clips-page td.empty-state{padding:24px;text-align:center;color:var(--muted)}.clips-help>details>summary{padding:8px 0}.clips-help>details+details{border-top:1px solid var(--line);margin-top:8px;padding-top:8px}
.clips-page .table-wrap:has(#recent .empty-state) td.empty-state{border-bottom:0}
@media(max-width:600px){#make>.row{grid-template-columns:1fr}.clips-page .row:has(>#check)>div{flex-basis:100%}.clips-page #check{width:100%}}

/* Shared presentation: page-local layout rules retain their own geometry. */
body main h1{font-size:var(--text-title);line-height:var(--title-leading);font-weight:650;letter-spacing:-.025em;overflow-wrap:anywhere}
body main h2{font-size:var(--text-section);line-height:var(--section-leading);font-weight:600;overflow-wrap:anywhere}
body main .page-head{margin:0 0 var(--space-5);align-items:flex-start;gap:var(--space-4)}
body main .page-head h1{margin:0}body main .page-head p{margin:var(--space-1) 0 0;font-size:var(--text-body);color:var(--muted)}
body main :is(th,td){padding:var(--space-3);line-height:20px}body main td{overflow-wrap:anywhere}
body main thead th{background:transparent;color:var(--muted);font-size:var(--text-small);font-weight:600;border-bottom-color:var(--line-strong)}
body main tbody tr:hover{background:var(--hover)}body main tbody tr:hover td{background:transparent}
body main :is(td,th):is(.num,.n,.r){text-align:right;font-variant-numeric:tabular-nums}
body main :is(.empty,.empty-state,.rq-empty){padding:24px;text-align:center;color:var(--muted)}
body main .kpis{gap:16px;align-items:stretch}
body main .kpi{display:flex;flex-direction:column;min-height:112px;height:100%;padding:var(--space-4)}
body main .kpi .l{font-size:12px;line-height:16px;min-height:32px;color:var(--muted)}
body main .kpi .v{font-weight:600}body main .kpi .s{color:var(--muted);margin-top:auto;padding-top:6px}
body main :is(.chip,.badge,.rescue-level){font-size:12px;line-height:18px;font-weight:500;border-radius:var(--r-pill);padding:1px 8px}
body :is(a,button,input,select,textarea,summary){transition:background-color 120ms,color 120ms,border-color 120ms,transform 120ms}
body :is(button,input,select,textarea):disabled{opacity:.65;cursor:not-allowed}
body :is(a,button,input,select,textarea,summary,[tabindex]):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
body main .pager :is(button,select){min-height:32px}
body main :is(button,.btn){min-height:32px}
body main button.danger:hover:not(:disabled){background:var(--err-bg)}
body :is(.tabs :is(a,button),header.shell nav a,.table-wrap,.heat-scroll):focus-visible{outline-offset:-2px}
body details>summary{list-style:none;font-weight:500}
body details>summary::-webkit-details-marker{display:none}
body details>summary::before{content:'';display:inline-block;width:6px;height:6px;border-right:1.5px solid currentColor;border-top:1.5px solid currentColor;transform:rotate(45deg);margin-right:10px;vertical-align:2px;flex:none;transition:transform 120ms}
body details[open]>summary::before{transform:rotate(135deg)}
body .acct>summary::before,body .rq-row>summary::before{content:none}
body main details.fold>summary::after{content:none}
body header.shell nav{gap:4px}body header.shell nav a{height:36px}
body header.shell .acct>summary{min-height:48px;padding:8px;gap:10px}
body header.shell .acct[open]>summary{background:var(--hover)}
body header.shell .acct-menu{width:260px;padding:16px;border-color:var(--line-strong)}
/* One table-header style everywhere, sortable header buttons included; page CSS loaded later must not thin it. */
body main thead th,body main thead th button.ghost{font-weight:600;color:var(--muted);font-size:12px;letter-spacing:.025em}
body main thead th button.ghost:hover{color:var(--ink)}
/* Secondary actions in a card header (Download CSV, ...) read as buttons, not as text. */
body main .card>.row>button.ghost{border:1px solid var(--control);min-height:32px;padding:5px 12px}
body main .card>.row>button.ghost:hover{border-color:var(--line-strong);background:var(--hover)}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`

export const PAGE_CSS = () => CSS

/** Client-side pagination for any list a page has already loaded. Put ${PAGER_JS} inside a page's
 * <script>, then:
 *   const pg = makePager({ mount: $('people-pager'), noun: 'people', size: 25, draw: (slice, start) => { ...render slice... } })
 *   pg.set(items)            // new items: back to page 1 (pg.set(items, true) keeps the page, e.g. after a save)
 * It renders "1–25 of 230 people", Previous/Next, "Page 2 of 10" and a page-size choice (25/50/100) into
 * mount, announces changes to screen readers, and hides itself when everything fits on one page. */
export const PAGER_JS = String.raw`function makePager(o){const mount=o.mount,noun=o.noun||'items';let size=o.size||25,page=0,items=[]
mount.classList.add('pager');mount.setAttribute('role','navigation');mount.setAttribute('aria-label',(o.label||noun)+' pages')
function draw(){const pages=Math.max(1,Math.ceil(items.length/size));if(page>=pages)page=pages-1;const start=page*size,slice=items.slice(start,start+size)
o.draw(slice,start);mount.innerHTML='';if(items.length<=Math.min(size,25)){mount.hidden=true;return}mount.hidden=false
const info=document.createElement('span');info.setAttribute('aria-live','polite');info.textContent=(start+1)+'–'+(start+slice.length)+' of '+items.length+' '+noun
const pg=document.createElement('span');pg.className='pg'
const btn=(t,dis,go,lab)=>{const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent=t;b.disabled=dis;b.setAttribute('aria-label',lab);b.onclick=()=>{page=go;draw();(mount.querySelector('button:not(:disabled)')||mount).focus()};return b}
pg.appendChild(btn('‹ Previous',page===0,page-1,'Previous page'));const at=document.createElement('span');at.textContent='Page '+(page+1)+' of '+pages;pg.appendChild(at);pg.appendChild(btn('Next ›',page>=pages-1,page+1,'Next page'))
const sel=document.createElement('select');sel.setAttribute('aria-label','Rows per page');[...new Set([o.size||25,25,50,100])].sort((a,b)=>a-b).forEach(n=>{const op=document.createElement('option');op.value=n;op.textContent=n+' per page';if(n===size)op.selected=true;sel.appendChild(op)})
sel.onchange=()=>{size=+sel.value;page=0;draw()};pg.appendChild(sel);mount.appendChild(info);mount.appendChild(pg)}
return{set(list,keep){items=list||[];if(!keep)page=0;draw()},redraw:draw,get page(){return page}}}`

export const APP_NAME = config.app.name
export const APP_TAG = config.app.tag
export type Section = 'Replay clips' | 'Live' | 'Dashboards' | 'Surveys' | 'Chat' | 'System' | 'Admin'

/** The header on every page: the product name, the sections this person may open, and sign out. */
// Line icons (24px grid, 1.75 stroke), inline so the app needs nothing from the internet.
const ICON: Record<string, string> = {
    'Replay clips': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    Live: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    Dashboards: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    Surveys: '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/>',
    Chat: '<path d="M12 3v3M12 18v3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M3 12h3M18 12h3"/><circle cx="12" cy="12" r="3.5"/>',
    System: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    Admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
}
const icon = (name: string) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name] || ''}</svg>`
/** The product mark: a lens (two rings) on the accent square, drawn to sit on the text's centre line. */
export const LOGO = `<svg class="mark" viewBox="0 0 28 28" aria-hidden="true" focusable="false"><rect width="28" height="28" rx="7" fill="var(--accent)"/><circle cx="14" cy="14" r="6" fill="none" stroke="var(--accent-ink)" stroke-width="2.4"/></svg>`

/** The app shell: a sidebar (brand, sections, account) on wide screens, a top bar on narrow ones. */
export function headerHtml(v: Viewer | undefined, section: Section): string {
    const brand = `<a class="brand" href="/">${LOGO}<span class="names"><span class="word">${esc(APP_NAME)}</span>${APP_TAG ? `<span class="tag">${esc(APP_TAG)}</span>` : ''}</span></a>`
    const skip = `<a class="skip" href="#main">Skip to content</a>`
    const mainId = `<script>addEventListener('DOMContentLoaded',()=>{const m=document.querySelector('main');if(m){if(!m.id)m.id='main';if(!m.hasAttribute('tabindex'))m.tabIndex=-1}
// On phones the tab bars scroll sideways: keep the current tab in view (on load, and when tabs switch).
const keep=()=>document.querySelectorAll('main [aria-current=page],main [role=tab][aria-selected=true]').forEach(t=>{for(let a=t.parentElement;a&&a!==m;a=a.parentElement){if(a.scrollWidth>a.clientWidth+1&&/auto|scroll/.test(getComputedStyle(a).overflowX)){const r=t.getBoundingClientRect(),c=a.getBoundingClientRect();a.scrollLeft+=r.left-c.left-(c.width-r.width)/2;break}}});
const active=document.querySelector('header.shell nav [aria-current=page]');
if(active){const nav=active.parentElement;const link=active.getBoundingClientRect(),bar=nav.getBoundingClientRect();if(link.right>bar.right)nav.scrollLeft+=link.right-bar.right}
keep();addEventListener('load',keep);addEventListener('hashchange',()=>setTimeout(keep));document.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('[role=tab]'))setTimeout(keep)})})</script>`
    if (!v) return `${skip}<header class="bare">${brand}</header>${mainId}`
    const tabs = (
        [
            ['Replay clips', '/replays', 'watch'],
            ['Live', '/replays/live', 'watch'],
            ['Dashboards', '/replays/dashboards', 'dashboards'],
            ['Surveys', '/replays/surveys', 'surveys'],
            ['Chat', '/replays/connect', 'connect'],
            ['System', '/replays/system', 'system'],
            ['Admin', '/replays/admin', 'admin'],
        ] as const
    )
        .filter(([, , need]) => (need === 'system' ? canSeeSystem(v) : need === 'surveys' ? surveysActive() && canUseSurveys(v) : need === 'dashboards' ? !!appEvents() && canUseDashboards(v) : need === 'connect' ? config.features.lensMcp && canConnect(v) : can(v.role, need as Role)))
        .map(([name, href]) => `<a href="${href}"${name === section ? ' aria-current="page"' : ''}>${icon(name)}<span>${name}</span></a>`)
        .join('')
    const initials = (v.name || v.email).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('')
    return `${skip}${mainId}<header class="shell">${brand}<nav aria-label="Sections">${tabs}</nav><details class="hdr acct"><summary aria-label="Account: ${esc(v.email)}"><span class="avatar" aria-hidden="true">${esc(initials)}</span><span class="who-short"><b>${esc(v.name || v.email.split('@')[0])}</b><span>${esc(ROLE_TEXT[v.role].replace(/ \(.*\)$/, ''))}</span></span></summary><div class="acct-menu"><span class="who">${esc(v.email)}</span><span class="muted small">${esc(ROLE_TEXT[v.role])}</span><button class="secondary" id="signout" type="button">Sign out</button></div></details></header>
<script>document.getElementById('signout').onclick=()=>fetch('/replays/logout',{method:'POST',headers:{'x-clip-page':'1'}}).then(()=>location.href='/');document.addEventListener('click',e=>{const d=document.querySelector('details.acct');if(d&&d.open&&!d.contains(e.target))d.open=false});document.addEventListener('keydown',e=>{const d=document.querySelector('details.acct');if(e.key==='Escape'&&d&&d.open){d.open=false;d.querySelector('summary').focus()}})</script>`
}

export function loginHtml(section: Section = 'Replay clips'): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(undefined, section)}<main class="login-page"><div class="card"><h1>Sign in to ${esc(APP_NAME)}</h1>
<p class="small muted">Use your PostHog account to continue.</p>
<form id="f"><p><label for="email">Email</label><input id="email" type="email" autocomplete="username" required></p>
<p><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required></p>
<p><button id="go" type="submit">Sign in</button></p><p id="msg" class="small err" role="alert"></p></form>
<details><summary>Use PostHog sign-in instead</summary><p class="small muted"><a href="${esc(config.posthog.publicHost)}/login" target="_blank" rel="noopener">Sign in on PostHog</a>, then <a href="/replays">reload this page</a>.</p><p class="small muted">Signing in here also signs you in to PostHog in this browser.</p></details></div></main>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();const b=document.getElementById('go');if(b.disabled)return;b.disabled=true;document.getElementById('msg').textContent='Signing in…';
try{const r=await fetch('/replays/login',{method:'POST',headers:{'content-type':'application/json','x-clip-page':'1'},body:JSON.stringify({email:document.getElementById('email').value,password:document.getElementById('pw').value})});
const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Sign in failed.');location.href=location.pathname+location.search}catch(err){document.getElementById('msg').textContent=err.message}finally{b.disabled=false}}</script></body></html>`
}

function noAccessHtml(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No access · ${esc(APP_NAME)}</title><style>${CSS}</style></head>
<body>${headerHtml(v, 'Replay clips')}<main style="max-width:560px"><div class="card"><h1 style="font-size:24px;margin-bottom:12px">Request access to replay clips</h1>
<p class="small muted">Signed in as <b>${esc(v.email)}</b>.</p><p>Ask a PostHog admin for the “Watch clips” role on the admin page.</p>
<details><summary>Why access is required</summary><p class="small muted">Replays can show client data, so an admin grants access to each person.</p></details></div></main></body></html>`
}

function pageHtml(v: Viewer): string {
    const bookmarklet = `javascript:(()=>{window.open(${JSON.stringify(config.service.publicUrl + '/replays?url=')}+encodeURIComponent(location.href))})()`
    const boot = JSON.stringify({ lengths: LENGTHS, ttl: config.service.clipLinkTtlHours, retention: RETENTION_DAYS, perHour: PER_HOUR, canDownload: can(v.role, 'download'), shareLinks: can(v.role, 'download') && loadAccess().allow_share_links }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay clips · ${esc(APP_NAME)}</title><style>${CSS}

</style></head>
<body>${headerHtml(v, 'Replay clips')}<main class="clips-page narrow">
<div class="page-head"><div><h1>Replay clips</h1><p>Choose a replay and make a clip to share.</p></div></div>

<div class="card"><h2>1. Choose a replay</h2>
<label for="input">PostHog replay link or session ID</label>
<div class="row"><div><input id="input" placeholder="Paste a replay link or session ID" autocomplete="off"></div>
<button id="check" type="button">Check replay</button></div>
<p aria-live="polite" aria-atomic="true" id="inspect-msg" class="small"></p>
<div id="info" class="hidden">
<div class="facts"><div><span>Client</span><b id="f-client"></b></div><div><span>User</span><b id="f-user"></b></div><div><span>Recorded</span><b id="f-when"></b></div><div><span>Length</span><b id="f-len"></b></div></div>
<p class="small muted">Key moments: choose one to start just before it.</p><div id="moments" class="chips"></div><div id="moments-pager"></div>
<p class="small muted" id="pages"></p></div></div>

<div class="card" id="make" aria-disabled="true"><h2>2. Make the clip</h2><p class="small muted" id="make-help">Check a replay to enable clip creation.</p>
<div class="row"><div><label for="start">Start at (m:ss)</label><input id="start" value="0:00"></div>
<div><label for="length">Length</label><select id="length"></select></div>
<button id="go" type="button" disabled>Make clip</button></div>
<p aria-live="polite" aria-atomic="true" id="job-msg" class="small"></p>
<div id="result" class="hidden"><div class="player" id="player"><video aria-label="Replay clip" id="video" controls preload="metadata" controlslist="nodownload nofullscreen" oncontextmenu="return CFG.canDownload"><track kind="captions" srclang="en" label="Comments" id="track"></video><div class="cap" id="cap" aria-live="polite"></div><button class="fs" id="fs" type="button" title="Full screen, with the comments">Full screen</button></div>
<div class="row" style="align-items:center"><button class="ghost" id="save" type="button">Save this</button><a class="btn ghost" id="dl">Download MP4</a><button class="ghost" id="share" type="button">Copy share link</button><a class="btn ghost" id="open" target="_blank" rel="noopener">Open in PostHog</a></div>
<p aria-live="polite" aria-atomic="true" id="keep-msg" class="small muted"></p><p aria-live="polite" aria-atomic="true" id="share-msg" class="small muted"></p>
<div class="comments"><h3>Comments on the video</h3>
<p class="small muted" style="margin:0 0 12px">Comments appear as captions in the video, downloads and share links.</p>
<div id="c-list"></div><div id="comments-pager"></div>
<div class="row" style="margin-top:10px"><div style="flex:0 0 120px"><label for="c-at">At (m:ss)</label><input id="c-at" value="0:00" autocomplete="off"></div>
<div style="flex:0 0 140px"><label for="c-dur">Show for</label><select id="c-dur"></select></div>
<div style="flex:0"><button class="ghost" id="c-now" type="button" title="Take the moment the video is at" style="white-space:nowrap">Use video time</button></div></div>
<p style="margin:8px 0"><label for="c-text">Comment</label><textarea id="c-text" rows="2" placeholder="What should people notice at this moment?"></textarea></p>
<div class="row" style="align-items:center"><button id="c-add" type="button">Add comment</button><button class="ghost hidden" id="c-cancel" type="button">Cancel</button><span class="small" aria-live="polite" aria-atomic="true" id="c-msg"></span></div>
<p class="small muted" id="c-plain"></p></div></div></div>

<div class="card"><h2>Your clips</h2><div class="table-wrap" role="region" aria-label="Your clips" tabindex="0"><table><thead><tr><th scope="col">Made</th><th scope="col">Client</th><th scope="col">User</th><th scope="col">Part</th><th scope="col">Kept until</th><th scope="col">Actions</th></tr></thead><tbody id="recent"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table><div id="recent-pager"></div></div>
<p id="recent-msg" class="small" role="alert"></p></div>
<section class="card clips-help"><details><summary>How this works</summary><p class="small muted" id="retention"></p></details>

<details><summary>Open replays from PostHog in one click</summary>
<p class="small">Drag this button to your bookmarks bar. While you watch a replay in PostHog, click it to open the replay here.</p>
<p><a class="btn ghost" href="${esc(bookmarklet)}">Get MP4</a></p></details></section>
</main>
<script>
${PAGER_JS}
const CFG=${boot};const $=id=>document.getElementById(id);
const clock=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,'0');return h?h+':'+String(m).padStart(2,'0')+':'+x:m+':'+x};
const when=iso=>new Date(iso).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1',...(opts.headers||{})}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
CFG.lengths.forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l+' seconds';if(l===30)o.selected=true;$('length').appendChild(o)});
$('retention').textContent='Clips are deleted '+CFG.retention+' days after they were last made, unless you click Save. Share links expire after '+Math.round(CFG.ttl/24)+' days. Every view and download is logged.';
const day=iso=>new Date(iso).toLocaleDateString([], {dateStyle:'medium'});
const keepText=c=>c.saved?'You saved this clip. It stays until you unsave it.':c.saved_by.length?'Saved by someone else, so it is kept.':'Deleted on '+day(c.expires_at)+' unless someone saves it.';
async function toggleSave(c){if(c.saved&&!confirm('Unsave this clip? It may be deleted after the retention period.'))return c;const r=await api('/replays/api/clips/'+encodeURIComponent(c.name)+'/save',{method:'POST',body:JSON.stringify({saved:!c.saved})});return r}
let info=null,cur=null;
function txt(el,t,cls){el.textContent=t;el.className='small '+(cls||'');el.setAttribute('role',cls==='err'?'alert':'status')}
const momentsPager=makePager({mount:$('moments-pager'),noun:'key moments',size:25,draw:moments=>{  const box=$('moments');box.innerHTML='';
  if(!moments.length){box.innerHTML='<span class="muted small">No errors or frustrated clicks in this recording.</span>'}
  moments.forEach(m=>{const b=document.createElement('button');b.type='button';b.className='chip'+(m.kind==='error'?' error':'');b.innerHTML='<span class="t"></span>';b.querySelector('.t').textContent=clock(m.offset_s);b.append(m.kind+' '+m.label);b.onclick=()=>{$('start').value=clock(Math.max(0,m.offset_s-5))};box.appendChild(b)});
}});
async function check(){if($('check').disabled)return;const input=$('input').value.trim();if(!input){txt($('inspect-msg'),'Paste a replay link or session ID first.','err');$('input').focus();return}info=null;$('check').disabled=true;$('input').disabled=true;$('make').setAttribute('aria-disabled','true');$('make-help').hidden=false;txt($('inspect-msg'),'Checking…','muted');$('info').classList.add('hidden');$('go').disabled=true;
 try{const r=await api('/replays/api/inspect',{method:'POST',body:JSON.stringify({input})});info=r.info;
  $('f-client').textContent=info.client||'unknown';$('f-user').textContent=info.user||'unknown';$('f-when').textContent=when(info.start);$('f-len').textContent=clock(info.duration_s);
  momentsPager.set(info.moments.filter(m=>m.kind!=='page'));
  $('pages').textContent=info.pages.length?'Pages: '+info.pages.join(' → '):'';
  $('start').value=clock(r.suggested_start_s);$('info').classList.remove('hidden');$('go').disabled=false;$('make').setAttribute('aria-disabled','false');$('make-help').hidden=true;txt($('inspect-msg'),'Replay checked. Choose a start time and length.','ok')
 }catch(e){txt($('inspect-msg'),e.message+' Check the link and try again.','err')}finally{$('check').disabled=false;$('input').disabled=false}}
$('input').addEventListener('input',()=>{info=null;$('go').disabled=true;$('make').setAttribute('aria-disabled','true');$('make-help').hidden=false;$('info').classList.add('hidden');txt($('inspect-msg'),'Check this replay before making a clip.','muted')});
$('check').onclick=check;$('input').addEventListener('keydown',e=>{if(e.key==='Enter')check()});$('input').addEventListener('paste',()=>setTimeout(check,50));
$('go').onclick=async()=>{if($('go').disabled)return;$('go').disabled=true;$('check').disabled=true;$('input').disabled=true;$('result').classList.add('hidden');txt($('job-msg'),'Queued…','muted');
 try{let j=await api('/replays/api/clips',{method:'POST',body:JSON.stringify({input:$('input').value.trim(),start:$('start').value,length:Number($('length').value)})});
  while(j.state==='queued'||j.state==='rendering'){$('job-msg').innerHTML='<span class="spin" aria-hidden="true"></span> '+(j.state==='queued'?'Waiting in queue (position '+j.position+')':'Making the clip… '+j.elapsed_s+' s (usually 10 to 30 s)');await new Promise(r=>setTimeout(r,1500));j=await api('/replays/api/jobs/'+j.id)}
  if(j.state==='failed')throw new Error(j.error||'The clip could not be made.');
  show(j.clip);txt($('job-msg'),'Ready.','ok');loadRecent()
 }catch(e){txt($('job-msg'),e.message,'err')}finally{$('go').disabled=false;$('check').disabled=false;$('input').disabled=false}};
function show(c){$('dl').classList.toggle('hidden',!CFG.canDownload);$('share').classList.toggle('hidden',!CFG.shareLinks);$('video').src=c.video_url+'#t=1';$('dl').href=c.download_url;$('track').src='/replays/api/clips/'+encodeURIComponent(c.name)+'/comments.vtt';loadComments(c);$('open').href=c.replay_url;$('share').dataset.name=c.name;cur=c;$('save').textContent=c.saved?'Saved ✓ (unsave)':'Save this';txt($('keep-msg'),keepText(c),'muted');$('share-msg').textContent='';$('result').classList.remove('hidden');$('result').scrollIntoView({behavior:'smooth',block:'nearest'})}
$('share').onclick=async()=>{if($('share').disabled)return;$('share').disabled=true;txt($('share-msg'),'Creating link…','muted');try{const r=await api('/replays/api/share/'+encodeURIComponent($('share').dataset.name),{method:'POST',body:JSON.stringify({comments:true})});let copied=false;try{await navigator.clipboard.writeText(r.url);copied=true}catch{};$('share-msg').textContent=(copied?'Link copied':'Copy this link')+(r.comments?', with the comments in the video':'')+'. Anyone with it can watch this clip for '+Math.round(r.expires_hours/24)+' days: '+r.url}catch(e){txt($('share-msg'),e.message+' Try again.','err')}finally{$('share').disabled=false}};
$('save').onclick=async()=>{if(!cur||$('save').disabled)return;$('save').disabled=true;try{const c=await toggleSave(cur);cur=c;$('save').textContent=c.saved?'Saved ✓ (unsave)':'Save this';txt($('keep-msg'),keepText(c),c.saved?'ok':'muted');loadRecent()}catch(e){txt($('keep-msg'),e.message,'err')}finally{$('save').disabled=false}};
const recentPager=makePager({mount:$('recent-pager'),noun:'clips',size:25,draw:clips=>{const tb=$('recent');tb.innerHTML='';
 if(!clips.length){tb.innerHTML='<tr><td colspan="6" class="empty-state">No clips yet. Check a replay above to make your first clip.</td></tr>';return}
 clips.forEach(c=>{const tr=document.createElement('tr');[when(c.created_at),c.client||'',(c.user||'').replace(/@.*/,''),c.range+(c.comments?' · '+c.comments+' comment'+(c.comments===1?'':'s'):''),c.saved?'Saved':c.expires_at?day(c.expires_at):'Saved by someone else'].forEach(t=>{const td=document.createElement('td');td.textContent=t;tr.appendChild(td)});
  const td=document.createElement('td');td.style.whiteSpace='nowrap';const w=document.createElement('button');w.type='button';w.className='ghost';w.textContent='Watch';w.onclick=()=>{show(c);$('video').focus()};
  const k=document.createElement('button');k.type='button';k.className='ghost';k.textContent=c.saved?'Unsave':'Save';k.onclick=async()=>{k.disabled=true;try{const n=await toggleSave(c);if(cur&&cur.name===n.name)show(n);loadRecent()}catch(e){$('recent-msg').textContent=e.message+' Try saving again.'}finally{k.disabled=false}};
  td.append(w,' ',k);tr.appendChild(td);tb.appendChild(tr)})}});
let recentLoad=0;
async function loadRecent(){const request=++recentLoad;try{const clips=[];let offset=0;while(true){const r=await api('/replays/api/clips?limit=100&offset='+offset);if(request!==recentLoad)return;clips.push(...r.clips);if(r.clips.length<100)break;offset+=r.clips.length}recentPager.set(clips,true);$('recent-msg').textContent=''}catch(e){if(request===1)$('recent').innerHTML='';$('recent-msg').textContent=e.message+' Reload the page to try again.'}}
// ---------------------------------------------------------------- comments on the video
let CM={clip:null,list:[],cues:[],editing:null,length:0,durations:[],touched:false};
const atText=x=>{x=Math.max(0,Math.round(x*10)/10);const m=Math.floor(x/60),r=x-m*60;const whole=Math.floor(r);const tenth=Math.round((r-whole)*10);return m+':'+String(whole).padStart(2,'0')+(tenth?'.'+tenth:'')};
const parseAt=t=>{const m=/^\\s*(?:(\\d+):)?(\\d{1,2})(?:\\.(\\d))?\\s*$/.exec(t||'');if(!m)return NaN;return Number(m[1]||0)*60+Number(m[2])+Number(m[3]||0)/10};
function cmMsg(t,cls){txt($('c-msg'),t,cls)}
async function loadComments(c){CM.clip=c;CM.editing=null;CM.touched=false;resetComposer();CM.list=[];CM.cues=[];commentsPager.set([]);$('c-add').disabled=true;cmMsg('Loading comments…','muted');try{const r=await api('/replays/api/clips/'+encodeURIComponent(c.name)+'/comments');if(CM.clip!==c)return;applyComments(r);$('c-add').disabled=false;cmMsg('')}catch(e){if(CM.clip===c)cmMsg(e.message+' Open the clip again to retry.','err')}}
function applyComments(r){CM.list=r.comments;CM.cues=r.cues;CM.length=r.length_s;
 if(!CM.durations.length){CM.durations=r.durations;r.durations.forEach(d=>{const o=document.createElement('option');o.value=d;o.textContent=d+' seconds';if(d===r.default_duration)o.selected=true;$('c-dur').appendChild(o)})}
 $('c-text').maxLength=r.max_text;renderComments();paint();
 if(CM.clip){CM.clip.comments=r.comments.length;$('dl').textContent=r.comments.length&&CFG.canDownload?'Download MP4 with comments':'Download MP4'}
 $('c-plain').innerHTML='';if(r.comments.length&&CFG.canDownload){const a=document.createElement('a');a.href=CM.clip.download_url+'?comments=0';a.textContent='Download without the comments';$('c-plain').appendChild(a)}
 const tr=$('video').textTracks[0];if(tr)tr.mode=document.fullscreenElement===$('video')?'showing':'hidden'}
const commentsPager=makePager({mount:$('comments-pager'),noun:'comments',size:25,draw:slice=>renderComments(slice)});
function renderComments(slice){if(!slice){commentsPager.set(CM.list,true);return}const box=$('c-list');box.innerHTML='';
 if(!CM.list.length){const p=document.createElement('p');p.className='small muted';p.textContent='No comments yet. Pause the video where something matters and write what to notice.';box.appendChild(p);return}
 slice.forEach(c=>{const row=document.createElement('div');row.className='cm';row.dataset.at=c.at_s;
  const at=document.createElement('button');at.className='ghost at';at.type='button';at.textContent=atText(c.at_s);at.title='Jump to this moment';at.onclick=()=>{const v=$('video');v.pause();v.currentTime=c.at_s;paint()};row.appendChild(at);
  const body=document.createElement('div');body.style.flex='1';const tx=document.createElement('div');tx.className='tx';tx.textContent=c.text;body.appendChild(tx);
  const by=document.createElement('div');by.className='by';by.textContent=c.author.replace(/@.*/,'')+' · shows for '+c.duration_s+' s'+(c.updated_at!==c.created_at?' · edited':'');body.appendChild(by);row.appendChild(body);
  if(c.can_edit){const e=document.createElement('button');e.className='ghost';e.type='button';e.textContent='Edit';e.onclick=()=>editComment(c);const d=document.createElement('button');d.className='ghost';d.type='button';d.textContent='Delete';
   d.onclick=async()=>{if(d.disabled||!confirm('Delete this comment?'))return;d.disabled=true;try{applyComments(await api('/replays/api/clips/'+encodeURIComponent(CM.clip.name)+'/comments/'+c.id,{method:'DELETE'}));cmMsg('Deleted.','ok');$('c-add').focus()}catch(err){cmMsg(err.message+' Try deleting again.','err')}finally{d.disabled=false}};
   const w=document.createElement('div');w.style.display='flex';w.style.gap='6px';w.append(e,d);row.appendChild(w)}
  box.appendChild(row)})}
function resetComposer(){CM.editing=null;$('c-text').value='';$('c-add').textContent='Add comment';$('c-cancel').classList.add('hidden');CM.touched=false;cmMsg('')}
function editComment(c){CM.editing=c;$('c-at').value=atText(c.at_s);$('c-dur').value=String(c.duration_s);if($('c-dur').value!==String(c.duration_s)){const o=document.createElement('option');o.value=c.duration_s;o.textContent=c.duration_s+' seconds';$('c-dur').appendChild(o);$('c-dur').value=String(c.duration_s)}
 $('c-text').value=c.text;$('c-add').textContent='Save changes';$('c-cancel').classList.remove('hidden');CM.touched=true;$('c-text').focus();const v=$('video');v.pause();v.currentTime=c.at_s;paint()}
$('c-cancel').onclick=()=>{resetComposer();$('c-text').focus()};
$('c-now').onclick=()=>{$('c-at').value=atText($('video').currentTime);CM.touched=true};
$('c-at').oninput=()=>{CM.touched=true};
// Writing a comment pauses the video and takes its moment, unless a moment was typed already.
$('c-text').addEventListener('focus',()=>{const v=$('video');if(!v.paused)v.pause();if(!CM.touched&&!CM.editing)$('c-at').value=atText(v.currentTime)});
$('c-add').onclick=async()=>{if(!CM.clip||$('c-add').disabled)return;const at=parseAt($('c-at').value);if(Number.isNaN(at)){cmMsg('Write the moment like 0:12 or 1:05.5.','err');return}
 const body=JSON.stringify({at_s:at,duration_s:Number($('c-dur').value),text:$('c-text').value});$('c-add').disabled=true;
 try{const path='/replays/api/clips/'+encodeURIComponent(CM.clip.name)+'/comments'+(CM.editing?'/'+CM.editing.id:'');const was=!!CM.editing;
  applyComments(await api(path,{method:'POST',body}));resetComposer();cmMsg(was?'Saved.':'Added. Play the video to see it.','ok');const v=$('video');v.currentTime=Math.max(0,at-1);paint()}
 catch(e){cmMsg(e.message,'err')}finally{$('c-add').disabled=false}};
$('c-text').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('c-add').click()}});
// Shows the comment for the video's current moment, big, over the picture.
let shownCue=null;
function paint(){const t=$('video').currentTime;const c=CM.cues.find(x=>t>=x.start&&t<x.end)||null;if(c!==shownCue){shownCue=c;const cap=$('cap');cap.innerHTML='';if(c){const sp=document.createElement('span');sp.textContent=c.text;cap.appendChild(sp)}}
 document.querySelectorAll('#c-list .cm').forEach(r=>r.classList.toggle('on',!!c&&Number(r.dataset.at)===c.start))}
(()=>{const v=$('video');let raf=0;const loop=()=>{paint();raf=v.paused?0:requestAnimationFrame(loop)};v.addEventListener('play',()=>{if(!raf)raf=requestAnimationFrame(loop)});['seeked','timeupdate','loadedmetadata','pause'].forEach(ev=>v.addEventListener(ev,paint))})();
$('fs').onclick=()=>{const p=$('player');if(document.fullscreenElement)document.exitFullscreen();else if(p.requestFullscreen)p.requestFullscreen().catch(()=>{})};
// Browsers that still put the bare video in full screen get the comments as captions there.
document.addEventListener('fullscreenchange',()=>{const tr=$('video').textTracks[0];if(tr)tr.mode=document.fullscreenElement===$('video')?'showing':'hidden';$('fs').textContent=document.fullscreenElement?'Exit full screen':'Full screen'});
loadRecent();
const qs=new URLSearchParams(location.search);const pre=qs.get('url');if(pre){$('input').value=pre;check()}
const one=qs.get('clip');if(one){api('/replays/api/clips/'+encodeURIComponent(one)).then(show).catch(e=>txt($('job-msg'),e.message,'err'))}
</script></body></html>`
}
