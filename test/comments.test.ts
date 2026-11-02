import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

// A throwaway database and clips folder. These have to be set before the modules load.
const dir = mkdtempSync(join(tmpdir(), 'triage-comments-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.CLIP_OUT_DIR = join(dir, 'clips')
process.env.CLIP_CACHE_DIR = join(dir, 'cache')
mkdirSync(process.env.CLIP_OUT_DIR)
const { db } = await import('../src/core/db.ts')
const { config } = await import('../src/core/config.ts')
const replays = await import('../src/service/replays.ts')
const cm = await import('../src/core/comments.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string
const clipFile = (name: string) => join(config.clip.outDir, name)

describe('checking a comment', () => {
    test('cleans the text and fills the default duration', () => {
        assert.deepEqual(cm.checkComment({ at_s: 4.26, text: '  Watch the total\r\n\n\n\nhere \u0007 ' }, 30), { at_s: 4.3, duration_s: cm.DEFAULT_DURATION, text: 'Watch the total\n\nhere' })
        assert.deepEqual(cm.checkComment({ at_s: 0, duration_s: 12, text: 'x' }, 30), { at_s: 0, duration_s: 12, text: 'x' })
    })
    test('refuses what cannot show', () => {
        for (const bad of [
            { at_s: 1, text: '   ' },
            { at_s: 1, text: 'x'.repeat(cm.MAX_TEXT + 1) },
            { at_s: -1, text: 'x' },
            { at_s: 30, text: 'x' }, // the clip is 30 s: 30 is past the end
            { at_s: 'abc', text: 'x' },
            { at_s: 1, duration_s: 0.5, text: 'x' },
            { at_s: 1, duration_s: 31, text: 'x' },
        ]) {
            assert.ok('error' in cm.checkComment(bad, 30), JSON.stringify(bad))
        }
    })
})

describe('when comments show', () => {
    const c = (at_s: number, text: string, duration_s = 5) => ({ at_s, duration_s, text })
    test('from their second, for their duration, cut at the next comment and the end', () => {
        assert.deepEqual(cm.cues([c(10, 'b'), c(2, 'a'), c(28, 'c')], 30), [
            { start: 2, end: 7, text: 'a' },
            { start: 10, end: 15, text: 'b' },
            { start: 28, end: 30, text: 'c' },
        ])
        assert.deepEqual(cm.cues([c(2, 'a', 12), c(6, 'b')], 30), [
            { start: 2, end: 6, text: 'a' },
            { start: 6, end: 11, text: 'b' },
        ])
    })
    test('two comments at the same second: the later one shows', () => {
        assert.deepEqual(cm.cues([c(3, 'first'), c(3, 'second')], 30), [{ start: 3, end: 8, text: 'second' }])
    })
    test('subtitle files', () => {
        const list = [{ start: 2.5, end: 7, text: 'Look <here> & {there}\nthen \\N click' }]
        const vtt = cm.toVtt(list)
        assert.match(vtt, /^WEBVTT\n\n1\n00:00:02\.500 --> 00:00:07\.000/)
        assert.match(vtt, /Look &lt;here&gt; &amp; \{there\}/)
        const ass = cm.toAss(list, 1280, 720, 'Liberation Sans')
        assert.match(ass, /PlayResX: 1280\nPlayResY: 720/)
        assert.match(ass, /Style: Comment,Liberation Sans,37,/)
        // No override tags or line-break codes can come from the text, but its own line breaks stay.
        assert.match(ass, /Dialogue: 0,0:00:02\.50,0:00:07\.00,Comment,,0,0,0,,Look <here> & \(there\)\\Nthen ∖N click$/m)
    })
})

describe('comments on a stored clip', () => {
    const name = '01a00000-0000-7000-8000-000000000001_10-40.mp4'
    test('add, list, edit and delete; they go with the clip', () => {
        writeFileSync(clipFile(name), Buffer.alloc(1024))
        replays.storeClip({ name, session_id: '01a00000-0000-7000-8000-000000000001', start_offset_s: 10, end_offset_s: 40 }, undefined, 'a@x.example')
        const one = cm.addComment(name, { at_s: 4, duration_s: 5, text: 'First' }, 'a@x.example')
        assert.ok(!('error' in one))
        cm.addComment(name, { at_s: 1, duration_s: 5, text: 'Earlier' }, 'b@x.example')
        assert.deepEqual(cm.listComments(name).map((x) => [x.at_s, x.text, x.author]), [[1, 'Earlier', 'b@x.example'], [4, 'First', 'a@x.example']])
        assert.equal(cm.commentCounts().get(name), 2)
        const edited = cm.updateComment((one as { id: number }).id, { at_s: 6, duration_s: 8, text: 'Moved' })!
        assert.deepEqual([edited.at_s, edited.duration_s, edited.text], [6, 8, 'Moved'])
        assert.equal(cm.getComment('other.mp4', edited.id), undefined, 'a comment belongs to its clip')
        cm.deleteComment(edited.id)
        assert.equal(cm.listComments(name).length, 1)
        // Deleting the clip deletes its comments and its burned copies.
        const copy = `${name.replace(/\.mp4$/, '')}.c0123456789ab.mp4`
        writeFileSync(clipFile(copy), Buffer.alloc(10))
        replays.deleteClip(name)
        assert.equal(cm.listComments(name).length, 0)
        assert.ok(!existsSync(clipFile(copy)))
    })

    test('a limit per clip', () => {
        const n2 = '01a00000-0000-7000-8000-000000000002_0-30.mp4'
        writeFileSync(clipFile(n2), Buffer.alloc(1024))
        replays.storeClip({ name: n2, session_id: '01a00000-0000-7000-8000-000000000002', start_offset_s: 0, end_offset_s: 30 }, undefined, 'a@x.example')
        for (let i = 0; i < cm.MAX_COMMENTS; i++) cm.addComment(n2, { at_s: i % 30, duration_s: 3, text: String(i) }, 'a@x.example')
        assert.ok('error' in cm.addComment(n2, { at_s: 1, duration_s: 3, text: 'one too many' }, 'a@x.example'))
        replays.deleteClip(n2)
    })

    test('old-clip cleanup keeps burned copies of clips that still exist', () => {
        const n3 = '01a00000-0000-7000-8000-000000000003_0-30.mp4'
        writeFileSync(clipFile(n3), Buffer.alloc(1024))
        replays.storeClip({ name: n3, session_id: '01a00000-0000-7000-8000-000000000003', start_offset_s: 0, end_offset_s: 30 }, undefined, 'a@x.example')
        replays.setSaved(n3, 'a@x.example', true)
        const copy = `${n3.replace(/\.mp4$/, '')}.cabcdefabcdef.mp4`
        const orphan = '01a00000-0000-7000-8000-000000000009_0-30.cabcdefabcdef.mp4'
        for (const f of [copy, orphan]) {
            writeFileSync(clipFile(f), Buffer.alloc(10))
            const old = new Date(Date.now() - 400 * 86_400_000)
            utimesSync(clipFile(f), old, old)
        }
        replays.pruneOldClips()
        assert.ok(existsSync(clipFile(copy)), 'the saved clip keeps its burned copy')
        assert.ok(!existsSync(clipFile(orphan)), 'a copy whose clip is gone is cleaned up')
        assert.equal(cm.variantOf(copy), n3)
        assert.equal(cm.variantOf(n3), undefined)
    })
})

describe('burning comments into the video', () => {
    // A plain grey test video, so no recording is needed (or looked at).
    const name = '01a00000-0000-7000-8000-00000000000b_0-6.mp4'
    const frame = (file: string, at: number) => execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
    const diff = (a: Buffer, b: Buffer) => {
        let n = 0
        for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 40) n++
        return n / a.length
    }

    test('a font is found on this machine', () => {
        const f = cm.findFont()
        assert.ok(f, 'fonts are installed with Chrome, see deploy/install.sh')
    })

    test('the comment is in the picture during its seconds, and only then', async () => {
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=640x360:d=6:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipFile(name)])
        replays.storeClip({ name, session_id: '01a00000-0000-7000-8000-00000000000b', start_offset_s: 0, end_offset_s: 6 }, undefined, 'a@x.example')
        assert.equal(await cm.captionedFile(name, 6), clipFile(name), 'no comments: the clip itself')
        cm.addComment(name, { at_s: 1, duration_s: 2, text: 'Look at the total here' }, 'a@x.example')
        const out = await cm.captionedFile(name, 6)
        assert.notEqual(out, clipFile(name))
        assert.match(out, /\.c[0-9a-f]{12}\.mp4$/)
        const changed = diff(frame(clipFile(name), 2), frame(out, 2))
        const before = diff(frame(clipFile(name), 0.5), frame(out, 0.5))
        const afterEnd = diff(frame(clipFile(name), 4.5), frame(out, 4.5))
        assert.ok(changed > 0.005, `text and its box cover part of the frame at 2 s (${changed})`)
        assert.ok(before < 0.001 && afterEnd < 0.001, `nothing is drawn before or after (${before}, ${afterEnd})`)
        // The same comments reuse the copy; an edit makes a new one and removes the old.
        assert.equal(await cm.captionedFile(name, 6), out)
        const id = cm.listComments(name)[0].id
        cm.updateComment(id, { at_s: 3, duration_s: 2, text: 'Now look at the export button' })
        const out2 = await cm.captionedFile(name, 6)
        assert.notEqual(out2, out)
        assert.ok(!existsSync(out), 'the old copy is gone')
        assert.ok(diff(frame(clipFile(name), 2), frame(out2, 2)) < 0.001, 'moved: nothing at 2 s any more')
        assert.ok(diff(frame(clipFile(name), 4), frame(out2, 4)) > 0.005, 'moved: shown at 4 s')
        assert.deepEqual(readdirSync(config.clip.outDir).filter((f) => f.startsWith(name.replace(/\.mp4$/, ''))).sort(), [name, out2.split('/').pop()].sort())
    })
})
