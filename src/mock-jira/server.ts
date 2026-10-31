// A small stand-in for Jira Cloud, for the demo. It implements the REST v3 calls the triage
// service makes (issue, comments, attachments, labels), sends signed `jira:issue_created`
// webhooks like Jira Cloud does, and has an issue UI with one-click example tickets.
//
//   pnpm mock-jira     (MOCK_JIRA_PORT, default 4000)
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { config, ROOT } from '../core/config.ts'
import { markdownToAdf, type AdfNode } from '../jira/adf.ts'
import { signWebhook } from '../jira/client.ts'
import { PAST_SUPPORT, RELEASES } from '../core/release-plan.ts'
import { EXAMPLES } from './examples.ts'

const PORT = Number(process.env.MOCK_JIRA_PORT || 4000)
const WEBHOOK_URL = process.env.MOCK_JIRA_WEBHOOK_URL || `http://localhost:${config.service.port}/webhooks/jira`
const UI_PASSWORD = process.env.DEMO_UI_PASSWORD || ''
const DATA = join(ROOT, 'run/mock-jira')
const STATE = join(DATA, 'state.json')
mkdirSync(join(DATA, 'attachments'), { recursive: true })

interface Comment {
    id: string
    author: string
    created: string
    body: AdfNode
}
interface Attachment {
    id: string
    filename: string
    mimeType: string
    size: number
    created: string
}
interface Issue {
    key: string
    type: string
    summary: string
    description: AdfNode
    reporter: { displayName: string; emailAddress: string; timeZone: string }
    created: string
    labels: string[]
    comments: Comment[]
    attachments: Attachment[]
    fields: Record<string, string>
    extra?: Record<string, unknown> // status, components, fixVersions: only the read-only archive uses them
}
interface State {
    next: number
    issues: Issue[]
}

function load(): State {
    return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : { next: 101, issues: [] }
}
let state = load()
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2))
const find = (key: string) => state.issues.find((i) => i.key === key) || ARCHIVE.find((i) => i.key === key)

// ------------------------------------------------------------------- releases (read-only archive)
// Product tickets (project ACP) with their fix versions, and last year's resolved support tickets,
// from the demo release plan. They are not stored: they are the same every start.
const ARCHIVE: Issue[] = [
    ...RELEASES.flatMap((r) =>
        r.tickets.map((tk) => ({
            key: tk.key,
            type: tk.type,
            summary: tk.summary,
            description: markdownToAdf(tk.description),
            reporter: { displayName: 'Product team', emailAddress: 'product@acme.example', timeZone: 'Europe/London' },
            created: new Date(Date.parse(r.date) - 30 * 86_400_000).toISOString(),
            labels: tk.labels || [],
            comments: [],
            attachments: [],
            fields: {},
            extra: {
                status: { name: r.released ? 'Done' : 'In Progress' },
                components: tk.components.map((name) => ({ name })),
                fixVersions: [{ name: r.name, releaseDate: r.date, released: r.released }],
                resolutiondate: r.released ? `${r.date}T09:00:00.000Z` : null,
            },
        }))
    ),
    ...PAST_SUPPORT.map((tk) => ({
        key: tk.key,
        type: tk.type,
        summary: tk.summary,
        description: markdownToAdf(tk.description),
        reporter: { displayName: 'Priya (Client Services)', emailAddress: 'priya.cs@acme.example', timeZone: 'Europe/London' },
        created: `${tk.created}T10:30:00.000Z`,
        labels: ['triaged'],
        comments: [],
        attachments: [],
        fields: {},
        extra: { status: { name: 'Done' }, components: [], fixVersions: [] },
    })),
]

const VERSIONS = RELEASES.map((r, n) => ({ id: String(10_000 + n), name: r.name, description: r.description, releaseDate: r.date, released: r.released, archived: false }))

