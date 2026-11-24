// The Watchlist page: clients whose replays Lens reads step by step (core/watchlist.ts), the sessions
// most worth watching, the same problem repeating across sessions, and one session's steps on a timeline.
// Who may open it: people with the "Watch clips" role and the replay-insights grant (as for client
// experience on the Dashboards page). Changing the list also needs dashboard sharing rights.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { MARK_TEXT, MARKS, type Mark } from '../core/replaymoments.ts'
import { changeWatch, highlights, readNow, repeatedProblems, sessionDetail, watchableClients, watchlist, watchRunning, WATCH_DAYS, type WatchAction } from '../core/watchlist.ts'
import { audit, can, canDashboard, canSeeReplayInsights, type Viewer } from './access.ts'
import { APP_NAME, esc, headerHtml, PAGE_CSS, PAGER_JS } from './replays.ts'
import { config } from '../core/config.ts'

const DAY = 86_400_000
export const canOpenWatch = (v: Viewer) => can(v.role, 'watch') && canSeeReplayInsights(v)
export const canManageWatch = (v: Viewer) => canOpenWatch(v) && (can(v.role, 'admin') || canDashboard(v.dashboards, 'share'))

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let size = 0
    const chunks: Buffer[] = []
    for await (const c of req) { size += (c as Buffer).length; if (size > 10_000) throw new Error('body too large'); chunks.push(c as Buffer) }
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
const PERIODS: Record<string, number> = { '1': 1, '7': 7, '14': 14, '30': 30 }
function filterOf(url: URL) {
    const asked = url.searchParams.get('days') || '7', days = Object.hasOwn(PERIODS, asked) ? PERIODS[asked] : 7
    const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - (days - 1) * DAY).toISOString().slice(0, 10)
    const kind = url.searchParams.get('kind') || ''
    const client = url.searchParams.get('client') || ''
    return { from, to, ...(client ? { client } : {}), ...((MARKS as readonly string[]).includes(kind) ? { kinds: [kind as Mark] } : {}) }
}

export async function handleWatch(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    if (!canOpenWatch(v)) return (json(res, 403, { error: 'The Watchlist needs the replay insights grant. Ask a Lens admin.' }), true)
    if (p === '/replays/watch/api/state' && req.method === 'GET') {
        const list = watchlist(), on = new Set(list.map((c) => c.client))
        json(res, 200, { watchlist: list.map((c) => ({ ...c, last_error: c.last_error ? 'PostHog did not answer' : null })), clients: watchableClients().filter((c) => !on.has(c.id)).slice(0, 2000), canManage: canManageWatch(v), running: watchRunning(), days: WATCH_DAYS() })
        return true
    }
    if (p === '/replays/watch/api/highlights' && req.method === 'GET') {
        const f = filterOf(url)
        const h = highlights(f, 200)
        json(res, 200, { ...h, problems: repeatedProblems(f), window: { from: f.from, to: f.to } })
        return true
    }
    if (p === '/replays/watch/api/session' && req.method === 'GET') {
        const d = sessionDetail(String(url.searchParams.get('id') || ''))
        if (!d) return (json(res, 404, { error: 'Replay unavailable: this session is not on the watchlist.' }), true)
        audit(v.email, 'watch.session.opened', { session_id: d.session_id, client: d.client })
        json(res, 200, d)
        return true
    }
    if (p === '/replays/watch/api/change' && req.method === 'POST') {
        if (!canManageWatch(v)) return (json(res, 403, { error: 'Changing the watchlist needs dashboard sharing rights. Ask a Lens admin.' }), true)
        const body = await readJson(req)
        const action = String(body.action || '') as WatchAction
        if (!['add', 'pause', 'resume', 'remove'].includes(action)) return (json(res, 400, { error: 'Unknown action.' }), true)
        try {
            const out = changeWatch(String(body.client || ''), action, v.email)
            audit(v.email, `watch.${action}`, { client: out.client })
            json(res, 200, out)
        } catch (e) { json(res, 400, { error: (e as Error).message }) }
        return true
    }
    if (p === '/replays/watch/api/read-now' && req.method === 'POST') {
        if (!canManageWatch(v)) return (json(res, 403, { error: 'Needs dashboard sharing rights.' }), true)
        json(res, 200, await readNow())
        return true
    }
    json(res, 404, { error: 'Not found.' })
    return true
}

