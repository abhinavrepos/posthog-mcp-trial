// The Surveys page: every in-app survey, what makes it appear, how it looks, and the answers, with
// Launch, Stop and Archive. PMs make and change surveys in chat (MCP tools); this page is where they and
// their team come back to see them. Admins, and anyone an admin ticked "Surveys" for.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, surveysActive } from '../core/config.ts'
import { archiveSurvey, conflictsFor, estimateReach, getSurvey, launchSurvey, listSurveys, queueAlert, stopSurvey, surveyAnswers, surveyOverview, surveyResults, viewOf } from '../core/surveys.ts'
import { ACKNOWLEDGEMENT, checkTicket, jiraTicketUrl, launchesOf, launchRules, recordLaunch } from '../core/launches.ts'
import { jiraConfigured } from '../core/config.ts'
import { audit, canSurvey, canUseSurveys, SURVEY_ROLE_TEXT, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS, PAGER_JS } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const c of req) {
        raw += c
        if (raw.length > 20_000) throw new Error('body too large')
    }
    try {
        return JSON.parse(raw || '{}')
    } catch {
        return {}
    }
}

/** What the person must read and confirm before this survey reaches users. */
export async function launchCheck(id: string) {
    const s = await getSurvey(id)
    const v = viewOf(s)
    const chain = s.conditions?.lensChain
    const queue = chain ? queueAlert(chain, conflictsFor(chain, { id: s.id }, await listSurveys())) : undefined
    return { survey: { id: v.id, name: v.name, status: v.status }, rules: launchRules(v, queue), queue, acknowledgement: ACKNOWLEDGEMENT, jira_checked: jiraConfigured() }
}
const days = (url: URL, fallback: number) => Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || fallback))

