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
    if (p === '/releases' || p === '/releases/') {
        res.writeHead(v ? 200 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(!v ? loginHtml('Releases') : can(v.role, 'insights') ? pageHtml(v) : noAccess(v))
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
main{max-width:1200px}.top{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}.top>div{min-width:180px}.top .grow{flex:1}
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
.rel{cursor:pointer}.rel:hover td{background:var(--soft)}.note{font-size:12px;color:var(--muted)}ul.tight{margin:6px 0;padding-left:20px}ul.tight li{margin:3px 0}`

function pageHtml(v: Viewer): string {
    const boot = JSON.stringify({ me: v.email, canEdit: can(v.role, 'watch'), isAdmin: can(v.role, 'admin'), jira: jiraBrowseBase(), app: APP_NAME }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Releases · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${CSS}</style></head>
<body>${headerHtml(v, 'Releases')}<main>
<div class="card"><div class="top">
 <div class="grow"><h1 id="title">Release insights</h1><div class="sub" id="subtitle">Jira releases matched to how clients use the product in PostHog.</div></div>
 <div><label for="scope">Show</label><select id="scope"></select></div>
 <div><label for="compare">Compare with</label><select id="compare"><option value="">Nothing</option></select></div>
 <div class="btns"><button class="ghost" id="tune" type="button" aria-expanded="false">Customise</button><button class="ghost" id="copy" type="button">Copy summary</button>${can(v.role, 'watch') ? '<button class="ghost" id="sync" type="button">Sync now</button>' : ''}</div>
</div><p class="note" id="status"></p>
<div class="panel" id="tune-panel"><h2 style="margin-top:14px">What counts as impact</h2>
<p class="small muted">Impact is the larger of <b>value</b> (reach, adoption, fixes) and <b>risk</b> (errors, rage clicks, support tickets). Each weight says how much its signal counts. Changes apply to your view at once${can(v.role, 'admin') ? '; "Save as default" applies them for everyone' : ''}.</p>
<div class="sliders" id="sliders"></div><p class="btns" style="margin-top:10px"><button class="ghost" id="reset-w" type="button">Back to defaults</button>${can(v.role, 'admin') ? '<button id="save-w" type="button">Save as default</button>' : ''}</p></div></div>

<div id="compare-box" class="card hidden"></div>
<div class="kpis" id="kpis"></div>
<div id="release-head" class="card hidden"></div>
<div class="grid2"><div class="card"><h2>Findings</h2><ul class="find" id="findings"></ul></div>
<div class="card"><h2>Impact map</h2><div class="legend"><span><i style="background:var(--s1)"></i>Mostly value</span><span><i style="background:var(--s2)"></i>Mostly risk</span></div><div id="map"></div><p class="note">Each dot is a ticket. Right means more value, up means more risk. Click a dot to open the ticket below.</p></div></div>
<div class="card" id="trend-card"><h2>Errors per 1,000 sessions, before and after each release</h2><div class="legend"><span><i style="background:transparent;border:2px solid var(--muted);width:7px;height:7px"></i>Before</span><span><i style="background:var(--s1)"></i>After</span></div><div id="trend"></div></div>
<div class="card"><h2 id="tickets-title">Tickets by impact</h2>
<div class="toolbar row" style="margin-bottom:10px"><div><label for="q">Search</label><input id="q" placeholder="Key, words, screen or event"></div>
<div><label for="sort">Sort by</label><select id="sort"><option value="impact">Impact</option><option value="value">Value</option><option value="risk">Risk</option><option value="reach">Clients reached</option></select></div>
<div><label for="type">Type</label><select id="type"><option value="">All ranked types</option></select></div>
<div style="flex:0;min-width:auto"><label><input type="checkbox" id="show-all" style="width:auto"> Show unranked</label></div></div>
<div class="table-wrap"><table id="tickets"><thead><tr><th>#</th><th>Ticket</th><th>Linked to</th><th class="num">Clients</th><th>Value</th><th>Risk</th><th class="num">Impact</th></tr></thead><tbody></tbody></table></div>
<p class="note">Value and risk show activity where a ticket changed the product, not proof that the ticket caused it. Click a ticket to see its numbers${can(v.role, 'watch') ? ' and fix its link' : ''}.</p></div>
<div class="card" id="releases-card"><h2>Releases</h2><div class="table-wrap"><table><thead><tr><th>Release</th><th>Date</th><th class="num">Tickets</th><th class="num">Clients on it</th><th class="num">Errors / 1k sessions</th><th class="num">Rage / 1k</th><th class="num">Support</th><th>Health</th></tr></thead><tbody id="releases"></tbody></table></div></div>
<div class="card" id="groups-card"><h2>Custom groups</h2><p class="small muted">Group any releases together, for example a programme or a half-year. Quarters are made for you.</p><div id="groups"></div></div>
${can(v.role, 'admin') ? '<div class="card" id="settings-card"><h2>Settings</h2><div id="settings"></div></div>' : ''}
</main><div class="tip" id="tip"></div>
<script>window.BOOT=${boot}</script><script src="/releases/static/app.js"></script></body></html>`
}
