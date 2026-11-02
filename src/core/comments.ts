// Comments pinned to moments of a clip, like subtitles in a film. Whoever watches the clip on the
// clip page sees each comment big over the video at its second. Downloads and share links get a
// copy of the MP4 with the comments burned into the picture, so they travel with the video.
//
// When a comment shows: from its second for its duration (5 s by default), and never past the next
// comment or the end of the clip.
//
// Burned copies are named <clip>.c<hash>.mp4 next to the clip, where the hash covers the comments,
// so a copy is made once per version of the comments and an edit makes a new one. Older copies of
// the same clip are removed when a new one is made, and all of them go with the clip.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { config } from './config.ts'
import { all, one, run } from './db.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)

export const MAX_TEXT = 300
export const MAX_COMMENTS = 100
export const DURATIONS = [3, 5, 8, 12, 20]
export const DEFAULT_DURATION = 5

export interface ClipComment {
    id: number
    clip_name: string
    at_s: number // seconds into the clip
    duration_s: number
    text: string
    author: string
    created_at: string
    updated_at: string
}

export function listComments(clip: string): ClipComment[] {
    return all<ClipComment>('SELECT * FROM clip_comments WHERE clip_name = ? ORDER BY at_s, id', clip)
}

export function commentCounts(): Map<string, number> {
    return new Map(all<{ clip_name: string; n: number }>('SELECT clip_name, COUNT(*) AS n FROM clip_comments GROUP BY clip_name').map((r) => [r.clip_name, r.n]))
}

/** Checks a comment against the clip. Returns the cleaned values, or why it is refused. */
export function checkComment(input: { at_s?: unknown; duration_s?: unknown; text?: unknown }, clipLength: number): { at_s: number; duration_s: number; text: string } | { error: string } {
    const text = String(input.text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    if (!text) return { error: 'Write something first.' }
    if (text.length > MAX_TEXT) return { error: `Keep it under ${MAX_TEXT} characters, so it fits on the video.` }
    const at = Number(input.at_s)
    if (!Number.isFinite(at) || at < 0 || at >= clipLength) return { error: `Pick a moment between 0:00 and the end of the clip.` }
    const dur = input.duration_s === undefined || input.duration_s === '' ? DEFAULT_DURATION : Number(input.duration_s)
    if (!Number.isFinite(dur) || dur < 1 || dur > 30) return { error: 'A comment shows for 1 to 30 seconds.' }
    return { at_s: Math.round(at * 10) / 10, duration_s: Math.round(dur * 10) / 10, text }
}

export function addComment(clip: string, c: { at_s: number; duration_s: number; text: string }, author: string): ClipComment | { error: string } {
    const n = one<{ n: number }>('SELECT COUNT(*) AS n FROM clip_comments WHERE clip_name = ?', clip)!.n
    if (n >= MAX_COMMENTS) return { error: `A clip can have ${MAX_COMMENTS} comments.` }
    const now = new Date().toISOString()
    const r = run('INSERT INTO clip_comments (clip_name, at_s, duration_s, text, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', clip, c.at_s, c.duration_s, c.text, author, now, now)
    return one<ClipComment>('SELECT * FROM clip_comments WHERE id = ?', Number(r.lastInsertRowid))!
}

export function getComment(clip: string, id: number): ClipComment | undefined {
    return one<ClipComment>('SELECT * FROM clip_comments WHERE id = ? AND clip_name = ?', id, clip)
}

export function updateComment(id: number, c: { at_s: number; duration_s: number; text: string }): ClipComment | undefined {
    run('UPDATE clip_comments SET at_s = ?, duration_s = ?, text = ?, updated_at = ? WHERE id = ?', c.at_s, c.duration_s, c.text, new Date().toISOString(), id)
    return one<ClipComment>('SELECT * FROM clip_comments WHERE id = ?', id)
}

export function deleteComment(id: number): void {
    run('DELETE FROM clip_comments WHERE id = ?', id)
}

// ------------------------------------------------------------------ when each comment shows
export interface Cue {
    start: number
    end: number
    text: string
}

/** When each comment is on screen: from its second for its duration, cut at the next comment and at
 * the end of the clip. Comments at the same second show one after the other's slot is cut to zero,
 * so the later one (by id) wins. */
export function cues(comments: Pick<ClipComment, 'at_s' | 'duration_s' | 'text'>[], clipLength: number): Cue[] {
    const sorted = [...comments].sort((a, b) => a.at_s - b.at_s)
    const out: Cue[] = []
    sorted.forEach((c, i) => {
        const next = sorted.slice(i + 1).find((n) => n.at_s > c.at_s)
        const end = Math.min(c.at_s + c.duration_s, next ? next.at_s : Infinity, clipLength)
        const later = sorted[i + 1] && sorted[i + 1].at_s === c.at_s
        if (end > c.at_s && !later) out.push({ start: c.at_s, end, text: c.text })
    })
    return out
}

const stamp = (s: number, sep: '.' | ',', centis = false) => {
    const ms = Math.round(s * 1000)
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    const sec = Math.floor((ms % 60_000) / 1000)
    const frac = centis ? String(Math.floor((ms % 1000) / 10)).padStart(2, '0') : String(ms % 1000).padStart(3, '0')
    return centis ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${frac}` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}${sep}${frac}`
}

/** WebVTT, for browsers that put the video itself in full screen. */
export function toVtt(list: Cue[]): string {
    const safe = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '→')
    return ['WEBVTT', '', ...list.flatMap((c, i) => [String(i + 1), `${stamp(c.start, '.')} --> ${stamp(c.end, '.')} line:85% size:90%`, safe(c.text), ''])].join('\n')
}