const LANES: { name: string; kinds: Mark[]; fg: string; bg: string }[] = [
    { name: 'Errors', kinds: ['error_loop', 'failed_submit'], fg: 'var(--err)', bg: 'var(--err-bg)' },
    { name: 'Response', kinds: ['repeated_clicks', 'no_response', 'slow_response'], fg: 'var(--warn)', bg: 'var(--warn-bg)' },
    { name: 'Before acting', kinds: ['hesitation', 'circling', 'hover_no_click', 'long_pause'], fg: 'var(--accent)', bg: 'var(--accent-soft)' },
    { name: 'Navigation', kinds: ['field_back_and_forth', 'scroll_hunting'], fg: 'var(--ink)', bg: 'var(--chip)' },
]

export function watchHtml(v: Viewer): string {
    const boot = JSON.stringify({
        canManage: canManageWatch(v), marks: MARKS.map((k) => ({ key: k, text: MARK_TEXT[k] })), lanes: LANES, mcp: config.features.lensMcp, mcpName: config.mcp.name,
    }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Watchlist · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}
.w-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,368px);gap:var(--space-5);align-items:start}
@media(max-width:1180px){.w-grid{grid-template-columns:minmax(0,1fr)}}
.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 12px}.filters>div{min-width:170px;flex:0 1 220px}.filters .reset{align-self:flex-end}
.cov{margin:0 0 16px;min-height:20px}
.feed{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none}
.hl{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);padding:var(--space-4);min-width:0}
.hl.open{border-color:var(--line-strong)}
.hl-top{display:flex;gap:10px;align-items:flex-start;justify-content:space-between}.hl h3{margin:0;font-size:15px;line-height:22px;font-weight:600}
.hl .meta{margin:2px 0 8px;font-size:12.5px;color:var(--muted)}.hl .ev{margin:0 0 10px;font-size:var(--text-body);line-height:21px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;padding:0;list-style:none}.k{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;padding:2px 9px;border-radius:var(--r-pill);border:1px solid transparent}
.k i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.acts .btn,.acts button{min-height:32px;padding:5px 12px;font-size:13px}
.detail{margin-top:14px;border-top:1px solid var(--line);padding-top:14px}
.tl{position:relative;overflow-x:auto}.tl svg{display:block;width:100%;min-width:560px;height:auto}.tl text{font-size:11px;fill:var(--muted);font-family:inherit;font-variant-numeric:tabular-nums}
.tl .mk{cursor:pointer}.tl .mk:focus{outline:none}.tl .mk:focus-visible rect.box,.tl .mk.sel rect.box{stroke:var(--ink);stroke-width:2}
.tl-pick{min-height:22px;margin:8px 0 10px;font-size:13px}
.steps td{vertical-align:top}.steps tr.sel td{background:var(--accent-soft)}.steps td.t{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted)}
aside .card{padding:var(--space-4);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);margin:0 0 12px}aside h2{font-size:15px;margin:0 0 4px}.pr{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column}
.pr li{padding:10px 0;border-top:1px solid var(--line)}.pr li:first-child{border-top:0}.pr b{display:block;font-size:13.5px;font-weight:600}.pr .n{font-size:12.5px;color:var(--muted)}
.pr .ex{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;font-size:12.5px}.pr .ex a{text-decoration:underline;text-underline-offset:2px}
.pr .filt{margin-top:6px;min-height:28px;padding:2px 10px;font-size:12.5px}#pr-more{margin-top:8px;min-height:28px;padding:2px 0;font-size:13px}
.ask{margin-top:16px}.ask code{display:block;white-space:normal;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-sm);padding:8px 10px;font-size:12.5px;line-height:18px;margin:6px 0}
.addrow{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px}.addrow>div{flex:1 1 320px;max-width:460px}
td .st{display:inline-flex;align-items:center;gap:6px}td .st i{width:8px;height:8px;border-radius:50%;background:var(--ok)}td .st.off i{background:var(--control)}
.rowacts{display:flex;gap:6px;justify-content:flex-end}.rowacts button{min-height:28px;padding:3px 10px;font-size:12.5px}
.confirm{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex-wrap:wrap;font-size:12.5px}
.empty-card{text-align:center;padding:40px 24px}.empty-card h2{font-size:var(--text-section);margin:0 0 6px}.empty-card p{margin:0 0 14px;color:var(--muted)}
.skel{height:132px;border-radius:var(--r);background:var(--surface-2)}
@keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}@media(prefers-reduced-motion:reduce){.skel{animation:none}}
</style></head>
<body>${headerHtml(v, 'Watchlist')}<main class="wide">
<div class="page-head"><div><h1>Watchlist</h1><p>Find moments worth replaying in the sessions of the clients you watch.</p></div>
<div class="row" style="gap:8px"><button class="secondary hidden" id="readnow" type="button">Check for new highlights</button></div></div>
<div class="tabs" role="tablist" aria-label="Watchlist views"><button role="tab" id="tab-hl" aria-selected="true" aria-controls="view-hl" type="button">Highlights</button><button role="tab" id="tab-cl" aria-selected="false" aria-controls="view-cl" type="button">Clients</button></div>