/** The small part of JQL the triage service uses: clauses joined by AND, ORDER BY ignored. */
export function jqlMatch(jql: string): (i: Issue) => boolean {
    const where = jql.replace(/\border\s+by\b.*$/i, '').trim()
    const tests: ((i: Issue) => boolean)[] = []
    for (const clause of where ? where.split(/\s+and\s+/i) : []) {
        const m = /^\s*(\w+)\s*(=|!=|>=|<=|>|<|\s+in\s+|\s+not\s+in\s+)\s*(.+?)\s*$/i.exec(clause)
        if (!m) throw new Error(`Unsupported JQL clause: ${clause}`)
        const field = m[1].toLowerCase()
        const op = m[2].trim().toLowerCase()
        const values = (/^\((.*)\)$/.exec(m[3])?.[1] ?? m[3]).split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''))
        const get = (i: Issue): string[] => {
            if (field === 'project') return [i.key.split('-')[0]]
            if (field === 'issuetype' || field === 'type') return [i.type]
            if (field === 'fixversion') return ((i.extra?.fixVersions as { name: string }[]) || []).map((v) => v.name)
            if (field === 'created') return [i.created]
            if (field === 'status') return [String((i.extra?.status as { name?: string })?.name || 'Open')]
            throw new Error(`Unsupported JQL field: ${m![1]}`)
        }
        const lower = (xs: string[]) => xs.map((x) => x.toLowerCase())
        tests.push((i) => {
            const have = get(i)
            if (op === '=' || op === 'in') return lower(have).some((h) => lower(values).includes(h))
            if (op === '!=' || op === 'not in') return !lower(have).some((h) => lower(values).includes(h))
            const a = Date.parse(have[0])
            const b = Date.parse(values[0])
            return op === '>=' ? a >= b : op === '>' ? a > b : op === '<=' ? a <= b : a < b
        })
    }
    return (i) => tests.every((test) => test(i))
}

function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function adfToHtml(n: AdfNode | undefined): string {
    if (!n) return ''
    const kids = () => (n.content || []).map(adfToHtml).join('')
    switch (n.type) {
        case 'doc':
            return kids()
        case 'paragraph':
            return `<p>${kids()}</p>`
        case 'heading':
            return `<h${Number(n.attrs?.level) + 1 || 3}>${kids()}</h${Number(n.attrs?.level) + 1 || 3}>`
        case 'bulletList':
            return `<ul>${kids()}</ul>`
        case 'listItem':
            return `<li>${kids()}</li>`
        case 'table':
            return `<table>${kids()}</table>`
        case 'tableRow':
            return `<tr>${kids()}</tr>`
        case 'tableHeader':
            return `<th>${kids()}</th>`
        case 'tableCell':
            return `<td>${kids()}</td>`
        case 'text': {
            let t = esc(n.text || '')
            for (const m of n.marks || []) {
                if (m.type === 'strong') t = `<strong>${t}</strong>`
                if (m.type === 'em') t = `<em>${t}</em>`
                if (m.type === 'code') t = `<code>${t}</code>`
                if (m.type === 'link') {
                    const href = String(m.attrs?.href || '')
                    if (/^https?:\/\//.test(href)) t = `<a href="${esc(href)}" target="_blank" rel="noopener">${t}</a>`
                }
            }
            return t
        }
        default:
            return kids()
    }
}

function toApi(i: Issue) {
    return {
        id: i.key.split('-')[1],
        key: i.key,
        self: `http://localhost:${PORT}/rest/api/3/issue/${i.key}`,
        fields: {
            summary: i.summary,
            description: i.description,
            issuetype: { name: i.type },
            reporter: i.reporter,
            created: i.created,
            labels: i.labels,
            attachment: i.attachments.map((a) => ({ ...a, content: `http://localhost:${PORT}/attachments/${a.id}/${encodeURIComponent(a.filename)}` })),
            ...i.fields,
            ...(i.extra || {}),
        },
    }
}

async function fireWebhook(issue: Issue) {
    const secret = config.jira.webhookSecret
    if (!secret) return console.error('JIRA_WEBHOOK_SECRET is not set; not sending a webhook')
    const body = JSON.stringify({ timestamp: Date.now(), webhookEvent: 'jira:issue_created', issue: toApi(issue) })
    try {
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-hub-signature': signWebhook(body, secret), 'x-atlassian-webhook-identifier': randomUUID() },
            body,
        })
        console.log(`webhook ${issue.key} → ${res.status}`)
    } catch (e) {
        console.error(`webhook ${issue.key} failed: ${(e as Error).message}`)
    }
}

