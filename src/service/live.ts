// The Live page: who is in the app right now, and how long each client spent in it (time in the
// app, active and idle) per day and per hour, down to each person and each session. The numbers
// come from PostHog events only (see core/presence.ts), never from recordings. Anyone with the
// "Watch clips" role can open it; a session's "Make a clip" link goes through the clip page as usual.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { GAP_CHOICES, includesToday, liveNow, parsePresenceQuery, presenceReport, presenceSessions, presenceSettings, validTimeZone, type PresenceQuery } from '../core/presence.ts'
import type { Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

// Several people often watch the same day. Ranges that include today are cached briefly; past days
// do not change.
const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>()
function cached<T>(key: string, ttl: number, make: () => Promise<T>): Promise<T> {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>
    const value = make()
    cache.set(key, { at: Date.now(), ttl, value })
    value.catch(() => cache.delete(key))
    if (cache.size > 300) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k)
    return value
}
const ttlFor = (q: PresenceQuery) => (includesToday(q) ? 30_000 : 10 * 60_000)

export async function handleLive(req: IncomingMessage, res: ServerResponse, url: URL, _v: Viewer): Promise<boolean> {
    const p = url.pathname
    if (req.method !== 'GET') {
        json(res, 405, { error: 'GET only.' })
        return true
    }
    try {
        if (p === '/replays/live/api/now') {
            const tz = url.searchParams.get('tz') || 'UTC'
            if (!validTimeZone(tz)) return (json(res, 400, { error: 'Unknown timezone.' }), true)
            const gap = Number(url.searchParams.get('gap') || presenceSettings().gap_s)
            if (!Number.isInteger(gap) || gap < 5 || gap > 1800) return (json(res, 400, { error: 'Bad active time.' }), true)
            json(res, 200, await cached(`now|${tz}|${gap}`, 15_000, () => liveNow(tz, gap)))
            return true
        }
        if (p === '/replays/live/api/time' || p === '/replays/live/api/sessions') {
            const q = parsePresenceQuery(url.searchParams)
            if ('error' in q) return (json(res, 400, { error: q.error }), true)
            if (p.endsWith('/time')) {
                json(res, 200, await cached(`time|${JSON.stringify(q)}`, ttlFor(q), () => presenceReport(q)))
                return true
            }
            if (!q.client) return (json(res, 400, { error: 'Pick a client first.' }), true)
            json(res, 200, { sessions: await cached(`sessions|${JSON.stringify(q)}`, ttlFor(q), () => presenceSessions(q)) })
            return true
        }
    } catch (e) {
        json(res, 502, { error: `PostHog did not answer: ${(e as Error).message.slice(0, 200)}` })
        return true
    }
    json(res, 404, { error: 'Not found.' })
    return true
}

