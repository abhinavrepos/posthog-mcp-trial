// The Live page: who is in the app right now, and how long each client spent in it (time in the
// app, active and idle) per day and per hour, down to each person and each session. The numbers
// come from PostHog events only (see core/presence.ts), never from recordings. Anyone with the
// "Watch clips" role can open it; a session's "Make a clip" link goes through the clip page as usual.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { GAP_CHOICES, includesToday, liveNow, parsePresenceQuery, personDay, presenceReport, presenceSessions, presenceSettings, validTimeZone, type PresenceQuery } from '../core/presence.ts'
import type { Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS, PAGER_JS } from './replays.ts'

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
        if (p === '/replays/live/api/person') {
            const q = parsePresenceQuery(url.searchParams)
            if ('error' in q) return (json(res, 400, { error: q.error }), true)
            if (!q.user) return (json(res, 400, { error: 'Pick a person first.' }), true)
            const one = { ...q, to: q.from, user: q.user }
            json(res, 200, await cached(`person|${JSON.stringify(one)}`, ttlFor(one), () => personDay(one)))
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
    const boot = JSON.stringify({ gap: s.gap_s, gaps: [...new Set([...GAP_CHOICES, s.gap_s])].sort((a, b) => a - b), liveMinutes: s.live_minutes, replayBase: `${config.posthog.publicHost}/project/${config.posthog.projectId}/replay/` }).replace(/</g, '\\u003c')
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live · ${APP_NAME}</title><style>${PAGE_CSS()}
:root{--act:var(--muted);--idle:var(--line-strong);--grid:var(--line);--axis:var(--faint);--live:var(--ok)}
.table-wrap:has(#now-rows .empty-state,#list .empty-state) td.empty-state{border-bottom:0}

.now{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px}#now-sub{flex:1;min-width:220px;font-size:14px}#now-updated{margin-left:auto;text-align:right}.hero{font-size:36px;font-weight:650;line-height:1}
.pulse{width:12px;height:12px;border-radius:50%;background:var(--live);flex:none}.pulse.off{background:var(--axis);animation:none}
.filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin:4px 0 16px}.filters>div,.filters>div.grow{min-width:0;flex:1 1 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px;min-height:112px;min-width:0}.tile span{display:block;font-size:12px;line-height:16px;font-weight:500;color:var(--muted)}.tile b{display:block;font-size:28px;line-height:32px;font-weight:650;letter-spacing:-.02em;margin-top:8px}
.tile small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.seg{display:flex;gap:2px;height:8px;width:100%;margin-top:8px}.seg i{display:block;height:8px;border-radius:999px}.seg .a{background:var(--act)}.seg .i{background:var(--idle)}
td .seg{width:90px;margin:0;display:inline-flex;vertical-align:middle}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:var(--muted);margin:0 0 12px}.legend span{white-space:nowrap}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.chart svg{display:block;width:100%;overflow:visible}.chart text{font-size:12px;font-family:inherit;fill:var(--muted);font-variant-numeric:tabular-nums}
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
details.how summary{cursor:pointer;font-weight:500}details.how li{margin:4px 0}
.tl-head{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}.tl-nav{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.tl-nav input[type=date]{width:auto;padding:6px 8px}.tl-nav button{padding:6px 11px}.tl-whole{display:flex;gap:5px;align-items:center;margin:0 4px;font-size:13px;color:var(--muted)}.tl-whole input{width:auto}
.tl-facts{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tl-facts span{padding:5px 0;font-size:13px;color:var(--muted)}.tl-facts b{color:var(--ink);font-variant-numeric:tabular-nums}
#tl-chart{outline:none;border-radius:6px}#tl-chart:focus-visible{box-shadow:0 0 0 2px var(--accent)}#tl-chart svg{cursor:crosshair}
.tlbtn{padding:3px 9px;font-size:13px}#tl-pick{min-height:34px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.live-settings{align-self:flex-end;min-width:0;padding:0;flex:0 0 auto}.live-settings>summary{display:flex;align-items:center;min-height:36px;padding:7px 12px;border:1px solid var(--control);border-radius:var(--r-sm)}.live-settings[open]{flex-basis:100%}.live-settings>div{max-width:260px;margin-top:12px}.heat-scroll{overflow-x:auto;max-width:100%}.heat{min-width:640px}.tiles{gap:16px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.tl-facts{gap:6px 20px}
@media(max-width:600px){.hero{font-size:30px}.now{gap:10px}#now-sub{min-width:0;flex-basis:180px}.live-settings{flex-basis:100%;padding:0}.tl-nav{gap:4px}.tl-nav input[type=date]{max-width:145px}.tl-facts{gap:4px 14px}}
#chart-title{margin-bottom:4px}#chart-title+p{margin:0 0 16px}.chart-empty{height:120px;display:flex;align-items:center;justify-content:center;color:var(--muted);text-align:center}#list thead button.ghost{min-height:24px;padding:0;font-size:12px;line-height:20px;font-weight:500;color:var(--muted)}#list-csv{font-size:13px;font-weight:500;min-height:32px;padding:5px 10px}#list-note:empty,#live-status:empty{display:none}
</style></head>
<body>${headerHtml(v, 'Live')}<main class="wide"><h1>Live activity</h1><p id="live-status" class="small" aria-live="polite"></p>

<div class="card"><h2>In the app now</h2><div class="now"><span aria-hidden="true" class="pulse off" id="pulse"></span><span class="hero" id="now-count">–</span><span class="muted" aria-live="polite" id="now-sub">Loading…</span><span id="now-updated" class="small muted"></span></div>
<div class="table-wrap"><table><thead><tr><th scope="col">Client</th><th scope="col">Person</th><th scope="col">Last action</th><th scope="col">In the app since</th><th scope="col" class="num">Today in the app</th><th scope="col" class="num">Today active</th><th scope="col">Actions</th></tr></thead><tbody id="now-rows"></tbody></table><div id="now-pager"></div></div></div>

<div class="filters" id="filters">
<div><label for="range">Period</label><select id="range"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="custom">Pick dates…</option></select></div>
<div class="custom hidden"><label for="from">From</label><input type="date" id="from"></div><div class="custom hidden"><label for="to">To</label><input type="date" id="to"></div>
<div class="grow"><label for="client">Client</label><select id="client"><option value="">All clients</option></select></div>
<details class="live-settings"><summary>Settings</summary><div><label for="gap">Active time after each action</label><select id="gap"></select></div></details>
</div>

<div class="card hidden" id="tl-card">
<div class="tl-head"><div style="flex:1;min-width:220px"><h2 id="tl-title" style="margin:0">Timeline</h2><div class="small muted" aria-live="polite" id="tl-sub"></div></div>
<div class="tl-nav"><button class="ghost" id="tl-prev" type="button" aria-label="Previous day">‹</button><input type="date" id="tl-day" aria-label="Day"><button class="ghost" id="tl-next" type="button" aria-label="Next day">›</button>
<button class="ghost" id="tl-today" type="button">Today</button><label class="tl-whole"><input type="checkbox" id="tl-whole" aria-label="Show the whole day">Whole day</label><button class="ghost" id="tl-close" type="button" aria-label="Close the timeline">×</button></div></div>
<div class="tl-facts" id="tl-facts"></div>
<div class="legend"><span><i aria-hidden="true" style="background:var(--act)"></i>Active</span><span><i aria-hidden="true" style="background:var(--idle)"></i>Idle (app open, no action)</span><span><i aria-hidden="true" style="background:var(--muted);width:2px"></i>An action</span><span><i aria-hidden="true" style="background:var(--ink);width:2px;height:12px"></i>Opened a screen</span></div>
<div class="chart" id="tl-chart" tabindex="0" aria-label="Timeline of the day. Use the left and right arrow keys to step through the actions."></div>
<div aria-live="polite" id="tl-pick" class="small muted">Point at the timeline to see what happened. Click a moment to make a clip from it.</div>
<details><summary class="small" id="tl-list-sum">Every action</summary><div class="table-wrap"><table id="tl-list"></table><div id="tl-list-pager"></div></div><p><button class="ghost hidden" id="tl-more" type="button">Show more</button></p></details>
</div>

<div id="report">
<div class="tiles" id="tiles"></div>
<div class="card"><h2 id="chart-title">Time in the app</h2><p class="small muted">Total time across all people.</p><div class="legend"><span><i aria-hidden="true" style="background:var(--act)"></i>Active</span><span><i aria-hidden="true" style="background:var(--idle)"></i>Idle</span></div>
<div class="chart" id="chart"></div><p class="small muted" id="chart-note"></p>
<details><summary class="small">Show as a table</summary><div class="table-wrap"><table id="chart-table"></table><div id="chart-table-pager"></div></div></details></div>
<div class="card" id="heat-card"><h2>Active time by hour</h2><p class="small muted">Darker hours have more active time across all people.</p><div class="heat-scroll" tabindex="0" role="region" aria-label="Hourly activity; scroll to see all hours"><div class="heat" id="heat" role="group" aria-label="Active time by hour. Use arrow keys to move between hours."></div></div><div class="scale" id="scale"></div></div>
<div class="card"><div class="row" style="align-items:center;margin-bottom:8px"><h2 id="list-title" style="margin:0;flex:1">Clients</h2><span id="who-pill"></span><button class="ghost" id="list-csv" type="button">Download CSV</button></div>
<div class="table-wrap"><table id="list"></table><div id="list-pager"></div></div><p class="small muted" id="list-note"></p></div>
<div class="card hidden" id="sessions-card"><div class="row" style="align-items:center;margin-bottom:8px"><h2 style="margin:0;flex:1" id="sessions-title">Sessions</h2><button class="ghost" id="sessions-csv" type="button">Download CSV</button></div>
<div class="table-wrap"><table id="sessions"></table><div id="sessions-pager"></div></div><p class="small"><button class="ghost hidden" id="more" type="button">Show more</button></p></div>
</div>

<details class="card how"><summary>How this works</summary><ul class="small">
<li>Charts add everyone’s time: three people for an hour make 3 h.</li>
<li><b>In the app</b>: from a person's first action to their last, in each session. PostHog ends a session after 30 minutes without any action, so a break longer than that starts a new session and is not counted.</li>
<li><b>Active</b>: after each action, the time until the next one, up to the limit you pick above (1 minute by default). <b>Idle</b>: the rest of the time in the app, when the app was open but nobody did anything.</li>
<li>An action is anything PostHog records from a person: clicks, typing, screens, your own events. Automatic background events are left out.</li>
<li>Each stretch of time counts in the hour it started. Times are in <span id="tz-name"></span>. Time after a person's very last action is not counted, because nothing shows when they stopped looking.</li>
<li>These numbers come from PostHog events only. Nothing here reads the recordings.</li></ul></details>
</main>
<div id="tip" hidden></div>
<script>
${PAGER_JS}
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
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(tag==='button')e.type='button';if(tag==='th')e.scope='col';if(tag==='i'||cls==='dot')e.setAttribute('aria-hidden','true');if(text!=null)e.textContent=text;return e};
const segBar=(a,i)=>{const w=el('span','seg');w.setAttribute('aria-hidden','true');const t=a+i;if(t<=0)return w;if(a>0){const x=el('i','a');x.style.flex=String(a);w.appendChild(x)}if(i>0){const y=el('i','i');y.style.flex=String(i);w.appendChild(y)}return w};
$('tz-name').textContent=TZ;
CFG.gaps.forEach(g=>{const o=el('option',null,g<60?g+' seconds':g===60?'1 minute':(g/60)+' minutes');o.value=g;$('gap').appendChild(o)});

// ---------------------------------------------------------------- state, kept in the address so a view can be shared
const S={range:'today',from:'',to:'',client:'',user:'',gap:CFG.gap};
const TL={user:'',client:'',clientName:'',day:'',data:null,pin:null,shown:300,whole:false};let tlbusy=0;
(()=>{const q=new URLSearchParams(location.search);for(const k of ['range','from','to','client','user'])if(q.get(k))S[k]=q.get(k);if(q.get('gap'))S.gap=Number(q.get('gap'));if(q.get('who')){TL.user=q.get('who');TL.client=q.get('wclient')||'';TL.day=q.get('wday')||''}})();
function period(){const today=dayOf(new Date());
 if(S.range==='today')return[today,today];if(S.range==='yesterday'){const y=addDays(today,-1);return[y,y]}
 if(S.range==='custom'&&S.from&&S.to)return[S.from,S.to];const n=Number(S.range)||7;return[addDays(today,1-n),today]}
function params(extra){const[f,t]=period();const q=new URLSearchParams({from:f,to:t,tz:TZ,gap:String(S.gap)});if(S.client)q.set('client',S.client);if(extra&&S.user)q.set('user',S.user);return q}
function syncUrl(){const q=new URLSearchParams();q.set('range',S.range);if(S.range==='custom'){q.set('from',S.from);q.set('to',S.to)}if(S.client)q.set('client',S.client);if(S.user)q.set('user',S.user);if(S.gap!==CFG.gap)q.set('gap',S.gap);if(TL.user){q.set('who',TL.user);if(TL.client)q.set('wclient',TL.client);q.set('wday',TL.day)}history.replaceState(null,'','?'+q)}
function syncControls(){$('range').value=S.range;document.querySelectorAll('.custom').forEach(d=>d.classList.toggle('hidden',S.range!=='custom'));const[f,t]=period();$('from').value=f;$('to').value=t;$('gap').value=String(S.gap)}

// ---------------------------------------------------------------- tooltip
const tip=$('tip');
function showTip(target,title,rows){tip.innerHTML='';tip.appendChild(el('div','t',title));rows.forEach(([color,value,label])=>{const r=el('div','r');if(color){const k=el('span','k');k.style.background=color;r.appendChild(k)}r.appendChild(el('b',null,value));r.appendChild(el('span','muted',label));tip.appendChild(r)});
 tip.hidden=false;const b=target.getBoundingClientRect(),w=tip.offsetWidth,h=tip.offsetHeight;let x=b.left+b.width/2-w/2,y=b.top-h-8;if(y<4)y=b.bottom+8;x=Math.max(4,Math.min(innerWidth-w-4,x));tip.style.left=x+'px';tip.style.top=y+'px'}
const hideTip=()=>{tip.hidden=true};
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTip()});
function hover(node,title,rows){node.addEventListener('pointerenter',()=>{node.classList.add('on');showTip(node,title,rows)});node.addEventListener('pointerleave',()=>{node.classList.remove('on');hideTip()});node.addEventListener('focus',()=>showTip(node,title,rows));node.addEventListener('blur',hideTip)}

