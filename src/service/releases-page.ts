// The release dashboard at /releases: Jira releases and their tickets against PostHog usage.
// The numbers come from core/releases.ts; this file has the routes, the permissions and the page
// shell. The page's script is public/releases.js.
//
//   Release insights only and up   see the dashboard, change weights for themselves
//   Watch clips and up             also fix ticket links, hide tickets, make groups, sync
//   Admin                          also change the settings and save default weights
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { config, ROOT } from '../core/config.ts'
import {
    areas,
    deleteGroup,
    groups,
    recompute,
    releaseSettings,
    saveGroup,
    saveReleaseSettings,
    scopes,
    setHidden,
    setLink,
    syncReleases,
    syncStatus,
    ticketRelease,
    view,
    viewMarkdown,
    type Link,
    type ReleaseSettings,
    type Weights,
} from '../core/releases.ts'
import { audit, can, currentViewer, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, loginHtml, PAGE_CSS } from './replays.ts'

const SCRIPT = () => readFileSync(join(ROOT, 'src/service/public/releases.js'), 'utf8')
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Where browsers open Jira issues: JIRA_PUBLIC_URL, or the API address with localhost swapped for this host. */
function jiraBrowseBase(): string {
    if (process.env.JIRA_PUBLIC_URL) return process.env.JIRA_PUBLIC_URL.replace(/\/+$/, '')
    const host = new URL(config.service.publicUrl).hostname
    return config.jira.baseUrl.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/]|$)/, `//${host}`)
}

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let data = ''
    for await (const c of req) {
        data += c
        if (data.length > 50_000) throw new Error('body too large')
    }
    return JSON.parse(data || '{}')
}

function weightsFrom(url: URL): Partial<Weights> | undefined {
    const raw = url.searchParams.get('w')
    if (!raw) return undefined
    const out: Partial<Weights> = {}
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (['reach', 'adoption', 'fixes', 'errors', 'friction', 'support'].includes(k) && Number(v) >= 0 && Number(v) <= 10) out[k as keyof Weights] = Number(v)
    }
    return out
}

/** Settings that change what is read from Jira or PostHog; the rest only change how it is shown. */
const NEEDS_SYNC: (keyof ReleaseSettings)[] = ['jira_project', 'support_jql', 'keep', 'window_days', 'client_property', 'version_property', 'component_screens']

