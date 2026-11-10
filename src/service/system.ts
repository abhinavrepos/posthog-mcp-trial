// The System page: is everything up, and how hard is the machine working. Admins, and anyone an admin
// ticked "System page" for on the admin page. The numbers
// come from the status page (deploy/status), which this service reads over localhost, so nobody needs
// a tunnel to port 8090. They are counts, times and machine figures; no event or replay content.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { canSeeSystem, readAudit, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS, storage } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

export async function readStatus(fetcher: typeof fetch = fetch): Promise<{ status: number; body: unknown }> {
    const { statusUrl, statusPassword } = config.service
    const headers: Record<string, string> = statusPassword ? { authorization: `Basic ${Buffer.from(`lens:${statusPassword}`).toString('base64')}` } : {}
    try {
        const r = await fetcher(`${statusUrl}/api/status`, { headers, signal: AbortSignal.timeout(8000) })
        if (!r.ok) return { status: 502, body: { error: `The status service answered ${r.status}.` } }
        return { status: 200, body: await r.json() }
    } catch {
        return { status: 502, body: { error: 'The status service is not answering.' } }
    }
}

// Shared with the browser so health and process state cannot disagree in the tile.
export function containerSummary(rows: { state?: string; health?: string | null; level: string }[]) {
    const expected = rows.filter(c => c.level !== 'info')
    return { expected: expected.length, running: expected.filter(c => c.state === 'running').length,
        unhealthy: expected.filter(c => c.health === 'unhealthy').length,
        restarting: expected.filter(c => c.state === 'restarting').length,
        stopped: expected.filter(c => c.state && c.state !== 'running' && c.state !== 'restarting').length,
        problems: expected.filter(c => c.level === 'down' || c.level === 'warn').length }
}

export function lensActivity(auditReader = readAudit, storageReader = storage, now = Date.now()) {
    const since = new Date(now - 86400_000).toISOString()
    let activity = null, disk = null
    try {
        const rows = auditReader({ since, limit: 100_000 })
        const count = (action: string) => rows.filter(r => r.action === action).length
        activity = { signins: count('signin'), failed_signins: count('signin.failed'), clips_made: count('clip.created'),
            clips_watched: count('clip.viewed'), clips_downloaded: count('clip.downloaded'), share_links: count('clip.link_shared'),
            truncated: rows.length >= 100_000 }
    } catch {}
    try { const d = storageReader(); disk = { clips: d.clips, bytes: d.bytes, saved: d.saved, saved_bytes: d.saved_bytes } } catch {}
    return { since, activity, storage: disk }
}