// ---------------------------------------------------------------- live now
let LIVE=new Set();
const nowPager=makePager({mount:$('now-pager'),noun:'people',size:25,draw:people=>{ const tb=$('now-rows');tb.innerHTML='';
 if(!people.length){const tr=el('tr');const td=el('td','empty-state','No active people in the last 5 minutes.');td.colSpan=7;tr.appendChild(td);tb.appendChild(tr)}
 people.forEach(p=>{const tr=el('tr');const choose=()=>{S.client=p.client_id;S.user='';S.range='today';syncControls();load()};
  const c=el('td');c.appendChild(el('span','dot'));const b=el('button','ghost',p.client_name);b.setAttribute('aria-label','Show people at '+p.client_name);b.onclick=choose;c.appendChild(b);tr.appendChild(c);
  tr.appendChild(el('td',null,p.user));tr.appendChild(el('td',null,ago(p.last_seen)));tr.appendChild(el('td',null,timeOf(p.session_start)));
  tr.appendChild(el('td','num',dur(p.today.open_s)));tr.appendChild(el('td','num',dur(p.today.active_s)));tr.appendChild(tlCell(p.user,p.client_id,dayOf(new Date()),p.client_name));tb.appendChild(tr)});}});
async function loadNow(){try{const r=await api('/replays/live/api/now?tz='+encodeURIComponent(TZ)+'&gap='+S.gap);
 LIVE=new Set(r.people.map(p=>p.client_id));
 $('now-count').textContent=r.people.length.toLocaleString();$('pulse').classList.toggle('off',!r.people.length);
 $('now-sub').textContent=(r.people.length===1?'person':'people')+' active in the last '+r.minutes+' minutes';
 $('now-updated').textContent='Updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
 nowPager.set(r.people,true);$('now-sub').className='muted';$('now-sub').removeAttribute('role');
 }catch(e){$('now-updated').textContent='';$('now-sub').textContent=e.message;$('now-sub').className='err';$('now-sub').setAttribute('role','alert')}}