<section id="view-hl" role="tabpanel" aria-labelledby="tab-hl">
<div class="filters" id="filters">
<div><label for="f-client">Client</label><select id="f-client"><option value="">All watched clients</option></select></div>
<div><label for="f-days">Period</label><select id="f-days"><option value="1">Last 24 hours</option><option value="7" selected>Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option></select></div>
<div><label for="f-kind">What happened</label><select id="f-kind"><option value="">Anything</option></select></div>
<button class="ghost reset hidden" id="f-reset" type="button">Reset filters</button>
</div>
<p class="cov small muted" id="cov" role="status" aria-live="polite"></p>
<div class="w-grid"><div><h2 class="sr-only" id="feed-h">Replay highlights</h2><ol class="feed" id="feed" aria-labelledby="feed-h"></ol><div id="feed-pager"></div></div>
<aside aria-labelledby="pr-h"><div class="card"><h2 id="pr-h">Repeated problems</h2><p class="small muted" style="margin:0">The same thing going wrong on the same control in several sessions.</p><ul class="pr" id="pr"></ul><button class="ghost hidden" id="pr-more" type="button" aria-expanded="false"></button></div>
<div class="card ask" id="ask"><h2>Ask in chat</h2><p class="small muted" style="margin:0">Copilot reads the same steps through Lens. Try:</p><code id="ask-q"></code><button class="ghost" id="ask-copy" type="button">Copy prompt</button> <span class="small muted" id="ask-done" aria-live="polite"></span></div></aside></div>
</section>