export async function handleSurveys(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    const page = p === '/replays/surveys' || p === '/replays/surveys/'
    if (!canUseSurveys(v)) {
        if (page) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Surveys · ${APP_NAME}</title><style>${PAGE_CSS()}</style></head><body>${headerHtml(v, 'Surveys')}<main style="max-width:560px"><div class="card"><h2>No access to the Surveys page</h2><p class="muted">Ask an admin to tick "Surveys" for you on the admin page.</p></div></main></body></html>`)
        } else json(res, 403, { error: 'No access to the Surveys page. Ask an admin.' })
        return true
    }
    if (page) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(surveysHtml(v))
        return true
    }
    if (!surveysActive()) return (json(res, 503, { error: config.surveys.enabled ? 'Surveys need POSTHOG_SURVEY_API_KEY. Run the installer again; it makes the key.' : 'Surveys are switched off (FEATURE_SURVEYS=off).' }), true)
    try {
        if (p === '/replays/surveys/api/list' && req.method === 'GET') return (json(res, 200, { surveys: await surveyOverview(days(url, 30)) }), true)
        const m = /^\/replays\/surveys\/api\/survey\/([0-9a-f-]{8,64})(?:\/(launch|stop|archive|reach|launch-check|answers))?$/i.exec(p)
        if (m && !m[2] && req.method === 'GET') {
            const r = await surveyResults(m[1], days(url, 90))
            return (json(res, 200, { ...r, launches: launchesOf(m[1]).map((l) => ({ ...l, ticket_url: jiraTicketUrl(l.ticket) })) }), true)
        }
        if (m && m[2] === 'answers' && req.method === 'GET') {
            const question = url.searchParams.get('question')
            if (!question) return (json(res, 400, { error: 'Choose a question.' }), true)
            try {
                const result = await surveyAnswers(m[1], question, url.searchParams.get('after') || undefined, Number(url.searchParams.get('limit') ?? 50), days(url, 90))
                return (json(res, 200, result), true)
            } catch (e) {
                if (e instanceof RangeError) return (json(res, 400, { error: e.message }), true)
                throw e
            }
        }
        if (m && m[2] === 'launch-check' && req.method === 'GET') return (json(res, 200, await launchCheck(m[1])), true)
        if (m && m[2] === 'reach' && req.method === 'GET') {
            const s = await getSurvey(m[1])
            const chain = s.conditions?.lensChain
            if (chain?.managedBy !== 'lens') return (json(res, 400, { error: 'Only surveys made in Lens have steps to count.' }), true)
            return (json(res, 200, await estimateReach(chain, days(url, 14))), true)
        }
        if (m && m[2] && ['launch', 'stop', 'archive'].includes(m[2]) && req.method === 'POST') {
            if (!canSurvey(v.role === 'admin' ? 'launch' : v.surveys, 'launch')) return (json(res, 403, { error: 'Launching, stopping and archiving surveys needs the "Also launch and stop surveys" survey role. Ask an admin.' }), true)
            if (m[2] === 'launch') {
                // The safeguard: the acknowledgement, word for word, and the Jira ticket this launch is for.
                const body = await readJson(req)
                if (body.acknowledgement !== ACKNOWLEDGEMENT) return (json(res, 400, { error: 'Tick the acknowledgement before launching.' }), true)
                const ticket = await checkTicket(body.ticket)
                if (!ticket.ok) return (json(res, 400, { error: ticket.error }), true)
                const check = await launchCheck(m[1])
                const s = await launchSurvey(m[1])
                recordLaunch({ survey_id: s.id, survey_name: s.name, ticket: ticket.key, ticket_summary: ticket.summary ?? null, launched_by: v.email, via: 'Surveys page', rules: check.rules, clients: s.conditions?.lensChain?.audience?.clients || [] })
                audit(v.email, 'survey.launched', { survey: s.id, name: s.name, ticket: ticket.key })
                return (json(res, 200, { ok: true, ticket: ticket.key }), true)
            }
            const s = m[2] === 'stop' ? await stopSurvey(m[1]) : await archiveSurvey(m[1])
            audit(v.email, `survey.${m[2] === 'stop' ? 'stopped' : 'archived'}`, { survey: s.id, name: s.name })
            return (json(res, 200, { ok: true }), true)
        }
    } catch (e) {
        return (json(res, 502, { error: (e as Error).message }), true)
    }
    json(res, 404, { error: 'Not found.' })
    return true
}

export function surveysHtml(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Surveys · ${APP_NAME}</title><style>${PAGE_CSS()}
:root{--act:var(--accent);--good:var(--ok);--good-bg:var(--ok-bg);--down:var(--err);--grid:var(--line)}
.chip.running{background:var(--accent-soft);color:var(--accent)}
.chip.draft{background:var(--chip);color:var(--muted)}
.head h2{margin:0;font-size:21px;overflow-wrap:anywhere}
.chain{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;margin:6px 0 10px}
.chain .st b{display:block;font-size:11px;color:var(--muted);font-weight:600}
.chain .ar{align-self:center;color:var(--muted)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px 16px;font-size:14px}
.facts span{color:var(--muted);display:block;font-size:12.5px}
.bars .row span{overflow-wrap:anywhere}
.bars .n{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.ans small{display:block;color:var(--muted)}
.pv{position:absolute;box-sizing:border-box;border:1.5px solid;font-size:14px;line-height:1.4;z-index:2}
.pv h3{margin:0 0 4px;font-size:15px;font-weight:600}
.pv .d{font-size:12.5px;margin:0 0 10px}
.pv .lbl{display:flex;justify-content:space-between;font-size:11.5px;margin:5px 0 4px}
.pv .btn{display:block;text-align:center;padding:9px;border-radius:7px;font-weight:600;margin:12px 0 4px}
.pv .ft{text-align:center;font-size:13px;font-weight:600;letter-spacing:.02em;opacity:.8;padding-top:6px}
.pv .box{border:1px solid var(--line);border-radius:7px;height:58px;padding:7px 9px;font-size:13px;margin-top:10px}
.pv .ch{border:1px solid var(--line);border-radius:7px;padding:7px 10px;margin:5px 0;font-size:13px}
.pv .x{position:absolute;top:8px;right:10px;font-size:15px;opacity:.6}
.pv .em{display:flex;justify-content:center;gap:26px;font-size:30px;margin-top:10px}
.conf ul{margin:6px 0 0;padding-left:18px}
table{width:100%;table-layout:fixed}
td,th{overflow-wrap:anywhere}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.days svg{display:block;max-width:100%}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}
.ldlg{border:0;border-radius:14px;padding:0;width:min(560px,calc(100% - 32px));max-height:calc(100% - 32px);background:var(--card);color:var(--ink);box-shadow:0 24px 60px var(--line)}
.ldlg::backdrop{background:color-mix(in srgb,var(--ink) 55%,transparent)}
.ldlg form{padding:20px 22px;display:flex;flex-direction:column;gap:12px}
.ldlg h2{margin:0;font-size:19px}
.ldlg ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}
.ldlg .ack input{width:18px;height:18px;margin-top:2px;flex:none}
.ldlg .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.ldlg .warnbox{border-left:4px solid var(--warn);background:var(--warn-bg);padding:8px 12px;border-radius:6px;font-size:13.5px}
.ldlg label.f{font-weight:600;font-size:14px}
.ldlg input[type=text]{text-transform:uppercase}.ldlg input[type=text]::placeholder{text-transform:none}#l-title:focus,#l-title:focus-visible{outline:none}
main.wide{min-width:0}
.layout{display:grid;align-items:start;grid-template-columns:minmax(0,290px) minmax(0,1fr);gap:36px}
.layout>section{min-width:0}
.toolbar select{padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);width:auto;max-width:100%;font-size:13px}
.chip{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;margin-right:6px;color:var(--muted);border:0;background:var(--hover);vertical-align:baseline}
#detail>.card>.chip{margin-bottom:8px}
main button.ghost,.ldlg button.ghost{border-color:transparent;color:var(--ink)}
main details{margin:16px 0}
main summary{cursor:pointer;font-weight:600;padding:6px 0;overflow-wrap:anywhere}
main details[open]>summary{margin-bottom:12px}
main details p{overflow-wrap:anywhere}
.head details{margin:0}
.head summary{font-size:14px;font-weight:500}
.tile{background:transparent;border:0;border-radius:0;padding:0}
.tile b{font-weight:600;font-variant-numeric:tabular-nums;font-size:28px}
.tile.secondary b{font-size:22px}
.facts div{border-top:1px solid var(--line);border:0;background:transparent;border-radius:0;padding:6px 0;overflow-wrap:anywhere}
.chain .st{font-size:13.5px;max-width:100%;overflow-wrap:anywhere;background:transparent;border:0;border-radius:0;padding:6px 0}
.chain .st.end{border-color:var(--act);color:var(--ink);background:transparent}
.chain .st.end b{color:var(--muted)}
.q p{margin:6px 0 12px}
.ans{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;border-left:0;border-bottom:1px solid var(--line);padding:10px 0;margin:0}
.conf{border-left:4px solid var(--warn);background:var(--warn-bg);padding:8px 12px;border-radius:6px;margin:10px 0;font-size:14px;border-left-width:3px}
.pacing{font-size:13px;color:var(--muted);margin:12px 0}
.screen .pv .em{gap:clamp(8px,4vw,26px)}
.pv .scale{display:flex;margin-top:10px;gap:2px}
.pv .scale i{flex:1;text-align:center;font-style:normal;padding:7px 0;border-radius:6px;border:1px solid var(--line);min-width:0;font-size:11px}
.ldlg ol li::marker{font-weight:700;color:var(--ink)}
.ldlg .ack{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;font-size:14px;cursor:pointer;border:0;border-radius:0;background:var(--hover);color:var(--ink)}
#page-msg:empty,#a-msg:empty,#l-msg:empty{margin:0}#page-msg[role=alert]:not(:empty){color:var(--err);border-left:3px solid var(--err);padding-left:12px}
main{min-width:0}
main h1{font-size:24px;line-height:32px;font-weight:650;margin:0}
main .page-head{margin-bottom:24px;align-items:center}
main .page-head p{margin:4px 0 0;font-size:14px;line-height:20px}
main h2{font-size:16px;line-height:24px;font-weight:600;margin:0 0 12px}
main h3{font-size:14px;line-height:20px;font-weight:600;margin:0 0 8px}
main input:not([type=checkbox]):not([type=radio]),main select{height:36px;min-height:36px;padding:7px 10px;font-size:13px;line-height:20px;max-width:100%;box-sizing:border-box}
main button,main .btn{min-height:36px;font-size:13px;line-height:20px;white-space:nowrap;word-break:normal;overflow-wrap:normal}
main th{word-break:normal;overflow-wrap:normal}
main .table-wrap{max-width:100%;overflow-x:auto}
main .pager button{min-height:32px;padding:5px 10px;border:1px solid var(--line-strong);background:var(--card);color:var(--ink);font-weight:500}
main .pager select{height:32px;min-height:32px}
main .pager .pg>span{min-height:32px;display:inline-flex;align-items:center}
#people-msg:empty,#outcome-msg:empty,#audit-msg:empty,#keys-msg:empty,#msg:empty{display:none}
.tabs{overflow-x:auto;max-width:100%}
.tabs :is(button,a){white-space:nowrap;flex-shrink:0}
.tabs .tab-link,.tabs .tab-link0{color:var(--muted);text-decoration:none;font-weight:500;padding:8px 12px;border-bottom:2px solid transparent}
.tabs :is([aria-current],[aria-selected=true]){color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.toolbar h1{font-size:24px;line-height:32px;margin:0}
.list .item{display:block;width:100%;text-align:left;white-space:normal;cursor:pointer;color:var(--ink);font:inherit;border:0;border-radius:0;border-bottom:1px solid var(--line);margin:0;background:transparent;padding:12px;line-height:20px}
.list .item>.chip{display:block;width:max-content;margin:0 0 6px;padding:0}
.list .item b{display:block;overflow-wrap:anywhere;font-size:14px;font-weight:600}
.list .item small{display:block;color:var(--muted);font-size:12.5px;margin-top:6px;line-height:18px}
.list .item[aria-current="true"]{border-color:var(--act);background:var(--accent-soft);box-shadow:inset 2px 0 var(--accent)}
.list .item:hover{border-color:var(--act);background:var(--hover)}
.head{justify-content:space-between;flex-wrap:wrap;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:start}
#detail .head h2{font-size:22px!important;line-height:28px}
.head .acts{display:flex;align-items:center;gap:8px;flex-wrap:nowrap}
.head .acts details{position:relative}
.head .acts details>summary{display:flex;align-items:center;min-height:36px;padding:7px 12px;border:1px solid var(--line-strong);border-radius:6px;font-size:13.5px;line-height:20px;box-sizing:border-box;white-space:nowrap}
.head .acts details[open]>button{position:absolute;right:0;top:44px;background:var(--card);border:1px solid var(--line);z-index:4}
.head .acts details[open]>summary{margin-bottom:0}
#detail>.card:first-child{border-bottom:1px solid var(--line);padding-bottom:16px;margin-bottom:16px}
#detail>.card:first-child>details{margin:12px 0 0}
.conf.ok{border-color:var(--good);background:transparent;padding-left:0;border:0;color:var(--muted);margin:12px 0;font-size:13px;line-height:20px}
.conf details{margin:4px 0}
.tile span{display:block;color:var(--muted);font-size:12px;line-height:16px}
.tile b,.tile.secondary b{display:block;font-size:28px;line-height:32px;font-weight:650;margin-top:6px}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 16px;margin:16px 0}
.secondary-metrics{display:flex;flex-wrap:wrap;gap:8px 24px;font-size:13px;color:var(--muted)}
.secondary-metrics b{color:var(--ink);font-weight:600}
.secondary-metrics+details{margin:8px 0 0}
#detail .card{border:0;border-radius:0;padding:0;margin:0 0 28px;background:transparent;margin-bottom:24px}
.q{border-top:1px solid var(--line);padding:16px 0}
.q h3{margin:0 0 4px;font-size:14px;line-height:20px;font-weight:600}
.bars .row{display:grid;align-items:center;font-size:13.5px;grid-template-columns:24px minmax(0,1fr) 32px;gap:12px;margin:8px 0}
.bars .bar{background:var(--act);min-width:0;height:8px;border-radius:3px}.bars .row>div{background:var(--chip);border-radius:3px;height:8px;overflow:hidden}.bars .row>span:first-child{color:var(--muted)}.bars .n{text-align:right;font-variant-numeric:tabular-nums}
.conf.ok>b{font-weight:500;color:var(--ok)}.conf.ok>b::before{content:'✓ ';font-weight:700}
#detail>details{margin:0;border-top:1px solid var(--line);padding:12px 0}#detail>.card:has(>.q){margin-bottom:0}.q .ans:last-child{border-bottom:0}
#detail>details>summary{padding:4px 0;font-weight:500}
.screen{position:relative;overflow:hidden;border:1px solid var(--line);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;height:320px;border-radius:8px;background:var(--hover)}
.screen .bar{display:flex;align-items:center;gap:8px;padding:0 12px;height:28px;background:var(--muted)}
.screen .bar i{display:block;border-radius:4px;width:40px;height:6px;background:var(--faint)}
.screen .grid{position:absolute;border-radius:6px;background-size:100% 28px;opacity:.9;inset:40px 12px 12px;background:var(--card);background-image:linear-gradient(var(--line) 1px,transparent 1px);background-size:100% 28px}
.screen .note{position:absolute;left:14px;bottom:10px;z-index:1;margin:0;border:0;border-radius:3px;padding:2px 4px;background:var(--card);color:var(--muted);font-size:11px;line-height:16px}
[id^="answers-status-"]:empty{display:none}
@media(max-width:860px){main.wide{margin-top:0;border-radius:0;padding:20px 16px}
.layout{grid-template-columns:minmax(0,1fr);gap:28px}
}
@media(max-width:440px){.head{gap:16px}
.facts{grid-template-columns:minmax(0,1fr)}
.tiles{gap:16px 8px}
.tile b{font-size:24px}
.tile span{font-size:12px}
.ldlg form{padding:20px 16px}
.screen{height:320px}
th,td{padding:8px 3px;font-size:12px}
}
@media(min-width:861px) and (max-width:1320px){.head{grid-template-columns:1fr}
.head .acts{grid-row:2}
}
@media(max-width:560px){.head{grid-template-columns:1fr}
.head .acts{grid-row:2}
}
</style></head>
<body>${headerHtml(v, 'Surveys')}<main class="wide" id="main">
<div class="layout">
<section><div class="toolbar"><h1>Surveys</h1><select id="days" aria-label="Survey counts period"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></div>
<p id="page-msg" class="small" role="status" aria-live="polite"></p><div class="list" id="list"><p class="empty">Loading…</p></div><div id="list-pager"></div>
<p class="small"><a href="/replays/connect">Create a survey in chat</a></p><details><summary>How this works</summary><p class="small muted">Your survey role: ${SURVEY_ROLE_TEXT[v.role === 'admin' ? 'launch' : v.surveys || 'none']}.</p><p class="small muted">Make or change surveys in chat. Describe who should see it, when it appears and what to ask. New surveys stay as drafts until launched.</p></details></section>
<section id="detail"><div class="card"><p class="empty">Choose a survey to see results and launch options.</p></div></section>
</div></main>
<dialog class="ldlg" id="ldlg" role="dialog" aria-modal="true" aria-labelledby="l-title" aria-describedby="l-name"><form method="dialog" id="l-form">
<h2 id="l-title" tabindex="-1">Launch this survey?</h2><p class="small muted" id="l-name"></p>
<div><b>Read all four launch rules:</b><ol id="l-rules" aria-live="polite"></ol></div>
<div id="l-queue"></div>
<div><label class="f" for="l-ticket">Jira ticket for this launch</label><input id="l-ticket" type="text" placeholder="e.g. REVAL-1234" autocomplete="off" spellcheck="false" maxlength="32" aria-describedby="l-ticket-help" required><p id="l-ticket-help" class="small muted">Required, for example REVAL-1234.</p></div>
<label class="ack" for="l-ack"><input type="checkbox" id="l-ack" required><span id="l-ack-text"></span></label>
<p id="l-msg" class="small err" role="alert"></p>
<div class="row"><button type="button" class="ghost" id="l-cancel">Cancel</button><button type="submit" id="l-go" disabled>Launch survey</button></div>
</form></dialog>
<script>${PAGER_JS}
${CLIENT.replace('__BRAND__', JSON.stringify(config.surveys.brand)).replace('__CAN_LAUNCH__', JSON.stringify(v.role === 'admin' || canSurvey(v.surveys, 'launch')))}</script></body></html>`
}

// Runs in the browser. Survey names, questions and answers come from people: everything goes through esc().
const CLIENT = String.raw`
const BRAND=__BRAND__
const CAN_LAUNCH=__CAN_LAUNCH__
const $=id=>document.getElementById(id)
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const num=n=>n==null?'–':Number(n).toLocaleString('en-US')
const when=t=>new Date(t).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})
const color=c=>/^#[0-9a-fA-F]{3,6}$/.test(c||'')?c:null
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(r.status===401)location.reload();if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const STATUS={running:'Running',draft:'Draft',stopped:'Stopped',archived:'Archived'}
let LIST=[],current=null,listRequest=0,busy=false
const listPager=makePager({mount:$('list-pager'),noun:'surveys',size:25,draw:renderList})
async function loadList(){const request=++listRequest;try{const d=await api('/replays/surveys/api/list?days='+$('days').value);if(request!==listRequest)return;LIST=d.surveys;drawList();$('page-msg').setAttribute('role','status');$('page-msg').textContent=LIST.some(s=>s.freshness)?'Showing cached survey counts while they refresh.':'';
  const want=location.hash.slice(1)||(LIST[0]&&LIST[0].id);if(want&&want!==current)await show(want);else if(!LIST.length){current=null;$('detail').innerHTML='<div class="card"><p class="empty">No surveys yet. <a href="/replays/connect">Set up chat</a> to make your first survey.</p></div>'}}
  catch(e){if(request!==listRequest)return;if(!LIST.length)$('list').innerHTML='<p class="empty">Surveys could not load.</p>';$('page-msg').setAttribute('role','alert');$('page-msg').textContent=e.message+' Change the period to try again.'}}
function drawList(){const active=document.activeElement,id=active&&active.dataset.id;listPager.set(LIST,true);if(id){const b=Array.from($('list').querySelectorAll('.item')).find(b=>b.dataset.id===id);if(b)b.focus()}}
function renderList(items){$('list').innerHTML=items.map(s=>'<button type="button" class="item" data-id="'+esc(s.id)+'" aria-current="'+(s.id===current)+'" aria-controls="detail"><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status]||s.status)+'</span><b>'+esc(s.name)+'</b><small>'+(s.freshness?'<span title="Counts are from a few minutes ago and are refreshing">Refreshing</span> · ':'')+num(s.shown)+' shown · '+num(s.answered)+' answered'+(s.clients==='all'?' · every client':' · '+esc(s.clients.slice(0,3).join(', '))+(s.clients.length>3?' +'+(s.clients.length-3):''))+'</small></button>').join('')||'<p class="empty">No surveys yet. Make your first survey in chat.</p>'
  $('list').querySelectorAll('.item').forEach(b=>b.onclick=()=>{location.hash=b.dataset.id})}
window.onhashchange=()=>{const id=location.hash.slice(1);if(id&&id!==current)show(id)}
$('days').onchange=()=>{$('page-msg').setAttribute('role','status');$('page-msg').textContent='Loading surveys…';listPager.set([]);loadList();if(current)show(current)}

const SHADOW={soft:'0 10px 30px rgba(15,23,42,.16)',strong:'0 16px 44px rgba(0,0,0,.38)',none:'none'},PAD={compact:'14px 16px',normal:'20px 22px',roomy:'26px 28px'}
function pxOf(v,d){const m=/^([0-9]+)px$/.exec(v||'');return m?+m[1]:d}
// A faithful sketch of the popover over an app window, placed where PostHog puts it (right = bottom right).
function preview(s){const l=s.look||{},bg=color(l.background)||'#fff',fg=color(l.text)||'#14213d',sub=color(l.text_subtle)||'#5b6577',bt=color(l.button)||'#0b5cad',btt=color(l.button_text)||'#fff',rb=color(l.rating)||'#f1f4f8',ra=color(l.rating_active)||bt,bd=color(l.border)||'#d8dee8',ib=color(l.input_background)||'#f7f9fc',it=color(l.input_text)||fg
  const q=s.questions[0];if(!q)return '<p class="small muted">No questions to preview. Add a question in chat.</p>'
  const pos=String(l.position||'right'),w=Math.min(l.max_width||340,360),r=l.corner_radius==null?14:l.corner_radius
  const v=pos.startsWith('top')?'top:46px':pos.startsWith('middle')?'top:50%;transform:translateY(-50%)':'bottom:0',hz=/left/.test(pos)?'left:24px':/center/.test(pos)?'left:50%;transform:translateX(-50%)':'right:24px'
  const bottom=!pos.startsWith('top')&&!pos.startsWith('middle'),rad=bottom?r+'px '+r+'px 0 0':r+'px'
  const both=pos==='middle_center'?'top:50%;left:50%;transform:translate(-50%,-50%)':v+';'+hz
  let body=''
  if(q.type==='thumbs')body='<div class="em"><span>👍</span><span>👎</span></div>'
  else if(q.type==='rating'||q.type==='nps'||q.type==='emoji rating'){const n=q.scale||(q.type==='nps'?10:5),start=n===10?0:1,mid=Math.floor((n===10?11:n)/2)
    body=q.type==='emoji rating'?'<div class="em">'+(n===3?'😞😐😀':'😡😞😐🙂😀').match(/./gu).map(e=>'<span>'+e+'</span>').join('')+'</div>':'<div class="scale">'+Array.from({length:n===10?11:n},(_,i)=>'<i style="background:'+(i===mid?ra:rb)+';color:'+(i===mid?btt:fg)+'">'+(start+i)+'</i>').join('')+'</div><div class="lbl" style="color:'+sub+'"><span>'+(q.type==='nps'?'Not likely':'')+'</span><span>'+(q.type==='nps'?'Very likely':'')+'</span></div>'}
  else if(q.choices)body=q.choices.slice(0,5).map((c,i)=>'<div class="ch" style="background:'+(i===0?ra:rb)+';color:'+(i===0?btt:fg)+'">'+esc(c)+(i===0?' <small>(selected)</small>':'')+'</div>').join('')
  else body='<div class="box" style="background:'+ib+';color:'+sub+'">'+esc(l.placeholder||'Type your answer…')+'</div>'
  const box='<div class="pv" style="'+both+';width:'+w+'px;max-width:calc(100% - 28px);background:'+bg+';color:'+fg+';border-color:'+bd+';border-radius:'+rad+';box-shadow:'+(SHADOW[l.shadow]||SHADOW.soft)+';padding:'+(PAD[l.padding]||PAD.normal)+';font-family:'+(l.font==='system'?'system-ui':'inherit')+(bottom?';border-bottom:0':'')+'"><span class="x" aria-hidden="true">×</span><h3>'+esc(q.text)+'</h3>'+(q.description?'<p class="d" style="color:'+sub+'">'+esc(q.description)+'</p>':'')+body+'<span class="btn" style="background:'+bt+';color:'+btt+'">'+esc(l.submit_label||'Submit')+'</span><div class="ft" style="color:'+fg+'">'+esc(BRAND)+'</div></div>'
  return '<p class="small muted">Preview only. Users answer in Reval.</p><div class="screen" role="img" aria-label="The survey over the app, '+esc(pos.replace('_',' '))+': '+esc(q.text)+(q.description?' — '+esc(q.description):'')+(q.choices?' Choices: '+esc(q.choices.join(', ')):' Type: '+esc(q.type))+'"><div class="bar"><i></i><i></i><i></i></div><div class="grid"></div>'+box+'<span class="note">Reval</span></div>'
    +(s.questions.length>1||l.thank_you?'<details><summary>Questions &amp; thank-you message</summary>':'')+(s.questions.length>1?'<p class="small muted">Then '+(s.questions.length-1)+' more: '+s.questions.slice(1).map(x=>'"'+esc(x.text)+'" ('+esc(x.type)+')').join(', ')+'</p>':'')
    +(l.thank_you?'<p class="small muted">After the answer: "'+esc(l.thank_you)+'"'+(l.thank_you_text?' · '+esc(l.thank_you_text):'')+'</p>':'')
    +(s.questions.length>1||l.thank_you?'</details>':'')}

function chain(s){const st=s.steps.map((t,i)=>'<div class="st"><b>Step '+(i+1)+'</b>'+esc(t)+'</div>').join('<span class="ar" aria-hidden="true">→</span>')
  return '<div class="chain">'+(st||'<div class="st">No steps</div>')+'<span class="ar" aria-hidden="true">→</span><div class="st end"><b>Then</b>Survey shows'+(s.waits_for_page?' once the page has loaded':'')+'</div></div>'}

function bars(dist){const e=Object.entries(dist||{}),max=Math.max(1,...e.map(x=>x[1]));return '<div class="bars">'+e.map(([k,n])=>'<div class="row"><span>'+esc(k)+'</span><div><div class="bar" aria-hidden="true" style="width:'+(n/max*100)+'%"></div></div><span class="n">'+num(n)+'</span></div>').join('')+'</div>'}

function perDay(rows){if(!rows.length)return '<p class="small muted">Nothing shown in this period.</p>';const W=600,H=120,max=Math.max(1,...rows.map(r=>r.shown)),bw=Math.min(28,Math.max(2,W/rows.length-2))
  return '<div class="days"><svg viewBox="0 0 '+W+' '+(H+18)+'" width="'+W+'" role="img" aria-label="Shown and answered per day">'+rows.map((r,i)=>{const x=i*(W/rows.length),h=r.shown/max*H,a=r.answered/max*H;return '<rect x="'+x+'" y="'+(H-h)+'" width="'+bw+'" height="'+h+'" fill="var(--grid)"><title>'+esc(r.day)+': '+r.shown+' shown</title></rect><rect x="'+x+'" y="'+(H-a)+'" width="'+bw+'" height="'+a+'" fill="var(--act)"><title>'+esc(r.day)+': '+r.answered+' answered</title></rect>'}).join('')+'<text x="0" y="'+(H+14)+'" font-size="11" fill="var(--muted)">'+esc(rows[0].day)+'</text><text x="'+W+'" y="'+(H+14)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+esc(rows[rows.length-1].day)+'</text></svg><p class="small muted">Light grey: shown. Dark grey: answered.</p></div><details><summary>Daily counts as a table</summary><table><caption class="sr-only">Daily survey counts</caption><thead><tr><th scope="col">Day</th><th scope="col">Shown</th><th scope="col">Answered</th></tr></thead><tbody id="daily-rows"></tbody></table><div id="daily-pager"></div></details>'}

async function show(id){const period=$('days').value;current=id;$('list').querySelectorAll('.item').forEach(b=>b.setAttribute('aria-current',String(b.dataset.id===id)));$('detail').setAttribute('aria-busy','true');$('page-msg').setAttribute('role','status');$('page-msg').textContent='Loading survey…';$('detail').innerHTML='<div class="card"><p class="empty">Loading…</p></div>'
  let r;try{r=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'?days='+period)}catch(e){if(current!==id||$('days').value!==period)return;$('detail').removeAttribute('aria-busy');$('page-msg').textContent='';$('detail').innerHTML='<div class="card"><p class="err" role="alert">'+esc(e.message)+' Try loading this survey again.</p><button type="button" class="ghost" id="detail-retry">Try again</button></div>';$('detail-retry').onclick=()=>show(id);return}
  if(current!==id||$('days').value!==period)return
  $('detail').removeAttribute('aria-busy');$('page-msg').textContent=''
  const s=r.survey
  const acts=!CAN_LAUNCH?'<span class="small muted">Ask an admin for launch access.</span>':(s.status==='draft'||s.status==='stopped'?'<button type="button" id="a-launch">'+(s.status==='draft'?'Launch':'Start again')+'</button>':'')+(s.status==='running'?'<button type="button" id="a-stop">Stop</button>':'')+'<details><summary>More actions</summary><button type="button" id="a-archive" class="ghost">Archive</button></details>'
  const launched=(r.launches||[])[0]
  const facts=[['Clients',(s.clients==='all'?'Every client':s.clients.join(', '))+(s.sample_percent<100?' · '+s.sample_percent+'% of their users':'')],['Shows',s.show==='every_time'?'Every time the steps happen':'Once per user'],['Time to complete steps',s.within_minutes?num(s.within_minutes)+' minutes':'No limit (same page)'],
    ['Starts over when',s.reset_on.length?s.reset_on.join('; '):'Never (a page reload starts over)'],['Days between any two surveys',s.days_between_surveys||'None'],['User limits',s.pacing?'At most '+s.pacing.per_user+' running at once · '+s.pacing.gap_hours+' h apart at least · '+s.pacing.quiet_days_after_close+' quiet days after a close':'PostHog rules only'],['Only on pages containing',s.url_contains||'Any page'],['Stops after',s.max_responses?num(s.max_responses)+' answers':'No limit'],
    ['Made',when(s.created)+(s.created_by?' by '+s.created_by:'')+(s.made_by_lens?' (Lens)':' (in PostHog)')],['Running since',s.started?when(s.started):'Not launched'+(s.stopped?'':'')]].concat(s.stopped?[['Stopped',when(s.stopped)]]:[]).concat(launched?[['Launched under',launched.ticket+(launched.ticket_summary?' · '+launched.ticket_summary:'')+' · by '+launched.launched_by+' ('+launched.via+'), '+when(launched.at)]]:[])
  const qs=r.questions.map((q,i)=>'<div class="q"><h3><span class="muted">'+(i+1)+'. </span>'+esc(q.text.replace(/^Q:\s*/i,''))+'</h3><p class="small muted">'+num(q.answers)+' answers'+(q.recent?' · Newest first':'')+(q.average!=null?' · average '+num(q.average):'')+(q.nps?' · NPS '+num(q.nps.score)+' ('+num(q.nps.promoters)+' promoters, '+num(q.nps.passives)+' passives, '+num(q.nps.detractors)+' detractors)':'')+'</p>'+(q.distribution?'<div id="dist-'+i+'"></div><div id="dist-pager-'+i+'"></div>':'')+(q.recent?'<div id="answers-'+i+'"></div><div id="answers-pager-'+i+'"></div><p class="small muted" id="answers-status-'+i+'" role="status" aria-live="polite"></p><button type="button" class="ghost" id="answers-more-'+i+'" aria-controls="answers-'+i+'">Show more</button>':'')+'</div>').join('')
  $('detail').innerHTML='<div class="card"><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status])+'</span><div class="head"><h2>'+esc(s.name)+'</h2><div class="acts">'+acts+'</div></div>'+(s.description?'<details><summary>About this survey</summary><p class="muted">'+esc(s.description)+'</p></details>':'')+'<p id="a-msg" class="small" role="status" aria-live="polite"></p>'
    +'</div>'
    +(r.queue?'<div class="conf'+(r.queue.level==='clear'?' ok':'')+'" role="'+(r.queue.level==='clear'?'status':'alert')+'"><b>'+(r.queue.level==='clear'?'No survey overlap':'Survey overlap')+'</b><details><summary>Survey pacing</summary><p>'+esc(r.queue.alert)+'</p></details>'+(r.conflicts.length?'<ul id="conflict-rows"></ul><div id="conflict-pager"></div>':'')+'</div>':'')+(s.pacing?'<details class="pacing"><summary>User limits</summary><p>'+esc('User limits: '+num(s.pacing.per_user)+' running at once · at least '+num(s.pacing.gap_hours)+' hours apart · '+num(s.pacing.quiet_days_after_close)+' quiet days after dismissal.')+'</p></details>':'')
    +'<div class="card"><h2>Results · last '+esc(period)+' days</h2>'+(r.freshness?'<p class="small muted" role="status">Showing cached results from '+esc(when(r.freshness.cached_at))+' while they refresh.</p>':'')+'<div class="tiles"><div class="tile"><span>Shown</span><b>'+num(r.shown)+'</b></div><div class="tile"><span>Answered</span><b>'+num(r.answered)+'</b></div><div class="tile"><span>Answer rate</span><b>'+(r.response_rate==null?'–':r.response_rate+'%')+'</b></div></div><div class="secondary-metrics"><div><span>Dismissed</span> <b>'+num(r.dismissed)+'</b></div>'+(r.chain_completed!=null?'<div><span>Steps completed</span> <b>'+num(r.chain_completed)+'</b></div>':'')+'</div>'

    +(r.chain_completed!=null&&r.chain_completed>r.shown?'<details><summary>How this works</summary><p class="small muted">Some completed steps do not show a survey. A survey may not show if the user already answered or dismissed it, saw another survey recently, or the page stayed busy.</p></details>':'')+'</div>'
    +'<div class="card"><h2>Answers by question</h2>'+(qs||'<p class="muted">No questions yet. Add one in chat.</p>')+'</div>'
    +'<details><summary>Daily activity</summary>'+perDay(r.by_day)+'</details>'
    +'<details><summary>By client</summary><p class="small muted">Ordered by times shown.'+(r.by_client_truncated?' Showing the first 5,000 clients.':'')+'</p>'+(r.by_client.length?'<table><caption class="sr-only">Survey results by client</caption><thead><tr><th scope="col">Client</th><th scope="col" class="n">Shown</th><th scope="col" class="n">Answered</th><th scope="col" class="n">Dismissed</th></tr></thead><tbody id="client-rows"></tbody></table><div id="client-pager"></div>':'<p class="small muted">No activity yet. Results appear here after users see the survey.</p>')+'</details>'
    +'<details><summary>When it shows &amp; settings</summary>'+chain(s)+'<div class="facts">'+facts.map(([k,x])=>'<div><span>'+esc(k)+'</span>'+esc(x)+'</div>').join('')+'</div>'
    +(s.made_by_lens?'<p style="margin-top:10px"><button type="button" id="a-reach" class="ghost">Estimate reach · last 14 days</button></p><div id="reach" aria-live="polite"></div>':'')+'</details>'
    +'<details open><summary>Preview survey</summary>'+preview(s)+'</details>'
  if($('conflict-pager'))makePager({mount:$('conflict-pager'),noun:'overlapping surveys',size:25,draw:items=>{$('conflict-rows').innerHTML=items.map(c=>'<li><a href="#'+esc(c.survey_id)+'">'+esc(c.name)+'</a>: '+esc(c.text.replace(/^[^:]*: /,''))+' ('+esc(c.clients==='all'?'every client':c.clients.join(', '))+')</li>').join('')}}).set(r.conflicts)
  r.questions.forEach((q,i)=>{
    if(q.distribution)makePager({mount:$('dist-pager-'+i),noun:'answer choices',label:'Question '+(i+1)+' answer choices',size:25,draw:items=>{$('dist-'+i).innerHTML=bars(Object.fromEntries(items))}}).set(Object.entries(q.distribution))
    if(q.recent){
      const box=$('answers-'+i),status=$('answers-status-'+i),button=$('answers-more-'+i);let loaded=[],loading=false,next=''
      const pager=makePager({mount:$('answers-pager-'+i),noun:'answers',label:'Question '+(i+1)+' written answers',size:25,draw:items=>{box.innerHTML=items.map(a=>'<div class="ans">'+esc(a.text)+'<small>'+esc(a.client)+' · '+esc(when(a.at))+'</small></div>').join('')||'<p class="small muted">No written answers yet.</p>'}})
      const more=async()=>{if(loading)return;loading=true;button.disabled=true;status.textContent='Loading answers…'
        try{const page=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/answers?question='+encodeURIComponent(q.id||String(i))+'&days='+period+'&limit=50'+(next?'&after='+encodeURIComponent(next):''));if(box!==$('answers-'+i))return
          loaded=loaded.concat(page.answers);pager.set(loaded,true);status.textContent=loaded.length>=page.total?'':num(loaded.length)+' of '+num(page.total)+' answers loaded.'+(page.freshness?' Showing cached answers while they refresh.':'');next=page.next||'';button.hidden=!next
        }catch(e){if(box!==$('answers-'+i))return;status.textContent=e.message+' Try again.'}finally{loading=false;button.disabled=false}}
      button.onclick=more;more()
    }
  })
  if($('client-pager'))makePager({mount:$('client-pager'),noun:'clients',size:25,draw:items=>{$('client-rows').innerHTML=items.map(c=>'<tr><td>'+esc(c.client)+'</td><td class="n">'+num(c.shown)+'</td><td class="n">'+num(c.answered)+'</td><td class="n">'+num(c.dismissed)+'</td></tr>').join('')}}).set(r.by_client)
  if($('daily-pager'))makePager({mount:$('daily-pager'),noun:'days',size:25,draw:items=>{$('daily-rows').innerHTML=items.map(d=>'<tr><td>'+esc(d.day)+'</td><td>'+num(d.shown)+'</td><td>'+num(d.answered)+'</td></tr>').join('')}}).set(r.by_day)
  const act=(name,ask)=>async()=>{if(busy||ask&&!confirm(ask))return;busy=true;const buttons=Array.from($('detail').querySelectorAll('.acts button'));buttons.forEach(b=>b.disabled=true);const msg=$('a-msg');msg.setAttribute('role','status');msg.textContent=name==='archive'?'Archiving…':'Stopping…';try{await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/'+name,{method:'POST'});if(name==='archive')location.hash='';current=null;await loadList();$('page-msg').textContent=name==='archive'?'Survey archived.':'Survey stopped.';const next=$('a-launch')||$('days');next.focus()}catch(e){msg.textContent=e.message+' Try again.';msg.className='small err';msg.setAttribute('role','alert')}finally{busy=false;buttons.forEach(b=>b.disabled=false)}}
  if($('a-launch'))$('a-launch').onclick=()=>openLaunch(id)
  if($('a-stop'))$('a-stop').onclick=act('stop','Stop showing "'+s.name+'"? Its answers stay.')
  if($('a-archive'))$('a-archive').onclick=act('archive','Archive "'+s.name+'"? It stops and leaves this list. Its answers stay in PostHog.')
  if($('a-reach'))$('a-reach').onclick=async ev=>{const button=ev.currentTarget;if(button.disabled)return;button.disabled=true;$('reach').innerHTML='<p class="small muted">Counting…</p>';try{const x=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/reach');$('reach').innerHTML='<p><b>'+num(x.sessions)+'</b> sessions, '+num(x.users)+' users at '+num(x.clients)+' clients.</p>'+bars(Object.fromEntries(x.by_step.map((b,i)=>['Step '+(i+1)+': '+b.step,b.sessions])))+(x.top_clients.length?'<p class="small muted">Most: '+x.top_clients.map(c=>esc(c.client)+' ('+num(c.sessions)+')').join(', ')+'</p>':'')+'<p class="small muted">'+esc(x.note)+'</p>'}catch(e){$('reach').innerHTML='<p class="err" role="alert">'+esc(e.message)+' Try counting again.</p>'}finally{button.disabled=false}}
}
// The safeguard: read the rules, give the Jira ticket, acknowledge; the server checks the same.
let LAUNCH=null,launchRequest=0,launchOpener=null,launching=false
async function openLaunch(id){const d=$('ldlg');if(d.open||busy)return;const request=++launchRequest;LAUNCH=null;launchOpener=document.activeElement;$('l-title').textContent='Launch this survey?';$('l-name').textContent='Loading launch rules…';$('l-msg').textContent='';$('l-ack-text').textContent='Loading acknowledgement…';$('l-ack').checked=false;$('l-ack').disabled=true;$('l-ticket').disabled=true;$('l-ticket').value='';$('l-go').disabled=true;$('l-rules').innerHTML='<li>Loading…</li>';$('l-queue').innerHTML='';d.showModal();$('l-title').focus()
  try{const check=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/launch-check');if(request!==launchRequest||!d.open)return;LAUNCH={...check,id}
    $('l-title').textContent=(LAUNCH.survey.status==='stopped'?'Start again: ':'Launch: ')+LAUNCH.survey.name;$('l-name').textContent='Reval users will see this survey. Read all four rules.'
    $('l-rules').innerHTML=LAUNCH.rules.map(x=>'<li>'+esc(x)+'</li>').join('')
    $('l-queue').innerHTML=LAUNCH.queue&&LAUNCH.queue.level!=='clear'?'<div class="warnbox">'+esc(LAUNCH.queue.alert)+'</div>':''
    $('l-ack-text').textContent=LAUNCH.acknowledgement;$('l-ack').disabled=false;$('l-ticket').disabled=false;launchReady()}
  catch(e){if(request!==launchRequest||!d.open)return;$('l-rules').innerHTML='';$('l-name').textContent='Launch rules could not load.';$('l-msg').textContent=e.message+' Cancel and try launching again.'}}
const TICKET=/^[A-Z][A-Z0-9_]{0,19}-[0-9]{1,9}$/
function launchReady(){$('l-go').disabled=!!(launching||!LAUNCH||LAUNCH.rules.length!==4||!$('l-ack').checked||!TICKET.test($('l-ticket').value.trim().toUpperCase()))}
$('l-ack').onchange=launchReady;$('l-ticket').oninput=launchReady;$('l-cancel').onclick=()=>$('ldlg').close()
$('ldlg').addEventListener('close',()=>{launchRequest++;LAUNCH=null;if(launchOpener&&launchOpener.isConnected)launchOpener.focus();else $('days').focus()})
$('l-form').onsubmit=async ev=>{ev.preventDefault();launchReady();if($('l-go').disabled)return;const launch=LAUNCH;launching=true;busy=true;$('l-go').disabled=true;$('l-go').textContent='Launching…';$('l-ack').disabled=true;$('l-ticket').disabled=true;$('l-msg').textContent=''
  try{await api('/replays/surveys/api/survey/'+encodeURIComponent(launch.id)+'/launch',{method:'POST',body:JSON.stringify({ticket:$('l-ticket').value.trim().toUpperCase(),acknowledgement:launch.acknowledgement})});if($('ldlg').open)$('ldlg').close();current=null;await loadList();$('page-msg').textContent='Survey launched.';if($('a-stop'))$('a-stop').focus()}
  catch(e){if($('ldlg').open)$('l-msg').textContent=e.message+' Check the ticket and try again.';else{$('page-msg').setAttribute('role','alert');$('page-msg').textContent=e.message+' Try launching again.'}}
  finally{launching=false;busy=false;$('l-ack').disabled=false;$('l-ticket').disabled=false;$('l-go').textContent='Launch survey';launchReady()}}
loadList();setInterval(()=>{if(document.visibilityState==='visible'&&!$('ldlg').open&&!busy&&!document.querySelector('main').contains(document.activeElement))loadList()},60000)
`