// ---------------------------------------------------------------- the report
let R=null,SESS=[],sortKey='open_s',sortDir=-1,busy=0,sbusy=0;
const pageKeys={};function keepPage(id,key){const keep=pageKeys[id]===key;pageKeys[id]=key;return keep}
async function load(){syncUrl();const my=++busy;$('report').classList.add('loading');$('report').setAttribute('aria-busy','true');$('live-status').removeAttribute('role');$('live-status').textContent='Loading activity…';
 try{const r=await api('/replays/live/api/time?'+params(false));if(my!==busy)return;R=r;render();if(r.warning){const st=$('live-status');st.setAttribute('role','alert');st.textContent=r.warning}
  if(S.client)await loadSessions();else $('sessions-card').classList.add('hidden')}
 catch(e){if(my!==busy)return;$('tiles').innerHTML='';const t=el('div','tile err',e.message+' Change the filters or try again.');t.setAttribute('role','alert');$('tiles').appendChild(t)}
 finally{if(my===busy){$('report').classList.remove('loading');$('report').setAttribute('aria-busy','false');if(!(R&&R.warning))$('live-status').textContent=''}}}
async function loadSessions(){const my=++sbusy,key=params(true).toString();$('sessions-card').setAttribute('aria-busy','true');try{const r=await api('/replays/live/api/sessions?'+key);if(my!==sbusy||key!==params(true).toString())return;SESS=r.sessions;renderSessions()}finally{if(my===sbusy)$('sessions-card').setAttribute('aria-busy','false')}}