function createIssue(input: { type: string; summary: string; description: string; reporter?: Partial<Issue['reporter']>; fields?: Record<string, string> }): Issue {
    const issue: Issue = {
        key: `SUP-${state.next++}`,
        type: input.type,
        summary: input.summary.slice(0, 250),
        description: markdownToAdf(input.description.slice(0, 20_000)),
        reporter: {
            displayName: input.reporter?.displayName || 'Priya (Client Services)',
            emailAddress: input.reporter?.emailAddress || 'priya.cs@acme.example',
            timeZone: input.reporter?.timeZone || 'Europe/London',
        },
        created: new Date().toISOString(),
        labels: [],
        comments: [],
        attachments: [],
        fields: input.fields || {},
    }
    state.issues.unshift(issue)
    save()
    void fireWebhook(issue)
    return issue
}

// ------------------------------------------------------------------- HTTP plumbing
async function readBody(req: IncomingMessage, limit = 200 * 1024 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = []
    let n = 0
    for await (const c of req) {
        n += (c as Buffer).length
        if (n > limit) throw new Error('too large')
        chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks)
}
function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
}
function html(res: ServerResponse, body: string, status = 200) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
}
function apiAuthOk(req: IncomingMessage): boolean {
    const want = 'Basic ' + Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64')
    return !!config.jira.email && req.headers.authorization === want
}
function uiAuthOk(req: IncomingMessage, res: ServerResponse): boolean {
    if (!UI_PASSWORD) return true
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization || ''))
    const pass = m ? Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':') : ''
    if (pass === UI_PASSWORD) return true
    res.writeHead(401, { 'www-authenticate': 'Basic realm="Acme Jira demo"', 'content-type': 'text/plain' })
    res.end('Password required')
    return false
}

// ------------------------------------------------------------------- UI
const CSS = `*{box-sizing:border-box}body{margin:0;font:14px/1.55 "Liberation Sans",Arial,sans-serif;color:#172b4d;background:#f7f8f9}
a{color:#0c66e4;text-decoration:none}header{background:#fff;border-bottom:1px solid #dcdfe4;padding:12px 24px;display:flex;gap:16px;align-items:center}
header b{color:#0c66e4}.wrap{max-width:1100px;margin:0 auto;padding:20px 24px}.grid{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px}
.card{background:#fff;border:1px solid #dcdfe4;border-radius:8px;padding:16px 20px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #dcdfe4;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f1f2f4}
.lbl{display:inline-block;background:#e9f2ff;color:#0055cc;border-radius:3px;padding:1px 6px;margin:0 4px 4px 0;font-size:12px}
.type{font-size:12px;font-weight:700;padding:2px 6px;border-radius:3px;background:#f1f2f4}.risk{background:#ffeceb;color:#ae2e24}
.btn{background:#0c66e4;color:#fff;border:0;border-radius:4px;padding:7px 12px;font:inherit;cursor:pointer}.btn.ghost{background:#fff;color:#0c66e4;border:1px solid #0c66e4}
.muted{color:#626f86;font-size:12px}code{background:#f1f2f4;padding:1px 4px;border-radius:3px;font-size:13px}video{width:100%;border-radius:6px;background:#000}
.comment{border-left:3px solid #0c66e4;padding-left:14px}.issues td:first-child{white-space:nowrap}textarea,input,select{width:100%;font:inherit;padding:7px;border:1px solid #dcdfe4;border-radius:4px}
.examples form{display:inline}.pending{color:#a54800}h3,h4{margin:14px 0 6px}@media(max-width:800px){.grid{grid-template-columns:1fr}}`

