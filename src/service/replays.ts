// The replay clip page: paste a PostHog replay link, pick a start and a length, get an MP4.
//
// Access uses the PostHog login. Browsers send cookies to every port of a host, so a person who
// is logged in to PostHog on this host is logged in here too. The service checks the session with
// PostHog itself, and only people who can open the project can make, watch or download clips.
// Every action goes to logs/audit.jsonl. Old clips are deleted after CLIP_RETENTION_DAYS.
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { renderClip } from '../core/clip.ts'
import { config, ROOT } from '../core/config.ts'
import { clipUrl } from '../core/links.ts'
import { replayUrl } from '../core/posthog.ts'
import { recordingInfo, type RecordingInfo } from '../core/recording-info.ts'
import { downloadName, formatClock, HourlyLimit, parseReplayInput, parseStartTime } from '../core/replay-input.ts'

const RETENTION_DAYS = Number(process.env.CLIP_RETENTION_DAYS || 30)
const PER_HOUR = Number(process.env.CLIPS_PER_HOUR || 20)
const MAX_QUEUE = 20
const LENGTHS = [10, 20, 30, 45, 60, 90, 120]
const INDEX = join(ROOT, 'run/replay-clips.json')
const AUDIT = join(ROOT, 'logs/audit.jsonl')
mkdirSync(join(ROOT, 'run'), { recursive: true })
mkdirSync(join(ROOT, 'logs'), { recursive: true })

export interface Viewer {
    email: string
    name: string
}

// ------------------------------------------------------------------ access
const authCache = new Map<string, { at: number; viewer?: Viewer }>()

function cookie(req: IncomingMessage, name: string): string | undefined {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const [k, ...v] = part.trim().split('=')
        if (k === name) return decodeURIComponent(v.join('='))
    }
    return undefined
}