export async function handleSystem(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    const page = p === '/replays/system' || p === '/replays/system/'
    if (!canSeeSystem(v)) {
        if (page) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>System · ${APP_NAME}</title><style>${PAGE_CSS()}</style></head><body>${headerHtml(v, 'System')}<main style="max-width:560px"><div class="card"><h2>No access to the System page</h2><p class="muted">Ask an admin to tick "System page" for you on the admin page.</p></div></main></body></html>`)
        } else json(res, 403, { error: 'No access to the System page. Ask an admin.' })
        return true
    }
    if (req.method !== 'GET') return (json(res, 405, { error: 'GET only.' }), true)
    if (page) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(systemHtml(v))
        return true
    }
    if (p === '/replays/system/api') {
        const r = await readStatus()
        json(res, r.status, r.status === 200 ? { ...(r.body as Record<string, unknown>), lens: lensActivity() } : r.body)
        return true
    }
    json(res, 404, { error: 'Not found.' })
    return true
}

export function systemHtml(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>System · ${APP_NAME}</title><style>${PAGE_CSS()}
:root{--act:#2a78d6;--grid:#e1e0d9;--axis:#c3c2b7;--good:#067647;--good-bg:#e7f5ec;--warn:#9a5b00;--warn-bg:#fff4dd;--down:#b42318;--down-bg:#fde9e7;--info-bg:#eef2ff}
main.wide{max-width:1180px}
.banner{display:flex;gap:14px;align-items:center;padding:14px 18px;border-radius:12px;margin-bottom:14px;border:1px solid var(--line);background:var(--card)}
.banner h1{margin:0;font-size:20px}.banner p{margin:2px 0 0;color:var(--muted);font-size:13px}
.banner .big{font-size:20px;font-weight:700;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;flex:none;color:#fff;background:var(--muted)}
.banner.ok{background:var(--good-bg)}.banner.ok .big{background:var(--good)}.banner.warn{background:var(--warn-bg)}.banner.warn .big{background:var(--warn)}.banner.down{background:var(--down-bg)}.banner.down .big{background:var(--down)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:14px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}.tile span{display:block;font-size:13px;color:var(--muted)}.tile b{display:block;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.tile small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:14px;margin-bottom:14px}.charts .card,.split .card{margin:0;min-width:0}.charts h2,.split h2{margin-top:0}
.chart{position:relative}.chart svg{display:block;max-width:100%}.note{color:var(--muted);font-size:13px;padding:30px 0;text-align:center}
.tip{position:absolute;pointer-events:none;background:#1c2230;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%);z-index:2}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:14px;margin-bottom:14px}
.svc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:7px 0;border-top:1px solid var(--line);font-size:14px}.svc:first-of-type{border-top:0}.svc .d{color:var(--muted);font-size:12.5px;text-align:right}
.st{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;white-space:nowrap}.st i{font-style:normal;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px}
.st.ok{color:var(--good)}.st.ok i{background:var(--good)}.st.warn{color:var(--warn)}.st.warn i{background:var(--warn)}.st.down{color:var(--down)}.st.down i{background:var(--down)}.st.info{color:var(--muted)}.st.info i{background:var(--muted)}
.tools{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.tools h2{margin:0}.tools input{max-width:240px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}td.w{overflow-wrap:anywhere}td small{display:none;color:var(--muted)}
@media (max-width:640px){.tools input{max-width:none}th.r,td.r{display:none}td small{display:block}.st{font-size:0;gap:0}.svc .st{font-size:12.5px;gap:5px}table{font-size:13px}th,td{padding:7px 4px}}
details.nums summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:6px}details.nums table{font-size:13px}
.tile.problem{border-color:var(--down);background:var(--down-bg)}.tile.problem small{color:var(--down)}
#problems:empty{display:none}.card{overflow-wrap:anywhere}main.wide{min-width:0}.table-wrap{overflow:visible}table{width:100%;table-layout:fixed}.containers-table th:first-child{width:72px}.containers-table th:nth-child(2){width:26%}.containers-table th.r{width:22%}td,th{overflow-wrap:anywhere}
.spark{display:block;width:90px;max-width:100%;height:24px}.container-detail{font-size:12px;color:var(--muted)}.container-detail p{margin:4px 0}.container-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
select{max-width:100%;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
@media(max-width:640px){.containers-table th:nth-child(2){width:42%}.svc{grid-template-columns:minmax(0,1fr) auto}.svc .d{grid-column:1/-1;grid-row:2;text-align:left}.containers-table th:last-child,.containers-table td:last-child{display:none}.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.tile b{font-size:21px}.banner{padding:12px}.card{padding:12px}.containers-table th:first-child{width:28px}.tools input{width:100%;min-width:0}}
</style></head>
<body>${headerHtml(v, 'System')}<main class="wide">
<div class="banner" id="banner" role="status"><span class="big" id="b-icon" aria-hidden="true">…</span><div><h1 id="b-head">Checking…</h1><p id="b-sub"></p></div></div>
<div id="problems"></div>
<div class="tiles" id="tiles"></div>
<div class="charts">
<div class="card"><h2>Events per hour, last 24 hours</h2><div class="chart" id="c-events"></div><details class="nums"><summary>Show the numbers</summary><div id="t-events"></div></details></div>
<div class="card"><h2>Events per minute, last 60 minutes</h2><div class="chart" id="c-minutes"></div></div>
<div class="card"><h2>CPU, last hour</h2><div class="chart" id="c-cpu"></div></div>
<div class="card"><h2>Memory, last hour</h2><div class="chart" id="c-mem"></div></div>
<div class="card"><h2>Disk used, last hour</h2><div class="chart" id="c-disk"></div></div>
<div class="card"><h2>Load, last hour</h2><div class="chart" id="c-load"></div></div>
</div>
<div class="split" id="services"></div>
<div class="split"><div class="card" id="clickhouse"></div><div class="card" id="lens"></div></div>
<div class="card"><div class="tools"><h2 id="c-title">Containers</h2><select id="view" aria-label="Container view"><option value="all">All containers · problems first</option><option value="mem_bytes">Top 5 by memory</option><option value="cpu_pct">Top 5 by CPU</option></select><input id="find" type="search" placeholder="Find a container" aria-label="Find a container"></div>
<div class="table-wrap"><table class="containers-table"><thead><tr><th>Status</th><th>Container</th><th class="r">Running</th><th class="n">CPU</th><th class="n">Memory</th><th class="n">Restarts</th></tr></thead><tbody id="rows"></tbody></table></div></div>
<div class="card"><h2>Recent changes</h2><div id="changes"></div></div>
<div class="card"><h2>About this server</h2><div id="about"></div></div>
<p class="small muted">Counts and machine figures only, refreshed every 15 seconds. No event or replay content is read. CPU and memory history restarts when the status service does.</p>
</main>
<script>${CLIENT}</script></body></html>`
}

// Runs in the browser. Names come from Docker, so everything goes through esc().
const CLIENT = String.raw`
const containerSummary = ${containerSummary.toString()}
const $=id=>document.getElementById(id)
const plural=(n,w)=>n+' '+w+(n===1?'':'s')
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const num=n=>esc(n==null?'–':Number(n).toLocaleString('en-US'))
const gb=b=>esc(b==null?'–':b>=1024**3?(b/1024**3).toFixed(1)+' GB':Math.round(b/1024**2)+' MB')
const pct=n=>esc(n==null?'–':(Number(n)<10?Number(n).toFixed(1):Math.round(Number(n)))+'%')
const LABEL={ok:'Up',warn:'Warning',down:'Down',info:'Info'},ICON={ok:'✓',warn:'!',down:'✕',info:'i'},RANK={down:3,warn:2,ok:1,info:0}
const st=value=>{const l=Object.hasOwn(LABEL,value)?value:'info';return '<span class="st '+l+'"><i aria-hidden="true">'+ICON[l]+'</i>'+LABEL[l]+'</span>'}
const clock=t=>new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
const nice=m=>{if(m<=0)return 1;const p=10**Math.floor(Math.log10(m));for(const s of [1,2,5,10])if(s*p>=m)return s*p;return 10*p}

// The same frame for each chart: three quiet grid lines, labels on the left, hover on a wide target.
let W=560
const H=190,L=44,R=8,T=8,B=22
function frame(max,fmt,xlabels){const y=v=>T+(H-T-B)*(1-v/max);let g=''
  for(const v of [0,max/2,max])g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var('+(v?'--grid':'--axis')+')"/><text x="'+(L-6)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+fmt(v)+'</text>'
  for(const [x,t,a] of xlabels)g+='<text x="'+x+'" y="'+(H-6)+'" text-anchor="'+a+'" font-size="11" fill="var(--muted)">'+esc(t)+'</text>'
  return {y,g}}
function hover(box,points){box.onmousemove=e=>{const s=box.querySelector('svg');if(!s)return;const r=s.getBoundingClientRect(),w=+s.getAttribute('width'),x=(e.clientX-r.left)/r.width*w
  let best=null,d=1e9;for(const p of points){const k=Math.abs(p.x-x);if(k<d){d=k;best=p}}
  let t=box.querySelector('.tip');if(!t){t=document.createElement('div');t.className='tip';box.append(t)}
  if(!best){t.remove();return}t.textContent=best.text;t.style.left=Math.min(r.width-60,Math.max(60,best.x/w*r.width))+'px';t.style.top=Math.max(26,best.y/H*r.height)+'px'}
  box.onmouseleave=()=>box.querySelector('.tip')?.remove()}

function bars(box,data,minute=false,at=Date.now()){W=box.clientWidth||560;if(!data){box.innerHTML='<p class="note">No event counts yet.</p>';return}
  const hour=minute?60000:3600000,count=minute?60:24,now=Math.floor(at/hour)*hour,by=new Map(data),slots=[];for(let i=count-1;i>=0;i--){const t=now-i*hour;slots.push([t,by.get(t)||0])}
  const max=nice(Math.max(...slots.map(s=>s[1]),1)),step=(W-L-R)/count,bw=Math.max(1,step-2)
  const f=frame(max,v=>v>=1000?(v/1000)+'k':String(Math.round(v)),[[L+bw/2,clock(slots[0][0]),'start'],[L+(count/2)*step,clock(slots[count/2][0]),'middle'],[W-R,clock(slots[count-1][0]),'end']]);const pts=[];let b=''
  slots.forEach(([t,n],i)=>{const x=L+i*step+1,top=f.y(n),base=f.y(0);if(n){const h=Math.max(2,base-top),r=Math.min(4,bw/2,h);b+='<path fill="var(--act)" d="M'+x+' '+base+'v'+(-(h-r))+'q0 '+(-r)+' '+r+' '+(-r)+'h'+(bw-2*r)+'q'+r+' 0 '+r+' '+r+'v'+(h-r)+'z"/>'}
    pts.push({x:x+bw/2,y:top,text:clock(t)+' · '+num(n)+' events'})})
  box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Event counts">'+f.g+b+'</svg>';hover(box,pts)
  if(!minute)$('t-events').innerHTML='<table><thead><tr><th>Hour</th><th class="n">Events</th></tr></thead><tbody>'+slots.slice().reverse().map(s=>'<tr><td>'+clock(s[0])+'</td><td class="n">'+num(s[1])+'</td></tr>').join('')+'</tbody></table>'}

function line(box,hist,idx,name,load=false){W=box.clientWidth||560;const p=(hist||[]).filter(h=>h[idx]!=null);if(p.length<2){box.innerHTML='<p class="note">Collecting, this fills in over the next few minutes.</p>';return}
  const t0=p[0][0],t1=p[p.length-1][0],x=t=>L+(W-L-R)*(t-t0)/Math.max(1,t1-t0),f=frame(load?nice(Math.max(...p.map(h=>h[idx]),1)):100,v=>load?String(v):v+'%',[[L,clock(t0),'start'],[W-R,clock(t1),'end']])
  const pts=p.map(h=>({x:x(h[0]),y:f.y(h[idx]),text:clock(h[0])+' · '+name+' '+(load?Number(h[idx]).toFixed(1):pct(h[idx]))})),d=pts.map((q,i)=>(i?'L':'M')+q.x.toFixed(1)+' '+q.y.toFixed(1)).join('')
  const e=pts[pts.length-1];box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(name)+' for the last hour, now '+(load?Number(p.at(-1)[idx]).toFixed(1):pct(p.at(-1)[idx]))+'">'+f.g+'<path d="'+d+'" fill="none" stroke="var(--act)" stroke-width="2" stroke-linejoin="round"/><circle cx="'+e.x+'" cy="'+e.y+'" r="4" fill="var(--act)" stroke="var(--card)" stroke-width="2"/></svg>';hover(box,pts)}

const tile=(name,value,sub,problem=false)=>'<div class="tile'+(problem?' problem':'')+'"><span>'+esc(name)+'</span><b>'+esc(value)+'</b>'+(sub?'<small>'+esc(sub)+'</small>':'')+'</div>'
let containers=[]
const opened=new Set()
function spark(hist,idx,label){const p=(hist||[]).filter(h=>Number.isFinite(h[idx]));if(p.length<2)return '';const max=Math.max(...p.map(h=>h[idx]),1),t0=p[0][0],dt=Math.max(1,p.at(-1)[0]-t0);return '<svg class="spark" viewBox="0 0 90 24" role="img" aria-label="'+esc(label)+' over the last hour"><path d="'+p.map((h,i)=>(i?'L':'M')+(90*(h[0]-t0)/dt).toFixed(1)+' '+(23-22*h[idx]/max).toFixed(1)).join('')+'" fill="none" stroke="var(--act)" stroke-width="1.5"/></svg>'}
function table(){const q=$('find').value.trim().toLowerCase();let list=containers.filter(c=>c.name.toLowerCase().includes(q));const view=$('view').value
  if(view!=='all')list=list.slice().sort((a,b)=>(b[view]??-1)-(a[view]??-1)).slice(0,5)
  $('rows').innerHTML=list.map(c=>{const key=c.group+'/'+c.name;return '<tr><td>'+st(c.level)+'</td><td class="w"><details data-key="'+esc(key)+'"'+(opened.has(key)?' open':'')+'><summary>'+esc(c.name)+'</summary><div class="container-detail">'+[
    ['Image',c.image],['Started',c.started_at],['OOM killed',c.oom_killed==null?null:String(c.oom_killed)],['Exit code',c.exit_code],
    ['Memory limit',c.mem_limit_bytes?gb(c.mem_limit_bytes)+' ('+pct(c.mem_limit_pct)+' used)':'No limit'],
    ['Network rx / tx',gb(c.network_rx_bytes)+' / '+gb(c.network_tx_bytes)],['Block read / write',gb(c.block_read_bytes)+' / '+gb(c.block_write_bytes)],['PIDs',c.pids]
  ].map(([k,v])=>'<p>'+esc(k)+': '+esc(v??'–')+'</p>').join('')+(c.health_output?'<pre>Last health check: '+esc(c.health_output)+'</pre>':'')+'</div></details><small>'+esc(c.detail)+'</small></td><td class="r">'+esc(c.detail)+'</td><td class="n">'+pct(c.cpu_pct)+spark(c.history,1,'CPU')+'</td><td class="n">'+gb(c.mem_bytes)+spark(c.history,2,'Memory')+'</td><td class="n">'+num(c.restarts)+'</td></tr>'}).join('')||'<tr><td colspan="6" class="muted">No container matches.</td></tr>'
  $('rows').querySelectorAll('details').forEach(d=>d.ontoggle=()=>d.open?opened.add(d.dataset.key):opened.delete(d.dataset.key))}
$('find').oninput=table;$('view').onchange=table
let lastStatus=null,connectionError=null
function freshness(){if(!lastStatus)return;const s=lastStatus,age=s.checked_at?Math.max(0,Math.floor((Date.now()-Date.parse(s.checked_at))/1000)):null,stale=age!=null&&age>60
  $('banner').className='banner '+(stale?'warn':connectionError?'down':s.level);$('b-icon').textContent=stale?'!':connectionError?'✕':ICON[s.level]||'…'
  $('b-head').textContent=stale?'Status data is stale — checks have stopped':connectionError?connectionError:!s.checked_at?'Checking…':s.down?plural(s.down,'problem')+(s.warn?', '+plural(s.warn,'warning'):''):s.warn?'Everything is up, '+plural(s.warn,'warning'):'Everything is up'
  $('b-sub').textContent=age==null?'Waiting for the first check':'Updated '+age+' s ago · '+new Date(s.checked_at).toLocaleString()}
const pairs=entries=>entries.map(([k,v])=>'<div class="svc"><span>'+esc(k)+'</span><span class="d">'+esc(v??'–')+'</span></div>').join('')

function draw(s){const rows=s.checks||[],m=s.metrics||{},mc=m.machine||{},byName=g=>rows.filter(r=>r.group===g)
  const box=rows.filter(r=>r.group.startsWith('Containers')).sort((a,b)=>RANK[b.level]-RANK[a.level]||a.name.localeCompare(b.name));containers=box
  const counts=containerSummary(box);lastStatus=s;connectionError=null;freshness()
  const problems=rows.filter(r=>r.level==='down'||r.level==='warn').sort((a,b)=>RANK[b.level]-RANK[a.level])
  $('problems').innerHTML=problems.length?'<div class="card"><h2>Needs attention</h2>'+problems.map(r=>'<div class="svc"><span>'+esc(r.group)+' · '+esc(r.name)+'</span><span class="d">'+esc(r.detail)+'</span>'+st(r.level)+'</div>').join('')+'</div>':''
  const hours=m.events_by_hour,last=hours?hours.filter(h=>h[0]>=Math.floor(Date.now()/3600000)*3600000).reduce((a,h)=>a+h[1],0):null,day=hours?hours.reduce((a,h)=>a+h[1],0):null
  const memUsed=mc.mem_total?mc.mem_total-mc.mem_available:null,disk=mc.disk_total?mc.disk_total-mc.disk_free:null
  $('tiles').innerHTML=[tile('Containers running',counts.running+' of '+counts.expected,[[counts.unhealthy,'unhealthy'],[counts.restarting,'restarting'],[counts.stopped,'stopped']].filter(x=>x[0]).map(x=>x[0]+' '+x[1]).join(' · ')||'all healthy',counts.problems>0),
    tile('Events this hour',num(last),'since the hour began'),tile('Events, 24 hours',num(day),'all event types'),tile('People, 24 hours',num(m.people_24h),'distinct ids'),tile('Recordings, 24 hours',num(m.recordings_24h),'counted, never opened'),
    tile('Ingestion warnings',num(m.ingestion_warnings_24h),'last 24 hours'),tile('CPU',pct(mc.cpu_pct),mc.cores?mc.cores+' cores, load '+(mc.load_5??0).toFixed(1):''),tile('Memory',memUsed==null?'–':gb(memUsed),mc.mem_total?'of '+gb(mc.mem_total):''),
    tile('Disk used',disk==null?'–':pct(disk/mc.disk_total*100),mc.disk_free!=null?gb(mc.disk_free)+' free of '+gb(mc.disk_total):''),tile('Swap used',gb(mc.swap_used),'of '+gb(mc.swap_total)),tile('ClickHouse data',gb(m.clickhouse_bytes),'on disk')].join('')
  bars($('c-events'),hours,false,m.extras_at||Date.now());bars($('c-minutes'),m.events_by_minute,true,m.extras_at||Date.now());line($('c-disk'),m.history,3,'Disk');line($('c-load'),m.history,4,'Load',true);line($('c-cpu'),m.history,1,'CPU');line($('c-mem'),m.history,2,'Memory')
  const svc=(name,list)=>list.length?'<div class="card"><h2>'+name+'</h2>'+list.map(r=>'<div class="svc"><span>'+esc(r.name)+'</span><span class="d">'+esc(r.detail)+'</span>'+st(r.level)+'</div>').join('')+'</div>':''
  $('services').innerHTML=svc('PostHog',byName('PostHog'))+svc('Lens',byName('Lens'))+svc('Data arriving',byName('Data arriving'))+svc('Machine',byName('Machine'))
  const ch=m.clickhouse||{},lens=s.lens||{},activity=lens.activity,clipDisk=lens.storage
  $('clickhouse').innerHTML='<h2>ClickHouse health</h2>'+pairs([['Version',ch.version],['Uptime',ch.uptime_s==null?null:Math.floor(ch.uptime_s/3600)+' hours'],['Running queries',num(ch.running_queries)],['Merges in progress',num(ch.merges)],['Pending mutations',num(ch.pending_mutations)],['Most active parts in one partition',num(ch.max_partition_parts)]])+'<details><summary>8 biggest tables by bytes on disk</summary>'+((ch.tables||[]).map(t=>'<div class="svc"><span>'+esc(t.database)+'.'+esc(t.table)+'</span><span class="d">'+gb(t.bytes)+' · '+num(t.rows)+' rows</span></div>').join('')||'<p class="muted">Unavailable</p>')+'</details>'
  $('lens').innerHTML='<h2>Lens activity · last 24 hours</h2>'+(activity?pairs([['Sign-ins',num(activity.signins)],['Failed sign-ins',num(activity.failed_signins)],['Clips made',num(activity.clips_made)],['Clips watched',num(activity.clips_watched)],['Clips downloaded',num(activity.clips_downloaded)],['Share links',num(activity.share_links)]])+(activity.truncated?'<p>Audit limit reached; counts are lower bounds.</p>':''):'<p class="muted">Activity unavailable</p>')+'<details><summary>Clip storage</summary>'+(clipDisk?pairs([['Clips',num(clipDisk.clips)],['Storage',gb(clipDisk.bytes)],['Saved clips',num(clipDisk.saved)],['Saved storage',gb(clipDisk.saved_bytes)]]):'<p>Unavailable</p>')+'</details>'
  $('changes').innerHTML=(s.changes||[]).map(c=>'<div class="svc"><span>'+esc(c.group)+' · '+esc(c.name)+'</span><span class="d">'+esc(new Date(c.at).toLocaleString())+' · '+esc(LABEL[c.from]||c.from)+' → '+esc(LABEL[c.level]||c.level)+'</span></div>').join('')||'<p class="muted">No changes observed yet. The last 100 transitions are kept until the status service restarts.</p>'
  const a=s.about||{},dd=m.docker_disk
  $('about').innerHTML=pairs([['PostHog web image',a.posthog_image],['ClickHouse version',a.clickhouse_version],['Docker engine',a.docker_version],['Status service uptime',a.uptime_s==null?null:Math.floor(a.uptime_s/60)+' minutes'],['Check interval',a.interval_s==null?null:a.interval_s+' s'],['Last check duration',a.took_ms==null?null:a.took_ms+' ms']])+'<details><summary>Docker disk usage · cached 10 minutes</summary>'+(dd?pairs([['Images',gb(dd.images_bytes)],['Containers (writable layers)',gb(dd.containers_bytes)],['Volumes',gb(dd.volumes_bytes)],['Build cache',gb(dd.build_cache_bytes)],['Measured',new Date(dd.at).toLocaleString()]]):'<p>Unavailable</p>')+'</details><p class="small muted">Large counts and table sizes refresh every five minutes. CPU is a share of the whole machine. Histories and recent changes are held in memory.</p>'
  $('c-title').textContent='Containers ('+box.length+')';table()}
async function tick(){try{const r=await fetch('/replays/system/api',{cache:'no-store'}),d=await r.json().catch(()=>({}));if(r.status===401)return location.reload();if(!r.ok)throw new Error(d.error||'The status service is not answering.');draw(d)}
  catch(e){connectionError=e.message;$('banner').className='banner down';$('b-icon').textContent='✕';$('b-head').textContent=e.message;$('b-sub').textContent='This page reads the status service on port 8090. On the box, run: sudo posthog-lens status'}}
tick();setInterval(tick,15000);setInterval(freshness,1000)
`
