// Turns a stretch of a session recording into an MP4, using PostHog's own rasterizer (bundled
// into vendor/ by scripts/build-rasterizer.mjs).
//
// Recordings are untrusted content: they are other people's DOM. The replay page therefore runs
// through an allowlist proxy as well as DNS rules, so literal IPs cannot bypass containment.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createClipQueue } from './clip-queue.ts'
import { config, ROOT } from './config.ts'
import { startEgress } from './egress.ts'
import { moveFile } from './files.ts'
import { mp4Duration } from './mp4.ts'
import { getRecording, getSnapshotsJsonl, hogql, PostHogError } from './posthog.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)

export interface ClipRequest {
    sessionId: string
    startOffsetS: number // seconds from the recording start
    durationS: number
}

export interface Clip {
    session_id: string
    file: string // absolute path of the MP4
    name: string // file name, used in URLs and attachments
    start_offset_s: number
    end_offset_s: number
    video_duration_s: number
    size_bytes: number
    render_s: number
    cached: boolean
}

function findChrome(): string {
    if (config.clip.chromePath) return config.clip.chromePath
    // The project's own copy first (the service runs as a non-root user), then puppeteer's default.
    for (const cache of [process.env.PUPPETEER_CACHE_DIR, join(ROOT, '.cache/puppeteer'), join(homedir(), '.cache/puppeteer')]) {
        if (!cache) continue
        const base = join(cache, 'chrome-headless-shell')
        const versions = existsSync(base) ? readdirSync(base).sort().reverse() : []
        for (const v of versions) {
            const p = join(base, v, 'chrome-headless-shell-linux64/chrome-headless-shell')
            if (existsSync(p)) return p
        }
    }
    throw new Error('chrome-headless-shell not found. Run `pnpm install` (puppeteer downloads it) or set CHROME_HEADLESS_SHELL.')
}

export function hostResolverRules(): string {
    const allowed = config.clip.allowedHosts
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    // Every name resolves to nothing except the allowlist. Chrome applies these rules to the proxy's
    // own address as well, so the egress proxy (127.0.0.1, src/core/egress.ts) is excluded: without it
    // Chrome cannot reach the proxy and every clip fails. Pages still cannot reach 127.0.0.1 directly:
    // all traffic, loopback included (<-loopback>), goes through the proxy, which refuses it.
    return ['MAP * ~NOTFOUND', ...allowed.map((h) => `EXCLUDE ${h}`), 'EXCLUDE 127.0.0.1'].join(', ')
}

type Rasterizer = {
    BrowserPool: new () => { launch(): Promise<void>; shutdown(): Promise<void> }
    rasterizeFile: (pool: unknown, html: string, input: string, out: string, opts: Record<string, unknown>) => Promise<{ video_duration_s?: number }>
}

let engine: { r: Rasterizer; pool: InstanceType<Rasterizer['BrowserPool']>; html: string } | undefined

let egress: Awaited<ReturnType<typeof startEgress>> | undefined

let engineFlight: Promise<NonNullable<typeof engine>> | undefined
function getEngine() {
    return engineFlight ??= initializeEngine().catch(error => { engineFlight = undefined; throw error })
}

async function initializeEngine() {
    if (engine) return engine
    const bundle = join(ROOT, 'vendor/rasterizer.cjs')
    if (!existsSync(bundle)) throw new Error('vendor/rasterizer.cjs is missing. Run `pnpm build:rasterizer` first.')
    // The rasterizer reads its settings from the environment when it loads.
    process.env.PUPPETEER_EXECUTABLE_PATH = findChrome()
    process.env.PLAYER_HTML_PATH = join(ROOT, 'vendor/player.html')
    process.env.SITE_URL ||= config.posthog.publicHost
    egress ||= await startEgress([...config.clip.allowedHosts.split(','), new URL(process.env.SITE_URL).host])
    // Node fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is enabled; Lens keeps its own routing.
    process.env.HTTPS_PROXY = egress.url
    process.env.RASTERIZER_USE_PROXY = 'true'
    process.env.CHROME_HOST_RESOLVER_RULES = hostResolverRules()
    process.env.LOG_LEVEL ||= 'warn'
    process.env.MAX_IDLE_BROWSERS ??= String(Math.min(2, clipQueueStats().concurrency))
    const r = require(bundle) as Rasterizer
    const pool = new r.BrowserPool()
    await pool.launch()
    engine = { r, pool, html: readFileSync(join(ROOT, 'vendor/player.html'), 'utf8') }
    return engine
}