function render(){fillClients();renderTiles();renderChart();renderHeat();renderList()}
function fillClients(){const s=$('client'),cur=S.client;s.innerHTML='';s.appendChild(new Option('All clients',''));
 const list=[...R.clients].sort((a,b)=>a.client_name.localeCompare(b.client_name));
 if(cur&&!list.some(c=>c.client_id===cur))list.unshift({client_id:cur,client_name:cur});
 list.forEach(c=>s.appendChild(new Option(c.client_name,c.client_id)));s.value=cur}
function tile(label,value,note,bar){const t=el('div','tile');t.appendChild(el('span',null,label));t.appendChild(el('b',null,value));if(note)t.appendChild(el('small',null,note));if(bar)t.appendChild(bar);$('tiles').appendChild(t)}
function renderTiles(){const T=R.totals;$('tiles').innerHTML='';const[f,t]=period();const days=(Date.parse(t)-Date.parse(f))/864e5+1;
 tile('In the app',hrs(T.open_s),days>1?hrs(T.open_s/days)+' a day':null);
 tile('Active',hrs(T.active_s),T.open_s===0?'No activity':pct(T.active_s,T.open_s)+' of the time',T.open_s>0?segBar(T.active_s,T.idle_s):null);
 tile('Idle',hrs(T.idle_s),T.open_s===0?'No activity':pct(T.idle_s,T.open_s)+' of the time');
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
 const max=Math.max(...items.map(i=>i.open),0);box.previousElementSibling.hidden=max===0;if(max===0){box.appendChild(el('div','chart-empty','No activity recorded for this period.'));$('chart-note').textContent='';chartPager.set(items,keepPage('chart',params(false).toString()));return}const step=niceStep(Math.max(max,60));const top=Math.max(step,Math.ceil(max/step)*step);
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
 chartPager.set(items,keepPage('chart',params(false).toString()))}
const chartPager=makePager({mount:$('chart-table-pager'),noun:'time periods',size:25,draw:items=>{const unit=series().unit; const tb=$('chart-table');tb.innerHTML='';const hr=el('tr');[unit==='hour'?'Hour':'Day','In the app','Active','Idle','People'].forEach((h,i)=>hr.appendChild(el('th',i?'num':null,h)));const th=el('thead');th.appendChild(hr);tb.appendChild(th);const bd=el('tbody');
 items.forEach(it=>{const tr=el('tr');tr.appendChild(el('td',null,it.title));[dur(it.open),dur(it.active),dur(it.idle),String(it.people)].forEach(v=>tr.appendChild(el('td','num',v)));bd.appendChild(tr)});tb.appendChild(bd)}});

const RAMP=Array.from({length:13},(_,i)=>'color-mix(in srgb,var(--muted) '+Math.round(8+i*7)+'%,var(--card))');
function renderHeat(){const[f,t]=period();const card=$('heat-card');if(f===t){card.classList.add('hidden');return}card.classList.remove('hidden');
 const box=$('heat');box.innerHTML='';box.style.gridTemplateColumns='92px repeat(24,minmax(0,1fr))';
 const by=new Map(R.hours.map(h=>[h.day+'|'+h.hour,h]));const max=Math.max(1,...R.hours.map(h=>h.active_s));
 box.appendChild(el('div','lbl',''));for(let h=0;h<24;h++)box.appendChild(el('div','hd',h%3===0?String(h).padStart(2,'0'):''));
 for(let d=t;d>=f;d=addDays(d,-1)){box.appendChild(el('div','lbl',dayName(d)));
  for(let h=0;h<24;h++){const x=by.get(d+'|'+h);const c=el('div','c');c.tabIndex=d===t&&h===0?0:-1;c.setAttribute('role','img');c.onkeydown=e=>{const cells=[...box.querySelectorAll('.c')],i=cells.indexOf(c);let next=i;if(e.key==='ArrowRight')next=i+1;else if(e.key==='ArrowLeft')next=i-1;else if(e.key==='ArrowDown')next=i+24;else if(e.key==='ArrowUp')next=i-24;else if(e.key==='Home')next=0;else if(e.key==='End')next=cells.length-1;else return;e.preventDefault();next=Math.max(0,Math.min(cells.length-1,next));c.tabIndex=-1;cells[next].tabIndex=0;cells[next].focus()};
   if(x&&x.active_s>0){c.style.background=RAMP[Math.min(RAMP.length-1,Math.floor(Math.sqrt(x.active_s/max)*(RAMP.length-1)))]}
   const hh=String(h).padStart(2,'0')+':00–'+String(h+1).padStart(2,'0')+':00';c.setAttribute('aria-label',dayName(d)+' '+hh+': '+dur(x?x.active_s:0)+' active, '+dur(x?x.idle_s:0)+' idle, '+(x?x.people:0)+' people');
   hover(c,dayName(d)+', '+hh,[['var(--act)',dur(x?x.active_s:0),'active'],['var(--idle)',dur(x?x.idle_s:0),'idle'],[null,String(x?x.people:0),(x&&x.people===1)?'person':'people']]);box.appendChild(c)}}
 const sc=$('scale');sc.innerHTML='';sc.appendChild(el('span',null,'Less'));[0,2,4,6,8,10,12].forEach(i=>{const s=el('i');s.style.background=RAMP[i];sc.appendChild(s)});sc.appendChild(el('span',null,'More · up to '+dur(max)+' active in one hour'))}

// clients, or the people of one client
function cols(){return S.client?[['user','Person'],['sessions','Sessions',1],['open_s','In the app',1],['active_s','Active',1],['idle_s','Idle',1],['share','Active share'],['first','First action'],['last','Last action'],['tl','Timeline']]
 :[['client_name','Client'],['people','People',1],['sessions','Sessions',1],['open_s','In the app',1],['active_s','Active',1],['idle_s','Idle',1],['share','Active share'],['last','Last action']]}
