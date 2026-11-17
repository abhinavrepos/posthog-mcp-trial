import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createClipQueue } from '../src/core/clip-queue.ts'
import type { Clip } from '../src/core/clip.ts'
import type { ReplayJob, ClipRecord } from '../src/service/replays.ts'
const dir = mkdtempSync(join(tmpdir(), 'lens-clip-callers-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', LENS_CLIP_MCP_WAIT_MS: '20' })
const { createReplayWorker, jobView } = await import('../src/service/replays.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { waitForReplayClip } = await import('../src/mcp/replay-clip.ts')
after(() => { db.close(); tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })
const turn = () => new Promise<void>(r => setImmediate(r))
const clip: Clip = { session_id: 'session', name: 'session_0-30.mp4', file: '/unused', start_offset_s: 0, end_offset_s: 30, video_duration_s: 30, size_bytes: 1, render_s: 1, cached: false }

test('replay worker submits concurrently, keeps queued positions, and completes each job once', async () => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ id: String(i), state: 'queued', owner: `person${i}`, session_id: String(i), start_s: 0, length_s: 30, info: {}, created_at: Date.now() } as ReplayJob))
    const queued = [...entries]
    const finish = new Map<string, (clip: Clip) => void>()
    const limiter = createClipQueue<Clip>(key => new Promise(resolve => finish.set(key, resolve)))
    let stored = 0; let audited = 0; let pruned = 0
    const work = createReplayWorker(queued, {
        render: (req, owner, onStart) => limiter.run(req.sessionId, owner, onStart),
        store: () => { stored++; return { holders: ['person'] } as ClipRecord },
        audit: () => { audited++ }, prune: () => { pruned++ },
    })
    work(); work(); await turn()
    assert.deepEqual(entries.map(j => j.state), ['rendering', 'rendering', 'rendering', 'rendering', 'rendering', 'queued', 'queued'])
    assert.equal(jobView(entries[5], queued).position, 1)
    assert.equal(jobView(entries[6], queued).position, 2)
    finish.get('0')!(clip); await turn()
    assert.equal(entries[5].state, 'rendering')
    assert.equal(jobView(entries[6], queued).position, 1)
    for (let i = 1; i < 7; i++) { finish.get(String(i))!(clip); await turn() }
    assert.ok(entries.every(j => j.state === 'done' && j.finished_at))
    assert.equal(queued.length, 0)
    assert.deepEqual([stored, audited, pruned], [7, 7, 7])
})

async function mcp(render: () => Promise<Clip>, record: (clip: Pick<Clip, 'name' | 'session_id' | 'start_offset_s' | 'end_offset_s'>, owner: string) => Promise<void>) {
    const server = new McpServer({ name: 'clip-test', version: '1' })
    registerTools(server, undefined, { who: 'person', email: 'person@example.com', surveyRole: 'none' }, false, { render, record })
    const client = new Client({ name: 'clip-test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    return { call: () => client.callTool({ name: 'get_replay_link', arguments: { session_id: 'session', start_s: 0, duration_s: 30 } }), close: async () => { await client.close(); await server.close() } }
}
test('get_replay_link returns still-rendering URL within budget and records once after completion', async () => {
    let finish!: (clip: Clip) => void
    const rendering = new Promise<Clip>(resolve => { finish = resolve })
    let records = 0
    const session = await mcp(() => rendering, async (c, owner) => { assert.equal(c, clip); assert.equal(owner, 'claude (MCP)'); records++ })
    try {
        const started = Date.now()
        const response = JSON.stringify(await session.call())
        assert.ok(Date.now() - started < 500)
        assert.match(response, /Replay in PostHog/)
        assert.match(response, /MP4 is still rendering and will appear on the clip page/)
        assert.match(response, /replays\?clip=session_0-30.mp4/)
        assert.equal(records, 0)
        finish(clip); await turn(); assert.equal(records, 1)
    } finally { await session.close() }
})
test('get_replay_link fast render returns the existing MP4 line and records once', async () => {
    let records = 0
    const session = await mcp(async () => clip, async () => { records++ })
    try {
        const response = JSON.stringify(await session.call())
        assert.match(response, /MP4 clip, 30 s, on the clip page/)
        assert.doesNotMatch(response, /still rendering/)
        assert.equal(records, 1)
    } finally { await session.close() }
})
test('late render rejection is observed, mapped once, and never recorded', async () => {
    let fail!: (error: Error) => void
    let errors = 0
    const result = await waitForReplayClip({ sessionId: 'session', startOffsetS: 0, durationS: 30 }, 'person', {
        render: () => new Promise((_resolve, reject) => { fail = reject }),
        record: async () => { assert.fail('failed render must not be recorded') },
        backgroundError: () => { errors++ },
    })
    assert.equal(result, undefined)
    fail(Error('late failure')); await turn(); assert.equal(errors, 1)
})

test('web and MCP submissions share the pending cap and overflow maps to busy', async () => {
    const limiter = createClipQueue<Clip>(() => new Promise(() => {}))
    for (let i = 0; i < 20; i++) limiter.run(String(i), String(i))
    const entry = { id: 'overflow', state: 'queued', owner: 'web', session_id: 'web', start_s: 0, length_s: 30, info: {}, created_at: Date.now() } as ReplayJob
    const queue = [entry]
    createReplayWorker(queue, {
        render: req => limiter.run(req.sessionId), store: () => { throw Error('must not store') }, audit: () => {}, prune: () => {},
    })()
    assert.equal(entry.state, 'failed'); assert.match(entry.error!, /clip queue is full/)
    assert.equal(queue.length, 0)
    const {toolError}=await import('../src/mcp/toolerror.ts')
    await assert.rejects(waitForReplayClip({sessionId:'mcp',startOffsetS:0,durationS:30},'mcp',{
        render: req => limiter.run(req.sessionId), record: async () => { assert.fail('must not record') }, backgroundError: () => {},
    }), error => { assert.equal(toolError(error,'get_replay_link','test').kind,'busy'); return true })
})


test('get_replay_link reports the actual fractional MP4 duration and records the clamped range', async () => {
    const clamped = { ...clip, end_offset_s: 2.003, video_duration_s: 2.003 }
    const session = await mcp(async () => clamped, async c => { assert.equal(c.end_offset_s, 2.003) })
    try { assert.match(JSON.stringify(await session.call()), /MP4 clip, 2.003 s/) }
    finally { await session.close() }
})


test('the replay worker publishes the produced duration after a recording-end clamp', async () => {
    const entry = { id: 'clamp', state: 'queued', owner: 'person', session_id: 'session', start_s: 68, length_s: 30, info: {}, created_at: Date.now() } as ReplayJob
    const short = { ...clip, start_offset_s: 68, end_offset_s: 70.003, video_duration_s: 2.003 }
    const queue = [entry]
    createReplayWorker(queue, {
        render: async req => { assert.equal(req.durationS, 30); return short },
        store: c => { assert.equal(c.end_offset_s, 70.003); return { holders: ['person'] } as ClipRecord },
        audit() {}, prune() {},
    })()
    await turn()
    assert.equal(entry.length_s, 2.003); assert.equal(entry.state, 'done')
})
