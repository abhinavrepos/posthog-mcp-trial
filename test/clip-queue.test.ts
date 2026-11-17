import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClipQueue, clipInteger } from '../src/core/clip-queue.ts'
const turn = () => new Promise<void>(r => setImmediate(r))
function fixture(options?: { concurrency?: number; perUser?: number }) {
    const starts: string[] = []
    const controls = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()
    const times: { queuedMs: number; renderMs: number }[] = []
    const queue = createClipQueue<string>(key => {
        starts.push(key)
        return new Promise((resolve, reject) => controls.set(key, { resolve, reject }))
    }, { ...options, timing: t => times.push(t) })
    const finish = async (key: string) => { controls.get(key)!.resolve(key); await turn() }
    return { queue, starts, controls, finish, times }
}
test('five owners start, sixth waits, FIFO resumes and timings are recorded', async () => {
    const f = fixture()
    const work = Array.from({ length: 6 }, (_, i) => f.queue.run(String(i), String(i)))
    await turn()
    assert.deepEqual(f.starts, ['0', '1', '2', '3', '4'])
    assert.deepEqual(f.queue.stats(), { rendering: 5, queued: 1, concurrency: 5 })
    await f.finish('0'); assert.equal(f.starts[5], '5')
    for (let i = 1; i < 6; i++) await f.finish(String(i))
    await Promise.all(work)
    assert.equal(f.times.length, 6)
    assert.ok(f.times.every(t => t.queuedMs >= 0 && t.renderMs >= 0))
})
test('one owner takes two slots; other owners bypass its queued requests', async () => {
    const f = fixture()
    const work = Array.from({ length: 5 }, (_, i) => f.queue.run(`a${i}`, 'a'))
    work.push(f.queue.run('b', 'b'), f.queue.run('c', 'c'), f.queue.run('d', 'd'))
    await turn()
    assert.deepEqual(f.starts, ['a0', 'a1', 'b', 'c', 'd'])
    for (const key of ['a0', 'a1', 'a2', 'a3', 'a4', 'b', 'c', 'd']) await f.finish(key)
    await Promise.all(work)
})
test('identical requests share the exact promise and one render', async () => {
    const f = fixture()
    const a = f.queue.run('same', 'a'); const b = f.queue.run('same', 'b')
    assert.equal(a, b)
    await turn(); assert.deepEqual(f.starts, ['same'])
    assert.equal(f.queue.stats().rendering, 1)
    await f.finish('same'); assert.deepEqual(await Promise.all([a, b]), ['same', 'same'])
})
test('failure frees a slot and propagates only to its own callers', async () => {
    const f = fixture({ concurrency: 1 })
    const a = f.queue.run('bad', 'a'); const shared = f.queue.run('bad', 'b')
    const bad = assert.rejects(a, /broken/); const alsoBad = assert.rejects(shared, /broken/)
    const good = f.queue.run('good', 'b')
    await turn(); f.controls.get('bad')!.reject(Error('broken'))
    await turn(); assert.deepEqual(f.starts, ['bad', 'good'])
    await f.finish('good'); assert.equal(await good, 'good'); await Promise.all([bad, alsoBad])
    assert.deepEqual(f.queue.stats(), { rendering: 0, queued: 0, concurrency: 1 })
})
test('environment concurrency one preserves serial FIFO, including ownerless work', async () => {
    const previous = process.env.LENS_CLIP_CONCURRENCY
    process.env.LENS_CLIP_CONCURRENCY = '1'
    try {
        const f = fixture(); const work = ['a', 'b', 'c'].map(k => f.queue.run(k))
        await turn(); assert.deepEqual(f.starts, ['a'])
        await f.finish('a'); assert.deepEqual(f.starts, ['a', 'b'])
        await f.finish('b'); await f.finish('c'); await Promise.all(work)
    } finally { if (previous === undefined) delete process.env.LENS_CLIP_CONCURRENCY; else process.env.LENS_CLIP_CONCURRENCY = previous }
})
test('settings clamp invalid and out-of-range values', () => {
    assert.equal(clipInteger(undefined, 5, 8), 5)
    assert.equal(clipInteger('oops', 5, 8), 5)
    assert.equal(clipInteger('0', 5, 8), 1)
    assert.equal(clipInteger('999', 5, 8), 8)
})

test('shared admission caps pending flights atomically and still admits duplicates', async () => {
    const f = fixture({ concurrency: 1 })
    const pending = Array.from({ length: 20 }, (_, i) => f.queue.run(String(i)))
    assert.equal(f.queue.run('0'), pending[0])
    await assert.rejects(async () => f.queue.run('overflow'), /clip queue is full/)
    await turn()
    await f.finish('0')
    const replacement = f.queue.run('replacement')
    for (let i = 1; i < 20; i++) await f.finish(String(i))
    await f.finish('replacement')
    await Promise.all([...pending, replacement])
})