function rows(){return S.client?(R.people||[]):R.clients}
const listPager=makePager({mount:$('list-pager'),noun:'clients or people',size:25,draw:slice=>renderList(slice)});
function renderList(slice){const pick=R.clients.find(c=>c.client_id===S.client);
 $('list-title').textContent=S.client?'People at '+(pick?pick.client_name:S.client):'Clients';
 const pill=$('who-pill');pill.innerHTML='';if(S.client){const p=el('span','pill',pick?pick.client_name:S.client);const x=el('button',null,'×');x.title='Show all clients';x.setAttribute('aria-label','Show all clients');x.onclick=()=>{S.client='';S.user='';load()};p.appendChild(x);pill.appendChild(p)}
 const t=$('list');t.innerHTML='';const hr=el('tr');
 cols().forEach(([k,label,num])=>{if(k==='tl'){hr.appendChild(el('th',null,'Timeline'));return}const th=el('th',num?'num':'');th.setAttribute('aria-sort',k===sortKey?(sortDir<0?'descending':'ascending'):'none');const b=el('button','ghost',label);if(k===sortKey){const arrow=el('span','arr',sortDir<0?'▼':'▲');arrow.setAttribute('aria-hidden','true');b.appendChild(arrow)}b.onclick=()=>{if(sortKey===k)sortDir=-sortDir;else{sortKey=k;sortDir=num||k==='last'||k==='share'?-1:1}renderList();const buttons=$('list').querySelectorAll('thead button');for(const button of buttons)if(button.textContent.startsWith(label)){button.focus();break}};th.appendChild(b);hr.appendChild(th)});
 const th=el('thead');th.appendChild(hr);t.appendChild(th);const bd=el('tbody');
 const val=(r,k)=>k==='share'?(r.open_s?r.active_s/r.open_s:0):r[k];
 const list=[...rows()].sort((a,b)=>{const x=val(a,sortKey),y=val(b,sortKey);return(typeof x==='string'?x.localeCompare(y):(x||0)-(y||0))*sortDir});
 if(!slice){listPager.set(list,keepPage('list',params(false).toString()+'|'+sortKey+'|'+sortDir));return}
 if(!list.length){const tr=el('tr');const td=el('td','empty-state','No activity in this period. Try a different period or client.');td.colSpan=cols().length;tr.appendChild(td);bd.appendChild(tr)}
 slice.forEach(r=>{const tr=el('tr');let choose;
  if(S.client){tr.title='Show '+r.user+"'s sessions";choose=()=>{S.user=S.user===r.user?'':r.user;syncUrl();loadSessions().catch(e=>{const status=$('live-status');status.setAttribute('role','alert');status.textContent=e.message+' Choose the person again to retry.'});renderList();for(const b of $('list').querySelectorAll('tbody button'))if(b.getAttribute('aria-label')==='Filter sessions for '+r.user){b.focus();break}};if(S.user===r.user)tr.style.background='var(--chip)'}
  else{tr.title='Show the people at '+r.client_name;choose=()=>{S.client=r.client_id;S.user='';sortKey='open_s';sortDir=-1;load();scrollTo({top:0,behavior:'smooth'})}}
  cols().forEach(([k,,num])=>{let td;
   if(k==='client_name'){td=el('td');if(LIVE.has(r.client_id)){const d=el('span','dot');d.title='In the app now';td.appendChild(d);td.appendChild(el('span','small','Live · '))}const b=el('button','ghost',r.client_name);b.setAttribute('aria-label','Show people at '+r.client_name);b.onclick=choose;td.appendChild(b)}
   else if(k==='share'){td=el('td');td.appendChild(segBar(r.active_s,r.idle_s));td.appendChild(el('span','small muted',' '+pct(r.active_s,r.open_s)))}
   else if(k==='first'||k==='last')td=el('td','small',whenOf(r[k]));
   else if(k==='user'){td=el('td');const b=el('button','ghost',r.user);b.setAttribute('aria-label','Filter sessions for '+r.user);b.setAttribute('aria-pressed',String(S.user===r.user));b.onclick=choose;td.appendChild(b)}
   else if(k==='tl'){const[f,t]=period();td=tlCell(r.user,S.client,f===t?f:dayOf(new Date(r.last)),pick?pick.client_name:'')}
   else td=el('td','num',k.endsWith('_s')?dur(r[k]):Number(r[k]).toLocaleString());
   tr.appendChild(td)});bd.appendChild(tr)});

 t.appendChild(bd);$('list-note').textContent=!list.length?'':S.client?'Choose a person to filter their sessions below. Choose them again to clear.':'Choose a client to see its people and sessions.'}

const sessionsPager=makePager({mount:$('sessions-pager'),noun:'sessions',size:25,draw:slice=>renderSessions(slice)});
function renderSessions(slice){if(!slice){sessionsPager.set(SESS,keepPage('sessions',params(true).toString()));return}const card=$('sessions-card');card.classList.remove('hidden');
 $('sessions-title').textContent=(S.user?S.user+"'s sessions":'Every session')+' ('+SESS.length.toLocaleString()+(SESS.length>=1000?'+':'')+')';
 const t=$('sessions');t.innerHTML='';const hr=el('tr');['Person','Started','Ended','In the app','Active','Idle','Actions','Clip','Timeline'].forEach((h,i)=>hr.appendChild(el('th',i>=3&&i<=6?'num':null,h)));const th=el('thead');th.appendChild(hr);t.appendChild(th);
 const bd=el('tbody');if(!SESS.length){const tr=el('tr');const td=el('td','muted','No sessions in this period. Try a different period or person.');td.colSpan=9;tr.appendChild(td);bd.appendChild(tr)}
 slice.forEach(s=>{const tr=el('tr');tr.appendChild(el('td',null,s.user));tr.appendChild(el('td','small',whenOf(s.start)));tr.appendChild(el('td','small',timeOf(s.end)));
  [dur(s.open_s),dur(s.active_s),dur(s.idle_s),String(s.actions)].forEach(v=>tr.appendChild(el('td','num',v)));
  const td=el('td');const a=el('a','btn ghost small','Make a clip');a.href='/replays?url='+encodeURIComponent(s.session_id);a.title='Open this session on the clip page';a.style.padding='3px 9px';td.appendChild(a);tr.appendChild(td);tr.appendChild(tlCell(s.user,s.client_id,dayOf(new Date(s.start)),s.client_name));bd.appendChild(tr)});
 t.appendChild(bd);$('more').classList.add('hidden')}