export function liveHtml(v: Viewer): string {
    const s = presenceSettings()
    const boot = JSON.stringify({ gap: s.gap_s, gaps: [...new Set([...GAP_CHOICES, s.gap_s])].sort((a, b) => a - b), liveMinutes: s.live_minutes }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live · ${APP_NAME}</title><style>${PAGE_CSS()}
:root{--act:#2a78d6;--idle:#86b6ef;--grid:#e1e0d9;--axis:#c3c2b7;--live:#0ca30c}
main.wide{max-width:1180px}
.now{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}#now-sub{flex:1;min-width:220px}.hero{font-size:52px;font-weight:650;line-height:1}
.pulse{width:12px;height:12px;border-radius:50%;background:var(--live);box-shadow:0 0 0 0 rgba(12,163,12,.5);animation:p 2s infinite;flex:none}.pulse.off{background:var(--axis);animation:none}
@keyframes p{70%{box-shadow:0 0 0 10px rgba(12,163,12,0)}100%{box-shadow:0 0 0 0 rgba(12,163,12,0)}}
.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 16px}.filters>div{min-width:150px}.filters>div.grow{flex:1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile span{display:block;font-size:13px;color:var(--muted)}.tile b{font-size:24px;font-weight:600}
.tile small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.seg{display:flex;gap:2px;height:8px;width:100%;margin-top:8px}.seg i{display:block;height:8px;border-radius:999px}.seg .a{background:var(--act)}.seg .i{background:var(--idle)}
td .seg{width:90px;margin:0;display:inline-flex;vertical-align:middle}
.legend{display:flex;gap:14px;font-size:13px;color:var(--muted);margin:-4px 0 6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.chart svg{display:block;width:100%;overflow:visible}.chart text{font:12px system-ui,sans-serif;fill:var(--muted);font-variant-numeric:tabular-nums}
.chart .hit{fill:transparent;cursor:default;outline:none}.chart g.col:hover path,.chart g.col.on path{filter:brightness(1.12)}
.chart g.col:focus-visible .hit{stroke:var(--accent);stroke-width:1}
.heat{display:grid;gap:2px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}.heat div{height:16px;border-radius:3px}
.heat .lbl{background:none;height:auto;line-height:16px;white-space:nowrap;padding-right:6px}.heat .hd{background:none;height:auto;text-align:left}
.heat .c{background:var(--bg);outline:none}.heat .c:hover,.heat .c:focus-visible{box-shadow:inset 0 0 0 1.5px var(--ink)}
.scale{display:flex;align-items:center;gap:3px;font-size:12px;color:var(--muted);margin-top:8px}.scale i{width:16px;height:10px;border-radius:2px;display:inline-block}
#tip{position:fixed;z-index:10;pointer-events:none;background:var(--card);border:1px solid var(--line);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.08);padding:8px 10px;font-size:13px;min-width:150px}
#tip .t{color:var(--muted);margin-bottom:4px}#tip .r{display:flex;align-items:center;gap:8px}#tip .r b{font-variant-numeric:tabular-nums}#tip .k{width:12px;height:2px;border-radius:1px;flex:none}
th.sort{cursor:pointer;user-select:none}th.sort:hover{color:var(--ink)}th .arr{font-size:10px;margin-left:3px}
tr.click{cursor:pointer}tr.click:hover td{background:var(--bg)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--live);margin-right:6px}
.loading{opacity:.55;transition:opacity .2s}.pill{display:inline-flex;gap:6px;align-items:center;background:var(--chip);border-radius:999px;padding:3px 10px;font-size:13px}
.pill button{padding:0 4px;border:0;background:none;color:var(--accent);font-size:15px;line-height:1}
details.how summary{cursor:pointer;font-weight:600}details.how li{margin:4px 0}
</style></head>
<body>${headerHtml(v, 'Live')}<main class="wide">

<div class="card"><div class="now"><span class="pulse off" id="pulse"></span><span class="hero" id="now-count">–</span><span class="muted" id="now-sub">Loading…</span></div>
<div class="table-wrap"><table><thead><tr><th>Client</th><th>Person</th><th>Last action</th><th>In the app since</th><th class="num">Today in the app</th><th class="num">Today active</th></tr></thead><tbody id="now-rows"></tbody></table></div></div>

<div class="filters" id="filters">
<div><label for="range">Period</label><select id="range"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Pick dates…</option></select></div>
<div class="custom hidden"><label for="from">From</label><input type="date" id="from"></div><div class="custom hidden"><label for="to">To</label><input type="date" id="to"></div>
<div class="grow"><label for="client">Client</label><select id="client"><option value="">All clients</option></select></div>
<div><label for="gap">Active for … after each action</label><select id="gap"></select></div>
</div>

<div id="report">
<div class="tiles" id="tiles"></div>
<div class="card"><h2 id="chart-title">Time in the app</h2><p class="small muted" style="margin-top:-6px">Each column adds up everyone's time, so three people for an hour make 3 h.</p><div class="legend"><span><i style="background:var(--act)"></i>Active</span><span><i style="background:var(--idle)"></i>Idle</span></div>
<div class="chart" id="chart"></div><p class="small muted" id="chart-note"></p>
<details><summary class="small">Show as a table</summary><div class="table-wrap"><table id="chart-table"></table></div></details></div>
<div class="card" id="heat-card"><h2>Active time by hour</h2><p class="small muted" style="margin-top:-6px">Each square is one hour of one day: the darker, the more active time, everyone added up.</p><div class="heat" id="heat"></div><div class="scale" id="scale"></div></div>
<div class="card"><div class="row" style="align-items:center;margin-bottom:8px"><h2 id="list-title" style="margin:0;flex:1">Clients</h2><span id="who-pill"></span><button class="ghost" id="list-csv" type="button">Download CSV</button></div>
<div class="table-wrap"><table id="list"></table></div><p class="small muted" id="list-note"></p></div>
<div class="card hidden" id="sessions-card"><div class="row" style="align-items:center;margin-bottom:8px"><h2 style="margin:0;flex:1" id="sessions-title">Sessions</h2><button class="ghost" id="sessions-csv" type="button">Download CSV</button></div>
<div class="table-wrap"><table id="sessions"></table></div><p class="small"><button class="ghost hidden" id="more" type="button">Show more</button></p></div>
</div>

<details class="card how"><summary>How the time is counted</summary><ul class="small">
<li><b>In the app</b>: from a person's first action to their last, in each session. PostHog ends a session after 30 minutes without any action, so a break longer than that starts a new session and is not counted.</li>
<li><b>Active</b>: after each action, the time until the next one, up to the limit you pick above (1 minute by default). <b>Idle</b>: the rest of the time in the app, when the app was open but nobody did anything.</li>
<li>An action is anything PostHog records from a person: clicks, typing, screens, your own events. Automatic background events are left out.</li>
<li>Each stretch of time counts in the hour it started. Times are in <span id="tz-name"></span>. Time after a person's very last action is not counted, because nothing shows when they stopped looking.</li>
<li>These numbers come from PostHog events only. Nothing here reads the recordings.</li></ul></details>
</main>
<div id="tip" hidden></div>
<script>
const CFG=${boot};const $=id=>document.getElementById(id);
const TZ=(()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch(e){return 'UTC'}})();
const api=p=>fetch(p,{headers:{'x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
const dayOf=d=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
const addDays=(s,n)=>{const d=new Date(s+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const dayName=s=>new Date(s+'T12:00:00Z').toLocaleDateString([], {weekday:'short',day:'numeric',month:'short',timeZone:'UTC'});
const timeOf=iso=>new Date(iso).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',timeZone:TZ});
const whenOf=iso=>new Date(iso).toLocaleString([], {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:TZ});
const ago=iso=>{const s=Math.max(0,Math.round((Date.now()-Date.parse(iso))/1000));return s<60?s+' s ago':Math.round(s/60)+' min ago'};
const dur=s=>{s=Math.round(s||0);if(s<60)return s+' s';const m=Math.round(s/60);if(m<60)return m+' min';const h=Math.floor(m/60),r=m%60;return h+' h'+(r?' '+r+' min':'')};
const hrs=s=>{const h=(s||0)/3600;return h>=100?Math.round(h).toLocaleString()+' h':h>=10?h.toFixed(0)+' h':h>=1?h.toFixed(1)+' h':dur(s)};
const pct=(a,b)=>b>0?Math.round(100*a/b)+'%':'–';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e};
const segBar=(a,i)=>{const w=el('span','seg');const t=a+i;if(t<=0)return w;if(a>0){const x=el('i','a');x.style.flex=String(a);w.appendChild(x)}if(i>0){const y=el('i','i');y.style.flex=String(i);w.appendChild(y)}return w};
$('tz-name').textContent=TZ;
CFG.gaps.forEach(g=>{const o=el('option',null,g<60?g+' seconds':g===60?'1 minute':(g/60)+' minutes');o.value=g;$('gap').appendChild(o)});

// ---------------------------------------------------------------- state, kept in the address so a view can be shared
const S={range:'today',from:'',to:'',client:'',user:'',gap:CFG.gap};
(()=>{const q=new URLSearchParams(location.search);for(const k of ['range','from','to','client','user'])if(q.get(k))S[k]=q.get(k);if(q.get('gap'))S.gap=Number(q.get('gap'))})();
function period(){const today=dayOf(new Date());
 if(S.range==='today')return[today,today];if(S.range==='yesterday'){const y=addDays(today,-1);return[y,y]}
 if(S.range==='custom'&&S.from&&S.to)return[S.from,S.to];const n=Number(S.range)||7;return[addDays(today,1-n),today]}
function params(extra){const[f,t]=period();const q=new URLSearchParams({from:f,to:t,tz:TZ,gap:String(S.gap)});if(S.client)q.set('client',S.client);if(extra&&S.user)q.set('user',S.user);return q}
function syncUrl(){const q=new URLSearchParams();q.set('range',S.range);if(S.range==='custom'){q.set('from',S.from);q.set('to',S.to)}if(S.client)q.set('client',S.client);if(S.user)q.set('user',S.user);if(S.gap!==CFG.gap)q.set('gap',S.gap);history.replaceState(null,'','?'+q)}
function syncControls(){$('range').value=S.range;document.querySelectorAll('.custom').forEach(d=>d.classList.toggle('hidden',S.range!=='custom'));const[f,t]=period();$('from').value=f;$('to').value=t;$('gap').value=String(S.gap)}

// ---------------------------------------------------------------- tooltip
const tip=$('tip');
function showTip(target,title,rows){tip.innerHTML='';tip.appendChild(el('div','t',title));rows.forEach(([color,value,label])=>{const r=el('div','r');if(color){const k=el('span','k');k.style.background=color;r.appendChild(k)}r.appendChild(el('b',null,value));r.appendChild(el('span','muted',label));tip.appendChild(r)});
 tip.hidden=false;const b=target.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;let x=b.left+b.width/2-w/2,y=b.top-h-8;if(y<4)y=b.bottom+8;x=Math.max(4,Math.min(innerWidth-w-4,x));tip.style.left=x+'px';tip.style.top=y+'px'}
const hideTip=()=>{tip.hidden=true};
function hover(node,title,rows){node.addEventListener('pointerenter',()=>{node.classList.add('on');showTip(node,title,rows)});node.addEventListener('pointerleave',()=>{node.classList.remove('on');hideTip()});node.addEventListener('focus',()=>showTip(node,title,rows));node.addEventListener('blur',hideTip)}

// ---------------------------------------------------------------- live now
let LIVE=new Set();
async function loadNow(){try{const r=await api('/replays/live/api/now?tz='+encodeURIComponent(TZ)+'&gap='+S.gap);
 LIVE=new Set(r.people.map(p=>p.client_id));const clients=LIVE.size;
 $('now-count').textContent=String(r.people.length);$('pulse').classList.toggle('off',!r.people.length);
 $('now-sub').textContent=(r.people.length===1?'person':'people')+' in the app now'+(r.people.length?', from '+clients+' client'+(clients===1?'':'s'):'')+' · an action in the last '+r.minutes+' minutes · updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
 const tb=$('now-rows');tb.innerHTML='';
 if(!r.people.length){const tr=el('tr');const td=el('td','muted','Nobody has done anything in the app in the last '+r.minutes+' minutes.');td.colSpan=6;tr.appendChild(td);tb.appendChild(tr)}
 r.people.forEach(p=>{const tr=el('tr','click');tr.title='Show '+p.client_name;tr.onclick=()=>{S.client=p.client_id;S.user='';S.range='today';syncControls();load()};
  const c=el('td');c.appendChild(el('span','dot'));c.appendChild(document.createTextNode(p.client_name));tr.appendChild(c);
  tr.appendChild(el('td',null,p.user));tr.appendChild(el('td',null,ago(p.last_seen)));tr.appendChild(el('td',null,timeOf(p.session_start)));
  tr.appendChild(el('td','num',dur(p.today.open_s)));tr.appendChild(el('td','num',dur(p.today.active_s)));tb.appendChild(tr)});
 if(R)renderList()}catch(e){$('now-sub').textContent=e.message;$('now-sub').className='err'}}

// ---------------------------------------------------------------- the report
let R=null,SESS=[],shown=200,sortKey='open_s',sortDir=-1,busy=0,sbusy=0,listAll=false;
async function load(){syncUrl();listAll=false;const my=++busy;$('report').classList.add('loading');
 try{const r=await api('/replays/live/api/time?'+params(false));if(my!==busy)return;R=r;render();
  if(S.client)await loadSessions();else $('sessions-card').classList.add('hidden')}
 catch(e){if(my!==busy)return;$('tiles').innerHTML='';const t=el('div','tile err',e.message);$('tiles').appendChild(t)}
 finally{if(my===busy)$('report').classList.remove('loading')}}
async function loadSessions(){const my=++sbusy;const r=await api('/replays/live/api/sessions?'+params(true));if(my!==sbusy)return;SESS=r.sessions;shown=200;renderSessions()}

function render(){fillClients();renderTiles();renderChart();renderHeat();renderList()}
function fillClients(){const s=$('client'),cur=S.client;s.innerHTML='';s.appendChild(new Option('All clients',''));
 const list=[...R.clients].sort((a,b)=>a.client_name.localeCompare(b.client_name));
 if(cur&&!list.some(c=>c.client_id===cur))list.unshift({client_id:cur,client_name:cur});
 list.forEach(c=>s.appendChild(new Option(c.client_name,c.client_id)));s.value=cur}
function tile(label,value,note,bar){const t=el('div','tile');t.appendChild(el('span',null,label));t.appendChild(el('b',null,value));if(note)t.appendChild(el('small',null,note));if(bar)t.appendChild(bar);$('tiles').appendChild(t)}
function renderTiles(){const T=R.totals;$('tiles').innerHTML='';const[f,t]=period();const days=(Date.parse(t)-Date.parse(f))/864e5+1;
 tile('In the app',hrs(T.open_s),days>1?hrs(T.open_s/days)+' a day':null);
 tile('Active',hrs(T.active_s),pct(T.active_s,T.open_s)+' of the time',segBar(T.active_s,T.idle_s));
 tile('Idle',hrs(T.idle_s),pct(T.idle_s,T.open_s)+' of the time');
 if(!S.client)tile('Clients',T.clients.toLocaleString());
 tile('People',T.people.toLocaleString(),T.people?dur(T.open_s/T.people)+' each on average':null);
 tile('Sessions',T.sessions.toLocaleString(),T.sessions?dur(T.open_s/T.sessions)+' on average':null)}

// columns: one per hour (a single day) or per day
function series(){const[f,t]=period();if(f===t){const by=new Map(R.hours.filter(h=>h.day===f).map(h=>[h.hour,h]));
  return{unit:'hour',items:Array.from({length:24},(_,h)=>{const x=by.get(h)||{};return{label:String(h).padStart(2,'0'),title:dayName(f)+', '+String(h).padStart(2,'0')+':00–'+String(h+1).padStart(2,'0')+':00',active:x.active_s||0,idle:x.idle_s||0,open:x.open_s||0,people:x.people||0}})}}
 const by=new Map(R.days.map(d=>[d.day,d]));const items=[];for(let d=f;d<=t;d=addDays(d,1)){const x=by.get(d)||{};items.push({label:dayName(d),title:dayName(d),active:x.active_s||0,idle:x.idle_s||0,open:x.open_s||0,people:x.people||0,sessions:x.sessions||0})}
 return{unit:'day',items}}
function niceStep(max){const steps=[60,300,600,900,1800,3600,7200,10800,21600,43200,86400,172800,432000,864000,1728000,4320000,8640000];return steps.find(s=>max/s<=5)||steps[steps.length-1]}
const axisLabel=s=>s===0?'0':s<3600?Math.round(s/60)+' min':(s/3600)+' h';
const NS='http://www.w3.org/2000/svg';const sv=(tag,attrs)=>{const e=document.createElementNS(NS,tag);for(const k in attrs)e.setAttribute(k,attrs[k]);return e};
function colPath(x,y,w,h,r){r=Math.min(r,h,w/2);return'M'+x+','+(y+h)+'V'+(y+r)+'Q'+x+','+y+' '+(x+r)+','+y+'H'+(x+w-r)+'Q'+(x+w)+','+y+' '+(x+w)+','+(y+r)+'V'+(y+h)+'Z'}
function renderChart(){const{unit,items}=series();const box=$('chart');box.innerHTML='';
 $('chart-title').textContent=unit==='hour'?'Time in the app, hour by hour':'Time in the app, day by day';
 const W=Math.max(320,box.clientWidth||900),H=230,L=52,B=28,T=8,Rr=6,ph=H-T-B,pw=W-L-Rr;
 const max=Math.max(...items.map(i=>i.open),0);const step=niceStep(Math.max(max,60));const top=Math.max(step,Math.ceil(max/step)*step);
 const svg=sv('svg',{viewBox:'0 0 '+W+' '+H,height:H,role:'img','aria-label':$('chart-title').textContent});
 for(let v=0;v<=top+1e-9;v+=step){const y=T+ph-(v/top)*ph;svg.appendChild(sv('line',{x1:L,x2:W-Rr,y1:y,y2:y,stroke:v===0?'var(--axis)':'var(--grid)','stroke-width':1}));const tx=sv('text',{x:L-8,y:y+4,'text-anchor':'end'});tx.textContent=axisLabel(v);svg.appendChild(tx)}
 const band=pw/items.length,bw=Math.max(3,Math.min(24,band*0.62)),every=Math.max(1,Math.ceil(items.length/Math.floor(pw/(unit==='hour'?28:64))));
 items.forEach((it,i)=>{const x=L+i*band+(band-bw)/2,base=T+ph;const g=sv('g',{class:'col',tabindex:'0','aria-label':it.title+': '+dur(it.open)+' in the app, '+dur(it.active)+' active, '+dur(it.idle)+' idle'});
  const ha=it.active/top*ph,hi=it.idle/top*ph;
  if(ha>0.5)g.appendChild(sv('path',{d:colPath(x,base-ha,bw,ha,hi>0.5?0:4),fill:'var(--act)'}));
  if(hi>0.5){const y=base-ha-(ha>0.5?2:0)-hi;g.appendChild(sv('path',{d:colPath(x,y,bw,hi,4),fill:'var(--idle)'}))}
  const hit=sv('rect',{class:'hit',x:L+i*band,y:T,width:band,height:ph});g.insertBefore(hit,g.firstChild);
  if(i%every===0){const tx=sv('text',{x:x+bw/2,y:H-8,'text-anchor':'middle'});tx.textContent=it.label;g.appendChild(tx)}
  svg.appendChild(g);
  hover(g,it.title,[['var(--act)',dur(it.active),'active'],['var(--idle)',dur(it.idle),'idle'],[null,dur(it.open),'in the app'],[null,String(it.people),it.people===1?'person':'people']])});
 box.appendChild(svg);
 const busiest=items.reduce((a,b)=>b.open>a.open?b:a,items[0]);$('chart-note').textContent=max>0?'Busiest '+(unit==='hour'?'hour':'day')+': '+busiest.title+', '+dur(busiest.open)+' in the app across '+busiest.people+(busiest.people===1?' person.':' people.'):'No time in the app in this period.';
 const tb=$('chart-table');tb.innerHTML='';const hr=el('tr');[unit==='hour'?'Hour':'Day','In the app','Active','Idle','People'].forEach((h,i)=>hr.appendChild(el('th',i?'num':null,h)));const th=el('thead');th.appendChild(hr);tb.appendChild(th);const bd=el('tbody');
 items.forEach(it=>{const tr=el('tr');tr.appendChild(el('td',null,it.title));[dur(it.open),dur(it.active),dur(it.idle),String(it.people)].forEach(v=>tr.appendChild(el('td','num',v)));bd.appendChild(tr)});tb.appendChild(bd)}

const RAMP=['#cde2fb','#b7d3f6','#9ec5f4','#86b6ef','#6da7ec','#5598e7','#3987e5','#2a78d6','#256abf','#1c5cab','#184f95','#104281','#0d366b'];
function renderHeat(){const[f,t]=period();const card=$('heat-card');if(f===t){card.classList.add('hidden');return}card.classList.remove('hidden');
 const box=$('heat');box.innerHTML='';box.style.gridTemplateColumns='92px repeat(24,minmax(0,1fr))';
 const by=new Map(R.hours.map(h=>[h.day+'|'+h.hour,h]));const max=Math.max(1,...R.hours.map(h=>h.active_s));
 box.appendChild(el('div','lbl',''));for(let h=0;h<24;h++)box.appendChild(el('div','hd',h%3===0?String(h).padStart(2,'0'):''));
 for(let d=t;d>=f;d=addDays(d,-1)){box.appendChild(el('div','lbl',dayName(d)));
  for(let h=0;h<24;h++){const x=by.get(d+'|'+h);const c=el('div','c');c.tabIndex=0;
   if(x&&x.active_s>0){c.style.background=RAMP[Math.min(RAMP.length-1,Math.floor(Math.sqrt(x.active_s/max)*(RAMP.length-1)))]}
   const hh=String(h).padStart(2,'0')+':00–'+String(h+1).padStart(2,'0')+':00';c.setAttribute('aria-label',dayName(d)+' '+hh+': '+dur(x?x.active_s:0)+' active');
   hover(c,dayName(d)+', '+hh,[['var(--act)',dur(x?x.active_s:0),'active'],['var(--idle)',dur(x?x.idle_s:0),'idle'],[null,String(x?x.people:0),(x&&x.people===1)?'person':'people']]);box.appendChild(c)}}
 const sc=$('scale');sc.innerHTML='';sc.appendChild(el('span',null,'Less'));[0,2,4,6,8,10,12].forEach(i=>{const s=el('i');s.style.background=RAMP[i];sc.appendChild(s)});sc.appendChild(el('span',null,'More · up to '+dur(max)+' active in one hour'))}

// clients, or the people of one client
function cols(){return S.client?[['user','Person'],['sessions','Sessions',1],['open_s','In the app',1],['active_s','Active',1],['idle_s','Idle',1],['share','Active share'],['first','First action'],['last','Last action']]
 :[['client_name','Client'],['people','People',1],['sessions','Sessions',1],['open_s','In the app',1],['active_s','Active',1],['idle_s','Idle',1],['share','Active share'],['last','Last action']]}
function rows(){return S.client?(R.people||[]):R.clients}
function renderList(){const pick=R.clients.find(c=>c.client_id===S.client);
 $('list-title').textContent=S.client?'People at '+(pick?pick.client_name:S.client):'Clients';
 const pill=$('who-pill');pill.innerHTML='';if(S.client){const p=el('span','pill',pick?pick.client_name:S.client);const x=el('button',null,'×');x.title='Show all clients';x.onclick=()=>{S.client='';S.user='';load()};p.appendChild(x);pill.appendChild(p)}
 const t=$('list');t.innerHTML='';const hr=el('tr');
 cols().forEach(([k,label,num])=>{const th=el('th','sort'+(num?' num':''),label);if(k===sortKey)th.appendChild(el('span','arr',sortDir<0?'▼':'▲'));th.onclick=()=>{if(sortKey===k)sortDir=-sortDir;else{sortKey=k;sortDir=num||k==='last'||k==='share'?-1:1}renderList()};hr.appendChild(th)});
 const th=el('thead');th.appendChild(hr);t.appendChild(th);const bd=el('tbody');
 const val=(r,k)=>k==='share'?(r.open_s?r.active_s/r.open_s:0):r[k];
 const list=[...rows()].sort((a,b)=>{const x=val(a,sortKey),y=val(b,sortKey);return(typeof x==='string'?x.localeCompare(y):(x||0)-(y||0))*sortDir});
 if(!list.length){const tr=el('tr');const td=el('td','muted','Nobody used the app in this period.');td.colSpan=cols().length;tr.appendChild(td);bd.appendChild(tr)}
 const LIMIT=25,cut=!listAll&&list.length>LIMIT+5;(cut?list.slice(0,LIMIT):list).forEach(r=>{const tr=el('tr','click');
  if(S.client){tr.title='Show '+r.user+"'s sessions";tr.onclick=()=>{S.user=S.user===r.user?'':r.user;syncUrl();loadSessions().catch(e=>alert(e.message));renderList()};if(S.user===r.user)tr.style.background='var(--chip)'}
  else{tr.title='Show the people at '+r.client_name;tr.onclick=()=>{S.client=r.client_id;S.user='';sortKey='open_s';sortDir=-1;load();scrollTo({top:0,behavior:'smooth'})}}
  cols().forEach(([k,,num])=>{let td;
   if(k==='client_name'){td=el('td');if(LIVE.has(r.client_id)){const d=el('span','dot');d.title='In the app now';td.appendChild(d)}td.appendChild(document.createTextNode(r.client_name))}
   else if(k==='share'){td=el('td');td.appendChild(segBar(r.active_s,r.idle_s));td.appendChild(el('span','small muted',' '+pct(r.active_s,r.open_s)))}
   else if(k==='first'||k==='last')td=el('td','small',whenOf(r[k]));
   else if(k==='user')td=el('td',null,r.user);
   else td=el('td','num',k.endsWith('_s')?dur(r[k]):Number(r[k]).toLocaleString());
   tr.appendChild(td)});bd.appendChild(tr)});
 if(cut){const tr=el('tr');const td=el('td');td.colSpan=cols().length;const b=el('button','ghost','Show all '+list.length.toLocaleString()+' '+(S.client?'people':'clients'));b.type='button';b.onclick=()=>{listAll=true;renderList()};td.appendChild(b);tr.appendChild(td);bd.appendChild(tr)}
 t.appendChild(bd);$('list-note').textContent=S.client?'Click a person to see only their sessions below.':'Click a client to see its people and every session.'}

function renderSessions(){const card=$('sessions-card');card.classList.remove('hidden');
 $('sessions-title').textContent=(S.user?S.user+"'s sessions":'Every session')+' ('+SESS.length.toLocaleString()+(SESS.length>=1000?'+':'')+')';
 const t=$('sessions');t.innerHTML='';const hr=el('tr');['Person','Started','Ended','In the app','Active','Idle','Actions',''].forEach((h,i)=>hr.appendChild(el('th',i>=3&&i<=6?'num':null,h)));const th=el('thead');th.appendChild(hr);t.appendChild(th);
 const bd=el('tbody');if(!SESS.length){const tr=el('tr');const td=el('td','muted','No sessions in this period.');td.colSpan=8;tr.appendChild(td);bd.appendChild(tr)}
 SESS.slice(0,shown).forEach(s=>{const tr=el('tr');tr.appendChild(el('td',null,s.user));tr.appendChild(el('td','small',whenOf(s.start)));tr.appendChild(el('td','small',timeOf(s.end)));
  [dur(s.open_s),dur(s.active_s),dur(s.idle_s),String(s.actions)].forEach(v=>tr.appendChild(el('td','num',v)));
  const td=el('td');const a=el('a','btn ghost small','Make a clip');a.href='/replays?url='+encodeURIComponent(s.session_id);a.title='Open this session on the clip page';a.style.padding='3px 9px';td.appendChild(a);tr.appendChild(td);bd.appendChild(tr)});
 t.appendChild(bd);$('more').classList.toggle('hidden',SESS.length<=shown);$('more').textContent='Show '+Math.min(200,SESS.length-shown)+' more'}
$('more').onclick=()=>{shown+=200;renderSessions()};

// ---------------------------------------------------------------- CSV
function csv(name,head,lines){const q=v=>{v=v==null?'':String(v);return/[",\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
 const blob=new Blob([[head,...lines].map(r=>r.map(q).join(',')).join('\\n')+'\\n'],{type:'text/csv'});const a=el('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},500)}
const mins=s=>(s/60).toFixed(1);
$('list-csv').onclick=()=>{if(!R)return;const[f,t]=period();const tag=f===t?f:f+'_to_'+t;
 if(S.client)csv('people_'+S.client+'_'+tag+'.csv',['person','sessions','minutes_in_app','minutes_active','minutes_idle','first_action','last_action'],(R.people||[]).map(r=>[r.user,r.sessions,mins(r.open_s),mins(r.active_s),mins(r.idle_s),r.first,r.last]));
 else csv('clients_'+tag+'.csv',['client_id','client','people','sessions','minutes_in_app','minutes_active','minutes_idle','first_action','last_action'],R.clients.map(r=>[r.client_id,r.client_name,r.people,r.sessions,mins(r.open_s),mins(r.active_s),mins(r.idle_s),r.first,r.last]))};
$('sessions-csv').onclick=()=>{const[f,t]=period();csv('sessions_'+S.client+'_'+(f===t?f:f+'_to_'+t)+'.csv',['session_id','person','client','started','ended','minutes_in_app','minutes_active','minutes_idle','actions'],SESS.map(s=>[s.session_id,s.user,s.client_name,s.start,s.end,mins(s.open_s),mins(s.active_s),mins(s.idle_s),s.actions]))};

// ---------------------------------------------------------------- controls
$('range').onchange=()=>{S.range=$('range').value;if(S.range==='custom'){const[f,t]=period();S.from=S.from||f;S.to=S.to||t}syncControls();load()};
$('from').onchange=$('to').onchange=()=>{S.from=$('from').value;S.to=$('to').value;if(S.from&&S.to&&S.to>=S.from)load()};
$('client').onchange=()=>{S.client=$('client').value;S.user='';sortKey='open_s';sortDir=-1;load()};
$('gap').onchange=()=>{S.gap=Number($('gap').value);load();loadNow()};
let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if(R)renderChart()},150)});
syncControls();load();loadNow();
setInterval(()=>{if(document.hidden)return;loadNow();if(period()[1]>=dayOf(new Date()))load()},30000);
</script></body></html>`
}