/** Handles /releases*. Returns false when the path is not ours. */
export async function handleReleases(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname
    if (p !== '/releases' && !p.startsWith('/releases/')) return false
    if (p === '/releases/static/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' })
        res.end(SCRIPT())
        return true
    }
    if ((req.method === 'POST' || req.method === 'DELETE') && req.headers['x-clip-page'] !== '1') return (json(res, 403, { error: 'Missing page header.' }), true)

    const v = await currentViewer(req)
    const page = PAGES.find((x) => x.path === p.replace(/\/+$/, '') || (x.id === 'overview' && p === '/releases/'))
    if (page) {
        const allowed = v && can(v.role, 'insights') && (page.id !== 'settings' || can(v.role, 'admin'))
        res.writeHead(!v ? 401 : allowed ? 200 : 403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(!v ? loginHtml('Releases') : allowed ? pageHtml(v, page.id) : noAccess(v))
        return true
    }
    if (!v) return (json(res, 401, { error: 'Sign in first.' }), true)
    if (!can(v.role, 'insights')) return (json(res, 403, { error: 'Ask an admin for the "Release insights only" role.' }), true)
    const need = (role: 'watch' | 'admin') => {
        if (can(v.role, role)) return true
        json(res, 403, { error: role === 'admin' ? 'Only admins can change the settings.' : 'Changing links and groups needs the "Watch clips" role.' })
        return false
    }

    if (p === '/releases/api/view' && req.method === 'GET') {
        let w: Partial<Weights> | undefined
        try {
            w = weightsFrom(url)
        } catch {
            return (json(res, 400, { error: 'Bad weights.' }), true)
        }
        const scope = url.searchParams.get('scope') || 'all'
        const compare = url.searchParams.get('compare')
        json(res, 200, { view: view(scope, w), compare: compare ? view(compare, w) : null, scopes: scopes(), groups: groups() })
        return true
    }
    if (p === '/releases/api/summary.md' && req.method === 'GET') {
        let w: Partial<Weights> | undefined
        try {
            w = weightsFrom(url)
        } catch {}
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
        res.end(viewMarkdown(view(url.searchParams.get('scope') || 'all', w), 8))
        return true
    }
    if (p === '/releases/api/areas' && req.method === 'GET') return (json(res, 200, areas()), true)
    if (p === '/releases/api/status' && req.method === 'GET') return (json(res, 200, syncStatus()), true)

    if (p === '/releases/api/sync' && req.method === 'POST') {
        if (!need('watch')) return true
        audit(v.email, 'releases.synced')
        void syncReleases().catch((e) => console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'release sync failed', error: (e as Error).message })))
        return (json(res, 202, syncStatus()), true)
    }

    let m = /^\/releases\/api\/tickets\/([A-Z][A-Z0-9_]*-\d+)\/(link|hide)$/.exec(p)
    if (m && req.method === 'POST') {
        if (!need('watch')) return true
        const key = m[1]
        const release = ticketRelease(key)
        if (!release) return (json(res, 404, { error: 'No such ticket in the kept releases.' }), true)
        const body = await readJson(req)
        if (m[2] === 'hide') {
            setHidden(key, !!body.hidden)
            audit(v.email, body.hidden ? 'releases.ticket_hidden' : 'releases.ticket_shown', { ticket: key })
        } else if (body.reset) {
            setLink(key, null, v.email)
            audit(v.email, 'releases.link_reset', { ticket: key })
        } else {
            const screen = typeof body.screen === 'string' && body.screen.startsWith('/') ? body.screen.slice(0, 200) : undefined
            const event = typeof body.event === 'string' && body.event ? body.event.slice(0, 200) : undefined
            if (!screen && !event) return (json(res, 400, { error: 'Pick a screen, an event, or both.' }), true)
            const link: Link = { screen, event, ...(typeof body.risk === 'boolean' ? { risk: body.risk } : {}) }
            setLink(key, link, v.email)
            audit(v.email, 'releases.link_set', { ticket: key, ...link })
        }
        try {
            await recompute(release)
        } catch (e) {
            return (json(res, 502, { error: `Saved, but PostHog could not recount: ${(e as Error).message.slice(0, 160)}` }), true)
        }
        return (json(res, 200, { ok: true }), true)
    }

    if (p === '/releases/api/groups' && req.method === 'POST') {
        if (!need('watch')) return true
        const body = await readJson(req)
        try {
            const id = saveGroup({ id: body.id ? Number(body.id) : undefined, name: String(body.name || ''), releases: Array.isArray(body.releases) ? body.releases.map(String) : [] }, v.email)
            audit(v.email, 'releases.group_saved', { group: String(body.name || ''), releases: body.releases })
            return (json(res, 200, { id }), true)
        } catch (e) {
            return (json(res, 400, { error: (e as Error).message }), true)
        }
    }
    m = /^\/releases\/api\/groups\/(\d+)$/.exec(p)
    if (m && req.method === 'DELETE') {
        if (!need('watch')) return true
        deleteGroup(Number(m[1]))
        audit(v.email, 'releases.group_deleted', { group: Number(m[1]) })
        return (json(res, 200, { ok: true }), true)
    }

    if (p === '/releases/api/settings' && req.method === 'GET') return (json(res, 200, releaseSettings()), true)
    if (p === '/releases/api/settings' && req.method === 'POST') {
        if (!need('admin')) return true
        const body = (await readJson(req)) as Partial<ReleaseSettings>
        const before = releaseSettings()
        try {
            const after = saveReleaseSettings(body)
            audit(v.email, 'releases.settings', body as Record<string, unknown>)
            const resync = NEEDS_SYNC.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
            if (resync) void syncReleases().catch(() => {})
            return (json(res, 200, { ok: true, resync }), true)
        } catch (e) {
            return (json(res, 400, { error: (e as Error).message }), true)
        }
    }

    json(res, 404, { error: 'Not found.' })
    return true
}

