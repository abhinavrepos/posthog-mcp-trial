import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, mock, test } from 'node:test'

const dir = mkdtempSync(join(process.cwd(), '.growing-replay-'))
Object.assign(process.env, { TRIAGE_ENV_FILE: join(dir, 'none'), TRIAGE_DB: join(dir, 'triage.db'), TASKS_DB: join(dir, 'tasks.db'), CLIP_CACHE_DIR: join(dir, 'cache'), CLIP_OUT_DIR: join(dir, 'clips'), CHROME_HEADLESS_SHELL: '/mock', POSTHOG_HOST: 'http://posthog.invalid', POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_PROJECT_ID: '1' })
const require = createRequire(import.meta.url)
const bundle = require.resolve('../vendor/rasterizer.cjs'), previous = require.cache[bundle]
const start = Date.parse('2026-11-17T10:00:00Z')
let duration = 12, renders = 0
let idle = false
const calls: number[] = []
function movie(seconds: number) {
    const mvhd = Buffer.alloc(32)
    mvhd.writeUInt32BE(32); mvhd.write('mvhd', 4); mvhd.writeUInt32BE(1000, 20); mvhd.writeUInt32BE(Math.round(seconds * 1000), 24)
    const moov = Buffer.alloc(8); moov.writeUInt32BE(40); moov.write('moov', 4)
    return Buffer.concat([moov, mvhd])
}
require.cache[bundle] = { exports: {
    BrowserPool: class { async launch() {} async shutdown() {} },
    async rasterizeFile(_pool: unknown, _html: string, _input: string, work: string, opts: { trim: number }) {
        renders++; calls.push(opts.trim)
        mkdirSync(work, { recursive: true }); writeFileSync(join(work, 'video.mp4'), movie(opts.trim))
        return {}
    },
} } as NodeJS.Module
mock.method(Server.prototype, 'listen', function (this: Server, ...args: any[]) { args.at(-1)(); return this })
mock.method(Server.prototype, 'address', () => ({ port: 1 }))
mock.method(Server.prototype, 'close', function (this: Server, callback: () => void) { callback(); return this })
mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const path = String(url)
    if (path.includes('/@me/')) return Response.json({ email: 'watch@example.com', organizations: [{ id: 'org', membership_level: 1 }] })
    if (path.includes('/query/')) {
        const sql = JSON.parse(String(init?.body)).query.query as string
        return sql.includes('max(timestamp)')
            ? Response.json({ columns: ['last'], results: [[idle ? new Date(start + 70_000).toISOString() : null]] })
            : Response.json({ columns: [], results: [] })
    }
    if (path.includes('session_recordings')) return Response.json({ start_time: new Date(start).toISOString(), end_time: new Date(start + duration * 1000).toISOString(), recording_duration: duration })
    return Response.json({ organization: 'org' })
})
const C = await import('../src/core/clip.ts')
const { handleReplays, storeClip } = await import('../src/service/replays.ts')
const { setPerson } = await import('../src/service/access.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
after(async () => { await C.shutdownClips(); if (previous) require.cache[bundle] = previous; else delete require.cache[bundle]; mock.restoreAll(); tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
function snapshots(sid = 'growing') {
    const cache = join(dir, 'cache', 'snapshots'); mkdirSync(cache, { recursive: true })
    writeFileSync(join(cache, `${sid}_${start + duration * 1000}.jsonl`), '["w",{"timestamp":1}]\n')
}
async function request(path: string, body?: Buffer[]) {
    let status = 0, output = ''
    const req = Object.assign(Readable.from(body ?? []), { method: body ? 'POST' : 'GET', headers: { cookie: 'sessionid=watch-session', 'x-clip-page': '1' } })
    const res = { writeHead(code: number) { status = code }, end(data: string) { output = data } }
    await handleReplays(req as unknown as IncomingMessage, res as ServerResponse, new URL(path, 'http://localhost'))
    return { status, body: JSON.parse(output) }
}
setPerson('watch@example.com', 'watch', 'test')

test('a tail-clamped cached clip is refreshed when the recording grows', async () => {
    snapshots()
    const request = { sessionId: 'growing', startOffsetS: 10, durationS: 10 }
    const short = await C.renderClip(request)
    assert.equal(short.video_duration_s, 2)
    storeClip(short, undefined, 'watch@example.com')
    const captioned = short.file.replace(/\.mp4$/, '.c012345abcdef.mp4')
    writeFileSync(captioned, movie(2))
    assert.equal((await C.renderClip(request)).cached, true, 'an unchanged recording reuses the tail clip')
    assert.equal(renders, 1)
    duration = 30; snapshots()
    const grown = await C.renderClip(request)
    assert.equal(grown.video_duration_s, 10)
    assert.equal(grown.end_offset_s, 20)
    assert.equal(grown.cached, false)
    storeClip(grown, undefined, 'watch@example.com')
    assert.equal(existsSync(captioned), false, 'the previous short captioned copy must not survive replacement')
    assert.deepEqual(calls, [2, 10])
    assert.ok(existsSync(grown.file))
    assert.equal(JSON.parse(readFileSync(grown.file + '.json', 'utf8')).end, 20)
    assert.equal((await C.renderClip(request)).cached, true)
    assert.equal(renders, 2)
})

test('the web clip API accepts an idle stretch after the last snapshot', async () => {
    const sid = '01a1eb05-cda6-7bc7-9e37-47ae27245aff'
    idle = true; duration = 1; snapshots(sid)
    const result = await request('/replays/api/clips', [Buffer.from(JSON.stringify({ input: sid, start: '0:05', length: 10 }))])
    assert.equal(result.status, 202, JSON.stringify(result.body))
    let job = result.body
    for (let i = 0; i < 100 && ['queued', 'rendering'].includes(job.state); i++) {
        await new Promise<void>(resolve => setImmediate(resolve))
        job = (await request(`/replays/api/jobs/${job.id}`)).body
    }
    assert.equal(job.state, 'done', JSON.stringify(job))
    assert.equal(job.clip.start_s, 5)
    assert.equal(job.clip.end_s, 15)
    const invalid = await request('/replays/api/clips', [Buffer.from(JSON.stringify({ input: sid, start: '1:15', length: 10 }))])
    assert.equal(invalid.status, 400)
})

test('clip comment JSON preserves a Unicode character split across HTTP chunks', async () => {
    const name = 'unicode_0-10.mp4'
    storeClip({ name, session_id: 'unicode', start_offset_s: 0, end_offset_s: 10 }, undefined, 'watch@example.com')
    const text = 'José 李明华 reviewed this'
    const bytes = Buffer.from(JSON.stringify({ at_s: 0, duration_s: 5, text }))
    const split = bytes.indexOf(Buffer.from('é')) + 1
    const result = await request(`/replays/api/clips/${name}/comments`, [bytes.subarray(0, split), bytes.subarray(split)])
    assert.equal(result.status, 200)
    assert.equal(result.body.comments[0].text, text)
})