const page = (title: string, body: string, refresh = false) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${refresh ? '<meta http-equiv="refresh" content="4">' : ''}<style>${CSS}</style></head><body><header><b>◆ Jira</b><a href="/">Support board</a><a href="/releases">Releases</a><span class="muted">demo instance</span></header><div class="wrap">${body}</div></body></html>`

function board(): string {
    const rows = state.issues
        .map(
            (i) =>
                `<tr><td><a href="/browse/${i.key}">${i.key}</a></td><td><span class="type ${i.type === config.jira.riskIssueType ? 'risk' : ''}">${esc(i.type)}</span></td><td>${esc(i.summary)}</td><td>${i.labels.map((l) => `<span class="lbl">${esc(l)}</span>`).join('') || '<span class="pending">triaging…</span>'}</td><td class="muted">${i.created.slice(0, 16).replace('T', ' ')}</td></tr>`
        )
        .join('')
    const examples = EXAMPLES.map(
        (e, n) => `<form method="post" action="/ui/example"><input type="hidden" name="n" value="${n}"><button class="btn ghost" title="${esc(e.summary)}">${esc(e.button)}</button></form>`
    ).join(' ')
    return page(
        'Support board',
        `<div class="card examples"><h3 style="margin-top:0">File an example ticket</h3><p class="muted">Each one is filed the way client services would, and the triage service picks it up from the webhook.</p>${examples}
<p><a href="/new">Write your own ticket →</a></p></div>
<div class="card"><table class="issues"><tr><th>Key</th><th>Type</th><th>Summary</th><th>Labels</th><th>Created (UTC)</th></tr>${rows || '<tr><td colspan="5" class="muted">No tickets yet.</td></tr>'}</table></div>`,
        state.issues.some((i) => !i.labels.length)
    )
}

function issuePage(i: Issue): string {
    const videos = i.attachments
        .filter((a) => a.mimeType.startsWith('video/'))
        .map((a) => `<video controls preload="metadata" src="/attachments/${a.id}/${encodeURIComponent(a.filename)}#t=1"></video><div class="muted">${esc(a.filename)} · ${(a.size / 1024).toFixed(0)} KB</div>`)
        .join('')
    const comments = i.comments.map((c) => `<div class="card comment"><div class="muted">${esc(c.author)} · ${c.created.slice(0, 16).replace('T', ' ')} UTC</div>${adfToHtml(c.body)}</div>`).join('')
    const fields = Object.entries(i.fields).map(([k, v]) => `<div><span class="muted">${esc(k)}</span><br>${esc(v)}</div>`).join('')
    return page(
        `${i.key} ${i.summary}`,
        `<div class="muted"><a href="/">Support board</a> / ${i.key}</div><h2>${esc(i.summary)}</h2>
<div class="grid"><div><div class="card">${adfToHtml(i.description)}</div>${videos ? `<div class="card"><h4 style="margin-top:0">Attachments</h4>${videos}</div>` : ''}
<h3>Activity</h3>${comments || (i.extra ? '<p class="muted">No comments.</p>' : '<p class="pending">The triage service is working on it. This page refreshes on its own.</p>')}</div>
<div><div class="card"><div class="muted">Type</div><span class="type ${i.type === config.jira.riskIssueType ? 'risk' : ''}">${esc(i.type)}</span>
<div class="muted" style="margin-top:10px">Reporter</div>${esc(i.reporter.displayName)}<br><span class="muted">${esc(i.reporter.timeZone)}</span>
<div class="muted" style="margin-top:10px">Labels</div>${i.labels.map((l) => `<span class="lbl">${esc(l)}</span>`).join('') || '-'}${fields}
${
            i.extra
                ? `<div class="muted" style="margin-top:10px">Status</div>${esc(String((i.extra.status as { name: string }).name))}` +
                  `<div class="muted" style="margin-top:10px">Fix version</div>${esc(((i.extra.fixVersions as { name: string }[]) || []).map((v) => v.name).join(', ') || '-')}` +
                  `<div class="muted" style="margin-top:10px">Components</div>${esc(((i.extra.components as { name: string }[]) || []).map((c) => c.name).join(', ') || '-')}`
                : ''
        }