/** The PostHog user behind this request, if their session can open our project. */
export async function posthogViewer(req: IncomingMessage): Promise<Viewer | undefined> {
    const session = cookie(req, 'sessionid')
    if (!session || !/^[A-Za-z0-9:._-]{8,200}$/.test(session)) return undefined
    const key = createHash('sha256').update(session).digest('hex')
    const hit = authCache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit.viewer
    let viewer: Viewer | undefined
    try {
        const headers = { cookie: `sessionid=${session}`, accept: 'application/json' }
        const [me, project] = await Promise.all([
            fetch(`${config.posthog.host}/api/users/@me/`, { headers, signal: AbortSignal.timeout(10_000) }),
            fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/`, { headers, signal: AbortSignal.timeout(10_000) }),
        ])
        if (me.ok && project.ok) {
            const u = (await me.json()) as { email: string; first_name?: string }
            viewer = { email: u.email, name: u.first_name || u.email }
        }
    } catch {
        viewer = undefined
    }
    authCache.set(key, { at: Date.now(), viewer })
    if (authCache.size > 1000) authCache.clear()
    return viewer
}

export function audit(who: string, action: string, details: Record<string, unknown> = {}): void {
    try {
        appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), who, action, ...details }) + '\n')
    } catch {}
}

// ------------------------------------------------------------------ clip index
export interface ClipRecord {
    name: string // file in clips/
    session_id: string
    start_s: number
    end_s: number
    client?: string
    user?: string
    recording_start?: string
    download_name: string
    created_by: string
    created_at: string
}

function loadIndex(): ClipRecord[] {
    try {
        return JSON.parse(readFileSync(INDEX, 'utf8')) as ClipRecord[]
    } catch {
        return []
    }
}
let index = loadIndex()
const saveIndex = () => writeFileSync(INDEX, JSON.stringify(index, null, 2))

/** Deletes clips older than CLIP_RETENTION_DAYS, both files and index entries. */
export function pruneOldClips(now = Date.now()): number {
    const cutoff = now - RETENTION_DAYS * 86_400_000
    let removed = 0
    if (existsSync(config.clip.outDir)) {
        for (const f of readdirSync(config.clip.outDir)) {
            const p = join(config.clip.outDir, f)
            if (f.endsWith('.mp4') && statSync(p).mtimeMs < cutoff) {
                rmSync(p, { force: true })
                removed++
            }
        }
    }
    const before = index.length
    index = index.filter((c) => existsSync(join(config.clip.outDir, c.name)))
    if (index.length !== before) saveIndex()
    if (removed) audit('system', 'clips.pruned', { removed, retention_days: RETENTION_DAYS })
    return removed
}

// ------------------------------------------------------------------ jobs
interface Job {
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
const jobs = new Map<string, Job>()
const queue: Job[] = []
let busy = false
const limit = new HourlyLimit(PER_HOUR)

async function work() {
    if (busy) return
    busy = true
    try {
        for (let job = queue.shift(); job; job = queue.shift()) {
            job.state = 'rendering'
            job.started_at = Date.now()
            try {
                const clip = await renderClip({ sessionId: job.session_id, startOffsetS: job.start_s, durationS: job.length_s })
                const record: ClipRecord = {
                    name: clip.name,
                    session_id: job.session_id,
                    start_s: clip.start_offset_s,
                    end_s: clip.end_offset_s,
                    client: job.info.client,
                    user: job.info.user,
                    recording_start: job.info.start,
                    download_name: downloadName({ client: job.info.client, user: job.info.user, recordingStart: job.info.start, startS: clip.start_offset_s, endS: clip.end_offset_s }),
                    created_by: job.owner,
                    created_at: new Date().toISOString(),
                }
                index = [record, ...index.filter((c) => c.name !== record.name)].slice(0, 500)
                saveIndex()
                job.clip = record
                job.state = 'done'
                audit(job.owner, 'clip.created', { session_id: job.session_id, clip: clip.name, cached: clip.cached, render_s: clip.render_s })
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
        }
    } finally {
        busy = false
    }
}

function jobView(job: Job) {
    return {
        id: job.id,
        state: job.state,
        position: job.state === 'queued' ? queue.indexOf(job) + 1 : 0,
        error: job.error,
        elapsed_s: Math.round(((job.finished_at || Date.now()) - (job.started_at || job.created_at)) / 1000),
        clip: job.clip ? clipView(job.clip) : undefined,
    }
}

function clipView(c: ClipRecord) {
    return {
        ...c,
        range: `${formatClock(c.start_s)}–${formatClock(c.end_s)}`,
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
    let data = ''
    for await (const c of req) {
        data += c
        if (data.length > 20_000) throw new Error('body too large')
    }
    return JSON.parse(data || '{}')
}

/** Streams an MP4 with Range support, inline or as a download. */
export function streamMp4(req: IncomingMessage, res: ServerResponse, file: string, opts: { download?: string; cache?: string } = {}) {
    const size = statSync(file).size
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
        res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) })
        return createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) })
    createReadStream(file).pipe(res)
}

const SAFE_NAME = /^[A-Za-z0-9-]+_\d+-\d+\.mp4$/

// ------------------------------------------------------------------ routes
/** Handles /replays*. Returns false when the path is not ours. */
export async function handleReplays(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname
    if (!p.startsWith('/replays')) return false

    const viewer = await posthogViewer(req)
    if (p === '/replays' || p === '/replays/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(viewer ? pageHtml(viewer) : loginHtml())
        return true
    }
    if (!viewer) {
        json(res, 401, { error: 'Log in to PostHog first.' })
        return true
    }

    // Cross-site forms cannot set custom headers, so this blocks CSRF on the JSON endpoints.
    const fromPage = req.headers['x-clip-page'] === '1'
    if (req.method === 'POST' && !fromPage) {
        json(res, 403, { error: 'Missing page header.' })
        return true
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
        if (queue.length >= MAX_QUEUE) {
            json(res, 429, { error: 'The clip queue is full. Try again in a minute.' })
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
            json(res, 400, { error: `The recording is only ${formatClock(info.duration_s)} long.` })
            return true
        }
        const job: Job = { id: randomUUID(), state: 'queued', owner: viewer.email, session_id: input.sessionId, start_s: Math.floor(start), length_s: Math.max(3, Math.min(length, Math.ceil(info.duration_s - start))), info, created_at: Date.now() }
        jobs.set(job.id, job)
        queue.push(job)
        audit(viewer.email, 'clip.requested', { session_id: job.session_id, start_s: job.start_s, length_s: job.length_s })
        void work()
        json(res, 202, jobView(job))
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
        json(res, 200, { clips: index.slice(0, 50).map(clipView), retention_days: RETENTION_DAYS })
        return true
    }

    m = /^\/replays\/api\/share\/([^/]+)$/.exec(p)
    if (m && req.method === 'POST') {
        const name = decodeURIComponent(m[1])
        if (!SAFE_NAME.test(name) || !index.some((c) => c.name === name)) {
            json(res, 404, { error: 'No such clip.' })
            return true
        }
        audit(viewer.email, 'clip.link_shared', { clip: name })
        json(res, 200, { url: clipUrl(name), expires_hours: config.service.clipLinkTtlHours })
        return true
    }

    m = /^\/replays\/(video|download)\/([^/]+)$/.exec(p)
    if (m && req.method === 'GET') {
        const name = decodeURIComponent(m[2])
        const record = index.find((c) => c.name === name)
        const file = join(config.clip.outDir, name)
        if (!SAFE_NAME.test(name) || !record || !existsSync(file)) {
            json(res, 404, { error: 'No such clip.' })
            return true
        }
        if (m[1] === 'download') audit(viewer.email, 'clip.downloaded', { clip: name })
        else if (!req.headers.range || /^bytes=0-/.test(String(req.headers.range))) audit(viewer.email, 'clip.viewed', { clip: name })
        streamMp4(req, res, file, { download: m[1] === 'download' ? record.download_name : undefined, cache: 'private, no-store' })
        return true
    }

    json(res, 404, { error: 'Not found.' })
    return true
}

// ------------------------------------------------------------------ pages
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `:root{--bg:#f5f6f8;--card:#fff;--ink:#1c2230;--muted:#636b7c;--line:#e0e3ea;--accent:#1d4ed8;--accent-ink:#fff;--err:#b42318;--ok:#067647;--chip:#eef2ff}
@media (prefers-color-scheme:dark){:root{--bg:#12151c;--card:#1b1f29;--ink:#e7e9ee;--muted:#9aa2b2;--line:#2c3240;--accent:#6b8afd;--accent-ink:#0b1020;--err:#f97066;--ok:#47cd89;--chip:#252c3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
header b{font-size:16px}.muted{color:var(--muted)}.small{font-size:13px}main{max-width:980px;margin:0 auto;padding:20px 16px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 12px}label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
input,select{width:100%;font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:7px;padding:9px 11px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}.row>div{flex:1;min-width:140px}
button,.btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-weight:600;border-radius:7px;padding:9px 14px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:default}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:6px 0 12px}.facts div{background:var(--bg);border-radius:7px;padding:8px 10px}
.facts b{overflow-wrap:anywhere}.facts span{display:block;font-size:12px;color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{text-align:left;border:1px solid var(--line);background:var(--chip);color:var(--ink);font-weight:500;padding:5px 9px;border-radius:999px;font-size:13px}
.chip.error{border-color:var(--err)}.chip .t{font-variant-numeric:tabular-nums;color:var(--muted);margin-right:4px}
.err{color:var(--err)}.ok{color:var(--ok)}video{width:100%;border-radius:8px;background:#000;margin:8px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.table-wrap{overflow-x:auto}.hidden{display:none}code{background:var(--bg);padding:1px 5px;border-radius:4px}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s 1s linear infinite;display:inline-block}@keyframes s{to{transform:rotate(1turn)}}`

function loginHtml(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay clips</title><style>${CSS}</style></head>
<body><header><b>Replay clips</b></header><main><div class="card"><h2>Log in to PostHog first</h2>
<p>Replays can show client data, so this page uses your PostHog login. Log in to PostHog in this browser, then come back here.</p>
<p><a class="btn" href="${esc(config.posthog.publicHost)}/login?next=/" target="_blank" rel="noopener">Open PostHog login</a> <button class="ghost" onclick="location.reload()">I've logged in</button></p>
<p class="muted small">PostHog and this page must be opened on the same host name for the login to carry over.</p></div></main></body></html>`
}

function pageHtml(v: Viewer): string {
    const bookmarklet = `javascript:(()=>{window.open(${JSON.stringify(config.service.publicUrl + '/replays?url=')}+encodeURIComponent(location.href))})()`
    const boot = JSON.stringify({ lengths: LENGTHS, ttl: config.service.clipLinkTtlHours, retention: RETENTION_DAYS, perHour: PER_HOUR }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Replay clips</title><style>${CSS}</style></head>
<body><header><b>Replay clips</b><span class="muted small">${esc(v.email)}</span></header><main>

<div class="card"><h2>1. Which replay?</h2>
<label for="input">PostHog replay link or session id</label>
<div class="row"><div style="flex:4"><input id="input" placeholder="${esc(config.posthog.publicHost)}/project/${esc(config.posthog.projectId)}/replay/…" autocomplete="off"></div>
<div style="flex:0"><button id="check">Check</button></div></div>
<p id="inspect-msg" class="small"></p>
<div id="info" class="hidden">
<div class="facts"><div><span>Client</span><b id="f-client"></b></div><div><span>User</span><b id="f-user"></b></div><div><span>Recorded</span><b id="f-when"></b></div><div><span>Length</span><b id="f-len"></b></div></div>
<label>Key moments (click one to start the clip just before it)</label><div id="moments" class="chips"></div>
<p class="small muted" id="pages"></p></div></div>

<div class="card" id="make" aria-disabled="true"><h2>2. Make the clip</h2>
<div class="row"><div><label for="start">Start at (m:ss)</label><input id="start" value="0:00"></div>
<div><label for="length">Length</label><select id="length"></select></div>
<div style="flex:0"><button id="go" disabled>Make clip</button></div></div>
<p id="job-msg" class="small"></p>
<div id="result" class="hidden"><video id="video" controls preload="metadata"></video>
<div class="row" style="align-items:center"><a class="btn" id="dl">Download MP4</a><button class="ghost" id="share">Copy share link</button><a class="btn ghost" id="open" target="_blank" rel="noopener">Open in PostHog</a></div>
<p id="share-msg" class="small muted"></p></div></div>

<div class="card"><h2>Recent clips</h2><div class="table-wrap"><table><thead><tr><th>Made</th><th>Client</th><th>User</th><th>Part</th><th>By</th><th></th></tr></thead><tbody id="recent"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>
<p class="small muted" id="retention"></p></div>

<div class="card"><h2>Get MP4 from PostHog in one click</h2>
<p class="small">Drag this button to your bookmarks bar. While you watch a replay in PostHog, click it to open the replay here.</p>
<p><a class="btn ghost" href="${esc(bookmarklet)}">Get MP4</a></p></div>
</main>
<script>
const CFG=${boot};const $=id=>document.getElementById(id);
const clock=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,'0');return h?h+':'+String(m).padStart(2,'0')+':'+x:m+':'+x};
const when=iso=>new Date(iso).toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1',...(opts.headers||{})}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
CFG.lengths.forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l+' seconds';if(l===30)o.selected=true;$('length').appendChild(o)});
$('retention').textContent='Clips are deleted after '+CFG.retention+' days. Share links expire after '+Math.round(CFG.ttl/24)+' days. Every view and download is logged.';
let info=null;
function txt(el,t,cls){el.textContent=t;el.className='small '+(cls||'')}
async function check(){const input=$('input').value.trim();if(!input)return;txt($('inspect-msg'),'Checking…','muted');$('info').classList.add('hidden');$('go').disabled=true;
 try{const r=await api('/replays/api/inspect',{method:'POST',body:JSON.stringify({input})});info=r.info;
  $('f-client').textContent=info.client||'unknown';$('f-user').textContent=info.user||'unknown';$('f-when').textContent=when(info.start);$('f-len').textContent=clock(info.duration_s);
  const box=$('moments');box.innerHTML='';const shown=info.moments.filter(m=>m.kind!=='page').slice(0,30);
  if(!shown.length){box.innerHTML='<span class="muted small">No errors or frustrated clicks in this recording.</span>'}
  shown.forEach(m=>{const b=document.createElement('button');b.type='button';b.className='chip'+(m.kind==='error'?' error':'');b.innerHTML='<span class="t"></span>';b.querySelector('.t').textContent=clock(m.offset_s);b.append(m.kind+' '+m.label);b.onclick=()=>{$('start').value=clock(Math.max(0,m.offset_s-5))};box.appendChild(b)});
  $('pages').textContent=info.pages.length?'Pages: '+info.pages.join(' → '):'';
  $('start').value=clock(r.suggested_start_s);$('info').classList.remove('hidden');$('go').disabled=false;txt($('inspect-msg'),'')
 }catch(e){txt($('inspect-msg'),e.message,'err')}}
$('check').onclick=check;$('input').addEventListener('keydown',e=>{if(e.key==='Enter')check()});$('input').addEventListener('paste',()=>setTimeout(check,50));
$('go').onclick=async()=>{$('go').disabled=true;$('result').classList.add('hidden');txt($('job-msg'),'Queued…','muted');
 try{let j=await api('/replays/api/clips',{method:'POST',body:JSON.stringify({input:$('input').value.trim(),start:$('start').value,length:Number($('length').value)})});
  while(j.state==='queued'||j.state==='rendering'){$('job-msg').innerHTML='<span class="spin"></span> '+(j.state==='queued'?'Waiting in queue (position '+j.position+')':'Making the clip… '+j.elapsed_s+' s (usually 10 to 30 s)');await new Promise(r=>setTimeout(r,1500));j=await api('/replays/api/jobs/'+j.id)}
  if(j.state==='failed')throw new Error(j.error||'The clip could not be made.');
  show(j.clip);txt($('job-msg'),'Ready.','ok');loadRecent()
 }catch(e){txt($('job-msg'),e.message,'err')}finally{$('go').disabled=false}};
function show(c){$('video').src=c.video_url+'#t=1';$('dl').href=c.download_url;$('open').href=c.replay_url;$('share').dataset.name=c.name;$('share-msg').textContent='';$('result').classList.remove('hidden');$('result').scrollIntoView({behavior:'smooth',block:'nearest'})}
$('share').onclick=async()=>{try{const r=await api('/replays/api/share/'+encodeURIComponent($('share').dataset.name),{method:'POST'});await navigator.clipboard.writeText(r.url).catch(()=>{});$('share-msg').textContent='Link copied. Anyone with it can watch this clip for '+Math.round(r.expires_hours/24)+' days: '+r.url}catch(e){$('share-msg').textContent=e.message}};
async function loadRecent(){try{const r=await api('/replays/api/clips');const tb=$('recent');tb.innerHTML='';
 if(!r.clips.length){tb.innerHTML='<tr><td colspan="6" class="muted">No clips yet.</td></tr>';return}
 r.clips.forEach(c=>{const tr=document.createElement('tr');[when(c.created_at),c.client||'',(c.user||'').replace(/@.*/,''),c.range,(c.created_by||'').replace(/@.*/,'')].forEach(t=>{const td=document.createElement('td');td.textContent=t;tr.appendChild(td)});
  const td=document.createElement('td');const w=document.createElement('button');w.className='ghost';w.textContent='Watch';w.onclick=()=>show(c);td.appendChild(w);tr.appendChild(td);tb.appendChild(tr)})}catch(e){$('recent').innerHTML='<tr><td colspan="6" class="err"></td></tr>';$('recent').querySelector('td').textContent=e.message}}
loadRecent();
const pre=new URLSearchParams(location.search).get('url');if(pre){$('input').value=pre;check()}
</script></body></html>`
}
