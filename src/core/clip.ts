// Turns a stretch of a session recording into an MP4, using PostHog's own rasterizer (bundled
// into vendor/ by scripts/build-rasterizer.mjs).
//
// Recordings are untrusted content: they are other people's DOM. The replay page therefore runs
// through an allowlist proxy as well as DNS rules, so literal IPs cannot bypass containment.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { config, ROOT } from './config.ts'
import { startEgress } from './egress.ts'
import { moveFile } from './files.ts'
import { getRecording, getSnapshotsJsonl, PostHogError } from './posthog.ts'

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

async function getEngine() {
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
    const r = require(bundle) as Rasterizer
    const pool = new r.BrowserPool()
    await pool.launch()
    engine = { r, pool, html: readFileSync(join(ROOT, 'vendor/player.html'), 'utf8') }
    return engine
}

export async function shutdownClips(): Promise<void> {
    if (engine) await engine.pool.shutdown()
    engine = undefined
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

// One render at a time: each one drives a full Chrome.
let pending = 0
export const pendingRenders = () => pending
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
    pending++
    const next = queue.then(fn, fn).finally(() => { pending-- })
    queue = next.catch(() => {})
    return next
}

/** The recording's snapshots as a cached JSONL file (also read by replaynet.ts). */
export async function snapshotsFile(sessionId: string): Promise<string> {
    const dir = join(config.clip.cacheDir, 'snapshots')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const meta = await getRecording(sessionId)
    // The key includes the end time, so a recording that is still growing gets fetched again.
    const key = `${sessionId}_${Date.parse(meta.end_time) || 0}`.replace(/[^A-Za-z0-9_-]/g, '')
    const file = join(dir, `${key}.jsonl`)
    if (!existsSync(file)) {
        try {
            await getSnapshotsJsonl(sessionId, file + '.tmp')
            if (statSync(file + '.tmp').size > config.clip.maxCacheMb * 1024 * 1024) throw new PostHogError('Recording too large for snapshot cache', 413)
            renameSync(file + '.tmp', file)
        } finally { rmSync(file + '.tmp', { force: true }) }
    }
    if (statSync(file).size > config.clip.maxCacheMb * 1024 * 1024) {
        rmSync(file, { force: true })
        throw new PostHogError('Recording too large for snapshot cache', 413)
    }
    pruneCache(dir, file)
    return file
}

/** Deletes the oldest cached snapshot files once the cache passes CLIP_CACHE_MAX_MB. */
export function pruneCache(dir: string, protectedFile: string): void {
    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f: join(dir, f), ...statSync(join(dir, f)) }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
    let total = statSync(protectedFile).size
    for (const x of files) {
        if (x.f === protectedFile) continue
        total += x.size
        if (total > config.clip.maxCacheMb * 1024 * 1024) rmSync(x.f, { force: true })
    }
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

export async function renderClip(req: ClipRequest): Promise<Clip> {
    const name = clipName(req)
    const outDir = config.clip.outDir
    mkdirSync(outDir, { recursive: true, mode: 0o700 })
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
        return withRenderWork(work, async () => {
            const out = await r.rasterizeFile(pool, html, input, work, {
                start_offset_s: start,
                end_offset_s: end,
                playback_speed: 1,
                skip_inactivity: false,
                show_metadata_footer: true,
                recording_fps: 12,
                output_format: 'mp4',
            })
            moveFile(join(work, 'video.mp4'), file)
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