/** Comment text as plain ASS text: no override tags, no accidental line-break codes. */
export function assText(t: string): string {
    return t.replace(/\\/g, '∖').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N')
}

/** An ASS subtitle file sized for the video: big white text on a dark box near the bottom. */
export function toAss(list: Cue[], width: number, height: number, font = 'Liberation Sans'): string {
    const size = Math.round(height * 0.052)
    const pad = Math.max(6, Math.round(height * 0.014))
    const mv = Math.round(height * 0.07)
    const mh = Math.round(width * 0.06)
    return [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${width}`,
        `PlayResY: ${height}`,
        'WrapStyle: 0',
        'ScaledBorderAndShadow: yes',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        // BorderStyle 3: an opaque box behind the text, in OutlineColour (&HAABBGGRR, AA 00 = solid).
        `Style: Comment,${font},${size},&H00FFFFFF,&H00FFFFFF,&H33000000,&H33000000,-1,0,0,0,100,100,0,0,3,${pad},0,2,${mh},${mh},${mv},1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        ...list.map((c) => `Dialogue: 0,${stamp(c.start, '.', true)},${stamp(c.end, '.', true)},Comment,,0,0,0,,${assText(c.text)}`),
        '',
    ].join('\n')
}

// ------------------------------------------------------------------ burned copies
const VARIANT = /^(.+_\d+-\d+)\.c([0-9a-f]{12})\.mp4$/
/** The clip a burned copy belongs to, or undefined when the file is not one. */
export const variantOf = (file: string) => {
    const m = VARIANT.exec(file)
    return m ? `${m[1]}.mp4` : undefined
}

export function variantName(clip: string, list: Cue[]): string {
    const hash = createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 12)
    return `${clip.replace(/\.mp4$/, '')}.c${hash}.mp4`
}

export function removeVariants(clip: string, keep?: string): void {
    if (!existsSync(config.clip.outDir)) return
    for (const f of readdirSync(config.clip.outDir)) if (variantOf(f) === clip && f !== keep) rmSync(join(config.clip.outDir, f), { force: true })
}

const FONTS: [string, string][] = [
    ['LiberationSans-Bold.ttf', 'Liberation Sans'],
    ['NotoSans-Bold.ttf', 'Noto Sans'],
    ['DejaVuSans-Bold.ttf', 'DejaVu Sans'],
]
let fontFound: { dir: string; name: string } | null | undefined
/** A bold sans font on this machine (Ubuntu and Amazon Linux keep them in different folders). */
export function findFont(root = '/usr/share/fonts'): { dir: string; name: string } | null {
    if (fontFound !== undefined && root === '/usr/share/fonts') return fontFound
    const dirs: string[] = []
    const walk = (d: string, depth: number) => {
        if (depth > 3 || !existsSync(d)) return
        dirs.push(d)
        for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) walk(join(d, e.name), depth + 1)
    }
    walk(root, 0)
    let found: { dir: string; name: string } | null = null
    for (const [file, name] of FONTS) {
        const dir = dirs.find((d) => existsSync(join(d, file)))
        if (dir) {
            found = { dir, name }
            break
        }
    }
    if (root === '/usr/share/fonts') fontFound = found
    return found
}

const ffmpeg = () => require('ffmpeg-static') as string

/** The width and height of a video, read from ffmpeg's description of it. */
export async function videoSize(file: string): Promise<{ width: number; height: number }> {
    const err: string = await exec(ffmpeg(), ['-hide_banner', '-i', file]).then(
        () => '',
        (e: { stderr?: string }) => String(e.stderr || '')
    )
    const m = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(err)
    return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1280, height: 720 }
}

/** Burns the cues into a copy of `source`, written to `target`. */
export async function burn(source: string, target: string, list: Cue[]): Promise<void> {
    const { width, height } = await videoSize(source)
    const font = findFont()
    const work = join(config.clip.cacheDir, `captions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(work, { recursive: true })
    try {
        writeFileSync(join(work, 'comments.ass'), toAss(list, width, height, font?.name))
        // The filter reads the subtitle file by a plain relative name, so no path needs escaping.
        const filter = `subtitles=comments.ass${font ? `:fontsdir=${font.dir.replace(/[\\:',[\]]/g, '\\$&')}` : ''}`
        const tmp = join(work, 'out.mp4')
        await exec(ffmpeg(), ['-v', 'error', '-y', '-i', source, '-vf', filter, '-map', '0:v:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', tmp], { cwd: work, timeout: 180_000 })
        renameSync(tmp, target)
    } finally {
        rmSync(work, { recursive: true, force: true })
    }
}

const making = new Map<string, Promise<string>>()
/** The clip's file with its comments burned in, made now if needed. Without comments, the clip itself. */
export async function captionedFile(clip: string, clipLength: number): Promise<string> {
    const source = join(config.clip.outDir, clip)
    const list = cues(listComments(clip), clipLength)
    if (!list.length) return source
    const name = variantName(clip, list)
    const target = join(config.clip.outDir, name)
    if (existsSync(target)) return target
    let job = making.get(name)
    if (!job) {
        job = burn(source, target, list).then(() => {
            removeVariants(clip, name)
            return target
        })
        making.set(name, job)
        job.finally(() => making.delete(name)).catch(() => {})
    }
    return job
}