<section id="view-cl" role="tabpanel" aria-labelledby="tab-cl" hidden>
<div class="card"><h2>Watched clients</h2><p class="small muted">Lens reads each watched client's finished replays from the last <span id="days">14</span> days, a few every 10 minutes, on this machine. It keeps the steps only: control names, timings and counts. Never typed values, screen text or pointer positions.</p>
<div class="addrow hidden" id="addrow"><div><label for="add-client">Add a client</label><input id="add-client" list="add-list" autocomplete="off" placeholder="Start typing a client name"><datalist id="add-list"></datalist></div><button id="add-go" type="button">Add to watchlist</button></div>
<p class="small err" id="cl-msg" role="alert"></p>
<div class="table-wrap" role="region" aria-label="Watched clients" tabindex="0"><table><thead><tr><th scope="col">Client</th><th scope="col">Status</th><th scope="col" class="num" title="Finished replays found in the period">Found</th><th scope="col" class="num">Read</th><th scope="col" class="num" title="Replays found and still waiting to be read">Waiting</th><th scope="col" title="When Lens last finished reading a replay for this client">Last read</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody id="cl-rows"></tbody></table></div></div>
</section>
</main>
<script>${PAGER_JS}
const CFG=${boot};const $=id=>document.getElementById(id)
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
const api=async(path,opts={})=>{const r=await fetch('/replays/watch/api/'+path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1',...(opts.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||('Request failed ('+r.status+')'));return d}
const clock=ms=>{const s=Math.floor(ms/1000);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
const dur=ms=>ms<60000?Math.round(ms/1000)+' s':Math.round(ms/60000)+' min'
const when=iso=>new Date(iso).toLocaleString([], {weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})
const ago=iso=>{if(!iso)return 'Not yet';const m=Math.round((Date.now()-Date.parse(iso))/60000);return m<1?'Just now':m<60?m+' min ago':m<1440?Math.round(m/60)+' h ago':when(iso)}
const laneOf=k=>CFG.lanes.find(l=>l.kinds.includes(k))
const markText=k=>(CFG.marks.find(m=>m.key===k)||{}).text||k
const chip=k=>{const l=laneOf(k)||CFG.lanes[3];const c=el('li','k');const dot=el('i');dot.style.background=l.fg;c.appendChild(dot);c.appendChild(document.createTextNode(markText(k)));return c}
const SEV={high:['High','err'],medium:['Medium','warn'],low:['Low','']}
let state={watchlist:[],clients:[]},token=0,open=null,loaded=false
const q=new URLSearchParams(location.search)
$('f-client').value='';$('f-days').value=q.get('days')||'7'
CFG.marks.forEach(m=>{const o=el('option',null,m.text);o.value=m.key;$('f-kind').appendChild(o)})
$('f-kind').value=q.get('kind')||''

// ---------------------------------------------------------------- tabs
const tabs=[[$('tab-hl'),$('view-hl')],[$('tab-cl'),$('view-cl')]]
function show(i,focus){tabs.forEach(([t,p],j)=>{t.setAttribute('aria-selected',String(i===j));t.tabIndex=i===j?0:-1;p.hidden=i!==j});if(focus)tabs[i][0].focus();const u=new URL(location.href);if(i===1)u.searchParams.set('view','clients');else u.searchParams.delete('view');history.replaceState(null,'',u)}
tabs.forEach(([t],i)=>{t.onclick=()=>show(i);t.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();show((i+1)%2,true)}}})
if(q.get('view')==='clients')show(1);else show(0)

// ---------------------------------------------------------------- state and clients
async function loadState(){
  state=await api('state');$('days').textContent=state.days
  const sel=$('f-client'),keep=loaded?sel.value:(q.get('client')||'');loaded=true;sel.innerHTML='';const all=el('option',null,'All watched clients');all.value='';sel.appendChild(all)
  state.watchlist.forEach(c=>{const o=el('option',null,c.name+(c.paused?' (paused)':''));o.value=c.client;sel.appendChild(o)})
  sel.value=state.watchlist.some(c=>c.client===keep)?keep:''
  $('addrow').classList.toggle('hidden',!state.canManage);$('readnow').classList.toggle('hidden',!state.canManage||!state.watchlist.length)
  const dl=$('add-list');dl.innerHTML='';state.clients.forEach(c=>{const o=el('option');o.value=c.name===c.id?c.id:c.name+' · '+c.id;dl.appendChild(o)})
  drawClients()
}
function drawClients(){
  const tb=$('cl-rows');tb.innerHTML=''
  if(!state.watchlist.length){const tr=el('tr'),td=el('td','empty-state',state.canManage?'No clients on your watchlist. Add one above.':'No clients on the watchlist yet. Someone with dashboard sharing rights can add them.');td.colSpan=7;tr.appendChild(td);tb.appendChild(tr);return}
  state.watchlist.forEach(c=>{const tr=el('tr');tr.appendChild(el('td',null,c.name))
    const st=el('td');const s=el('span','st'+(c.paused?' off':''));s.appendChild(el('i'));s.appendChild(document.createTextNode(c.paused?'Paused':c.last_error?'Active · PostHog did not answer':'Active'));st.appendChild(s);tr.appendChild(st)
    ;[c.found,c.read,c.waiting].forEach(n=>tr.appendChild(el('td','num',String(n))))
    tr.appendChild(el('td','small',ago(c.last_read_at)))
    const a=el('td');const box=el('div','rowacts');a.appendChild(box);tr.appendChild(a)
    if(state.canManage){const b=el('button','secondary',c.paused?'Resume':'Pause');b.type='button';b.onclick=()=>change(c.client,c.paused?'resume':'pause',b);box.appendChild(b)
      const r=el('button','ghost','Remove');r.type='button';r.setAttribute('aria-label','Remove '+c.name);r.onclick=()=>{box.innerHTML='';const cf=el('div','confirm');cf.appendChild(el('span',null,'Remove '+c.name+'? Its steps are deleted.'));const y=el('button','danger','Remove');y.type='button';y.onclick=()=>change(c.client,'remove',y);const n=el('button','ghost','Cancel');n.type='button';n.onclick=()=>{drawClients();tb.querySelector('[aria-label="Remove '+CSS.escape(c.name)+'"]')?.focus()};cf.append(y,n);box.appendChild(cf);n.focus()};box.appendChild(r)}
    tb.appendChild(tr)})
}
async function change(client,action,btn){$('cl-msg').textContent='';if(btn)btn.disabled=true
  try{await api('change',{method:'POST',body:JSON.stringify({client,action})});await loadState();loadFeed()}catch(e){$('cl-msg').textContent='Couldn’t update the watchlist: '+e.message}finally{if(btn&&btn.isConnected)btn.disabled=false}}
$('add-go').onclick=()=>{const v=$('add-client').value.trim();if(!v)return $('add-client').focus();const m=state.clients.find(c=>v===c.id||v===c.name||v.endsWith(' · '+c.id));if(!m){$('cl-msg').textContent='No client matches “'+v+'”. Pick one from the list.';return}change(m.id,'add',$('add-go')).then(()=>{$('add-client').value=''})}
$('add-client').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();$('add-go').click()}}
$('readnow').onclick=async()=>{const b=$('readnow');b.disabled=true;$('cov').textContent='Checking for new highlights…'
  try{const r=await api('read-now',{method:'POST'});$('cov').textContent=r.started?'Checking for new highlights… new sessions appear here within a minute.':'A check is already running. New sessions appear here shortly.'}catch(e){$('cov').textContent='Couldn’t start a check: '+e.message}
  setTimeout(()=>{b.disabled=false;loadState().then(loadFeed)},60000)}