function noAccess(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No access · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}</style></head>
<body>${headerHtml(v, 'Releases')}<main style="max-width:560px"><div class="card"><h2>You don't have access yet</h2><p>You're signed in as <b>${esc(v.email)}</b>. Ask an admin for the "Release insights only" role.</p></div></main></body></html>`
}

const CSS = `
:root{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;--grid:#e6e8ee;--soft:#f0f2f6}
@media (prefers-color-scheme:dark){:root{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--grid:#2a303c;--soft:#202634}}
main{max-width:1200px;margin-top:6px}.top{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}.top>div{min-width:180px}.top .grow{flex:1}
.top h1{font-size:22px;margin:0}.top .sub{color:var(--muted);font-size:13px}.btns{display:flex;gap:8px;flex-wrap:wrap}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:16px}@media (max-width:900px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:560px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.kpi b{display:block;font-size:26px;font-variant-numeric:tabular-nums;line-height:1.2}
.kpi span{font-size:12px;color:var(--muted)}.kpi .d{font-size:12px;font-weight:600}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}@media (max-width:900px){.grid2{grid-template-columns:1fr}}
.find{list-style:none;padding:0;margin:0}.find li{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:14px}.find li:last-child{border:0}
.ico{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;padding:2px 7px;border-radius:999px;height:20px;white-space:nowrap}
.ico.win{color:#067647;background:#dcfae6}.ico.risk{color:#b42318;background:#fee4e2}.ico.fix{color:#175cd3;background:#d1e9ff}.ico.info{color:var(--muted);background:var(--soft)}
@media (prefers-color-scheme:dark){.ico.win{color:#75e0a7;background:#053321}.ico.risk{color:#fda29b;background:#55160c}.ico.fix{color:#84caff;background:#102a56}}
.health{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;white-space:nowrap}.health i{width:9px;height:9px;border-radius:50%;display:inline-block}
svg text{fill:var(--muted);font:11px system-ui,sans-serif}svg .lbl{fill:var(--ink);font-weight:600}.chart{width:100%;height:auto;display:block}
.tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--card);font-size:12px;padding:7px 9px;border-radius:6px;max-width:280px;z-index:20;display:none;line-height:1.4}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);flex-wrap:wrap;margin:4px 0 6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}
.bar{height:6px;border-radius:3px;background:var(--soft);min-width:60px;position:relative}.bar>i{position:absolute;left:0;top:0;bottom:0;border-radius:3px}
.bar.v>i{background:var(--s1)}.bar.r>i{background:var(--s2)}.num{font-variant-numeric:tabular-nums;text-align:right}
tr.tk{cursor:pointer}tr.tk:hover td{background:var(--soft)}tr.tk td{vertical-align:middle}tr.detail td{background:var(--soft);padding:14px}
.type{font-size:11px;font-weight:600;border-radius:4px;padding:1px 6px;background:var(--chip);white-space:nowrap}.src{font-size:11px;color:var(--muted)}
.mini{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:8px 0}.mini>div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font-size:13px}
.mini b{font-variant-numeric:tabular-nums}.edit{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;align-items:end;margin-top:10px}
.sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.sliders input{padding:0}.panel{display:none}.panel.open{display:block}
.chips{display:flex;gap:6px;flex-wrap:wrap}.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.tabs button{padding:5px 11px;font-size:13px}
.tabs button[aria-pressed=false]{background:transparent;color:var(--accent)}.empty{padding:30px;text-align:center;color:var(--muted)}
.cmp td,.cmp th{text-align:right}.cmp td:first-child,.cmp th:first-child{text-align:left}.up{color:var(--err)}.down{color:var(--ok)}
.rel{cursor:pointer}.rel:hover td{background:var(--soft)}.note{font-size:12px;color:var(--muted)}ul.tight,ol.tight{margin:6px 0;padding-left:20px}ul.tight li,ol.tight li{margin:5px 0}
.bar-top{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:8px 20px}
.crumbs{display:flex;gap:2px;flex-wrap:wrap}.crumbs a{color:var(--muted);text-decoration:none;font-weight:600;font-size:14px;padding:6px 10px;border-radius:6px}.crumbs a:hover{color:var(--ink);background:var(--bg)}
.crumbs a[aria-current=page]{color:var(--ink);box-shadow:inset 0 -2px 0 var(--accent);border-radius:0}
.pick{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.pick label{margin:0;font-size:13px}.pick select{width:auto;min-width:170px;padding:6px 9px}.pick button{padding:6px 10px}
.intro{margin:4px 0 14px}.intro h1{font-size:24px;margin:0}.intro .sub{color:var(--muted)}
.flow{display:flex;gap:8px;align-items:stretch;flex-wrap:wrap}.flow .step{flex:1;min-width:150px;background:var(--soft);border-radius:8px;padding:10px 12px;font-size:13px}.flow .step b{display:block;margin-bottom:4px;font-size:14px}.flow i{align-self:center;color:var(--muted);font-style:normal}
.toplist{list-style:none;margin:0;padding:0}.toplist li{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer}.toplist li:last-child{border:0}
.toplist .n{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}
@media (max-width:700px){.bar-top{padding:8px 12px}.pick select{min-width:0;flex:1}.flow i{display:none}}`

type PageId = 'overview' | 'tickets' | 'releases' | 'compare' | 'how' | 'settings'
const PAGES: { id: PageId; path: string; label: string }[] = [
    { id: 'overview', path: '/releases', label: 'Overview' },
    { id: 'tickets', path: '/releases/tickets', label: 'Tickets' },
    { id: 'releases', path: '/releases/list', label: 'Releases & groups' },
    { id: 'compare', path: '/releases/compare', label: 'Compare' },
    { id: 'how', path: '/releases/how', label: 'How it works' },
    { id: 'settings', path: '/releases/settings', label: 'Settings' },
]

function pageHtml(v: Viewer, id: PageId): string {
    const boot = JSON.stringify({ me: v.email, page: id, canEdit: can(v.role, 'watch'), isAdmin: can(v.role, 'admin'), jira: jiraBrowseBase(), app: APP_NAME }).replace(/</g, '\\u003c')
    const tabs = PAGES.filter((x) => x.id !== 'settings' || can(v.role, 'admin'))
        .map((x) => `<a href="${x.path}" data-keep-scope${x.id === id ? ' aria-current="page"' : ''}>${x.label}</a>`)
        .join('')
    const scoped = id !== 'how' && id !== 'settings' && id !== 'compare'
    const toolbar = `<div class="bar-top"><div class="crumbs">${tabs}</div>
${scoped ? `<div class="pick"><label for="scope">Showing</label><select id="scope"></select><button class="ghost small" id="tune" type="button" aria-expanded="false">Customise</button><button class="ghost small" id="copy" type="button">Copy summary</button>${can(v.role, 'watch') ? '<button class="ghost small" id="sync" type="button">Sync now</button>' : ''}</div>` : ''}</div>`
    const tune = `<div class="card panel" id="tune-panel"><h2>What counts as impact</h2>
<p class="small muted">Impact is the larger of <b>value</b> (reach, adoption, fixes) and <b>risk</b> (errors, rage clicks, support tickets). Each weight says how much its signal counts. Changes apply to your view at once${can(v.role, 'admin') ? '; "Save as default" applies them for everyone' : ''}. <a href="/releases/how">How the numbers are made</a></p>
<div class="sliders" id="sliders"></div><p class="btns" style="margin-top:10px"><button class="ghost" id="reset-w" type="button">Back to defaults</button>${can(v.role, 'admin') ? '<button id="save-w" type="button">Save as default</button>' : ''}</p></div>`
    const head = `<div class="intro"><h1 id="title">Release insights</h1><div class="sub" id="subtitle"></div><p class="note" id="status"></p></div>`
    const body: Record<PageId, string> = {
        overview: `${head}${tune}<div class="kpis" id="kpis"></div><div id="release-head" class="card hidden"></div>
<div class="grid2"><div class="card"><h2>Findings</h2><ul class="find" id="findings"></ul></div>
<div class="card"><h2>Impact map</h2><div class="legend"><span><i style="background:var(--s1)"></i>Mostly value</span><span><i style="background:var(--s2)"></i>Mostly risk</span></div><div id="map"></div><p class="note">Each dot is a ticket. Right means more value, up means more risk. Click a dot to open it.</p></div></div>
<div class="grid2"><div class="card"><h2>Most impact</h2><div id="top-value"></div></div><div class="card"><h2>Most risk</h2><div id="top-risk"></div></div></div>
<div class="card" id="trend-card"><h2>Errors per 1,000 sessions, before and after each release</h2><div class="legend"><span><i style="background:transparent;border:2px solid var(--muted);width:7px;height:7px"></i>Before</span><span><i style="background:var(--s1)"></i>After</span></div><div id="trend"></div><p class="note">Click a release to open it.</p></div>`,
        tickets: `${head}${tune}<div class="card"><h2 id="tickets-title">Tickets</h2>
<div class="toolbar row" style="margin-bottom:10px"><div><label for="q">Search</label><input id="q" placeholder="Key, words, screen or event"></div>
<div><label for="sort">Sort by</label><select id="sort"><option value="impact">Impact</option><option value="value">Value</option><option value="risk">Risk</option><option value="reach">Clients reached</option></select></div>
<div><label for="type">Type</label><select id="type"></select></div>
<div style="flex:0;min-width:auto"><label><input type="checkbox" id="show-all" style="width:auto"> Show unranked</label></div></div>
<div class="table-wrap"><table id="tickets"><thead><tr><th>#</th><th>Ticket</th><th>Linked to</th><th class="num">Clients</th><th>Value</th><th>Risk</th><th class="num">Impact</th></tr></thead><tbody></tbody></table></div>
<p class="note">Value and risk show activity where a ticket changed the product, not proof that the ticket caused it. Click a ticket for its numbers${can(v.role, 'watch') ? ' and to fix its link' : ''}.</p></div>`,
        releases: `${head}<div class="card" id="releases-card"><h2>Releases</h2><div class="table-wrap"><table><thead><tr><th>Release</th><th>Date</th><th class="num">Tickets</th><th class="num">Clients on it</th><th class="num">Errors / 1k sessions</th><th class="num">Rage / 1k</th><th class="num">Support</th><th>Health</th></tr></thead><tbody id="releases"></tbody></table></div><p class="note">Click a release to see it on the overview.</p></div>
<div class="grid2"><div class="card"><h2>Quarters</h2><div id="quarters"></div></div><div class="card" id="groups-card"><h2>Custom groups</h2><p class="small muted">Group any releases together, for example a programme or a half-year.</p><div id="groups"></div></div></div>`,
        compare: `<div class="intro"><h1>Compare</h1><div class="sub">Any two releases, quarters or groups, side by side.</div></div>
<div class="card"><div class="row"><div><label for="cmp-a">This</label><select id="cmp-a"></select></div><div><label for="cmp-b">Against</label><select id="cmp-b"></select></div></div></div>
<div id="cmp-out"></div>`,
        how: howHtml(),
        settings: `<div class="intro"><h1>Settings</h1><div class="sub">What the release dashboard reads from Jira and PostHog, and how it scores. Changes that need new data start a sync.</div></div>
<div class="card"><h2>Default weights</h2><p class="small muted">Everyone starts from these. Each person can still adjust their own view with Customise.</p><div class="sliders" id="sliders"></div><p class="btns" style="margin-top:10px"><button id="save-w" type="button">Save weights</button></p><p class="small" id="w-msg"></p></div>
<div class="card" id="settings-card"><h2>Sources and rules</h2><div id="settings"></div></div>`,
    }
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(PAGES.find((x) => x.id === id)!.label)} · Releases · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${CSS}</style></head>
<body>${headerHtml(v, 'Releases')}${toolbar}<main>${body[id]}</main><div class="tip" id="tip"></div>
<script>window.BOOT=${boot}</script><script src="/releases/static/app.js"></script></body></html>`
}

