// The System page: is everything up, and how hard is the machine working. Admins only. The numbers
// come from the status page (deploy/status), which this service reads over localhost, so nobody needs
// a tunnel to port 8090. They are counts, times and machine figures; no event or replay content.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { can, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS } from './replays.ts'

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

export async function handleSystem(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    const page = p === '/replays/system' || p === '/replays/system/'
    if (!can(v.role, 'admin')) {
        if (page) {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>System · ${APP_NAME}</title><style>${PAGE_CSS()}</style></head><body>${headerHtml(v, 'System')}<main style="max-width:560px"><div class="card"><h2>Admins only</h2><p class="muted">This page is for PostHog owners and admins.</p></div></main></body></html>`)
        } else json(res, 403, { error: 'Admins only.' })
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
        json(res, r.status, r.body)
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
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px}.charts .card,.split .card{margin:0;min-width:0}.charts h2,.split h2{margin-top:0}
.chart{position:relative}.chart svg{display:block;max-width:100%}.note{color:var(--muted);font-size:13px;padding:30px 0;text-align:center}
.tip{position:absolute;pointer-events:none;background:#1c2230;color:#fff;font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%);z-index:2}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;margin-bottom:14px}
.svc{display:grid;grid-template-columns:max-content minmax(0,1fr) auto;gap:4px 12px;align-items:center;padding:7px 0;border-top:1px solid var(--line);font-size:14px}.svc:first-of-type{border-top:0}.svc .d{color:var(--muted);font-size:12.5px;text-align:right}
.st{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;white-space:nowrap}.st i{font-style:normal;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:10px}
.st.ok{color:var(--good)}.st.ok i{background:var(--good)}.st.warn{color:var(--warn)}.st.warn i{background:var(--warn)}.st.down{color:var(--down)}.st.down i{background:var(--down)}.st.info{color:var(--muted)}.st.info i{background:var(--muted)}
.tools{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.tools h2{margin:0}.tools input{max-width:240px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}td.w{overflow-wrap:anywhere}td small{display:none;color:var(--muted)}
@media (max-width:640px){.tools input{max-width:none}th.r,td.r{display:none}td small{display:block}.st{font-size:0;gap:0}.svc .st{font-size:12.5px;gap:5px}table{font-size:13px}th,td{padding:7px 4px}}
details.nums summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:6px}details.nums table{font-size:13px}
</style></head>
<body>${headerHtml(v, 'System')}<main class="wide">
<div class="banner" id="banner" role="status"><span class="big" id="b-icon" aria-hidden="true">…</span><div><h1 id="b-head">Checking…</h1><p id="b-sub"></p></div></div>
<div class="tiles" id="tiles"></div>
<div class="charts">
<div class="card"><h2>Events per hour, last 24 hours</h2><div class="chart" id="c-events"></div><details class="nums"><summary>Show the numbers</summary><div id="t-events"></div></details></div>
<div class="card"><h2>CPU, last hour</h2><div class="chart" id="c-cpu"></div></div>
<div class="card"><h2>Memory, last hour</h2><div class="chart" id="c-mem"></div></div>
</div>
<div class="split" id="services"></div>
<div class="card"><div class="tools"><h2 id="c-title">Containers</h2><input id="find" type="search" placeholder="Find a container" aria-label="Find a container"></div>
<div class="table-wrap"><table><thead><tr><th>Status</th><th>Container</th><th class="r">Running</th><th class="n">CPU</th><th class="n">Memory</th><th class="n">Restarts</th></tr></thead><tbody id="rows"></tbody></table></div></div>
<p class="small muted">Counts and machine figures only, refreshed every 15 seconds. No event or replay content is read. CPU and memory history restarts when the status service does.</p>
</main>
<script>${CLIENT}</script></body></html>`
}

// Runs in the browser. Names come from Docker, so everything goes through esc().
const CLIENT = String.raw`
const $=id=>document.getElementById(id)
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const num=n=>n==null?'–':Number(n).toLocaleString('en-US')
const gb=b=>b==null?'–':b>=1024**3?(b/1024**3).toFixed(1)+' GB':Math.round(b/1024**2)+' MB'
const pct=n=>n==null?'–':(n<10?n.toFixed(1):Math.round(n))+'%'
const LABEL={ok:'Up',warn:'Warning',down:'Down',info:'Info'},ICON={ok:'✓',warn:'!',down:'✕',info:'i'},RANK={down:3,warn:2,ok:1,info:0}
const st=l=>'<span class="st '+l+'"><i aria-hidden="true">'+ICON[l]+'</i>'+LABEL[l]+'</span>'
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

function bars(box,data){W=box.clientWidth||560;if(!data){box.innerHTML='<p class="note">No event counts yet.</p>';return}
  const hour=3600000,now=Math.floor(Date.now()/hour)*hour,by=new Map(data),slots=[];for(let i=23;i>=0;i--){const t=now-i*hour;slots.push([t,by.get(t)||0])}
  const max=nice(Math.max(...slots.map(s=>s[1]),1)),step=(W-L-R)/24,bw=Math.max(3,step-2)
  const f=frame(max,v=>v>=1000?(v/1000)+'k':String(Math.round(v)),[[L+bw/2,clock(slots[0][0]),'start'],[L+12*step,clock(slots[12][0]),'middle'],[W-R,clock(slots[23][0]),'end']]);const pts=[];let b=''
  slots.forEach(([t,n],i)=>{const x=L+i*step+1,top=f.y(n),base=f.y(0);if(n){const h=Math.max(2,base-top),r=Math.min(4,bw/2,h);b+='<path fill="var(--act)" d="M'+x+' '+base+'v'+(-(h-r))+'q0 '+(-r)+' '+r+' '+(-r)+'h'+(bw-2*r)+'q'+r+' 0 '+r+' '+r+'v'+(h-r)+'z"/>'}
    pts.push({x:x+bw/2,y:top,text:clock(t)+' · '+num(n)+' events'})})
  box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Events per hour for the last 24 hours">'+f.g+b+'</svg>';hover(box,pts)
  $('t-events').innerHTML='<table><thead><tr><th>Hour</th><th class="n">Events</th></tr></thead><tbody>'+slots.slice().reverse().map(s=>'<tr><td>'+clock(s[0])+'</td><td class="n">'+num(s[1])+'</td></tr>').join('')+'</tbody></table>'}

function line(box,hist,idx,name){W=box.clientWidth||560;const p=(hist||[]).filter(h=>h[idx]!=null);if(p.length<2){box.innerHTML='<p class="note">Collecting, this fills in over the next few minutes.</p>';return}
  const t0=p[0][0],t1=p[p.length-1][0],x=t=>L+(W-L-R)*(t-t0)/Math.max(1,t1-t0),f=frame(100,v=>v+'%',[[L,clock(t0),'start'],[W-R,clock(t1),'end']])
  const pts=p.map(h=>({x:x(h[0]),y:f.y(h[idx]),text:clock(h[0])+' · '+name+' '+pct(h[idx])})),d=pts.map((q,i)=>(i?'L':'M')+q.x.toFixed(1)+' '+q.y.toFixed(1)).join('')
  const e=pts[pts.length-1];box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+name+' for the last hour, now '+pct(p[p.length-1][idx])+'">'+f.g+'<path d="'+d+'" fill="none" stroke="var(--act)" stroke-width="2" stroke-linejoin="round"/><circle cx="'+e.x+'" cy="'+e.y+'" r="4" fill="var(--act)" stroke="var(--card)" stroke-width="2"/></svg>';hover(box,pts)}

const tile=(name,value,sub)=>'<div class="tile"><span>'+esc(name)+'</span><b>'+esc(value)+'</b>'+(sub?'<small>'+esc(sub)+'</small>':'')+'</div>'
let containers=[]
function table(){const q=$('find').value.trim().toLowerCase(),list=containers.filter(c=>c.name.toLowerCase().includes(q))
  $('rows').innerHTML=list.map(c=>'<tr><td>'+st(c.level)+'</td><td class="w">'+esc(c.name)+'<small>'+esc(c.detail)+'</small></td><td class="r">'+esc(c.detail)+'</td><td class="n">'+pct(c.cpu_pct)+'</td><td class="n">'+gb(c.mem_bytes)+'</td><td class="n">'+num(c.restarts)+'</td></tr>').join('')||'<tr><td colspan="6" class="muted">No container matches.</td></tr>'}
$('find').oninput=table

function draw(s){const rows=s.checks||[],m=s.metrics||{},mc=m.machine||{},byName=g=>rows.filter(r=>r.group===g)
  const box=rows.filter(r=>r.group.startsWith('Containers')).sort((a,b)=>RANK[b.level]-RANK[a.level]||a.name.localeCompare(b.name));containers=box
  const running=box.filter(c=>c.state?c.state==='running':c.level==='ok'||c.level==='warn').length,one=box.filter(c=>c.level==='info').length,head=!s.checked_at?'Checking…':s.down?s.down+' problem'+(s.down>1?'s':'')+(s.warn?', '+s.warn+' warning'+(s.warn>1?'s':''):''):s.warn?'Everything is up, '+s.warn+' warning'+(s.warn>1?'s':''):'Everything is up'
  $('banner').className='banner '+s.level;$('b-icon').textContent=ICON[s.level]||'…';$('b-head').textContent=head;$('b-sub').textContent=s.checked_at?'Last checked '+new Date(s.checked_at).toLocaleString():''
  const hours=m.events_by_hour,last=hours&&hours.length?hours.filter(h=>h[0]>=Math.floor(Date.now()/3600000)*3600000).reduce((a,h)=>a+h[1],0):null,day=hours?hours.reduce((a,h)=>a+h[1],0):null
  const memUsed=mc.mem_total?mc.mem_total-mc.mem_available:null,disk=mc.disk_total?mc.disk_total-mc.disk_free:null
  $('tiles').innerHTML=[tile('Containers running',running+' of '+(box.length-one),one?one+' finished one-time job'+(one>1?'s':''):''),
    tile('Events this hour',num(last),'since the hour began'),tile('Events, 24 hours',num(day),'all event types'),tile('People, 24 hours',num(m.people_24h),'distinct ids'),tile('Recordings, 24 hours',num(m.recordings_24h),'counted, never opened'),
    tile('Ingestion warnings',num(m.ingestion_warnings_24h),'last 24 hours'),tile('CPU',pct(mc.cpu_pct),mc.cores?mc.cores+' cores, load '+(mc.load_5??0).toFixed(1):''),tile('Memory',memUsed==null?'–':gb(memUsed),mc.mem_total?'of '+gb(mc.mem_total):''),
    tile('Disk used',disk==null?'–':pct(disk/mc.disk_total*100),mc.disk_free!=null?gb(mc.disk_free)+' free of '+gb(mc.disk_total):''),tile('ClickHouse data',gb(m.clickhouse_bytes),'on disk')].join('')
  bars($('c-events'),hours);line($('c-cpu'),m.history,1,'CPU');line($('c-mem'),m.history,2,'Memory')
  const svc=(name,list)=>list.length?'<div class="card"><h2>'+name+'</h2>'+list.map(r=>'<div class="svc"><span>'+esc(r.name)+'</span><span class="d">'+esc(r.detail)+'</span>'+st(r.level)+'</div>').join('')+'</div>':''
  $('services').innerHTML=svc('PostHog',byName('PostHog'))+svc('Lens',byName('Lens'))+svc('Data arriving',byName('Data arriving'))
  $('c-title').textContent='Containers ('+box.length+')';table()}
async function tick(){try{const r=await fetch('/replays/system/api',{cache:'no-store'}),d=await r.json().catch(()=>({}));if(r.status===401)return location.reload();if(!r.ok)throw new Error(d.error||'The status service is not answering.');draw(d)}
  catch(e){$('banner').className='banner down';$('b-icon').textContent='✕';$('b-head').textContent=e.message;$('b-sub').textContent='This page reads the status service on port 8090. On the box, run: sudo posthog-lens status'}}
tick();setInterval(tick,15000)
`
