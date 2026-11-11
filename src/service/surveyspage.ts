// The Surveys page: every in-app survey, what makes it appear, how it looks, and the answers, with
// Launch, Stop and Archive. PMs make and change surveys in chat (MCP tools); this page is where they and
// their team come back to see them. Admins, and anyone an admin ticked "Surveys" for.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, surveysActive } from '../core/config.ts'
import { archiveSurvey, conflictsFor, estimateReach, getSurvey, launchSurvey, listSurveys, queueAlert, stopSurvey, surveyOverview, surveyResults, viewOf } from '../core/surveys.ts'
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
        const m = /^\/replays\/surveys\/api\/survey\/([0-9a-f-]{8,64})(?:\/(launch|stop|archive|reach|launch-check))?$/i.exec(p)
        if (m && !m[2] && req.method === 'GET') {
            const r = await surveyResults(m[1], days(url, 90))
            return (json(res, 200, { ...r, launches: launchesOf(m[1]).map((l) => ({ ...l, ticket_url: jiraTicketUrl(l.ticket) })) }), true)
        }
        if (m && m[2] === 'launch-check' && req.method === 'GET') return (json(res, 200, await launchCheck(m[1])), true)
        if (m && m[2] === 'reach' && req.method === 'GET') {
            const s = await getSurvey(m[1])
            const chain = s.conditions?.lensChain
            if (chain?.managedBy !== 'lens') return (json(res, 400, { error: 'Only surveys made in Lens have steps to count.' }), true)
            return (json(res, 200, await estimateReach(chain, days(url, 14))), true)
        }
        if (m && m[2] && req.method === 'POST') {
            if (!canSurvey(v.role === 'admin' ? 'launch' : v.surveys, 'launch')) return (json(res, 403, { error: 'Launching, stopping and archiving surveys needs the "Also launch and stop surveys" survey role. Ask an admin.' }), true)
            if (m[2] === 'launch') {
                // The safeguard: the acknowledgement, word for word, and the Jira ticket this launch is for.
                const body = await readJson(req)
                if (body.acknowledgement !== ACKNOWLEDGEMENT) return (json(res, 400, { error: 'Tick the acknowledgement before launching.' }), true)
                const ticket = await checkTicket(body.ticket)
                if (!ticket.ok) return (json(res, 400, { error: ticket.error }), true)
                const check = await launchCheck(m[1])
                const s = await launchSurvey(m[1])
                recordLaunch({ survey_id: s.id, survey_name: s.name, ticket: ticket.key, ticket_summary: ticket.summary ?? null, launched_by: v.email, via: 'Surveys page', rules: check.rules })
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
:root{--act:#2a78d6;--good:#067647;--good-bg:#e7f5ec;--warn:#9a5b00;--warn-bg:#fff4dd;--down:#b42318;--grid:#e1e0d9}
main.wide{max-width:1240px;min-width:0}
.layout{display:grid;grid-template-columns:minmax(0,330px) minmax(0,1fr);gap:14px;align-items:start}
@media(max-width:860px){.layout{grid-template-columns:minmax(0,1fr)}}
.list .item{display:block;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:0 0 8px;cursor:pointer;color:var(--ink);font:inherit}
.list .item:hover{border-color:var(--act)}.list .item[aria-current="true"]{border-color:var(--act);box-shadow:0 0 0 1px var(--act)}
.list .item b{display:block;overflow-wrap:anywhere}.list .item small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px}
.chip{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 8px;border-radius:999px;margin-right:6px;vertical-align:1px;background:var(--chip);color:var(--muted)}
.chip.running{background:var(--good-bg);color:var(--good)}.chip.draft{background:var(--warn-bg);color:var(--warn)}
.head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.head h2{margin:0;font-size:21px;overflow-wrap:anywhere}.head .acts{display:flex;gap:6px;flex-wrap:wrap}
.chain{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;margin:6px 0 10px}
.chain .st{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13.5px;max-width:100%;overflow-wrap:anywhere}.chain .st b{display:block;font-size:11px;color:var(--muted);font-weight:600}
.chain .ar{align-self:center;color:var(--muted)}.chain .st.end{background:var(--act);color:#fff;border-color:var(--act)}.chain .st.end b{color:#e6efff}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px 16px;font-size:14px}.facts div{padding:5px 0;border-top:1px solid var(--line)}.facts span{color:var(--muted);display:block;font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:8px 0 12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tile span{display:block;font-size:12.5px;color:var(--muted)}.tile b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.bars .row{display:grid;grid-template-columns:minmax(60px,30%) minmax(0,1fr) 48px;gap:8px;align-items:center;font-size:13.5px;margin:4px 0}.bars .row span{overflow-wrap:anywhere}.bars .bar{height:14px;border-radius:4px;background:var(--act);min-width:2px}.bars .n{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.q{border-top:1px solid var(--line);padding:10px 0}.q h3{font-size:15px;margin:0 0 4px}.ans{border-left:3px solid var(--line);padding:4px 10px;margin:6px 0;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.ans small{display:block;color:var(--muted)}
.screen{position:relative;height:440px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#e9edf3;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.screen .bar{height:34px;background:#1f3a5f;display:flex;align-items:center;gap:8px;padding:0 12px}.screen .bar i{display:block;height:8px;width:60px;border-radius:4px;background:rgba(255,255,255,.35)}
.screen .grid{position:absolute;inset:48px 14px 14px 14px;background:#fff;border-radius:6px;background-image:linear-gradient(#eef1f5 1px,transparent 1px);background-size:100% 28px;opacity:.9}
.screen .note{position:absolute;left:14px;bottom:10px;font-size:11px;color:#6b7280;z-index:1}
.pv{position:absolute;box-sizing:border-box;border:1.5px solid;font-size:14px;line-height:1.4;z-index:2}.pv h3{margin:0 0 4px;font-size:15px;font-weight:600}.pv .d{font-size:12.5px;margin:0 0 10px}
.pv .scale{display:flex;gap:4px;margin-top:10px}.pv .scale i{flex:1;text-align:center;font-style:normal;padding:7px 0;border-radius:6px;font-size:13px;border:1px solid rgba(127,127,127,.25)}
.pv .lbl{display:flex;justify-content:space-between;font-size:11.5px;margin:5px 0 4px}.pv .btn{display:block;text-align:center;padding:9px;border-radius:7px;font-weight:600;margin:12px 0 4px}.pv .ft{text-align:center;font-size:13px;font-weight:600;letter-spacing:.02em;opacity:.8;padding-top:6px}
.pv .box{border:1px solid rgba(127,127,127,.35);border-radius:7px;height:58px;padding:7px 9px;font-size:13px;margin-top:10px}.pv .ch{border:1px solid rgba(127,127,127,.35);border-radius:7px;padding:7px 10px;margin:5px 0;font-size:13px}.pv .x{position:absolute;top:8px;right:10px;font-size:15px;opacity:.6}
.pv .em{display:flex;justify-content:center;gap:26px;font-size:30px;margin-top:10px}
.conf{border-left:4px solid var(--warn);background:var(--warn-bg);padding:8px 12px;border-radius:6px;margin:10px 0;font-size:14px}.conf.ok{border-color:var(--good);background:var(--good-bg)}.conf ul{margin:6px 0 0;padding-left:18px}
table{width:100%;table-layout:fixed}td,th{overflow-wrap:anywhere}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.days svg{display:block;max-width:100%}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}.toolbar select{padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
.ldlg{border:0;border-radius:14px;padding:0;width:min(560px,calc(100% - 32px));max-height:calc(100% - 32px);background:var(--card);color:var(--ink);box-shadow:0 24px 60px rgba(0,0,0,.35)}
.ldlg::backdrop{background:rgba(15,23,42,.55)}.ldlg form{padding:20px 22px;display:flex;flex-direction:column;gap:12px}.ldlg h2{margin:0;font-size:19px}
.ldlg ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}.ldlg ol li::marker{font-weight:700;color:var(--accent)}
.ldlg .ack{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1.5px solid var(--line);border-radius:10px;font-size:14px;cursor:pointer}.ldlg .ack input{width:18px;height:18px;margin-top:2px;flex:none}
.ldlg .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.ldlg .warnbox{border-left:4px solid var(--warn);background:var(--warn-bg);padding:8px 12px;border-radius:6px;font-size:13.5px}
.ldlg label.f{font-weight:600;font-size:14px}.ldlg input[type=text]{text-transform:uppercase}
</style></head>
<body>${headerHtml(v, 'Surveys')}<main class="wide" id="main">
<div class="layout">
<section><div class="toolbar"><h1 style="margin:0;font-size:21px">Surveys</h1><select id="days" aria-label="Survey counts period"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></div>
<p id="page-msg" class="small" role="status" aria-live="polite"></p><div class="list" id="list"><p class="empty">Loading…</p></div><div id="list-pager"></div>
<p class="small muted">Your survey role: ${SURVEY_ROLE_TEXT[v.role === 'admin' ? 'launch' : v.surveys || 'none']}. Make or change surveys in chat (<a href="/replays/connect">set up chat</a>). Describe who should see it, when it appears and what to ask. New surveys stay as drafts until launched.</p></section>
<section id="detail"><div class="card"><p class="empty">Choose a survey to see its preview and answers.</p></div></section>
</div></main>
<dialog class="ldlg" id="ldlg" role="dialog" aria-modal="true" aria-labelledby="l-title" aria-describedby="l-name"><form method="dialog" id="l-form">
<h2 id="l-title" tabindex="-1">Launch this survey?</h2><p class="small muted" id="l-name"></p>
<div><b>Before you launch, the four rules of how it works:</b><ol id="l-rules" aria-live="polite"></ol></div>
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
const color=c=>/^#[0-9a-fA-F]{3,6}$/.test(c||'')?c:null
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(r.status===401)location.reload();if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const STATUS={running:'Running',draft:'Draft',stopped:'Stopped',archived:'Archived'}
let LIST=[],current=null,listRequest=0,busy=false
const listPager=makePager({mount:$('list-pager'),noun:'surveys',size:25,draw:renderList})
async function loadList(){const request=++listRequest;try{const d=await api('/replays/surveys/api/list?days='+$('days').value);if(request!==listRequest)return;LIST=d.surveys;drawList();$('page-msg').setAttribute('role','status');$('page-msg').textContent='';
  const want=location.hash.slice(1)||(LIST[0]&&LIST[0].id);if(want&&want!==current)await show(want);else if(!LIST.length){current=null;$('detail').innerHTML='<div class="card"><p class="empty">No surveys yet. <a href="/replays/connect">Set up chat</a> to make your first survey.</p></div>'}}
  catch(e){if(request!==listRequest)return;if(!LIST.length)$('list').innerHTML='<p class="empty">Surveys could not load.</p>';$('page-msg').setAttribute('role','alert');$('page-msg').textContent=e.message+' Change the period to try again.'}}
function drawList(){const active=document.activeElement,id=active&&active.dataset.id;listPager.set(LIST,true);if(id){const b=Array.from($('list').querySelectorAll('.item')).find(b=>b.dataset.id===id);if(b)b.focus()}}
function renderList(items){$('list').innerHTML=items.map(s=>'<button type="button" class="item" data-id="'+esc(s.id)+'" aria-current="'+(s.id===current)+'" aria-controls="detail"><b><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status]||s.status)+'</span>'+esc(s.name)+'</b><small>'+num(s.shown)+' shown · '+num(s.answered)+' answered'+(s.clients==='all'?' · every client':' · '+esc(s.clients.slice(0,3).join(', '))+(s.clients.length>3?' +'+(s.clients.length-3):''))+'</small></button>').join('')||'<p class="empty">No surveys yet. Make your first survey in chat.</p>'
  $('list').querySelectorAll('.item').forEach(b=>b.onclick=()=>{location.hash=b.dataset.id})}
window.onhashchange=()=>{const id=location.hash.slice(1);if(id&&id!==current)show(id)}
$('days').onchange=()=>{$('page-msg').setAttribute('role','status');$('page-msg').textContent='Loading surveys…';listPager.set([]);loadList()}

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
  return '<div class="screen" role="img" aria-label="The survey over the app, '+esc(pos.replace('_',' '))+': '+esc(q.text)+(q.description?' — '+esc(q.description):'')+(q.choices?' Choices: '+esc(q.choices.join(', ')):' Type: '+esc(q.type))+'"><div class="bar"><i></i><i></i><i></i></div><div class="grid"></div>'+box+'<span class="note">Reval</span></div>'
    +(s.questions.length>1?'<p class="small muted">Then '+(s.questions.length-1)+' more: '+s.questions.slice(1).map(x=>'"'+esc(x.text)+'" ('+esc(x.type)+')').join(', ')+'</p>':'')
    +(l.thank_you?'<p class="small muted">After the answer: "'+esc(l.thank_you)+'"'+(l.thank_you_text?' · '+esc(l.thank_you_text):'')+'</p>':'')
    +'<p class="small muted">Preview only. Users answer this survey in Reval.</p>'}

function chain(s){const st=s.steps.map((t,i)=>'<div class="st"><b>Step '+(i+1)+'</b>'+esc(t)+'</div>').join('<span class="ar" aria-hidden="true">→</span>')
  return '<div class="chain">'+(st||'<div class="st">No steps</div>')+'<span class="ar" aria-hidden="true">→</span><div class="st end"><b>Then</b>Survey shows'+(s.waits_for_page?' once the page has loaded':'')+'</div></div>'}

function bars(dist){const e=Object.entries(dist||{}),max=Math.max(1,...e.map(x=>x[1]));return '<div class="bars">'+e.map(([k,n])=>'<div class="row"><span>'+esc(k)+'</span><div><div class="bar" aria-hidden="true" style="width:'+(n/max*100)+'%"></div></div><span class="n">'+num(n)+'</span></div>').join('')+'</div>'}

function perDay(rows){if(!rows.length)return '<p class="small muted">Nothing shown in this period.</p>';const W=600,H=120,max=Math.max(1,...rows.map(r=>r.shown)),bw=Math.min(28,Math.max(2,W/rows.length-2))
  return '<div class="days"><svg viewBox="0 0 '+W+' '+(H+18)+'" width="'+W+'" role="img" aria-label="Shown and answered per day">'+rows.map((r,i)=>{const x=i*(W/rows.length),h=r.shown/max*H,a=r.answered/max*H;return '<rect x="'+x+'" y="'+(H-h)+'" width="'+bw+'" height="'+h+'" fill="var(--grid)"><title>'+esc(r.day)+': '+r.shown+' shown</title></rect><rect x="'+x+'" y="'+(H-a)+'" width="'+bw+'" height="'+a+'" fill="var(--act)"><title>'+esc(r.day)+': '+r.answered+' answered</title></rect>'}).join('')+'<text x="0" y="'+(H+14)+'" font-size="11" fill="var(--muted)">'+esc(rows[0].day)+'</text><text x="'+W+'" y="'+(H+14)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+esc(rows[rows.length-1].day)+'</text></svg><p class="small muted">Grey: shown. Blue: answered.</p></div><details><summary>Daily counts as a table</summary><table><caption class="sr-only">Daily survey counts</caption><thead><tr><th scope="col">Day</th><th scope="col">Shown</th><th scope="col">Answered</th></tr></thead><tbody id="daily-rows"></tbody></table><div id="daily-pager"></div></details>'}

async function show(id){current=id;$('list').querySelectorAll('.item').forEach(b=>b.setAttribute('aria-current',String(b.dataset.id===id)));$('detail').setAttribute('aria-busy','true');$('page-msg').setAttribute('role','status');$('page-msg').textContent='Loading survey…';$('detail').innerHTML='<div class="card"><p class="empty">Loading…</p></div>'
  let r;try{r=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'?days=90')}catch(e){if(current!==id)return;$('detail').removeAttribute('aria-busy');$('page-msg').textContent='';$('detail').innerHTML='<div class="card"><p class="err" role="alert">'+esc(e.message)+' Try loading this survey again.</p><button type="button" class="ghost" id="detail-retry">Try again</button></div>';$('detail-retry').onclick=()=>show(id);return}
  if(current!==id)return
  $('detail').removeAttribute('aria-busy');$('page-msg').textContent='Survey loaded: '+r.survey.name
  const s=r.survey
  const acts=!CAN_LAUNCH?'<span class="small muted">Launching and stopping needs the launch survey role.</span>':(s.status==='draft'||s.status==='stopped'?'<button type="button" id="a-launch">'+(s.status==='draft'?'Launch':'Start again')+'</button>':'')+(s.status==='running'?'<button type="button" id="a-stop" class="ghost">Stop</button>':'')+'<button type="button" id="a-archive" class="ghost">Archive</button>'
  const launched=(r.launches||[])[0]
  const facts=[['Clients',(s.clients==='all'?'Every client':s.clients.join(', '))+(s.sample_percent<100?' · '+s.sample_percent+'% of their users':'')],['Shows',s.show==='every_time'?'Every time the steps happen':'Once per user'],['Steps must happen within',s.within_minutes?s.within_minutes+' minutes':'No limit (same page)'],
    ['Starts over when',s.reset_on.length?s.reset_on.join('; '):'Never (a page reload starts over)'],['Days between any two surveys',s.days_between_surveys||'None'],['Protecting users',s.pacing?'At most '+s.pacing.per_user+' running at once · '+s.pacing.gap_hours+' h apart at least · '+s.pacing.quiet_days_after_close+' quiet days after a close':'PostHog rules only'],['Only on pages containing',s.url_contains||'Any page'],['Stops after',s.max_responses?num(s.max_responses)+' answers':'No limit'],
    ['Made',new Date(s.created).toLocaleString()+(s.created_by?' by '+s.created_by:'')+(s.made_by_lens?' (Lens)':' (in PostHog)')],['Running since',s.started?new Date(s.started).toLocaleString():'Not launched'+(s.stopped?'':'')]].concat(s.stopped?[['Stopped',new Date(s.stopped).toLocaleString()]]:[]).concat(launched?[['Launched under',launched.ticket+(launched.ticket_summary?' · '+launched.ticket_summary:'')+' · by '+launched.launched_by+' ('+launched.via+'), '+new Date(launched.at).toLocaleString()]]:[])
  const qs=r.questions.map((q,i)=>'<div class="q"><h3>'+esc(q.text)+'</h3><p class="small muted">'+num(q.answers)+' answers'+(q.average!=null?' · average '+q.average:'')+(q.nps?' · NPS '+q.nps.score+' ('+q.nps.promoters+' promoters, '+q.nps.passives+' passives, '+q.nps.detractors+' detractors)':'')+'</p>'+(q.distribution?'<div id="dist-'+i+'"></div><div id="dist-pager-'+i+'"></div>':'')+(q.recent?'<p class="small muted">Latest written answers (up to 30).</p><div id="answers-'+i+'"></div><div id="answers-pager-'+i+'"></div>':'')+'</div>').join('')
  $('detail').innerHTML='<div class="card"><div class="head"><h2><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status])+'</span>'+esc(s.name)+'</h2><div class="acts">'+acts+'</div></div>'+(s.description?'<p class="muted">'+esc(s.description)+'</p>':'')+'<p id="a-msg" class="small" role="status" aria-live="polite"></p>'
    +'<h2>When it shows</h2>'+chain(s)+(r.queue?'<div class="conf'+(r.queue.level==='clear'?' ok':'')+'" role="'+(r.queue.level==='clear'?'status':'alert')+'"><b>'+(r.queue.level==='clear'?'No overlap with other surveys.':'Notice for whoever runs this survey')+'</b> '+esc(r.queue.alert)+(r.conflicts.length?'<ul id="conflict-rows"></ul><div id="conflict-pager"></div>':'')+'</div>':'')+'<div class="facts">'+facts.map(([k,x])=>'<div><span>'+esc(k)+'</span>'+esc(x)+'</div>').join('')+'</div>'
    +(s.made_by_lens?'<p style="margin-top:10px"><button type="button" id="a-reach" class="ghost">How many would have seen it? (last 14 days)</button></p><div id="reach" aria-live="polite"></div>':'')+'</div>'
    +'<div class="card"><h2>How it looks</h2>'+preview(s)+'</div>'
    +'<div class="card"><h2>Results · last 90 days</h2><div class="tiles">'+(r.chain_completed!=null?'<div class="tile"><span>Steps completed</span><b>'+num(r.chain_completed)+'</b></div>':'')+'<div class="tile"><span>Shown</span><b>'+num(r.shown)+'</b></div><div class="tile"><span>Answered</span><b>'+num(r.answered)+'</b></div><div class="tile"><span>Dismissed</span><b>'+num(r.dismissed)+'</b></div><div class="tile"><span>Answer rate</span><b>'+(r.response_rate==null?'–':r.response_rate+'%')+'</b></div></div>'
    +(r.chain_completed!=null&&r.chain_completed>r.shown?'<p class="small muted">Steps can complete without the survey showing: the user already answered or dismissed it, saw another survey recently, or the page stayed busy.</p>':'')
    +perDay(r.by_day)+'</div>'
    +'<div class="card"><h2>Answers</h2>'+(qs||'<p class="muted">No questions.</p>')+'</div>'
    +'<div class="card"><h2>By client</h2><p class="small muted">Up to 100 clients, ordered by times shown.</p>'+(r.by_client.length?'<table><caption class="sr-only">Survey results by client</caption><thead><tr><th scope="col">Client</th><th scope="col" class="n">Shown</th><th scope="col" class="n">Answered</th><th scope="col" class="n">Dismissed</th></tr></thead><tbody id="client-rows"></tbody></table><div id="client-pager"></div>':'<p class="small muted">No activity yet. Results appear here after users see the survey.</p>')+'</div>'
  if($('conflict-pager'))makePager({mount:$('conflict-pager'),noun:'overlapping surveys',size:25,draw:items=>{$('conflict-rows').innerHTML=items.map(c=>'<li><a href="#'+esc(c.survey_id)+'">'+esc(c.name)+'</a>: '+esc(c.text.replace(/^[^:]*: /,''))+' ('+esc(c.clients==='all'?'every client':c.clients.join(', '))+')</li>').join('')}}).set(r.conflicts)
  r.questions.forEach((q,i)=>{
    if(q.distribution)makePager({mount:$('dist-pager-'+i),noun:'answer choices',label:'Question '+(i+1)+' answer choices',size:25,draw:items=>{$('dist-'+i).innerHTML=bars(Object.fromEntries(items))}}).set(Object.entries(q.distribution))
    if(q.recent)makePager({mount:$('answers-pager-'+i),noun:'answers',label:'Question '+(i+1)+' written answers',size:25,draw:items=>{$('answers-'+i).innerHTML=items.map(a=>'<div class="ans">'+esc(a.text)+'<small>'+esc(a.client)+' · '+esc(new Date(a.at).toLocaleString())+'</small></div>').join('')||'<p class="small muted">No written answers yet. Check back after users answer.</p>'}}).set(q.recent)
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