export async function shutdownClips(): Promise<void> {
    if (engine) await engine.pool.shutdown()
    engine = undefined
    engineFlight = undefined
    await egress?.close()
    egress = undefined
}

// Leave recent directories alone: another service process may still be rendering there.
export function cleanRenderWork(now = Date.now()): void {
    const dir = join(config.clip.cacheDir, 'render')
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
        const file = join(dir, entry)
        if (now - statSync(file).mtimeMs > 86_400_000) rmSync(file, { recursive: true, force: true })
    }
}
cleanRenderWork()

const renders = createClipQueue(async key => renderUnqueued(JSON.parse(key) as ClipRequest), {
    timing: times => console.info(JSON.stringify({ msg: 'clip render timing', ...times })),
})
export const clipQueueStats = renders.stats
export const pendingRenders = () => { const s = renders.stats(); return s.queued + s.rendering }

/** The recording's snapshots as a cached JSONL file (also read by replaynet.ts). */
const deletedSnapshots = new Set<string>()
const snapshotFlights = new Map<string, Promise<string>>()
const snapshotUses = new Map<string, { count: number; files: Set<string> }>()
/** Pin before fetching: another fetch can prune before an awaiting renderer resumes. */
export async function withSnapshotsFile<T>(sessionId: string, use: (file: string) => Promise<T>): Promise<T> {
    let active = snapshotUses.get(sessionId)
    if (!active) { active = { count: 0, files: new Set() }; snapshotUses.set(sessionId, active) }
    active.count++
    try { return await use(await snapshotsFile(sessionId)) }
    finally { if (!--active.count) snapshotUses.delete(sessionId) }
}
export function snapshotsFile(sessionId: string): Promise<string> {
    if (deletedSnapshots.has(sessionId)) return Promise.reject(new PostHogError('Recording deleted', 404))
    let flight = snapshotFlights.get(sessionId)
    if (!flight) {
        flight = fetchSnapshotsFile(sessionId).finally(() => snapshotFlights.delete(sessionId))
        snapshotFlights.set(sessionId, flight)
    }
    return flight
}
async function fetchSnapshotsFile(sessionId: string): Promise<string> {
    const dir = join(config.clip.cacheDir, 'snapshots')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const meta = await getRecording(sessionId)
    if (deletedSnapshots.has(sessionId)) throw new PostHogError('Recording deleted', 404)
    // The key includes the end time, so a recording that is still growing gets fetched again.
    const key = `${sessionId}_${Date.parse(meta.end_time) || 0}`.replace(/[^A-Za-z0-9_-]/g, '')
    const file = join(dir, `${key}.jsonl`)
    if (existsSync(file) && Date.now() - statSync(file).mtimeMs > config.clip.snapshotMaxDays * 86_400_000 && ![...snapshotUses.values()].some(use => use.files.has(file))) rmSync(file, { force: true })
    if (!existsSync(file)) {
        try {
            await getSnapshotsJsonl(sessionId, file + '.tmp')
            if (statSync(file + '.tmp').size > config.clip.maxCacheMb * 1024 * 1024) throw new PostHogError('Recording too large for snapshot cache', 413)
            if (deletedSnapshots.has(sessionId)) throw new PostHogError('Recording deleted', 404)
            renameSync(file + '.tmp', file)
        } finally { rmSync(file + '.tmp', { force: true }) }
    }
    if (statSync(file).size > config.clip.maxCacheMb * 1024 * 1024) {
        rmSync(file, { force: true })
        throw new PostHogError('Recording too large for snapshot cache', 413)
    }
    snapshotUses.get(sessionId)?.files.add(file)
    pruneCache(dir, file)
    return file
}