$('more').onclick=()=>renderSessions();

// ---------------------------------------------------------------- one person's day
function tlCell(user,client,day,name){const td=el('td');const b=el('button','ghost tlbtn','Timeline');b.type='button';b.title='Show '+user+"'s day as a timeline";b.onclick=e=>{e.stopPropagation();openTimeline(user,client,day,name)};td.appendChild(b);return td}
let timelineOpener=null;
function openTimeline(user,client,day,name){timelineOpener=document.activeElement;TL.user=user;TL.client=client||'';TL.clientName=name||'';TL.day=day||dayOf(new Date());TL.pin=null;TL.shown=300;TL.data=null;TM=null;$('tl-card').classList.remove('hidden');syncUrl();loadTimeline();$('tl-title').tabIndex=-1;$('tl-title').focus();$('tl-card').scrollIntoView({behavior:'smooth',block:'start'})}
async function loadTimeline(){if(!TL.user)return;const my=++tlbusy;$('tl-card').classList.add('loading');$('tl-card').setAttribute('aria-busy','true');$('tl-sub').textContent='Loading timeline…';
 try{const q=new URLSearchParams({user:TL.user,from:TL.day,to:TL.day,tz:TZ,gap:String(S.gap)});if(TL.client)q.set('client',TL.client);
  const d=await api('/replays/live/api/person?'+q);if(my!==tlbusy)return;TL.data=d;renderTimeline()}
 catch(e){if(my!==tlbusy)return;$('tl-title').textContent=TL.user;$('tl-sub').textContent=e.message;$('tl-sub').className='small err';$('tl-sub').setAttribute('role','alert')}
 finally{if(my===tlbusy){$('tl-card').classList.remove('loading');$('tl-card').setAttribute('aria-busy','false')}}}
const PF=new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const secOf=iso=>{const o={};PF.formatToParts(new Date(iso)).forEach(x=>o[x.type]=x.value);return(+o.hour)*3600+(+o.minute)*60+(+o.second)};
const hms=x=>{x=Math.max(0,Math.round(x));return String(Math.floor(x/3600)).padStart(2,'0')+':'+String(Math.floor(x%3600/60)).padStart(2,'0')+':'+String(x%60).padStart(2,'0')};
const hm=x=>hms(x).slice(0,5);
function fact(label,value){const sp=el('span');sp.appendChild(document.createTextNode(label+' '));sp.appendChild(el('b',null,value));$('tl-facts').appendChild(sp)}
// Sessions with their active stretches, in seconds since midnight (viewer's timezone), and lanes so
// sessions at the same time (two browsers) do not hide each other.
function tlModel(d){const acts=d.actions.map(a=>({...a,s:secOf(a.t)})).sort((a,b)=>a.s-b.s);
 const sessions=d.sessions.map(x=>({...x,s0:secOf(x.start),s1:Math.max(secOf(x.start),secOf(x.end)),active:[]})).sort((a,b)=>a.s0-b.s0);
 const byId=new Map(sessions.map(x=>[x.session_id,x]));
 acts.forEach(a=>{const x=byId.get(a.session_id);if(!x)return;const e=Math.min(86400,a.s+Math.min(a.gap_s,d.gap_s));if(e<=a.s)return;const last=x.active[x.active.length-1];if(last&&a.s<=last[1])last[1]=Math.max(last[1],e);else x.active.push([a.s,e])});
 const lanes=[];sessions.forEach(x=>{let i=lanes.findIndex(end=>end<x.s0);if(i<0){i=lanes.length;lanes.push(0)}lanes[i]=x.s1;x.lane=i});
 return{acts,sessions,lanes:Math.max(1,lanes.length)}}
let TM=null;
function renderTimeline(){const d=TL.data;TM=tlModel(d);const today=dayOf(new Date());
 if(d.actions.length&&d.client_name)TL.clientName=d.client_name;$('tl-title').textContent=d.user;$('tl-sub').className='small muted';$('tl-sub').removeAttribute('role');$('tl-sub').textContent=[TL.clientName||d.client_name,dayName(d.day)+(d.day===today?' (today)':'')].filter(Boolean).join(' · ');
 $('tl-day').value=d.day;$('tl-next').disabled=d.day>=today;$('tl-whole').checked=TL.whole;
 $('tl-facts').innerHTML='';const T=d.totals;
 if(!T.sessions){fact('No activity on','this day');}
 else{fact('In the app',dur(T.open_s));fact('Active',dur(T.active_s)+' ('+pct(T.active_s,T.open_s)+')');fact('Idle',dur(T.idle_s));fact('Sessions',String(T.sessions));fact('Actions',T.actions.toLocaleString());
  fact('First action',hm(secOf(T.first)));fact('Last action',hm(secOf(T.last)));if(T.longest_pause_s>=60)fact('Longest pause',dur(T.longest_pause_s))}
 drawTimeline();renderPin();renderTlList()}
function tlRange(){if(TL.whole||!TM.sessions.length)return[0,86400];const a=Math.min(...TM.sessions.map(x=>x.s0)),b=Math.max(...TM.sessions.map(x=>x.s1));
 let r0=Math.floor(a/3600)*3600,r1=Math.ceil((b+1)/3600)*3600;if(r1-r0<3600)r1=Math.min(86400,r0+3600);if(r1-r0<3600)r0=Math.max(0,r1-3600);return[r0,r1]}