/** The "How it works" page: where every number comes from, with the current settings filled in. */
function howHtml(): string {
    const s = releaseSettings()
    const w = s.weights
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    return `<div class="intro"><h1>How it works</h1><div class="sub">Where every number on these pages comes from. No AI makes them: they are counts from Jira and PostHog, put through fixed rules you can read and change.</div></div>
<div class="card"><h2>The pipeline</h2>
<div class="flow">
<div class="step"><b>1. Jira</b><span>Released versions of project <code>${esc(s.jira_project)}</code> (the last ${s.keep}), their tickets, and support tickets matching <code>${esc(s.support_jql)}</code>.</span></div><i aria-hidden="true">→</i>
<div class="step"><b>2. Link</b><span>Each ticket is matched to the screen it changed and, when one fits, the PostHog event it added. Rules below.</span></div><i aria-hidden="true">→</i>
<div class="step"><b>3. PostHog</b><span>HogQL counts for the ${s.window_days} days after each release (or until the next one) and the same number of days before.</span></div><i aria-hidden="true">→</i>
<div class="step"><b>4. Score</b><span>Counts become value and risk scores from 0 to 100, with the weights below.</span></div><i aria-hidden="true">→</i>
<div class="step"><b>5. Show</b><span>Findings are sentences filled in from the numbers by fixed rules. Stored in the database, refreshed every 6 hours.</span></div>
</div>
<p class="small muted">Nothing is sent to Claude or any other AI to make these pages. Claude only comes in if you ask it, through the MCP tools at the bottom.</p></div>

<div class="grid2"><div class="card"><h2>2. Linking a ticket to the product</h2><ol class="tight">
<li><b>A link set by a person</b> on the Tickets page always wins.</li>
<li><b>Its Jira component</b>, through the component map in Settings, or a screen with the same name (component "Invoices" → the Invoices screen).</li>
<li><b>Words in the ticket</b> that name a screen ("revenue report").</li>
<li><b>A PostHog event</b> is added when its name shares a feature word with the ticket title <i>and</i> it first appeared within three weeks of the release. That is how a new feature shows up: "Bulk send invoices" → <code>invoice_bulk_sent</code>, first seen on release day. Bugs and tasks never take a new event, and a shared screen word alone ("revenue") is not enough.</li></ol>
<p class="small muted">Every ticket shows why it was linked and how sure the match is. Tasks and anything with no screen are listed but not ranked.</p></div>
<div class="card"><h2>3. What is counted</h2><ul class="tight">
<li><b>Use:</b> times the ticket's event happened, or page views of its screen; and the people and clients behind them. A client is the <code>${esc(s.client_property)}</code> event property.</li>
<li><b>Errors:</b> <code>$exception</code> events on the screen, per 100 sessions on it. <b>New errors</b> are error types first seen after the release.</li>
<li><b>Rage clicks:</b> <code>$rageclick</code> events on the screen, per 100 sessions.</li>
<li><b>Support tickets:</b> tickets from the support JQL created in the window, matched to a screen by their summary.</li>
<li><b>Clients on the release:</b> ${s.version_property ? `clients whose events carry <code>${esc(s.version_property)}</code> = the release name` : 'not shown: no version property is set, so releases are matched by date only'}.</li></ul>
<p class="small muted">Before and after use the same number of days, so they compare like for like.</p></div></div>

<div class="card"><h2>4. The scores</h2>
<div class="table-wrap"><table><thead><tr><th>Signal</th><th>How it is measured (0 to 1)</th><th class="num">Weight now</th></tr></thead><tbody>
<tr><td><b>Reach</b> <span class="ico win">value</span></td><td>Clients who used it ÷ clients active after the release. A whole-screen link counts ×${s.screen_reach_factor}, because not everyone on the screen used the change.</td><td class="num">${w.reach}</td></tr>
<tr><td><b>Adoption</b> <span class="ico win">value</span></td><td>Times its event happened ÷ sessions on its screen, with 40% counting as full marks. Only for tickets with an event.</td><td class="num">${w.adoption}</td></tr>
<tr><td><b>Fixes</b> <span class="ico win">value</span></td><td>Drop in errors per 100 sessions (5 = full marks) or rage clicks per 100 sessions (8 = full marks) on its screen. Only for tickets that changed how the screen already worked.</td><td class="num">${w.fixes}</td></tr>
<tr><td><b>Errors</b> <span class="ico risk">risk</span></td><td>Rise in errors per 100 sessions on its screen (5 = full marks), and at least half marks if a new error type hit 2+ clients.</td><td class="num">${w.errors}</td></tr>
<tr><td><b>Rage clicks</b> <span class="ico risk">risk</span></td><td>Rise in rage clicks per 100 sessions on its screen (8 = full marks).</td><td class="num">${w.friction}</td></tr>
<tr><td><b>Support tickets</b> <span class="ico risk">risk</span></td><td>Support tickets about its screen after the release (4 = full marks).</td><td class="num">${w.support}</td></tr>
</tbody></table></div>
<p><b>Value</b> = weighted average of reach, adoption and fixes. <b>Risk</b> = weighted average of errors, rage clicks and support tickets. Signals that do not apply to a ticket are left out of its average. <b>Impact = the larger of value and risk</b>, times 100, so a ticket matters if it helped a lot <i>or</i> hurt a lot; the colour says which.</p>
<p class="small muted"><b>Who carries a screen's problems:</b> the tickets that changed how the screen already worked (linked to it without an event of their own). If every ticket on the screen added an event, they share it. Anyone with "Watch clips" can switch this per ticket. <b>Release health:</b> at risk when a new error hits 2+ clients, errors triple, or 3+ support tickets follow; watch when errors or rage clicks rise or any support ticket follows.</p></div>

<div class="grid2"><div class="card"><h2>What you can change</h2><ul class="tight">
<li><b>Your view:</b> Customise sets the six weights for you alone.</li>
<li><b>A ticket:</b> its screen, its event, whether screen problems count for it, or leave it out of the ranking (Tickets page).</li>
<li><b>Groups:</b> any set of releases, next to the automatic quarters (Releases &amp; groups).</li>
<li><b>Admins:</b> default weights, the Jira project and support JQL, releases kept (${s.keep}), days measured (${s.window_days}), year start (${months[s.fiscal_start_month - 1]}), ranked ticket types (${s.ticket_types.map(esc).join(', ')}), the client and version properties, the component map (Settings).</li>
<li><b>Deeper:</b> the rules live in <code>src/core/releases.ts</code> (one file), with tests.</li></ul></div>
<div class="card"><h2>Claude and MCP</h2>
<p>The same numbers are available to Claude through MCP tools on this service: <code>release_insights</code>, <code>list_releases</code>, <code>release_tickets</code>, <code>ticket_impact</code> and <code>compare_releases</code>. Claude reads the stored numbers and answers questions in words, for example "which Q3 ticket hurt the most clients, and what fixed it?"</p>
<p class="small muted">Connect Claude Code with <code>claude mcp add --transport http posthog-lens ${esc(config.service.publicUrl)}/mcp --header "Authorization: Bearer &lt;MCP_TOKEN&gt;"</code>. The tools see event counts and ticket text only, never session replays.</p></div></div>

<div class="card"><h2>Limits worth knowing</h2><ul class="tight">
<li>It shows <b>where</b> things changed after a ticket shipped, not proof that the ticket <b>caused</b> it. Two tickets on the same screen in one release share the screen's numbers.</li>
<li>A release that shipped days ago is still counting; its numbers move until the window closes.</li>
<li>Automatic links are a starting point. The Tickets page shows each reason so wrong ones are easy to spot and fix.</li></ul></div>`
}
