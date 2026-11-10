// The Surveys page: every in-app survey, what makes it appear, how it looks, and the answers, with
// Launch, Stop and Archive. PMs make and change surveys in chat (MCP tools); this page is where they and
// their team come back to see them. Admins, and anyone an admin ticked "Surveys" for.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, surveysActive } from '../core/config.ts'
import { archiveSurvey, estimateReach, getSurvey, launchSurvey, stopSurvey, surveyOverview, surveyResults } from '../core/surveys.ts'
import { audit, canUseSurveys, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
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
        const m = /^\/replays\/surveys\/api\/survey\/([0-9a-f-]{8,64})(?:\/(launch|stop|archive|reach))?$/i.exec(p)
        if (m && !m[2] && req.method === 'GET') return (json(res, 200, await surveyResults(m[1], days(url, 90))), true)
        if (m && m[2] === 'reach' && req.method === 'GET') {
            const s = await getSurvey(m[1])
            const chain = s.conditions?.lensChain
            if (chain?.managedBy !== 'lens') return (json(res, 400, { error: 'Only surveys made in Lens have steps to count.' }), true)
            return (json(res, 200, await estimateReach(chain, days(url, 14))), true)
        }
        if (m && m[2] && req.method === 'POST') {
            const s = m[2] === 'launch' ? await launchSurvey(m[1]) : m[2] === 'stop' ? await stopSurvey(m[1]) : await archiveSurvey(m[1])
            audit(v.email, `survey.${m[2] === 'launch' ? 'launched' : m[2] === 'stop' ? 'stopped' : 'archived'}`, { survey: s.id, name: s.name })
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
.head{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}.head h1{margin:0;font-size:21px;overflow-wrap:anywhere}.head .acts{display:flex;gap:6px;flex-wrap:wrap}
.chain{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;margin:6px 0 10px}
.chain .st{background:var(--chip);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font-size:13.5px;max-width:100%;overflow-wrap:anywhere}.chain .st b{display:block;font-size:11px;color:var(--muted);font-weight:600}
.chain .ar{align-self:center;color:var(--muted)}.chain .st.end{background:var(--act);color:#fff;border-color:var(--act)}.chain .st.end b{color:#e6efff}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:4px 16px;font-size:14px}.facts div{padding:5px 0;border-top:1px solid var(--line)}.facts span{color:var(--muted);display:block;font-size:12.5px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:8px 0 12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.tile span{display:block;font-size:12.5px;color:var(--muted)}.tile b{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.bars .row{display:grid;grid-template-columns:minmax(60px,30%) minmax(0,1fr) 48px;gap:8px;align-items:center;font-size:13.5px;margin:4px 0}.bars .row span{overflow-wrap:anywhere}.bars .bar{height:14px;border-radius:4px;background:var(--act);min-width:2px}.bars .n{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.q{border-top:1px solid var(--line);padding:10px 0}.q h3{font-size:15px;margin:0 0 4px}.ans{border-left:3px solid var(--line);padding:4px 10px;margin:6px 0;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere}.ans small{display:block;color:var(--muted)}
.preview{display:flex;justify-content:center;padding:14px;background:repeating-linear-gradient(45deg,var(--chip),var(--chip) 10px,transparent 10px,transparent 20px);border-radius:10px}
.pv{width:100%;max-width:340px;border-radius:10px;padding:14px 16px 8px;border:1.5px solid;box-shadow:0 6px 22px rgba(0,0,0,.18);font-size:14px}.pv h4{margin:0 0 10px;font-size:15px}.pv .scale{display:flex;gap:4px}.pv .scale i{flex:1;text-align:center;font-style:normal;padding:6px 0;border-radius:5px;font-size:13px}
.pv .lbl{display:flex;justify-content:space-between;font-size:11.5px;opacity:.75;margin:4px 0 10px}.pv .btn{display:block;text-align:center;padding:8px;border-radius:6px;font-weight:600;margin:10px 0 6px}.pv .ft{text-align:center;font-size:11px;opacity:.65;padding:4px 0}
.pv .box{border:1px solid rgba(127,127,127,.5);border-radius:6px;height:54px;opacity:.6}.pv .ch{border:1px solid rgba(127,127,127,.5);border-radius:6px;padding:6px 8px;margin:4px 0;font-size:13px}
table{width:100%;table-layout:fixed}td,th{overflow-wrap:anywhere}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.days svg{display:block;max-width:100%}
.empty{color:var(--muted);padding:24px 0;text-align:center}
.toolbar{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap}.toolbar select{padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
</style></head>
<body>${headerHtml(v, 'Surveys')}<main class="wide">
<div class="layout">
<section><div class="toolbar"><h2 style="margin:0">Surveys</h2><select id="days" aria-label="Counts over"><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last year</option></select></div>
<div class="list" id="list"><p class="empty">Loading…</p></div>
<p class="small muted">Make or change a survey in chat: describe which dialog, button or message should show it, for which clients, and how it should look. Lens checks it and saves a draft; it reaches users only after you launch it.</p></section>
<section id="detail"><div class="card"><p class="empty">Pick a survey.</p></div></section>
</div></main>
<script>${CLIENT.replace('__BRAND__', JSON.stringify(config.surveys.brand))}</script></body></html>`
}

// Runs in the browser. Survey names, questions and answers come from people: everything goes through esc().
const CLIENT = String.raw`
const BRAND=__BRAND__
const $=id=>document.getElementById(id)
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const num=n=>n==null?'–':Number(n).toLocaleString('en-US')
const color=c=>/^#[0-9a-fA-F]{3,6}$/.test(c||'')?c:null
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(r.status===401)location.reload();if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const STATUS={running:'Running',draft:'Draft',stopped:'Stopped',archived:'Archived'}
let LIST=[],current=null
async function loadList(){try{const d=await api('/replays/surveys/api/list?days='+$('days').value);LIST=d.surveys;drawList();
  const want=location.hash.slice(1)||(LIST[0]&&LIST[0].id);if(want&&want!==current)show(want);else if(!LIST.length)$('detail').innerHTML='<div class="card"><p class="empty">No surveys yet. Ask in chat, for example: "Ask ACME users how easy booking a hedge was, right after they save one."</p></div>'}
  catch(e){$('list').innerHTML='<p class="err">'+esc(e.message)+'</p>'}}
function drawList(){$('list').innerHTML=LIST.map(s=>'<button class="item" data-id="'+esc(s.id)+'" aria-current="'+(s.id===current)+'"><b><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status]||s.status)+'</span>'+esc(s.name)+'</b><small>'+num(s.shown)+' shown · '+num(s.answered)+' answered'+(s.clients==='all'?' · every client':' · '+esc(s.clients.slice(0,3).join(', '))+(s.clients.length>3?' +'+(s.clients.length-3):''))+'</small></button>').join('')||'<p class="empty">No surveys yet.</p>'
  $('list').querySelectorAll('.item').forEach(b=>b.onclick=()=>{location.hash=b.dataset.id})}
window.onhashchange=()=>{const id=location.hash.slice(1);if(id&&id!==current)show(id)}
$('days').onchange=loadList

function preview(s){const l=s.look||{},bg=color(l.background)||'#fff',fg=color(l.text)||'#1d1f27',bt=color(l.button)||'#0b5cad',btt=color(l.button_text)||'#fff',rb=color(l.rating)||'#eef1f5',ra=color(l.rating_active)||bt,bd=color(l.border)||'#c9d1dc'
  const q=s.questions[0];if(!q)return ''
  let body=''
  if(q.type==='rating'||q.type==='nps'){const n=q.scale||(q.type==='nps'?10:5),start=n===10?0:1;body='<div class="scale">'+Array.from({length:n===10?11:n},(_,i)=>'<i style="background:'+(i===Math.floor(n/2)?ra:rb)+';color:'+(i===Math.floor(n/2)?btt:fg)+'">'+(start+i)+'</i>').join('')+'</div><div class="lbl"><span>'+(q.type==='nps'?'Not likely':'')+'</span><span>'+(q.type==='nps'?'Very likely':'')+'</span></div>'}
  else if(q.choices)body=q.choices.slice(0,5).map(c=>'<div class="ch">'+esc(c)+'</div>').join('')
  else body='<div class="box"></div>'
  return '<div class="preview"><div class="pv" style="background:'+bg+';color:'+fg+';border-color:'+bd+'"><h4>'+esc(q.text)+'</h4>'+body+'<span class="btn" style="background:'+bt+';color:'+btt+'">'+esc(l.submit_label||'Submit')+'</span><div class="ft">'+esc(BRAND)+'</div></div></div>'+(s.questions.length>1?'<p class="small muted">Then '+(s.questions.length-1)+' more: '+s.questions.slice(1).map(x=>'"'+esc(x.text)+'"').join(', ')+'</p>':'')+'<p class="small muted">A close likeness: the real one is drawn by PostHog\'s survey script in the app, '+esc(l.position||'right')+' side.</p>'}

function chain(s){const st=s.steps.map((t,i)=>'<div class="st"><b>Step '+(i+1)+'</b>'+esc(t)+'</div>').join('<span class="ar" aria-hidden="true">→</span>')
  return '<div class="chain">'+(st||'<div class="st">No steps</div>')+'<span class="ar" aria-hidden="true">→</span><div class="st end"><b>Then</b>Survey shows'+(s.waits_for_page?' once the page has loaded':'')+'</div></div>'}

function bars(dist){const e=Object.entries(dist||{}),max=Math.max(1,...e.map(x=>x[1]));return '<div class="bars">'+e.map(([k,n])=>'<div class="row"><span>'+esc(k)+'</span><div><div class="bar" style="width:'+(n/max*100)+'%"></div></div><span class="n">'+num(n)+'</span></div>').join('')+'</div>'}

function perDay(rows){if(!rows.length)return '<p class="small muted">Nothing shown in this period.</p>';const W=600,H=120,max=Math.max(1,...rows.map(r=>r.shown)),bw=Math.min(28,Math.max(2,W/rows.length-2))
  return '<div class="days"><svg viewBox="0 0 '+W+' '+(H+18)+'" width="'+W+'" role="img" aria-label="Shown and answered per day">'+rows.map((r,i)=>{const x=i*(W/rows.length),h=r.shown/max*H,a=r.answered/max*H;return '<rect x="'+x+'" y="'+(H-h)+'" width="'+bw+'" height="'+h+'" fill="var(--grid)"><title>'+esc(r.day)+': '+r.shown+' shown</title></rect><rect x="'+x+'" y="'+(H-a)+'" width="'+bw+'" height="'+a+'" fill="var(--act)"><title>'+esc(r.day)+': '+r.answered+' answered</title></rect>'}).join('')+'<text x="0" y="'+(H+14)+'" font-size="11" fill="var(--muted)">'+esc(rows[0].day)+'</text><text x="'+W+'" y="'+(H+14)+'" font-size="11" text-anchor="end" fill="var(--muted)">'+esc(rows[rows.length-1].day)+'</text></svg><p class="small muted">Grey: shown. Blue: answered.</p></div>'}

async function show(id){current=id;drawList();$('detail').innerHTML='<div class="card"><p class="empty">Loading…</p></div>'
  let r;try{r=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'?days=90')}catch(e){$('detail').innerHTML='<div class="card"><p class="err">'+esc(e.message)+'</p></div>';return}
  if(current!==id)return
  const s=r.survey
  const acts=(s.status==='draft'||s.status==='stopped'?'<button id="a-launch">'+(s.status==='draft'?'Launch':'Start again')+'</button>':'')+(s.status==='running'?'<button id="a-stop" class="ghost">Stop</button>':'')+'<button id="a-archive" class="ghost">Archive</button>'
  const facts=[['Clients',s.clients==='all'?'Every client':s.clients.join(', ')],['Shows',s.show==='every_time'?'Every time the steps happen':'Once per user'],['Steps must happen within',s.within_minutes?s.within_minutes+' minutes':'No limit (same page)'],
    ['Starts over when',s.reset_on.length?s.reset_on.join('; '):'Never (a page reload starts over)'],['Days between any two surveys',s.days_between_surveys||'None'],['Only on pages containing',s.url_contains||'Any page'],['Stops after',s.max_responses?num(s.max_responses)+' answers':'No limit'],
    ['Made',new Date(s.created).toLocaleString()+(s.created_by?' by '+s.created_by:'')+(s.made_by_lens?' (Lens)':' (in PostHog)')],['Running since',s.started?new Date(s.started).toLocaleString():'Not launched'+(s.stopped?'':'')]].concat(s.stopped?[['Stopped',new Date(s.stopped).toLocaleString()]]:[])
  const qs=r.questions.map(q=>'<div class="q"><h3>'+esc(q.text)+'</h3><p class="small muted">'+num(q.answers)+' answers'+(q.average!=null?' · average '+q.average:'')+(q.nps?' · NPS '+q.nps.score+' ('+q.nps.promoters+' promoters, '+q.nps.passives+' passives, '+q.nps.detractors+' detractors)':'')+'</p>'+(q.distribution?bars(q.distribution):'')+(q.recent?(q.recent.length?q.recent.map(a=>'<div class="ans">'+esc(a.text)+'<small>'+esc(a.client)+' · '+esc(new Date(a.at).toLocaleString())+'</small></div>').join(''):'<p class="small muted">No written answers yet.</p>'):'')+'</div>').join('')
  $('detail').innerHTML='<div class="card"><div class="head"><h1><span class="chip '+esc(s.status)+'">'+esc(STATUS[s.status])+'</span>'+esc(s.name)+'</h1><div class="acts">'+acts+'</div></div>'+(s.description?'<p class="muted">'+esc(s.description)+'</p>':'')+'<p id="a-msg" class="small"></p>'
    +'<h2>When it shows</h2>'+chain(s)+'<div class="facts">'+facts.map(([k,x])=>'<div><span>'+esc(k)+'</span>'+esc(x)+'</div>').join('')+'</div>'
    +(s.made_by_lens?'<p style="margin-top:10px"><button id="a-reach" class="ghost">How many would have seen it? (last 14 days)</button></p><div id="reach"></div>':'')+'</div>'
    +'<div class="card"><h2>How it looks</h2>'+preview(s)+'</div>'
    +'<div class="card"><h2>Results · last 90 days</h2><div class="tiles">'+(r.chain_completed!=null?'<div class="tile"><span>Steps completed</span><b>'+num(r.chain_completed)+'</b></div>':'')+'<div class="tile"><span>Shown</span><b>'+num(r.shown)+'</b></div><div class="tile"><span>Answered</span><b>'+num(r.answered)+'</b></div><div class="tile"><span>Dismissed</span><b>'+num(r.dismissed)+'</b></div><div class="tile"><span>Answer rate</span><b>'+(r.response_rate==null?'–':r.response_rate+'%')+'</b></div></div>'
    +(r.chain_completed!=null&&r.chain_completed>r.shown?'<p class="small muted">Steps can complete without the survey showing: the user already answered or dismissed it, saw another survey recently, or the page stayed busy.</p>':'')
    +perDay(r.by_day)+'</div>'
    +'<div class="card"><h2>Answers</h2>'+(qs||'<p class="muted">No questions.</p>')+'</div>'
    +'<div class="card"><h2>By client</h2>'+(r.by_client.length?'<table><thead><tr><th>Client</th><th class="n">Shown</th><th class="n">Answered</th><th class="n">Dismissed</th></tr></thead><tbody>'+r.by_client.map(c=>'<tr><td>'+esc(c.client)+'</td><td class="n">'+num(c.shown)+'</td><td class="n">'+num(c.answered)+'</td><td class="n">'+num(c.dismissed)+'</td></tr>').join('')+'</tbody></table>':'<p class="small muted">Not shown to anyone yet.</p>')+'</div>'
  const act=(name,ask)=>async()=>{if(ask&&!confirm(ask))return;try{await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/'+name,{method:'POST'});if(name==='archive')location.hash='';current=null;await loadList()}catch(e){$('a-msg').textContent=e.message;$('a-msg').className='small err'}}
  if($('a-launch'))$('a-launch').onclick=act('launch','Show "'+s.name+'" to '+(s.clients==='all'?'every client':s.clients.join(', '))+' from now on?')
  if($('a-stop'))$('a-stop').onclick=act('stop','Stop showing "'+s.name+'"? Its answers stay.')
  $('a-archive').onclick=act('archive','Archive "'+s.name+'"? It stops and leaves this list. Its answers stay in PostHog.')
  if($('a-reach'))$('a-reach').onclick=async()=>{$('reach').innerHTML='<p class="small muted">Counting…</p>';try{const x=await api('/replays/surveys/api/survey/'+encodeURIComponent(id)+'/reach');$('reach').innerHTML='<p><b>'+num(x.sessions)+'</b> sessions, '+num(x.users)+' users at '+num(x.clients)+' clients.</p>'+bars(Object.fromEntries(x.by_step.map((b,i)=>['Step '+(i+1)+': '+b.step,b.sessions])))+(x.top_clients.length?'<p class="small muted">Most: '+x.top_clients.map(c=>esc(c.client)+' ('+num(c.sessions)+')').join(', ')+'</p>':'')+'<p class="small muted">'+esc(x.note)+'</p>'}catch(e){$('reach').innerHTML='<p class="err">'+esc(e.message)+'</p>'}}
}
loadList();setInterval(()=>{if(document.visibilityState==='visible')loadList()},60000)
`