let TG=null;
function drawTimeline(){const box=$('tl-chart');box.innerHTML='';const[r0,r1]=tlRange();
 const W=Math.max(320,box.clientWidth||900),L=4,R=4,TICK=14,LANE=26,GAPL=12,AX=22,lanes=TM.lanes;
 const laneTop=i=>TICK+i*(LANE+TICK+GAPL);const H=laneTop(lanes)-GAPL+AX;const pw=W-L-R;const X=v=>L+(Math.min(r1,Math.max(r0,v))-r0)/(r1-r0)*pw;
 const svg=sv('svg',{viewBox:'0 0 '+W+' '+H,height:H,role:'img','aria-label':'Timeline of '+TL.data.user+' on '+dayName(TL.data.day)});
 const span=r1-r0,steps=[900,1800,3600,7200,10800,21600];const step=steps.find(st=>pw/(span/st)>=56)||21600;
 for(let v=Math.ceil(r0/step)*step;v<=r1;v+=step){const x=X(v);svg.appendChild(sv('line',{x1:x,x2:x,y1:0,y2:H-AX,stroke:'var(--grid)','stroke-width':1}));const tx=sv('text',{x:x,y:H-6,'text-anchor':v===r0?'start':v===r1?'end':'middle'});tx.textContent=v>=86400?'24:00':hm(v);svg.appendChild(tx)}
 for(let i=0;i<lanes;i++)svg.appendChild(sv('rect',{x:L,y:laneTop(i)+TICK,width:pw,height:LANE,rx:4,fill:'var(--bg)'}));
 TM.sessions.forEach(x=>{const y=laneTop(x.lane)+TICK;const x0=X(x.s0),w=Math.max(2,X(x.s1)-x0);svg.appendChild(sv('rect',{x:x0,y:y,width:w,height:LANE,rx:3,fill:'var(--idle)'}));
  x.active.forEach(([a,b])=>{const ax=X(a);svg.appendChild(sv('rect',{x:ax,y:y,width:Math.max(1.5,X(b)-ax),height:LANE,fill:'var(--act)'}))})});
 const lane=new Map(TM.sessions.map(x=>[x.session_id,x.lane]));
 TM.acts.forEach(a=>{const i=lane.get(a.session_id)||0;const opened=a.label.startsWith('Opened');const x=X(a.s);const y=laneTop(i)+TICK;svg.appendChild(sv('line',{x1:x,x2:x,y1:y-(opened?12:7),y2:y-2,stroke:opened?'var(--ink)':'var(--muted)','stroke-width':1,'stroke-opacity':opened?0.9:0.55}))});
 const cross=sv('line',{x1:0,x2:0,y1:0,y2:H-AX,stroke:'var(--ink)','stroke-width':1,visibility:'hidden'});svg.appendChild(cross);
 const pin=sv('line',{x1:0,x2:0,y1:0,y2:H-AX,stroke:'var(--accent)','stroke-width':2,visibility:'hidden'});svg.appendChild(pin);
 const hit=sv('rect',{x:L,y:0,width:pw,height:H-AX,fill:'transparent'});svg.appendChild(hit);box.appendChild(svg);
 TG={r0,r1,L,pw,W,X,cross,pin,svg};
 const secAt=ev=>{const b=svg.getBoundingClientRect();const px=(ev.clientX-b.left)*W/b.width;return r0+(px-L)/pw*(r1-r0)};
 hit.addEventListener('pointermove',ev=>{const sec=secAt(ev);const info=tlAt(sec);cross.setAttribute('x1',X(info.sec));cross.setAttribute('x2',X(info.sec));cross.setAttribute('visibility','visible');
  const rows=[[info.state==='active'?'var(--act)':info.state==='idle'?'var(--idle)':null,info.state==='out'?'Not in the app':info.state==='active'?'Active':'Idle',info.pause?'· pause of '+dur(info.pause):'']];
  if(info.act)rows.push([null,info.act.label,info.act.screen&&!info.act.label.includes(info.act.screen)?'on '+info.act.screen:'']);
  showTipXY(ev.clientX,ev.clientY,hms(info.sec),rows)});
 hit.addEventListener('pointerleave',()=>{cross.setAttribute('visibility','hidden');hideTip()});
 hit.addEventListener('click',ev=>{TL.pin=tlAt(secAt(ev));renderPin()})}
// What was happening at a second: the nearest action (if close), and whether the person was active,
// idle or not in the app.
function tlAt(sec){const acts=TM.acts;let lo=0,hi=acts.length-1,best=null;
 while(lo<=hi){const m=(lo+hi)>>1;if(acts[m].s<sec)lo=m+1;else hi=m-1}
 [acts[lo-1],acts[lo]].forEach(a=>{if(a&&(!best||Math.abs(a.s-sec)<Math.abs(best.s-sec)))best=a});
 const tol=Math.max(15,(TG.r1-TG.r0)/TG.pw*6);const act=best&&Math.abs(best.s-sec)<=tol?best:null;const at=act?act.s:sec;
 const x=TM.sessions.find(z=>at>=z.s0&&at<=z.s1);let state='out',pause=0;
 if(x){state=x.active.some(([a,b])=>at>=a&&at<b)?'active':'idle';if(state==='idle'){const before=acts.filter(a=>a.session_id===x.session_id&&a.s<=at).pop();if(before)pause=before.gap_s}}
 if(act&&state==='idle'&&act.s===at)state='active';
 return{sec:at,act,session:x,state,pause}}
function showTipXY(x,y,title,rows){tip.innerHTML='';tip.appendChild(el('div','t',title));rows.forEach(([color,value,label])=>{const r=el('div','r');if(color){const k=el('span','k');k.style.background=color;r.appendChild(k)}r.appendChild(el('b',null,value));if(label)r.appendChild(el('span','muted',label));tip.appendChild(r)});
 tip.hidden=false;const w=tip.offsetWidth,h=tip.offsetHeight;let left=x+14,top=y-h-12;if(left+w>innerWidth-4)left=x-w-14;if(top<4)top=y+16;tip.style.left=Math.max(4,left)+'px';tip.style.top=top+'px'}
