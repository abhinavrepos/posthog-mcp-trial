import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'
import { runInNewContext } from 'node:vm'

const dir = mkdtempSync(join(tmpdir(), 'lens-clip-render-'))
Object.assign(process.env, { TRIAGE_ENV_FILE: join(dir, 'none'), CLIP_CACHE_DIR: join(dir, 'cache'), CLIP_OUT_DIR: join(dir, 'clips'), CHROME_HEADLESS_SHELL: '/mock', POSTHOG_HOST: 'https://posthog.test', POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_PROJECT_ID: '1' })
const truth = JSON.parse(readFileSync('test/fixtures/replay/clips.json', 'utf8'))
const require = createRequire(import.meta.url)
const bundle = require.resolve('../vendor/rasterizer.cjs')
const original = require.cache[bundle], originalFetch = globalThis.fetch
const calls: Record<string, any>[] = []
let renderedDuration: number | undefined
// A movie header is enough for the production duration reader; no browser or video content is returned.
function movie(seconds: number) {
    const mvhd = Buffer.alloc(32)
    mvhd.writeUInt32BE(32); mvhd.write('mvhd', 4); mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(Math.round(seconds * 1000), 24)
    const moov = Buffer.alloc(8); moov.writeUInt32BE(40); moov.write('moov', 4)
    return Buffer.concat([moov, mvhd])
}
require.cache[bundle] = { exports: {
    BrowserPool: class { async launch() {} async shutdown() {} },
    async rasterizeFile(_pool: unknown, _html: string, input: string, work: string, opts: Record<string, any>) {
        assert.ok(readFileSync(input, 'utf8').includes('timestamp'))
        calls.push(opts)
        mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'video.mp4'), movie(renderedDuration ?? opts.trim ?? 14.3))
        return { video_duration_s: 999 }
    },
} } as NodeJS.Module
// The egress proxy is unused by the fake browser; the sandbox forbids listening sockets.
mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) { args.at(-1)(); return this })
mock.method(Server.prototype, 'address', () => ({ port: 1 }))
mock.method(Server.prototype, 'close', function (this: Server, callback: () => void) { callback(); return this })
const C = await import('../src/core/clip.ts')
const { mp4Duration } = await import('../src/core/mp4.ts')
globalThis.fetch = async () => Response.json({ start_time: '2026-01-01T00:00:00Z', end_time: '2026-01-01T00:01:10.003Z', recording_duration: 70.003 })
after(async () => { await C.shutdownClips(); if (original) require.cache[bundle] = original; else delete require.cache[bundle]; globalThis.fetch = originalFetch; mock.restoreAll(); rmSync(dir, { recursive: true, force: true }) })

for (const persona of ['idle', 'error-looping']) test(`${persona}: real snapshots render requested duration, clamp end and retain actual cached metadata`, async () => {
    const sid = truth[persona].session_id
    const snapshots = join(dir, 'cache', 'snapshots'); mkdirSync(snapshots, { recursive: true })
    copyFileSync(`test/fixtures/replay/${persona}.jsonl`, join(snapshots, `${sid}_${Date.parse('2026-01-01T00:01:10.003Z')}.jsonl`))
    for (const [start, length, expected] of [[0, 10, 10], [0, 30, 30], [68, 30, 2.003]]) {
        const req = { sessionId: sid, startOffsetS: start, durationS: length }
        const clip = await C.renderClip(req)
        assert.equal(calls.at(-1)!.trim, expected)
        assert.equal(calls.at(-1)!.end_offset_s, start + expected)
        assert.equal(calls.at(-1)!.skip_inactivity, false)
        assert.equal(clip.video_duration_s, mp4Duration(clip.file))
        assert.equal(clip.video_duration_s, expected)
        assert.equal(clip.end_offset_s, start + expected)
        const count = calls.length
        const cached = await C.renderClip(req)
        assert.equal(cached.cached, true); assert.equal(cached.end_offset_s, clip.end_offset_s); assert.equal(cached.video_duration_s, expected)
        assert.equal(calls.length, count)
    }
    await assert.rejects(C.renderClip({ sessionId: sid, startOffsetS: 71, durationS: 10 }), /beyond recording end/)
})