// ---------------------------------------------------------------- highlights
const pager=makePager({mount:$('feed-pager'),noun:'sessions',size:25,label:'Highlights',draw:items=>{const f=$('feed');f.innerHTML='';items.forEach(h=>f.appendChild(card(h)))}})
function filtersQS(){const p=new URLSearchParams();const c=$('f-client').value,d=$('f-days').value,k=$('f-kind').value;if(c)p.set('client',c);if(d!=='7')p.set('days',d);if(k)p.set('kind',k);return p}
function syncURL(){const u=new URL(location.href);['client','days','kind'].forEach(k=>u.searchParams.delete(k));filtersQS().forEach((v,k)=>u.searchParams.set(k,v));history.replaceState(null,'',u);$('f-reset').classList.toggle('hidden',![...filtersQS().keys()].length)}
;['f-client','f-days','f-kind'].forEach(id=>$(id).onchange=()=>{syncURL();loadFeed()})
$('f-reset').onclick=()=>{$('f-client').value='';$('f-days').value='7';$('f-kind').value='';syncURL();loadFeed();$('f-client').focus()}
function emptyCard(title,text,btn){const li=el('li','hl empty-card');li.appendChild(el('h2',null,title));li.appendChild(el('p',null,text));if(btn){const b=el('button',null,btn[0]);b.type='button';b.onclick=btn[1];li.appendChild(b)}return li}
async function loadFeed(){
  const my=++token;open=null;const f=$('feed');f.innerHTML='';for(let i=0;i<3;i++){const s=el('li','skel');s.setAttribute('aria-hidden','true');f.appendChild(s)}$('cov').textContent='Loading highlights…';$('pr').innerHTML=''
  askText()
  try{const d=await api('highlights?'+filtersQS());if(my!==token)return
    const c=d.coverage,n=x=>x.toLocaleString();$('cov').textContent=!state.watchlist.length?'':c.sessions_read?[n(c.sessions_read)+' sessions reviewed',n(c.with_highlights)+' with highlights',c.waiting?n(c.waiting)+' waiting':'',c.skipped?n(c.skipped)+' unreadable':''].filter(Boolean).join(' · '):(c.waiting?n(c.waiting)+' replays waiting to be reviewed':'')
    pager.set([]);f.innerHTML=''
    if(!state.watchlist.length){f.appendChild(emptyCard('No clients on your watchlist','Add a client and Lens starts reading its replays, step by step.',state.canManage?['Add a client',()=>{show(1);$('add-client').focus()}]:null));drawProblems([]);return}
    if(!d.items.length){const filtered=[...filtersQS().keys()].some(k=>k!=='days');f.appendChild(c.sessions_read?emptyCard(filtered?'No highlights match these filters':'Nothing stood out',filtered?'Try another client or kind, or a longer period.':'No struggles in the '+c.sessions_read+' sessions read in this period.',filtered?['Reset filters',()=>$('f-reset').click()]:null):emptyCard(c.waiting?'Replays are waiting to be read':'No replays found in this period',c.waiting?'Lens reads a few every 10 minutes. Check back shortly.':'Watched clients have no finished recordings in this period.',null));drawProblems(d.problems);return}
    pager.set(d.items);drawProblems(d.problems)
  }catch(e){if(my!==token)return;pager.set([]);f.innerHTML='';f.appendChild(emptyCard('Couldn’t load highlights',e.message,['Retry',loadFeed]));$('cov').textContent=''}
}
function clipLink(url,t){const a=el('a','btn',t);a.href=url;a.target='_blank';a.rel='noopener';return a}
function card(h){
  const li=el('li','hl');li.dataset.id=h.session_id
  const top=el('div','hl-top');const t=el('h3',null,h.headline);top.appendChild(t);const [sl,sc]=SEV[h.severity];const b=el('span','badge '+sc,sl);b.setAttribute('aria-label','Severity: '+sl);top.appendChild(b);li.appendChild(top)
  li.appendChild(el('p','meta',h.client_name+' · '+when(h.started_at)+' · '+dur(h.duration_ms)+' ('+dur(h.active_ms)+' active)'))
  li.appendChild(el('p','ev',h.evidence))
  const ch=el('ul','chips');ch.setAttribute('aria-label','What happened');h.marks.forEach(k=>ch.appendChild(chip(k)));li.appendChild(ch)
  const acts=el('div','acts');const watch=clipLink(h.moment.clip_page,'Watch from '+clock(h.moment.offset_s*1000));watch.classList.add('secondary');acts.appendChild(watch)
  const more=el('button','secondary','Session details');more.type='button';more.setAttribute('aria-expanded','false');more.onclick=()=>toggle(li,h,more);acts.appendChild(more)
  if(h.steps_marked>1)acts.appendChild(el('span','small muted',h.steps_marked+' moments in this session'))
  li.appendChild(acts);return li
}
async function toggle(li,h,btn){
  const ex=li.querySelector('.detail');if(ex){ex.remove();li.classList.remove('open');btn.textContent='Session details';btn.setAttribute('aria-expanded','false');open=null;return}
  if(open&&open.li!==li){const o=open;toggle(o.li,o.h,o.btn)}
  open={li,h,btn};btn.textContent='Close details';btn.setAttribute('aria-expanded','true');li.classList.add('open')
  const box=el('div','detail');box.appendChild(el('p','small muted','Loading the steps…'));li.appendChild(box)
  try{const d=await api('session?id='+encodeURIComponent(h.session_id));box.innerHTML='';drawDetail(box,d,h)}catch(e){box.innerHTML='';box.appendChild(el('p','small err',e.message))}
}
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&open){const b=open.btn;toggle(open.li,open.h,b);b.focus()}})
function drawDetail(box,d,h){
  box.appendChild(el('h4',null,'Timeline'))
  const wrap=el('div','tl');box.appendChild(wrap)
  const W=900,L=96,R=12,laneH=26,top=8,lanes=[...CFG.lanes,{name:'Other steps',kinds:[],fg:'var(--control)',bg:'var(--chip)'}],H=top+lanes.length*laneH+24
  const span=Math.max(d.duration_ms,1000),x=ms=>L+(W-L-R)*Math.min(1,ms/span)
  const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.setAttribute('viewBox','0 0 '+W+' '+H);svg.setAttribute('role','group');svg.setAttribute('aria-label','Session timeline: '+d.steps.length+' steps. Use the left and right arrow keys to move between moments.')
  const mk=(t,a)=>{const n=document.createElementNS(NS,t);for(const k in a)n.setAttribute(k,a[k]);return n}
  lanes.forEach((l,i)=>{const y=top+i*laneH;svg.appendChild(mk('line',{x1:L,x2:W-R,y1:y+laneH/2,y2:y+laneH/2,stroke:'var(--line)'}));const tx=mk('text',{x:0,y:y+laneH/2+4});tx.textContent=l.name;svg.appendChild(tx)})
  for(let i=0;i<=4;i++){const ms=span*i/4,tx=mk('text',{x:x(ms),y:H-6,'text-anchor':i===0?'start':i===4?'end':'middle'});tx.textContent=clock(ms);svg.appendChild(tx)}
  const marks=[];d.steps.forEach((s,idx)=>{const lane=s.marks.length?lanes.findIndex(l=>l.kinds.includes(s.marks[0])):lanes.length-1;const y=top+lane*laneH
    const g=mk('g',{class:'mk',tabindex:'-1',role:'button','aria-label':clock(s.at_ms)+', '+(s.marks.length?s.marks.map(markText).join(', ')+': ':'')+s.line})
    const x0=s.marks.length?Math.min(x(s.from_ms),x(s.at_ms)-8):x(s.at_ms)-3,w=Math.max(s.marks.length?10:6,x(s.at_ms)-x0+3)
    const ln=lanes[lane];g.appendChild(mk('rect',{class:'box',x:x0,y:y+5,width:w,height:laneH-10,rx:4,fill:s.marks.length?ln.bg:'var(--chip)',stroke:s.marks.length?ln.fg:'var(--line-strong)','stroke-width':1}))
    g.appendChild(mk('rect',{x:x0-6,y:y,width:w+12,height:laneH,fill:'transparent'}))
    const ttl=mk('title',{});ttl.textContent=clock(s.from_ms)+'–'+clock(s.at_ms)+' · '+(s.marks.length?s.marks.map(markText).join(', ')+' · ':'')+s.line;g.appendChild(ttl)
    g.onclick=()=>pick(idx,false);g.onkeydown=e=>{const order=marks.map(m=>m.idx);const p=order.indexOf(idx);let n=null;if(e.key==='ArrowRight')n=order[Math.min(order.length-1,p+1)];if(e.key==='ArrowLeft')n=order[Math.max(0,p-1)];if(e.key==='Home')n=order[0];if(e.key==='End')n=order[order.length-1];if(n!=null){e.preventDefault();pick(n,true)}if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(idx,true)}}
    svg.appendChild(g);marks.push({idx,g})})
  wrap.appendChild(svg)
  const pickInfo=el('div','tl-pick');pickInfo.setAttribute('aria-live','polite');box.appendChild(pickInfo)
  const watch=clipLink(h.moment.clip_page,'Watch from '+clock(h.moment.offset_s*1000));const actRow=el('div','acts');actRow.appendChild(watch);box.appendChild(actRow)
  box.appendChild(el('h4',null,'Steps'))
  const tw=el('div','table-wrap');tw.setAttribute('role','region');tw.setAttribute('aria-label','Steps in this session');tw.tabIndex=0;const tb=el('table','steps');tw.appendChild(tb);box.appendChild(tw)
  const hr=el('tr');['Time','Step','What happened','Replay'].forEach(t=>{const th=el('th',null,t);th.scope='col';hr.appendChild(th)});const th=el('thead');th.appendChild(hr);tb.appendChild(th)
  const body=el('tbody');tb.appendChild(body);const rows=[]
  d.steps.forEach((s,idx)=>{const tr=el('tr');tr.appendChild(el('td','t',clock(s.at_ms)));tr.appendChild(el('td',null,s.line))
    const w=el('td');if(s.marks.length){const u=el('ul','chips');u.style.margin='0';s.marks.forEach(k=>u.appendChild(chip(k)));w.appendChild(u)}else w.appendChild(el('span','small muted','Nothing unusual'));tr.appendChild(w)
    const r=el('td');const a=el('a',null,clock(s.offset_s*1000));a.href=s.clip_page;a.target='_blank';a.rel='noopener';a.setAttribute('aria-label','Watch from '+clock(s.offset_s*1000));r.appendChild(a);tr.appendChild(r);body.appendChild(tr);rows.push(tr)})
  function pick(idx,focus){const s=d.steps[idx];marks.forEach(m=>{m.g.classList.toggle('sel',m.idx===idx);m.g.setAttribute('tabindex',m.idx===idx?'0':'-1')});rows.forEach((r,i)=>r.classList.toggle('sel',i===idx));pickInfo.textContent=clock(s.at_ms)+' · '+(s.marks.length?s.marks.map(markText).join(', ')+' · ':'')+s.line;watch.href=s.clip_page;watch.textContent='Watch from '+clock(s.offset_s*1000);if(focus){const m=marks.find(m=>m.idx===idx);m&&m.g.focus()}rows[idx]&&rows[idx].scrollIntoView({block:'nearest'})}
  const first=d.steps.findIndex(s=>s.n===h.moment.step);pick(first>=0?first:0,false)
}
let allProblems=false
$('pr-more').onclick=()=>{allProblems=!allProblems;drawProblems(lastProblems);$('pr-more').focus()}
let lastProblems=[]
function drawProblems(list){lastProblems=list;const u=$('pr');u.innerHTML='';const more=$('pr-more')
  if(!list.length){u.appendChild(el('li','small muted','No repeated problems in this view.'));more.classList.add('hidden');return}
  more.classList.toggle('hidden',list.length<=3);more.textContent=allProblems?'Show fewer':'Show all '+list.length+' patterns';more.setAttribute('aria-expanded',String(allProblems))
  list.slice(0,allProblems?30:3).forEach(p=>{const li=el('li');li.appendChild(el('b',null,p.what+' on '+p.where));li.appendChild(el('span','n',p.sessions+' sessions · '+p.clients+' client'+(p.clients===1?'':'s')+' · '+p.people+' '+(p.people===1?'person':'people')))
    const fb=el('button','secondary filt','Show these sessions');fb.type='button';fb.setAttribute('aria-label','Show sessions with: '+p.what);fb.onclick=()=>{$('f-kind').value=p.mark;syncURL();loadFeed();$('feed-h').scrollIntoView({block:'start'})}
    const ex=el('div','ex');p.examples.forEach(x=>{const a=el('a',null,x.client_name+' · '+new Date(x.started_at).toLocaleDateString([], {day:'numeric',month:'short'})+' at '+clock(x.offset_s*1000));a.setAttribute('aria-label','Watch '+x.client_name+', '+when(x.started_at)+', from '+clock(x.offset_s*1000));a.href=x.clip_page;a.target='_blank';a.rel='noopener';ex.appendChild(a)});li.appendChild(ex);if($('f-kind').value!==p.mark)li.appendChild(fb);u.appendChild(li)})}
function askText(){const c=$('f-client'),name=c.value?c.options[c.selectedIndex].textContent.replace(/ \\(paused\\)$/,''):'';const days=$('f-days').options[$('f-days').selectedIndex].textContent.toLowerCase()
  $('ask-q').textContent='Using '+CFG.mcpName+', what went wrong '+(name?'at '+name:'at my watched clients')+' in the '+days.replace(/^last /,'last ')+'? Show the step-by-step moments of the worst session, with replay links.'
  $('ask').hidden=!CFG.mcp}
$('ask-copy').onclick=async()=>{try{await navigator.clipboard.writeText($('ask-q').textContent);$('ask-done').textContent='Copied.'}catch{$('ask-done').textContent='Select the text to copy it.'}setTimeout(()=>$('ask-done').textContent='',3000)}

loadState().then(()=>{syncURL();loadFeed()}).catch(e=>{$('cov').textContent='';$('feed').appendChild(emptyCard('Couldn’t load the watchlist',e.message,['Retry',()=>location.reload()]))})
</script></body></html>`
}