function clipLink(session,abs){if(!session||!session.recording_start)return null;const rs=Date.parse(session.recording_start);const off=Math.max(0,Math.floor((abs-rs)/1000)-10);return{off,from:secOf(new Date(rs+off*1000).toISOString()),href:'/replays?url='+encodeURIComponent(CFG.replayBase+session.session_id+'?t='+off)}}
function absOf(sec,session){return Date.parse(session.start)+(sec-session.s0)*1000}
function renderPin(){const box=$('tl-pick');box.innerHTML='';box.className='small';const P=TL.pin;
 if(!P||!TG){TG&&TG.pin.setAttribute('visibility','hidden');box.className='small muted';box.textContent='Point at the timeline to see what happened. Click a moment to make a clip from it.';return}
 TG.pin.setAttribute('x1',TG.X(P.sec));TG.pin.setAttribute('x2',TG.X(P.sec));TG.pin.setAttribute('visibility','visible');
 box.appendChild(el('b',null,hms(P.sec)));
 box.appendChild(document.createTextNode(P.state==='out'?' Not in the app.':P.act?' '+P.act.label+(P.act.screen&&!P.act.label.includes(P.act.screen)?' on '+P.act.screen:'')+'.':' '+(P.state==='active'?'Active':'Idle')+'.'));
 if(P.session){const abs=P.act?Date.parse(P.act.t):absOf(P.sec,P.session);const c=clipLink(P.session,abs);
  if(c){const a=el('a','btn ghost tlbtn','Make a clip from '+hms(c.from));a.href=c.href;a.title='Opens the clip page 10 seconds before this moment (or where the recording starts)';box.appendChild(a)}
  else box.appendChild(el('span','muted','This session has no recording, so there is no clip.'))}}
$('tl-chart').addEventListener('keydown',e=>{if(!TM||!TM.acts.length)return;const acts=TM.acts;let i=TL.pin&&TL.pin.act?acts.indexOf(acts.find(a=>a.t===TL.pin.act.t&&a.session_id===TL.pin.act.session_id)):-1;
 if(e.key==='ArrowRight')i=Math.min(acts.length-1,i+1);else if(e.key==='ArrowLeft')i=i<0?acts.length-1:Math.max(0,i-1);else if(e.key==='Home')i=0;else if(e.key==='End')i=acts.length-1;else return;
 e.preventDefault();TL.pin=tlAt(acts[i].s);TL.pin.act=acts[i];renderPin()});
const actionsPager=makePager({mount:$('tl-list-pager'),noun:'actions',size:25,draw:slice=>renderTlList(slice)});
function renderTlList(slice){if(!slice){actionsPager.set(TM.acts,keepPage('actions',TL.user+'|'+TL.client+'|'+TL.day));return}const d=TL.data,t=$('tl-list');t.innerHTML='';$('tl-list-sum').textContent='Every action ('+d.actions.length.toLocaleString()+(d.truncated?'+, the first '+d.actions.length.toLocaleString()+' shown':'')+')';
 const hr=el('tr');['Time','What','Screen','Then','Clip'].forEach(h=>hr.appendChild(el('th',null,h)));const th=el('thead');th.appendChild(hr);t.appendChild(th);const bd=el('tbody');
 const sess=new Map(TM.sessions.map(x=>[x.session_id,x]));if(!slice.length){const tr=el('tr'),td=el('td','muted','No actions on this day. Try another day.');td.colSpan=5;tr.appendChild(td);bd.appendChild(tr)}
 slice.forEach(a=>{const tr=el('tr');tr.appendChild(el('td','small',hms(a.s)));tr.appendChild(el('td',null,a.label));tr.appendChild(el('td','small muted',a.screen));
  tr.appendChild(el('td','small muted',a.last?'last action of the session':a.gap_s>d.gap_s?'idle '+dur(a.gap_s-d.gap_s):''));
  const td=el('td');const c=clipLink(sess.get(a.session_id),Date.parse(a.t));if(c){const l=el('a','btn ghost tlbtn','Clip');l.href=c.href;l.title='Make a clip from 10 seconds before this action';td.appendChild(l)}tr.appendChild(td);bd.appendChild(tr)});
 t.appendChild(bd);$('tl-more').classList.add('hidden')}
$('tl-more').onclick=()=>{TL.shown+=300;renderTlList()};
$('tl-close').onclick=()=>{++tlbusy;TL.user='';TL.data=null;TM=null;$('tl-card').classList.add('hidden');hideTip();syncUrl();if(timelineOpener&&timelineOpener.isConnected)timelineOpener.focus();else $('client').focus()};
$('tl-card').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();$('tl-close').click()}});
$('tl-prev').onclick=()=>{TL.day=addDays(TL.day,-1);TL.pin=null;syncUrl();loadTimeline()};
$('tl-next').onclick=()=>{const t=dayOf(new Date());if(TL.day>=t)return;TL.day=addDays(TL.day,1);TL.pin=null;syncUrl();loadTimeline()};
$('tl-today').onclick=()=>{TL.day=dayOf(new Date());TL.pin=null;syncUrl();loadTimeline()};
$('tl-day').onchange=()=>{if(!$('tl-day').value)return;TL.day=$('tl-day').value;TL.pin=null;syncUrl();loadTimeline()};
$('tl-whole').onchange=()=>{TL.whole=$('tl-whole').checked;if(TL.data){drawTimeline();renderPin()}};

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
$('from').onchange=$('to').onchange=()=>{S.from=$('from').value;S.to=$('to').value;if(S.from&&S.to&&S.to>=S.from){$('to').setCustomValidity('');load()}else{$('to').setCustomValidity('Choose an end date on or after the start date.');$('to').reportValidity()}};
$('client').onchange=()=>{S.client=$('client').value;S.user='';sortKey='open_s';sortDir=-1;load()};
$('gap').onchange=()=>{S.gap=Number($('gap').value);load();loadNow();loadTimeline()};
let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(()=>{if(R)renderChart();if(TL.data){drawTimeline();renderPin()}},150)});
syncControls();load();loadNow();
setInterval(()=>{if(document.hidden||document.activeElement?.closest('main button,main input,main select,main summary,#tl-chart,#tl-card'))return;loadNow();if(period()[1]>=dayOf(new Date()))load();if(TL.user&&TL.day===dayOf(new Date()))loadTimeline()},30000);
if(TL.user){if(!TL.day)TL.day=dayOf(new Date());$('tl-card').classList.remove('hidden');loadTimeline()}
</script></body></html>`
}