/** Age bounds raw replay retention even when the size budget is never reached. */
export function pruneCache(dir: string, protectedFile?: string, now = Date.now()): void {
    if (!existsSync(dir)) return
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl') || f.endsWith('.jsonl.tmp'))
        .map((f) => ({ f: join(dir, f), ...statSync(join(dir, f)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = protectedFile && existsSync(protectedFile) ? statSync(protectedFile).size : 0
    for (const x of files) {
        if (x.f === protectedFile) continue
        total += x.size
        if ((total > config.clip.maxCacheMb * 1024 * 1024 || now - x.mtimeMs > config.clip.snapshotMaxDays * 86_400_000) && ![...snapshotUses.values()].some(use => use.files.has(x.f))
            && ![...snapshotFlights.keys()].some(id => x.f.startsWith(join(dir, id.replace(/[^A-Za-z0-9_-]/g, '') + '_')))) rmSync(x.f, { force: true })
    }
}

// Retention is authoritative, including raw files left by interrupted downloads or renders.
export function deleteReplayCache(sessionId: string): void {
    const sid = sessionId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!sid || sid !== sessionId) return
    deletedSnapshots.add(sessionId) // An in-flight download must not recreate content after deletion.
    for (const sub of ['snapshots', 'render']) {
        const dir = join(config.clip.cacheDir, sub)
        if (existsSync(dir)) for (const name of readdirSync(dir)) {
            if (name.startsWith(sid + '_')) rmSync(join(dir, name), { recursive: true, force: true })
        }
    }
}
pruneCache(join(config.clip.cacheDir, 'snapshots'))

/** Seconds from the recording's start to the session's last event. The recorder sends nothing while the page
 * does not change, so an idle session's recording can span 1 s while the person sat on it for a minute: that
 * stretch is the still page, and a clip of it must not be refused (replay check 2026-11-17, idle persona). */
async function sessionEndS(sessionId: string, recordingStart: string, query = hogql): Promise<number> {
    const start = Date.parse(recordingStart)
    if (!Number.isFinite(start)) return 0
    try {
        const [row] = await query(`SELECT max(timestamp) AS last FROM events WHERE $session_id = {sid} AND timestamp >= {from} AND timestamp < {to}`,
            { sid: sessionId, from: new Date(start - 3_600_000).toISOString(), to: new Date(start + 86_400_000).toISOString() })
        const last = Date.parse(String(row?.last ?? ''))
        return Number.isFinite(last) ? Math.max(0, (last - start) / 1000) : 0
    } catch { return 0 } // the recording's own length still applies
}

export async function clipRange(req: ClipRequest, deps: { query?: typeof hogql } = {}): Promise<ClipRequest> {
    const meta = await getRecording(req.sessionId)
    const recorded = Number(meta.recording_duration) || (Date.parse(meta.end_time) - Date.parse(meta.start_time)) / 1000
    const length = Math.max(Number.isFinite(recorded) ? recorded : 0, await sessionEndS(req.sessionId, meta.start_time, deps.query))
    const start = Math.max(0, Math.floor(req.startOffsetS))
    if (!(length > 0) || start >= length) throw new PostHogError('Clip starts beyond recording end', 400)
    return { sessionId: req.sessionId, startOffsetS: start, durationS: Math.min(Math.max(1, Math.round(req.durationS)), length - start) }
}

export function clipName(req: ClipRequest): string {
    const s = Math.max(0, Math.floor(req.startOffsetS))
    const e = s + Math.max(1, Math.round(req.durationS))
    return `${req.sessionId.replace(/[^A-Za-z0-9-]/g, '')}_${s}-${e}.mp4`
}

export async function withRenderWork<T>(work: string, render: () => Promise<T>): Promise<T> {
    rmSync(work, { recursive: true, force: true })
    try { return await render() }
    finally { rmSync(work, { recursive: true, force: true }) }
}

export function renderClip(req: ClipRequest, owner?: string, onStart?: () => void): Promise<Clip> {
    const normalized = { sessionId: req.sessionId, startOffsetS: Math.max(0, Math.floor(req.startOffsetS)), durationS: Math.max(1, Math.round(req.durationS)) }
    // An already rendered clip is a file lookup: answer at once instead of queuing behind Chrome renders.
    const cached = cachedClip(normalized)
    if (cached) { onStart?.(); return Promise.resolve(cached) }
    return renders.run(JSON.stringify(normalized), owner, onStart)
}

function cachedClip(req: ClipRequest, range?: ClipRequest): Clip | undefined {
    const name = clipName(req), file = join(config.clip.outDir, name)
    if (!existsSync(file) || !existsSync(file + '.json')) return undefined
    try {
        const meta = JSON.parse(readFileSync(file + '.json', 'utf8'))
        if (meta.version !== 2) return undefined // Old renders may include content past the requested end.
        // A tail-clamped render is reusable only after checking the current session length.
        // Live recordings can grow past the end that was known when this file was made.
        const expectedEnd = req.startOffsetS + req.durationS
        if (meta.end < expectedEnd - 0.002 && !range) return undefined
        if (range && Math.abs(meta.end - (range.startOffsetS + range.durationS)) > 0.002) return undefined
        const duration = mp4Duration(file)
        return { session_id: req.sessionId, file, name, start_offset_s: meta.start, end_offset_s: meta.start + duration,
            video_duration_s: duration, size_bytes: statSync(file).size, render_s: 0, cached: true }
    } catch { return undefined }
}

async function renderUnqueued(req: ClipRequest): Promise<Clip> {
    const name = clipName(req)
    const outDir = config.clip.outDir
    mkdirSync(outDir, { recursive: true, mode: 0o700 })
    const file = join(outDir, name)
    const range = await clipRange(req)
    const start = range.startOffsetS, end = start + range.durationS
    // Re-checked inside the queue: an identical request may have finished while this one waited.
    const cached = cachedClip(req, range)
    if (cached) return cached
    const t0 = Date.now()
    return withSnapshotsFile(req.sessionId, async input => {
        const { r, pool, html } = await getEngine()
        const work = join(config.clip.cacheDir, 'render', name.replace(/\.mp4$/, ''))
        return withRenderWork(work, async () => {
            await r.rasterizeFile(pool, html, input, work, {
                start_offset_s: start,
                end_offset_s: end,
                trim: range.durationS,
                playback_speed: 1,
                skip_inactivity: false,
                show_metadata_footer: true,
                // A fractional recording tail still needs an integral number of frames.
                recording_fps: Math.ceil(range.durationS * 12) / range.durationS,
                output_format: 'mp4',
            })
            if (deletedSnapshots.has(req.sessionId)) throw new PostHogError('Recording deleted', 404)
            const duration = mp4Duration(join(work, 'video.mp4'))
            if (Math.abs(duration - range.durationS) > 0.002) throw new Error('Rendered MP4 duration does not match the clip range')
            moveFile(join(work, 'video.mp4'), file)
            writeFileSync(file + '.json', JSON.stringify({ version: 2, start, end: start + duration }), { mode: 0o600 })
            return {
                session_id: req.sessionId,
                file,
                name,
                start_offset_s: start,
                end_offset_s: start + duration,
                video_duration_s: duration,
                size_bytes: statSync(file).size,
                render_s: (Date.now() - t0) / 1000,
                cached: false,
            }
        })
    })
}

function ffmpegPath(): string {
    return require('ffmpeg-static') as unknown as string
}

/** Grabs frames at the given seconds into a clip, as PNG buffers. */
export async function clipFrames(file: string, atSeconds: number[], width = 960): Promise<Buffer[]> {
    const frames: Buffer[] = []
    for (const t of atSeconds) {
        const out = join(config.clip.cacheDir, `frame-${process.pid}-${Date.now()}.png`)
        await run(ffmpegPath(), ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, out])
        if (existsSync(out)) {
            frames.push(readFileSync(out))
            rmSync(out, { force: true })
        }
    }
    return frames
}