test('old cached renders are replaced, and cache duration is read from the MP4', async () => {
    const sid = truth.idle.session_id, req = { sessionId: sid, startOffsetS: 5, durationS: 10 }
    const file = join(dir, 'clips', C.clipName(req))
    writeFileSync(file, movie(14.3))
    assert.equal((await C.renderClip(req)).cached, false)
    writeFileSync(file, movie(9.75))
    const cached = await C.renderClip(req)
    assert.equal(cached.video_duration_s, 9.75); assert.equal(cached.end_offset_s, 14.75)
})

test('snapshot age expires below budget, including abandoned partial downloads', () => {
    const cache = join(dir, 'age'); mkdirSync(cache)
    for (const name of ['old.jsonl', 'old.jsonl.tmp', 'recent.jsonl']) writeFileSync(join(cache, name), 'x')
    const old = new Date(Date.now() - 8 * 86_400_000)
    for (const name of ['old.jsonl', 'old.jsonl.tmp']) utimesSync(join(cache, name), old, old)
    C.pruneCache(cache)
    assert.equal(existsSync(join(cache, 'old.jsonl')), false)
    assert.equal(existsSync(join(cache, 'old.jsonl.tmp')), false)
    assert.ok(existsSync(join(cache, 'recent.jsonl')))
})

test('player clock covers quiet real recordings and stops without another event', () => {
    const html = readFileSync('vendor/player.html', 'utf8')
    const source = html.match(/var Jo=(class\{.*?\});H\(\);H\(\);var Vt/s)![1]
    for (const persona of ['idle', 'error-looping']) {
        const events = readFileSync(`test/fixtures/replay/${persona}.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line)[1]).sort((a, b) => a.timestamp - b.timestamp)
        let now = 0, frame!: () => void, ended = 0, played = 0
        const handlers: Record<string, (arg?: unknown) => void> = {}
        const first = events[0].timestamp
        const win = { windowId: 1, firstTimestamp: first, lastTimestamp: events.at(-1).timestamp,
            replayer: { on: (event: string, callback: () => void) => { handlers[event] = callback }, pause() {}, play() { played++ }, getCurrentTime: () => 0 } }
        const Player = runInNewContext(`(${source})`, { performance: { now: () => now }, window: {}, sg: 'timeline', requestAnimationFrame: (cb: () => void) => { frame = cb } })
        const player = new Player([win], [], first, { skipInactivity: false, endOffsetS: 30 }, { publishFrameTimeline() {}, signalEnded() { ended++ } })
        player.start(0); handlers.finish()
        assert.equal(ended, 0, 'last event must leave the still page running')
        now = 10_000; frame(); assert.equal(player.currentSessionMs(), 10_000); assert.equal(ended, 0)
        now = 30_000; frame(); assert.equal(ended, 1); assert.equal(played, 1)
    }
})

test('retention revokes a snapshot fetch already waiting for metadata', async () => {
    const prior = globalThis.fetch
    let release!: () => void
    globalThis.fetch = async () => { await new Promise<void>(resolve => { release = resolve }); return Response.json({ end_time: '2026-01-01' }) }
    try {
        const pending = C.snapshotsFile('deleted-in-flight')
        C.deleteReplayCache('deleted-in-flight')
        const rejected = assert.rejects(pending, /Recording deleted/)
        release(); await rejected
        await assert.rejects(C.snapshotsFile('deleted-in-flight'), /Recording deleted/)
    } finally { globalThis.fetch = prior }
})


test('a short or overshooting renderer result is rejected instead of publishing false metadata', async () => {
    const req = { sessionId: truth.idle.session_id, startOffsetS: 8, durationS: 10 }
    try {
        for (const seconds of [0.4, 14.3]) {
            renderedDuration = seconds
            await assert.rejects(C.renderClip(req), /duration does not match/)
            assert.equal(existsSync(join(dir, 'clips', C.clipName(req))), false)
        }
    } finally { renderedDuration = undefined }
})
