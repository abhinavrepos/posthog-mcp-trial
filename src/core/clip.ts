// Turns a stretch of a session recording into an MP4, using PostHog's own rasterizer (bundled
// into vendor/ by scripts/build-rasterizer.mjs).
//
// Recordings are untrusted content: they are other people's DOM. The replay page therefore runs
// with Chrome's DNS limited to CLIP_ALLOWED_HOSTS, so a recording cannot make the renderer reach
// anything else on this machine's network.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { config, ROOT } from './config.ts'
import { getRecording, getSnapshotsJsonl } from './posthog.ts'

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

function hostResolverRules(): string {
    const allowed = config.clip.allowedHosts
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    // Every name resolves to nothing except the allowlist.
    return ['MAP * ~NOTFOUND', ...allowed.map((h) => `EXCLUDE ${h}`)].join(', ')
}

type Rasterizer = {
    BrowserPool: new () => { launch(): Promise<void>; shutdown(): Promise<void> }
    rasterizeFile: (pool: unknown, html: string, input: string, out: string, opts: Record<string, unknown>) => Promise<{ video_duration_s?: number }>
}

let engine: { r: Rasterizer; pool: InstanceType<Rasterizer['BrowserPool']>; html: string } | undefined

async function getEngine() {
    if (engine) return engine
    const bundle = join(ROOT, 'vendor/rasterizer.cjs')
    if (!existsSync(bundle)) throw new Error('vendor/rasterizer.cjs is missing. Run `pnpm build:rasterizer` first.')
    // The rasterizer reads its settings from the environment when it loads.
    process.env.PUPPETEER_EXECUTABLE_PATH = findChrome()
    process.env.PLAYER_HTML_PATH = join(ROOT, 'vendor/player.html')
    process.env.SITE_URL ||= config.posthog.publicHost
    // No smokescreen proxy here; containment comes from the DNS allowlist below instead.
    process.env.RASTERIZER_USE_PROXY = 'false'
    process.env.CHROME_HOST_RESOLVER_RULES = hostResolverRules()
    process.env.LOG_LEVEL ||= 'warn'
    const r = require(bundle) as Rasterizer
    const pool = new r.BrowserPool()
    await pool.launch()
    engine = { r, pool, html: readFileSync(join(ROOT, 'vendor/player.html'), 'utf8') }
    return engine
}

export async function shutdownClips(): Promise<void> {
    if (engine) await engine.pool.shutdown()
    engine = undefined
}

// One render at a time: each one drives a full Chrome.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn)
    queue = next.catch(() => {})
    return next
}

async function snapshotsFile(sessionId: string): Promise<string> {
    const dir = join(config.clip.cacheDir, 'snapshots')
    mkdirSync(dir, { recursive: true })
    const meta = await getRecording(sessionId)
    // The key includes the end time, so a recording that is still growing gets fetched again.
    const key = `${sessionId}_${Date.parse(meta.end_time) || 0}`.replace(/[^A-Za-z0-9_-]/g, '')
    const file = join(dir, `${key}.jsonl`)
    if (!existsSync(file)) {
        writeFileSync(file + '.tmp', await getSnapshotsJsonl(sessionId))
        renameSync(file + '.tmp', file)
        pruneCache(dir)
    }
    return file
}

/** Deletes the oldest cached snapshot files once the cache passes CLIP_CACHE_MAX_MB. */
function pruneCache(dir: string): void {
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(dir, f), ...statSync(join(dir, f)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = 0
    for (const x of files) {
        total += x.size
        if (total > config.clip.maxCacheMb * 1024 * 1024) rmSync(x.f, { force: true })
    }
}

export function clipName(req: ClipRequest): string {
    const s = Math.max(0, Math.floor(req.startOffsetS))
    const e = s + Math.max(1, Math.round(req.durationS))
    return `${req.sessionId.replace(/[^A-Za-z0-9-]/g, '')}_${s}-${e}.mp4`
}

export async function renderClip(req: ClipRequest): Promise<Clip> {
    const name = clipName(req)
    const outDir = config.clip.outDir
    mkdirSync(outDir, { recursive: true })
    const file = join(outDir, name)
    const start = Math.max(0, Math.floor(req.startOffsetS))
    const end = start + Math.max(1, Math.round(req.durationS))
    if (existsSync(file)) {
        return { session_id: req.sessionId, file, name, start_offset_s: start, end_offset_s: end, video_duration_s: end - start, size_bytes: statSync(file).size, render_s: 0, cached: true }
    }
    return serial(async () => {
        const t0 = Date.now()
        const input = await snapshotsFile(req.sessionId)
        const { r, pool, html } = await getEngine()
        const work = join(config.clip.cacheDir, 'render', name.replace(/\.mp4$/, ''))
        rmSync(work, { recursive: true, force: true })
        const out = await r.rasterizeFile(pool, html, input, work, {
            start_offset_s: start,
            end_offset_s: end,
            playback_speed: 1,
            skip_inactivity: false,
            show_metadata_footer: true,
            recording_fps: 12,
            output_format: 'mp4',
        })
        renameSync(join(work, 'video.mp4'), file)
        rmSync(work, { recursive: true, force: true })
        return {
            session_id: req.sessionId,
            file,
            name,
            start_offset_s: start,
            end_offset_s: end,
            video_duration_s: Number(out.video_duration_s ?? end - start),
            size_bytes: statSync(file).size,
            render_s: (Date.now() - t0) / 1000,
            cached: false,
        }
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