<div class="muted" style="margin-top:10px">Created</div>${i.created.slice(0, 16).replace('T', ' ')} UTC</div></div></div>`,
        !i.comments.length && !i.extra
    )
}

function releasesPage(): string {
    const rows = [...RELEASES]
        .reverse()
        .map((r) => {
            const tickets = r.tickets
                .map((tk) => `<tr><td><a href="/browse/${tk.key}">${tk.key}</a></td><td><span class="type">${esc(tk.type)}</span></td><td>${esc(tk.summary)}</td><td class="muted">${esc(tk.components.join(', '))}</td></tr>`)
                .join('')
            return `<div class="card"><h3 style="margin-top:0">${esc(r.name)} <span class="muted" style="font-weight:400">· ${r.released ? 'Released' : 'Planned'} ${esc(r.date)}</span></h3><p class="muted">${esc(r.description)}</p><table class="issues">${tickets}</table></div>`
        })
        .join('')
    return page('Releases', `<h2>Acme Portal releases (project ACP)</h2>${rows}`)
}

function newForm(): string {
    return page(
        'New ticket',
        `<div class="card" style="max-width:640px"><h3 style="margin-top:0">New ticket</h3><form method="post" action="/ui/create">
<p><label>Type<select name="type"><option>${esc(config.jira.rciIssueType)}</option><option>${esc(config.jira.riskIssueType)}</option></select></label></p>
<p><label>Summary<input name="summary" required maxlength="250"></label></p>
<p><label>Description<textarea name="description" rows="7"></textarea></label></p>
<p><label>Reporter timezone<input name="tz" value="Europe/London"></label></p>
<button class="btn">Create</button></form></div>`
    )
}

// ------------------------------------------------------------------- routes
const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const p = url.pathname
    try {
        // REST API (what the triage service calls)
        if (p.startsWith('/rest/api/3/')) {
            if (!apiAuthOk(req)) return json(res, 401, { errorMessages: ['unauthorized'] })
            let m = /^\/rest\/api\/3\/project\/([A-Z]+)\/versions$/.exec(p)
            if (m && req.method === 'GET') return json(res, 200, m[1] === 'ACP' ? VERSIONS : [])
            if ((p === '/rest/api/3/search/jql' || p === '/rest/api/3/search') && (req.method === 'GET' || req.method === 'POST')) {
                const body = req.method === 'POST' ? JSON.parse((await readBody(req)).toString() || '{}') : {}
                const jql = String(body.jql ?? url.searchParams.get('jql') ?? '')
                const max = Math.min(100, Number(body.maxResults ?? url.searchParams.get('maxResults') ?? 50))
                const startAt = Number(body.nextPageToken ?? url.searchParams.get('nextPageToken') ?? body.startAt ?? url.searchParams.get('startAt') ?? 0)
                let matches: Issue[]
                try {
                    matches = [...state.issues, ...ARCHIVE].filter(jqlMatch(jql))
                } catch (e) {
                    return json(res, 400, { errorMessages: [(e as Error).message] })
                }
                matches.sort((a, b) => b.created.localeCompare(a.created))
                const page = matches.slice(startAt, startAt + max)
                const isLast = startAt + max >= matches.length
                return json(res, 200, { issues: page.map(toApi), isLast, ...(isLast ? {} : { nextPageToken: String(startAt + max) }), total: matches.length })
            }
            m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)$/.exec(p)
            if (m && req.method === 'GET') {
                const i = find(m[1])
                return i ? json(res, 200, toApi(i)) : json(res, 404, { errorMessages: ['Issue does not exist'] })
            }
            if (m && req.method === 'PUT') {
                const i = find(m[1])
                if (!i) return json(res, 404, { errorMessages: ['Issue does not exist'] })
                const body = JSON.parse((await readBody(req)).toString() || '{}')
                for (const op of body.update?.labels || []) {
                    if (op.add && !i.labels.includes(op.add)) i.labels.push(String(op.add))
                    if (op.remove) i.labels = i.labels.filter((l) => l !== op.remove)
                }
                save()
                res.writeHead(204)
                return res.end()
            }
            m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/comment$/.exec(p)
            if (m) {
                const i = find(m[1])
                if (!i) return json(res, 404, { errorMessages: ['Issue does not exist'] })
                if (req.method === 'GET') return json(res, 200, { startAt: 0, maxResults: 100, total: i.comments.length, comments: i.comments.map((c) => ({ id: c.id, created: c.created, author: { displayName: c.author }, body: c.body })) })
                if (req.method === 'POST') {
                    const body = JSON.parse((await readBody(req)).toString())
                    const c: Comment = { id: randomUUID(), author: 'Triage bot', created: new Date().toISOString(), body: body.body }
                    i.comments.push(c)
                    save()
                    return json(res, 201, { id: c.id })
                }
            }
            m = /^\/rest\/api\/3\/issue\/([A-Z]+-\d+)\/attachments$/.exec(p)
            if (m && req.method === 'POST') {
                const i = find(m[1])
                if (!i) return json(res, 404, { errorMessages: ['Issue does not exist'] })
                if (req.headers['x-atlassian-token'] !== 'no-check') return json(res, 403, { errorMessages: ['XSRF check failed'] })
                const web = new Request(`http://localhost${p}`, { method: 'POST', headers: req.headers as Record<string, string>, body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } as RequestInit)
                const form = await web.formData()
                const file = form.get('file')
                if (!(file instanceof File)) return json(res, 400, { errorMessages: ['no file'] })
                const a: Attachment = { id: randomUUID(), filename: file.name.replace(/[^A-Za-z0-9._-]/g, '_'), mimeType: file.type || 'application/octet-stream', size: file.size, created: new Date().toISOString() }
                writeFileSync(join(DATA, 'attachments', a.id), Buffer.from(await file.arrayBuffer()))
                i.attachments.push(a)
                save()
                return json(res, 200, [a])
            }
            if (p === '/rest/api/3/issue' && req.method === 'POST') {
                const body = JSON.parse((await readBody(req)).toString())
                const f = body.fields || {}
                const issue = createIssue({ type: f.issuetype?.name || config.jira.rciIssueType, summary: String(f.summary || ''), description: typeof f.description === 'string' ? f.description : '' })
                return json(res, 201, { key: issue.key })
            }
            return json(res, 404, { errorMessages: ['not found'] })
        }

        if (!uiAuthOk(req, res)) return
        if (p === '/' && req.method === 'GET') return html(res, board())
        if (p === '/new') return html(res, newForm())
        if (p === '/releases') return html(res, releasesPage())
        let m = /^\/browse\/([A-Z]+-\d+)$/.exec(p)
        if (m) {
            const i = find(m[1])
            return i ? html(res, issuePage(i)) : html(res, page('Not found', '<p>No such issue.</p>'), 404)
        }
        m = /^\/attachments\/([0-9a-f-]{36})\/[^/]+$/.exec(p)
        if (m) {
            const a = state.issues.flatMap((i) => i.attachments).find((x) => x.id === m![1])
            const file = join(DATA, 'attachments', m[1])
            if (!a || !existsSync(file)) return html(res, 'not found', 404)
            const data = readFileSync(file)
            const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''))
            if (range) {
                const start = Number(range[1])
                const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1
                res.writeHead(206, { 'content-type': a.mimeType, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) })
                return res.end(data.subarray(start, end + 1))
            }
            res.writeHead(200, { 'content-type': a.mimeType, 'accept-ranges': 'bytes', 'content-length': String(data.length) })
            return res.end(data)
        }
        if (p === '/ui/example' && req.method === 'POST') {
            const n = Number(new URLSearchParams((await readBody(req, 10_000)).toString()).get('n'))
            const ex = EXAMPLES[n]
            if (!ex) return html(res, 'unknown example', 400)
            const issue = createIssue(ex)
            res.writeHead(303, { location: `/browse/${issue.key}` })
            return res.end()
        }
        if (p === '/ui/create' && req.method === 'POST') {
            const f = new URLSearchParams((await readBody(req, 50_000)).toString())
            const issue = createIssue({ type: f.get('type') || config.jira.rciIssueType, summary: f.get('summary') || 'Untitled', description: f.get('description') || '', reporter: { timeZone: f.get('tz') || 'UTC' } })
            res.writeHead(303, { location: `/browse/${issue.key}` })
            return res.end()
        }
        if (p === '/ui/reset' && req.method === 'POST') {
            state = { next: 101, issues: [] }
            save()
            res.writeHead(303, { location: '/' })
            return res.end()
        }
        html(res, page('Not found', '<p>Not found.</p>'), 404)
    } catch (e) {
        console.error(e)
        if (!res.headersSent) json(res, 500, { errorMessages: [(e as Error).message] })
    }
})

server.listen(PORT, '0.0.0.0', () => console.log(`mock Jira on http://0.0.0.0:${PORT} (webhooks → ${WEBHOOK_URL})`))
