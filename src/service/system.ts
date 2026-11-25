// The System page: is everything up, and how hard is the machine working. Admins, and anyone an admin
// ticked "System page" for on the admin page. The numbers
// come from the status page (deploy/status), which this service reads over localhost, so nobody needs
// a tunnel to port 8090. They are counts, times and machine figures; no event or replay content.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { canSeeSystem, readAudit, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGER_JS, PAGE_CSS, skelBlock, skelRows, storage } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

export async function readStatus(fetcher: typeof fetch = fetch): Promise<{ status: number; body: unknown }> {
    const { statusUrl, statusPassword } = config.service
    const headers: Record<string, string> = statusPassword ? { authorization: `Basic ${Buffer.from(`lens:${statusPassword}`).toString('base64')}` } : {}
    try {
        const r = await fetcher(`${statusUrl}/api/status`, { headers, signal: AbortSignal.timeout(8000) })
        if (!r.ok) return { status: 502, body: { error: `The status service answered ${r.status}.`, upstream_status: r.status } }
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
            res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>System · ${APP_NAME}</title><style>${PAGE_CSS()}</style></head><body>${headerHtml(v, 'System')}<main id="main" tabindex="-1" style="max-width:560px"><div class="card"><h2>No access to the System page</h2><p class="muted">Ask an admin to tick "System page" for you on the admin page.</p></div></main></body></html>`)
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
:root{--act:var(--accent);--grid:var(--line);--axis:var(--faint);--good:var(--ok);--good-bg:var(--ok-bg);--down:var(--err);--down-bg:var(--err-bg);--info-bg:var(--accent-soft)}
.banner p{margin:2px 0 0;color:var(--muted);font-size:13px}
.banner.ok{background:var(--good-bg)}
.banner.ok .big{background:var(--good)}
.banner.warn{background:var(--warn-bg)}
.banner.warn .big{background:var(--warn)}
.banner.down{background:var(--down-bg)}
.banner.down .big{background:var(--down)}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:var(--space-4);margin-bottom:var(--space-4)}
.charts .card,.split .card{margin:0;min-width:0}
.charts>.card{padding:var(--space-4);background:var(--card);box-shadow:var(--shadow)}
.charts h2,.split h2{margin-top:0}
.chart{position:relative}
.chart svg{display:block;max-width:100%}
.note{color:var(--muted);font-size:13px;padding:30px 0;text-align:center}
.tip{position:absolute;pointer-events:none;background:var(--ink);color:var(--card);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;transform:translate(-50%,-110%);z-index:2}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:var(--space-4);margin-bottom:var(--space-4)}
.svc:first-of-type{border-top:0}
.svc .d{color:var(--muted);font-size:12.5px;text-align:right}
.st{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:600;white-space:nowrap}
.st i{font-style:normal;width:16px;height:16px;border-radius:50%;display:grid;place-items:center;color:var(--card);font-size:10px}
.st.ok{color:var(--good)}
.st.warn{color:var(--warn)}
.st.warn i{background:var(--warn)}
.st.down{color:var(--down)}
.st.down i{background:var(--down)}
.st.info{color:var(--muted)}
.st.info i{background:var(--muted)}
.tools h2{margin:0}
.tools input{max-width:240px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.w{overflow-wrap:anywhere}
td small{display:none;color:var(--muted)}
details.nums summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:6px}
details.nums table{font-size:13px}
#problems:empty{display:none}
.card{overflow-wrap:anywhere}
main.wide{min-width:0}
table{width:100%;table-layout:fixed}
.containers-table th:first-child{width:72px}
.containers-table th:nth-child(2){width:26%}
.containers-table th.r{width:22%}
td,th{overflow-wrap:anywhere}
.spark{display:block;width:90px;max-width:100%;height:24px}
.container-detail{font-size:12px;color:var(--muted)}
.container-detail p{margin:4px 0}
.container-detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
select{max-width:100%;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
main .ghost{border-color:transparent;color:var(--ink)}
.banner.ok,.banner.warn,.banner.down{background:transparent}
.banner>div{min-width:0}
.tile{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:16px 20px}
.section-details[open]>summary{margin-bottom:20px}
.section-details .card{border:1px solid var(--line);margin:0}
.charts,.split{gap:16px 32px}
details summary{cursor:pointer}
.tools{display:flex;justify-content:space-between;flex-wrap:wrap;align-items:center;margin-bottom:8px;gap:16px}
.tools select{width:auto;min-width:0}
.svc{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:4px 12px;align-items:center;border-top:1px solid var(--line);font-size:14px;padding:10px 0}
.table-wrap{min-width:0}
main{min-width:0}
main .page-head{margin-bottom:24px;align-items:center}
main .page-head p{margin:4px 0 0;font-size:14px;line-height:20px}
main h3{font-size:14px;line-height:20px;font-weight:600;margin:0 0 8px}
main input:not([type=checkbox]):not([type=radio]),main select{height:36px;min-height:36px;padding:7px 10px;font-size:13px;line-height:20px;max-width:100%;box-sizing:border-box}
main button,main .btn{min-height:36px;font-size:13px;line-height:20px;white-space:nowrap;word-break:normal;overflow-wrap:normal}
main th{word-break:normal;overflow-wrap:normal}
main .table-wrap{min-width:0;max-width:100%;overflow-x:auto}main .card>.table-wrap{max-width:none}
main .pager button{min-height:32px;padding:5px 10px;border:1px solid var(--line-strong);background:var(--card);color:var(--ink);font-weight:500}
main .pager select{height:32px;min-height:32px}
main .pager .pg>span{min-height:32px;display:inline-flex;align-items:center}
#people-msg:empty,#outcome-msg:empty,#audit-msg:empty,#keys-msg:empty,#msg:empty{display:none}
.banner{display:flex;border:0;border-radius:0;background:transparent;align-items:flex-start;padding:0 0 24px;margin-bottom:16px;gap:12px}
.banner h2{margin:0;font-size:24px;line-height:32px}
#banner.down,#banner.warn{background:var(--card);border:1px solid var(--line);border-inline-start:3px solid var(--err);border-radius:var(--r-sm);padding:10px 14px}
#banner.warn{border-inline-start-color:var(--warn)}
#banner.down #b-head,#banner.warn #b-head{font-size:18px;line-height:24px}#banner .big{background:transparent;color:var(--err);width:20px;height:24px;margin-top:0}#banner.warn .big{color:var(--warn)}#banner.ok .big{color:var(--good)}
.banner .big{font-weight:700;border-radius:50%;display:grid;place-items:center;flex:none;color:var(--card);background:var(--muted);width:20px;height:20px;font-size:14px;margin-top:2px}
#problems>.card{padding:0;margin-bottom:16px}
#problems h2{margin-bottom:8px}
#problems .svc,#jobs .svc{grid-template-columns:88px minmax(0,1fr);gap:12px;align-items:start;padding:8px 0;border:0}
#problems .svc+.svc,#jobs .svc+.svc{border-top:1px solid var(--line)}
.check-name{color:var(--ink);font-size:14px;line-height:20px;font-weight:600}
#problems .svc .d,#jobs .svc .d,.changes-list .d{color:var(--muted);font-size:13px;line-height:18px;text-align:left}
.observed,.changes-list time,#b-sub{font-variant-numeric:tabular-nums}
.observed{margin-inline-start:8px;color:var(--muted);font-size:12px;line-height:18px}
.check-action{margin-top:4px;font-size:13px;line-height:18px}
.check-action a{color:var(--ink);text-decoration:underline}
.blocked-checks{margin-top:8px;border-inline-start:1px solid var(--line);padding-inline-start:12px}
.changes-list{margin:8px 0;padding-inline-start:28px}
.changes-list li{padding:6px 0}
.changes-list li+li{border-top:1px solid var(--line)}
.tiles{display:grid;margin-bottom:14px;margin:0 0 24px;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.tile span{display:block;color:var(--muted);font-size:12px;font-weight:500;min-height:16px;line-height:16px}
.tile small{display:block;color:var(--muted);font-size:12px;margin-top:2px;line-height:16px}
.tile.problem span::before,.tile.failure span::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn);margin-right:6px;vertical-align:middle}.tile.failure span::before{background:var(--err)}
.tile.problem{border-color:var(--line);background:var(--card)}
.tile.problem small{color:var(--muted)}
.tile.failure{border-color:var(--line);background:var(--card)}
.section-details{border-bottom:1px solid var(--line);padding:14px 0}
.section-details>summary{cursor:pointer;font-size:14px;line-height:20px;font-weight:600}
.containers-card{margin-top:24px}
.containers-card>.tools{display:flex;align-items:center;justify-content:space-between;gap:16px}
.container-controls{display:flex;align-items:center;gap:12px;margin-top:0}
.container-controls input{flex:1;width:auto;max-width:none;min-width:0}
.container-controls .view-control{flex:none;margin:0}
.containers-table th:nth-child(5){width:180px}
.containers-table{min-width:860px}.containers-table td{vertical-align:middle}
@media(min-width:641px){.containers-table .skel-row td{height:34px}}
.containers-table .metric-inline{display:inline-grid;grid-template-columns:max-content 64px;white-space:nowrap;align-items:center;gap:12px}
.containers-table .spark{margin:0;width:64px;height:18px}
.containers-table td.w>details>summary{color:var(--ink);font-size:13px;line-height:20px;font-weight:500}
.st.ok i{background:var(--good);width:6px;height:6px}
.view-control>summary{min-height:36px;padding:7px 12px;border:1px solid var(--line-strong);border-radius:6px;font-size:13px;line-height:20px;box-sizing:border-box}
.view-control{position:relative}
.view-control[open]>.tools{position:absolute;right:0;z-index:2;min-width:220px;background:var(--card);border:1px solid var(--line);padding:12px}
.machine-details{margin:0 0 16px}
.tile b{display:block;font-variant-numeric:tabular-nums;font-size:26px;line-height:32px;font-weight:600;letter-spacing:-.02em;margin:6px 0 2px;white-space:normal}
.containers-table .badge{white-space:nowrap;font-size:11px}
@media (max-width:640px){.tools input{max-width:none}
th.r,td.r{display:none}
td small{display:block}
.st{font-size:12px;gap:3px}
.svc .st{font-size:12.5px;gap:5px}
table{font-size:13px}
th,td{padding:7px 4px}
}
@media(max-width:640px){.svc{grid-template-columns:minmax(0,1fr) auto}
.svc .d{grid-column:1/-1;grid-row:2;text-align:left}
.tile b{font-size:21px}
.card{padding:12px}
.tools input{width:100%;min-width:0}
.tools select{width:100%}
.containers-table th:nth-child(2){width:32%}
.containers-table th:first-child{width:65px}
.containers-table th:last-child,.containers-table td:last-child{display:table-cell}
.containers-table th:last-child{width:15%}
.st{white-space:normal}
.banner{padding:12px;gap:10px}
.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}
.banner h2{font-size:24px}

.containers-table .st{white-space:nowrap}
}
@media(max-width:1200px) and (min-width:641px){.tiles{grid-template-columns:repeat(3,minmax(0,1fr))}


}
</style></head>
<body>${headerHtml(v, 'System')}<main id="main" tabindex="-1" class="wide">
<div class="page-head"><div><h1>System</h1><p>Service health, ingestion and server activity.</p></div></div>
<div class="banner" id="banner"><span class="big" id="b-icon" aria-hidden="true">…</span><div><h2 id="b-head" role="status" aria-live="polite">Checking…</h2><p id="b-sub"></p><details id="status-details" hidden><summary>Technical details</summary><p id="status-error"></p></details></div></div>
<div class="skel-page" aria-hidden="true">${skelBlock('tiles')}<div class="card"><h2>Containers</h2><div class="table-wrap"><table><thead><tr><th>Status</th><th>Container</th><th>Running</th><th>CPU</th><th>Memory</th><th>Restarts</th></tr></thead><tbody>${skelRows(6, 'Loading containers…')}</tbody></table></div></div></div>
<div id="system-results" hidden><div id="problems"></div><div id="problems-pager"></div>
<details class="section-details"><summary id="jobs-summary">Signal jobs</summary><div id="jobs"></div></details>
<div id="tiles"></div>
<section class="section-details"><h2>Recent changes</h2><div id="changes-preview">Loading recent changes…</div><details id="all-changes"><summary>Show all changes</summary><div id="changes"></div><div id="changes-pager"></div></details></section>
<details class="section-details" id="trends"><summary>Trends</summary><div class="charts">
<div class="card"><h2>Events per hour, last 24 hours</h2><div class="chart" id="c-events"></div><details class="nums" id="n-events"><summary>Show the numbers</summary><div id="t-events"></div><div id="p-events"></div></details></div>
<div class="card"><h2>Events per minute, last 60 minutes</h2><div class="chart" id="c-minutes"></div><details class="nums" id="n-minutes"><summary>Show the numbers</summary><div id="t-minutes"></div><div id="p-minutes"></div></details></div>
<div class="card"><h2>CPU, last hour</h2><div class="chart" id="c-cpu"></div><details class="nums" id="n-cpu"><summary>Show the numbers</summary><div id="t-cpu"></div><div id="p-cpu"></div></details></div>
<div class="card"><h2>Memory, last hour</h2><div class="chart" id="c-mem"></div><details class="nums" id="n-mem"><summary>Show the numbers</summary><div id="t-mem"></div><div id="p-mem"></div></details></div>
<div class="card"><h2>Disk used, last hour</h2><div class="chart" id="c-disk"></div><details class="nums" id="n-disk"><summary>Show the numbers</summary><div id="t-disk"></div><div id="p-disk"></div></details></div>
<div class="card"><h2>Load, last hour</h2><div class="chart" id="c-load"></div><details class="nums" id="n-load"><summary>Show the numbers</summary><div id="t-load"></div><div id="p-load"></div></details></div>
</div>
</details>
<details class="section-details"><summary>Service checks</summary><div class="split" id="services"></div><div id="services-pager"></div>
</details>
<details class="section-details"><summary>Database and Signal activity</summary><div class="split"><div class="card" id="clickhouse"></div><div class="card" id="lens"></div></div>
</details>
<div class="card containers-card"><div class="tools"><h2 id="c-title">Containers</h2><div class="container-controls"><input id="find" type="search" placeholder="Find a container" aria-label="Find a container"><details class="view-control"><summary>View</summary><div class="tools"><select id="view" aria-label="Container view"><option value="all">All containers · problems first</option><option value="mem_bytes">Top 5 by memory</option><option value="cpu_pct">Top 5 by CPU</option></select></div></details></div></div>
<div class="table-wrap" role="region" aria-label="Containers" tabindex="0"><table class="containers-table"><thead><tr><th scope="col">Status</th><th scope="col">Container</th><th scope="col" class="r">Running</th><th scope="col" class="n">CPU</th><th scope="col" class="n">Memory</th><th scope="col" class="n">Restarts</th></tr></thead><tbody id="rows">${skelRows(6, 'Loading containers…')}</tbody></table></div><div id="containers-pager"></div></div>
<details class="section-details" id="about-section"><summary>About this server</summary><div id="about"></div><details class="nums"><summary>How this works</summary><p class="small muted">Only counts and machine figures are read, never event or replay content. CPU and memory history restarts with the status service.</p></details></details>
<p class="small muted" id="refresh-note">Refreshes every 15 seconds.</p></div>
</main>
<script>${PAGER_JS}
${CLIENT}</script></body></html>`
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
const LABEL={ok:'Up',warn:'Warning',down:'Down',info:'Info'},ICON={ok:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',warn:'!',down:'<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',info:'i'},RANK={down:3,warn:2,ok:1,info:0}
const st=value=>{const l=Object.hasOwn(LABEL,value)?value:'info';return '<span class="st '+l+'"><i aria-hidden="true">'+(l==='ok'?'':ICON[l])+'</i>'+LABEL[l]+'</span>'}
const clock=t=>new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
const stamp=value=>typeof value==='number'?new Date(value).getTime():typeof value==='string'?Date.parse(value):NaN
const utc=(t,seconds=false)=>new Date(t).toISOString().slice(11,seconds?19:16)+' UTC'
const utcDay=t=>new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})
const time=(t,text)=>'<time datetime="'+esc(new Date(t).toISOString())+'">'+esc(text)+'</time>'
const utcTime=t=>time(t,utcDay(t)+' '+utc(t))
function duration(ms){const s=Math.floor(ms/1000);if(s<60)return s+' s';if(s<3600)return Math.floor(s/60)+' min';if(s<86400)return Math.floor(s/3600)+' h';return plural(Math.floor(s/86400),'day')}
const nice=m=>{if(m<=0)return 1;const p=10**Math.floor(Math.log10(m));for(const s of [1,2,5,10])if(s*p>=m)return s*p;return 10*p}

// The same frame for each chart: three quiet grid lines, labels on the left, hover on a wide target.
let W=560
const H=190,L=44,R=8,T=8,B=22
function frame(max,fmt,xlabels){const y=v=>T+(H-T-B)*(1-v/max);let g=''
  for(const v of [0,max/2,max])g+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var('+(v?'--grid':'--axis')+')"/><text x="'+(L-6)+'" y="'+(y(v)+4)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+esc(fmt(v))+'</text>'
  for(const [x,t,a] of xlabels)g+='<text x="'+x+'" y="'+(H-6)+'" text-anchor="'+a+'" font-size="11" fill="var(--muted)">'+esc(t)+'</text>'
  return {y,g}}
function hover(box,points){box.onmousemove=e=>{const s=box.querySelector('svg');if(!s)return;const r=s.getBoundingClientRect(),w=+s.getAttribute('width'),x=(e.clientX-r.left)/r.width*w
  let best=null,d=1e9;for(const p of points){const k=Math.abs(p.x-x);if(k<d){d=k;best=p}}
  let t=box.querySelector('.tip');if(!t){t=document.createElement('div');t.className='tip';box.append(t)}
  if(!best){t.remove();return}t.textContent=best.text;t.style.left=Math.min(r.width-60,Math.max(60,best.x/w*r.width))+'px';t.style.top=Math.max(26,best.y/H*r.height)+'px'}
  box.onmouseleave=()=>box.querySelector('.tip')?.remove()}

function bars(box,data,minute=false,at=Date.now()){W=box.clientWidth||560;if(!data){numbers(minute?'minutes':'events',[],'Events');box.innerHTML='<p class="note">No event counts yet.</p>';return}
  const hour=minute?60000:3600000,count=minute?60:24,now=Math.floor(at/hour)*hour,by=new Map(data),slots=[];for(let i=count-1;i>=0;i--){const t=now-i*hour;slots.push([t,by.get(t)||0])}
  const max=nice(Math.max(...slots.map(s=>s[1]),2)),step=(W-L-R)/count,bw=Math.max(1,step-2)
  const f=frame(max,v=>v>=1000?(v/1000)+'k':String(Math.round(v)),[[L+bw/2,clock(slots[0][0]),'start'],[L+(count/2)*step,clock(slots[count/2][0]),'middle'],[W-R,clock(slots[count-1][0]),'end']]);const pts=[];let b=''
  slots.forEach(([t,n],i)=>{const x=L+i*step+1,top=f.y(n),base=f.y(0);if(n){const h=Math.max(2,base-top),r=Math.min(4,bw/2,h);b+='<path fill="var(--act)" d="M'+x+' '+base+'v'+(-(h-r))+'q0 '+(-r)+' '+r+' '+(-r)+'h'+(bw-2*r)+'q'+r+' 0 '+r+' '+r+'v'+(h-r)+'z"/>'}
    pts.push({x:x+bw/2,y:top,text:clock(t)+' · '+num(n)+' events'})})
  box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="Event counts">'+f.g+b+'</svg>';hover(box,pts)
  numbers(minute?'minutes':'events',slots.slice().reverse().map(s=>[s[0],s[1]]),'Events');
  if(!minute&&!$('n-events').open)$('t-events').innerHTML='<table><thead><tr><th scope="col">Hour</th><th scope="col" class="n">Events</th></tr></thead><tbody>'+slots.slice().reverse().map(s=>'<tr><td>'+esc(clock(s[0]))+'</td><td class="n">'+num(s[1])+'</td></tr>').join('')+'</tbody></table>'}

function line(box,hist,idx,name,load=false){W=box.clientWidth||560;const p=(hist||[]).filter(h=>h[idx]!=null);if(p.length<2){numbers(({CPU:'cpu',Memory:'mem',Disk:'disk',Load:'load'})[name],[],name);box.innerHTML='<p class="note">Collecting, this fills in over the next few minutes.</p>';return}
  numbers(({CPU:'cpu',Memory:'mem',Disk:'disk',Load:'load'})[name],p.map(h=>[h[0],load?Number(h[idx]).toFixed(1):pct(h[idx])]),name);
  const t0=p[0][0],t1=p[p.length-1][0],x=t=>L+(W-L-R)*(t-t0)/Math.max(1,t1-t0),f=frame(load?nice(Math.max(...p.map(h=>h[idx]),2)):100,v=>load?String(v):v+'%',[[L,clock(t0),'start'],[W-R,clock(t1),'end']])
  const pts=p.map(h=>({x:x(h[0]),y:f.y(h[idx]),text:clock(h[0])+' · '+name+' '+(load?Number(h[idx]).toFixed(1):pct(h[idx]))})),d=pts.map((q,i)=>(i?'L':'M')+q.x.toFixed(1)+' '+q.y.toFixed(1)).join('')
  const e=pts[pts.length-1];box.innerHTML='<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+esc(name)+' for the last hour, now '+(load?Number(p.at(-1)[idx]).toFixed(1):pct(p.at(-1)[idx]))+'">'+f.g+'<path d="'+d+'" fill="none" stroke="var(--act)" stroke-width="2" stroke-linejoin="round"/><circle cx="'+e.x+'" cy="'+e.y+'" r="4" fill="var(--act)" stroke="var(--card)" stroke-width="2"/></svg>';hover(box,pts)}

const tile=(name,value,sub,problem=false)=>'<div class="tile'+(problem===true?' failure':problem?' problem':'')+'"><span>'+esc(name)+'</span><b>'+esc(value)+'</b>'+(sub?'<small>'+esc(sub)+'</small>':'')+'</div>'
const pagers={}
function paged(id,items,noun,draw,keep=true){if(items.length>25||pagers[id]){const mount=$(id+'-pager'),active=document.activeElement,restore=mount.contains?.(active),tag=active?.tagName,text=active?.textContent;if(!pagers[id])pagers[id]=makePager({mount,noun,size:25,draw});pagers[id].set(items,keep);if(restore){const next=[...mount.querySelectorAll('button,select')].find(el=>el.tagName===tag&&(tag==='SELECT'||el.textContent===text)&&!el.disabled);(next||mount.querySelector('button:not(:disabled)'))?.focus()}}else draw(items)}
function numbers(id,rows,label){const details=$('n-'+id);details.ontoggle=()=>{if(!details.open)return;const draw=slice=>{$('t-'+id).innerHTML='<table><thead><tr><th scope="col">Time</th><th scope="col">'+esc(label)+'</th></tr></thead><tbody>'+slice.map(r=>'<tr><td>'+esc(clock(r[0]))+'</td><td>'+esc(r[1])+'</td></tr>').join('')+'</tbody></table>';if(!slice.length)$('t-'+id).innerHTML='<p class="muted">No readings yet. Check again in a few minutes.</p>'};if(!pagers['n-'+id])pagers['n-'+id]=makePager({mount:$('p-'+id),noun:'readings',size:25,draw});pagers['n-'+id].set(rows,true)};if(details.open)details.ontoggle()}
let containers=[],inventoryMessage=''
const opened=new Set()
function spark(hist,idx,label){const p=(hist||[]).filter(h=>Number.isFinite(h[idx]));if(p.length<2)return '';const max=Math.max(...p.map(h=>h[idx]),1),t0=p[0][0],dt=Math.max(1,p.at(-1)[0]-t0);return '<svg class="spark" viewBox="0 0 90 24" role="img" aria-label="'+esc(label)+' over the last hour"><path d="'+p.map((h,i)=>(i?'L':'M')+(90*(h[0]-t0)/dt).toFixed(1)+' '+(23-22*h[idx]/max).toFixed(1)).join('')+'" fill="none" stroke="var(--act)" stroke-width="1.5"/></svg>'}
function uptime(detail){const text=String(detail||''),match=text.match(/(?:up\s+)?(\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?|weeks?|[smhdw]))/i),compact=match?match[1].replace(/\s*seconds?/i,'s').replace(/\s*minutes?/i,'m').replace(/\s*hours?/i,'h').replace(/\s*days?/i,'d').replace(/\s*weeks?/i,'w'):text.replace(/,?\s*healthy/i,'').replace(/^up\s+/i,'');return '<span title="'+esc(text)+'">'+esc(compact)+'</span>'+(/\bhealthy\b/i.test(text)?' <span class="badge ok">Healthy</span>':'')}
function table(keep=true){const active=document.activeElement;const focusedKey=active?.closest?.('details[data-key]')?.dataset.key;const q=$('find').value.trim().toLowerCase();let list=containers.filter(c=>c.name.toLowerCase().includes(q));const view=$('view').value
  if(view!=='all')list=list.slice().sort((a,b)=>(b[view]??-1)-(a[view]??-1)).slice(0,5)
  paged('containers',list,'containers',slice=>{$('rows').innerHTML=slice.map(c=>{const key=c.group+'/'+c.name;return '<tr><td>'+st(c.level)+'</td><td class="w"><details data-key="'+esc(key)+'"'+(opened.has(key)?' open':'')+'><summary>'+esc(c.name)+'</summary><div class="container-detail">'+[
    ['Image',c.image],['Started',c.started_at],['OOM killed',c.oom_killed==null?null:String(c.oom_killed)],['Exit code',c.exit_code],
    ['Memory limit',c.mem_limit_bytes?gb(c.mem_limit_bytes)+' ('+pct(c.mem_limit_pct)+' used)':'No limit'],
    ['Network rx / tx',gb(c.network_rx_bytes)+' / '+gb(c.network_tx_bytes)],['Block read / write',gb(c.block_read_bytes)+' / '+gb(c.block_write_bytes)],['PIDs',c.pids]
  ].map(([k,v])=>'<p>'+esc(k)+': '+esc(v??'–')+'</p>').join('')+(c.health_output?'<pre>Last health check: '+esc(c.health_output)+'</pre>':'')+'</div></details><small>'+esc(c.detail)+'</small></td><td class="r">'+uptime(c.detail)+'</td><td class="n"><span class="metric-inline">'+pct(c.cpu_pct)+spark(c.history,1,'CPU')+'</span></td><td class="n"><span class="metric-inline">'+gb(c.mem_bytes)+spark(c.history,2,'Memory')+'</span>'+'</td><td class="n">'+num(c.restarts)+'</td></tr>'}).join('')||'<tr><td colspan="6" class="muted">'+esc(containers.length?'No containers match. Change your search or view.':inventoryMessage)+'</td></tr>'
  $('rows').querySelectorAll('details').forEach(d=>d.ontoggle=()=>d.open?opened.add(d.dataset.key):opened.delete(d.dataset.key));if(focusedKey)$('rows').querySelectorAll('details').forEach(d=>{if(d.dataset.key===focusedKey)d.querySelector('summary')?.focus()})},keep)}
$('find').oninput=()=>table(false);$('view').onchange=()=>table(false)
let lastStatus=null,connectionError=null,checkHeading=''
const snapshotNote='Showing results from the last completed check'
function freshness(){const s=lastStatus,at=stamp(s?.checked_at||null),age=Number.isFinite(at)?Math.max(0,Math.floor((Date.now()-at)/1000)):null,stale=age!=null&&age>60
  const completed=age==null?'Waiting for the first check':'Checks completed '+age+' s ago · '+utc(at,true)
  if(connectionError){
  $('banner').className='banner down';$('b-icon').innerHTML=ICON.down;$('b-head').textContent='System status is unavailable';
  $('b-sub').textContent=age==null?'Retrying automatically every 15 seconds.':snapshotNote+' · '+completed;$('b-sub').title='';
  $('refresh-note').hidden=true;$('status-details').hidden=false;$('status-error').textContent=connectionError;return}
  if(!s)return;const level=stale?'warn':s.level
  $('status-details').hidden=true;$('refresh-note').hidden=false;$('banner').className='banner '+(Object.hasOwn(ICON,level)?level:'info');$('b-icon').innerHTML=Object.hasOwn(ICON,level)?ICON[level]:''
  const heading=stale?'Status data is stale':age==null?'Checking…':checkHeading;if($('b-head').textContent!==heading)$('b-head').textContent=heading
  $('b-sub').textContent=(stale?snapshotNote+' · ':'')+completed;$('b-sub').title=age==null?'':new Date(at).toLocaleString()}
const pairs=entries=>entries.map(([k,v])=>'<div class="svc"><span>'+esc(k)+'</span><span class="d">'+esc(v??'–')+'</span></div>').join('')

function charts(m){bars($('c-events'),m.events_by_hour,false,m.extras_at||Date.now());bars($('c-minutes'),m.events_by_minute,true,m.extras_at||Date.now());line($('c-disk'),m.history,3,'Disk');line($('c-load'),m.history,4,'Load',true);line($('c-cpu'),m.history,1,'CPU');line($('c-mem'),m.history,2,'Memory')}

const failing=r=>r.level==='down'||r.level==='warn'
const isClickHouse=r=>r.group==='PostHog'&&r.name==='ClickHouse'
const blockedByClickHouse=r=>r.group==='Data arriving'&&['Events','Session replays'].includes(r.name)&&['cannot count: ClickHouse is not answering','cannot count: ClickHouse is too slow to answer'].includes(r.detail)
const sinceOrder=r=>{const since=stamp(r.since);return Number.isFinite(since)?since:Infinity}
const checkOrder=(a,b)=>RANK[b.level]-RANK[a.level]||sinceOrder(a)-sinceOrder(b)
const checkCounts=(down,warn)=>down?plural(down,'check')+' down'+(warn?' · '+plural(warn,'warning'):''):warn?plural(warn,'check')+' with '+(warn===1?'a warning':'warnings'):'No failing checks'
function observed(r,checkedAt){const since=stamp(r.since);return '<span class="observed">'+(!Number.isFinite(since)||since>checkedAt?'Start time unavailable':
  'Observed since '+utcTime(since)+(Number.isFinite(checkedAt)?' · '+esc(duration(checkedAt-since))+' at last check':''))+'</span>'}
function checkAction(r){
  if(r.group==='Signal jobs'&&/^PostHog settings are missing:/.test(r.detail))return '<div class="check-action">Ask the Signal administrator to verify the PostHog project ID and API key</div>'
  if(!failing(r))return ''
  if(isClickHouse(r))return '<div class="check-action"><a href="#c-title">Check the ClickHouse container and its last health output</a></div>'
  if(r.group==='Machine'&&r.name==='Disk')return '<div class="check-action"><a href="#about-section">Review disk usage and retention</a></div>'
  if(/^Health endpoint (?:refused the connection|did not respond|returned HTTP)/.test(r.detail))return '<div class="check-action"><a href="#c-title">Check the matching container and its listening port</a></div>'
  return ''
}
function checkRow(r,name,detail,meta='',extra=''){return '<div class="svc">'+st(r.level)+'<div><span class="check-name">'+esc(name)+'</span>'+meta+detail+checkAction(r)+extra+'</div></div>'}
function problemRow(r,checkedAt,children=[]){const name=r.group==='Machine'&&r.name==='Memory'?'Low available memory':r.group+' · '+r.name
  const blocked=children.length?'<div class="blocked-checks"><div class="d">Could not verify: '+esc(children.map(c=>c.name).join(', '))+'</div>'+children.map(c=>problemRow(c,checkedAt)).join('')+'</div>':''
  return checkRow(r,name,'<div class="d">'+esc(r.detail??'')+'</div>',observed(r,checkedAt),blocked)}
function lensJobs(jobs,triage){const down=jobs.filter(r=>r.level==='down').length,warn=jobs.filter(r=>r.level==='warn').length,waiting=jobs.filter(r=>r.level==='info').length
  const summary=down||warn?down?down+' down'+(warn?' · '+plural(warn,'warning'):''):plural(warn,'warning'):waiting?waiting+' waiting':'All jobs healthy'
  $('jobs-summary').textContent='Signal jobs'+(jobs.length?' · '+summary:triage&&triage.level!=='ok'?' · Status unavailable':'')
  $('jobs').innerHTML=jobs.map(r=>{const detail=r.detail||'',last=detail.match(/(?:^| · )(last success .+ ago|no success yet)$/)
    const reason=r.level==='info'&&r.key!=='replay_retention'&&r.key!=='survey_sync'?'Waiting for first run':last?detail.slice(0,last.index):detail
    const success=last?.[1]==='no success yet'?'No successful run yet':last?.[1]?.replace(/^last success /,'Last successful run · ')
    return checkRow(r,r.name,(reason?'<div class="d">'+esc(reason)+'</div>':'')+(success?'<div class="d">'+esc(success)+'</div>':''))
  }).join('')||(triage&&triage.level!=='ok'?'<p class="muted">Job status unavailable · triage health check failed</p>':'<p class="muted">No job status reported</p>')
}
function recentChanges(changes){const sorted=changes.slice().sort((a,b)=>(stamp(b.at)||0)-(stamp(a.at)||0)),starts=new Map(),entries=[]
  for(const c of sorted.reverse()){const key=JSON.stringify([c.group,c.name]),at=stamp(c.at),start=starts.get(key)
    const state=c.level??c.to;const ended=c.from==='down'&&state!=='down'
    if(state==='down'&&c.from!=='down')starts.set(key,at)
    if(state!=='down')starts.delete(key)
    const transition=state==='down'?'Went down':state==='warn'?c.from==='down'?'Improved to warning':'Entered warning':state==='ok'?'Recovered':'Changed to '+(Object.hasOwn(LABEL,state)?LABEL[state]:state||'Unknown')
    const downInterval=ended?(Number.isFinite(start)&&start<=at?' · went down at '+utcTime(start)+' · down for '+esc(duration(at-start)):' · Down start unavailable'):''
    entries.push('<li><span class="check-name">'+esc(c.group)+' · '+esc(c.name)+'</span><div class="d">'+esc(transition)+(Number.isFinite(at)?' at '+utcTime(at):' · Time unavailable')+downInterval+'</div></li>')
  }
  entries.reverse()
  const list=(slice,start=0)=>slice.length?'<ol class="changes-list" start="'+esc(start+1)+'">'+slice.join('')+'</ol>':'<p class="muted">No changes observed yet. The last 100 transitions are kept until the status service restarts.</p>'
  $('changes-preview').innerHTML=list(entries.slice(0,3));$('all-changes').hidden=entries.length<=3
  paged('changes',entries,'changes',(slice,start)=>{$('changes').innerHTML=list(slice,start)})
}

function draw(s){const rows=s.checks||[],m=s.metrics||{},mc=m.machine||{},byName=g=>rows.filter(r=>r.group===g)
  const dockerError=rows.find(r=>!r.state&&r.group==='Containers'&&r.name==='Docker')
  const emptyProject=r=>!r.state&&r.group==='Containers: '+r.name
  const box=rows.filter(r=>r.group.startsWith('Containers')&&r!==dockerError&&!emptyProject(r)).sort((a,b)=>RANK[b.level]-RANK[a.level]||a.name.localeCompare(b.name));containers=box
  const empty=rows.some(emptyProject),counts=containerSummary(box)
  inventoryMessage=dockerError?'Container inventory unavailable':empty?'No containers found for monitored projects':'No container status reported'
  const problems=rows.filter(failing).sort(checkOrder),checkedAt=stamp(s.checked_at||null)
  checkHeading=checkCounts(problems.filter(r=>r.level==='down').length,problems.filter(r=>r.level==='warn').length)
  lastStatus=s;connectionError=null;freshness()
  const clickHouse=problems.find(r=>isClickHouse(r)&&r.level==='down'),blocked=clickHouse?rows.filter(r=>failing(r)&&blockedByClickHouse(r)):[]
  paged('problems',problems.filter(r=>!blocked.includes(r)),'problems',slice=>{$('problems').innerHTML=slice.length?'<div class="card"><h2>Needs attention</h2>'+slice.map(r=>problemRow(r,checkedAt,r===clickHouse?blocked:[])).join('')+'</div>':''})
  lensJobs(byName('Signal jobs'),byName('Signal').find(r=>r.name==='Triage service'))
  recentChanges(s.changes||[])
  const hours=m.events_by_hour,last=hours?hours.filter(h=>h[0]>=Math.floor(Date.now()/3600000)*3600000).reduce((a,h)=>a+h[1],0):null,day=hours?hours.reduce((a,h)=>a+h[1],0):null
  const memUsed=mc.mem_total?mc.mem_total-mc.mem_available:null,disk=mc.disk_total?mc.disk_total-mc.disk_free:null
  const machineLevel=name=>{const level=byName('Machine').find(r=>r.name===name)?.level;return level==='down'?true:level==='warn'?'warn':false}
  const containerNotes=[[counts.unhealthy,'unhealthy'],[counts.restarting,'restarting'],[counts.stopped,'stopped']].filter(x=>x[0]).map(x=>x[0]+' '+x[1])
  if(box.length&&empty)containerNotes.push('Some monitored projects have no containers')
  if(!containerNotes.length)containerNotes.push(counts.problems?plural(counts.problems,'container check')+' need'+(counts.problems===1?'s':'')+' attention':'all healthy')
  if(box.length>counts.expected)containerNotes.push((box.length-counts.expected)+' auxiliary excluded')
  $('tiles').innerHTML='<h2>Infrastructure</h2><div class="tiles">'+[tile('Containers running',box.length?counts.running+' of '+counts.expected:'–',box.length?containerNotes.join(' · '):inventoryMessage,dockerError||empty||box.some(r=>r.level==='down')?true:counts.problems?'warn':false),
    tile('CPU',pct(mc.cpu_pct),mc.cores?mc.cores+' cores, load '+(mc.load_5??0).toFixed(1):''),tile('Memory',memUsed==null?'–':gb(memUsed),mc.mem_total?'of '+gb(mc.mem_total):'',machineLevel('Memory')),
    tile('Disk used',disk==null?'–':pct(disk/mc.disk_total*100),mc.disk_free!=null?gb(mc.disk_free)+' free of '+gb(mc.disk_total):'',machineLevel('Disk'))].join('')+'</div><h2>Activity</h2><div class="tiles">'+[    tile('Events this hour',num(last),'Current hour'),tile('Events, 24 hours',num(day),'all event types'),tile('People, 24 hours',num(m.people_24h),'Unique users'),tile('Recordings, 24 hours',num(m.recordings_24h),'Last 24 hours')].join('')+'</div><p class="small muted">Ingestion warnings, last 24 hours: '+num(m.ingestion_warnings_24h)+'</p><details class="machine-details"><summary>Machine details</summary><p>ClickHouse data: '+gb(m.clickhouse_bytes)+'. Swap used: '+gb(mc.swap_used)+' of '+gb(mc.swap_total)+'. Recording metrics are counted, never opened.</p></details>'
  charts(m)
  const svc=(name,list)=>list.length?'<div class="card"><h2>'+name+'</h2>'+list.map(r=>'<div class="svc"><span>'+esc(r.name)+'</span><span class="d">'+esc(r.detail)+'</span>'+st(r.level)+'</div>').join('')+'</div>':''
  paged('services',rows.filter(r=>['PostHog','Signal','Signal jobs','Data arriving','Machine'].includes(r.group)),'checks',slice=>{$('services').innerHTML=['PostHog','Signal','Signal jobs','Data arriving','Machine'].map(g=>svc(g,slice.filter(r=>r.group===g))).join('')})
  const ch=m.clickhouse||{},lens=s.lens||{},activity=lens.activity,clipDisk=lens.storage
  $('clickhouse').innerHTML='<h2>ClickHouse health</h2>'+pairs([['Version',ch.version],['Uptime',ch.uptime_s==null?null:Math.floor(ch.uptime_s/3600)+' hours'],['Running queries',num(ch.running_queries)],['Merges in progress',num(ch.merges)],['Pending mutations',num(ch.pending_mutations)],['Most active parts in one partition',num(ch.max_partition_parts)]])+'<details><summary>8 biggest tables by bytes on disk</summary>'+((ch.tables||[]).map(t=>'<div class="svc"><span>'+esc(t.database)+'.'+esc(t.table)+'</span><span class="d">'+gb(t.bytes)+' · '+num(t.rows)+' rows</span></div>').join('')||'<p class="muted">Unavailable</p>')+'</details>'
  $('lens').innerHTML='<h2>Signal activity · last 24 hours</h2>'+(activity?pairs([['Sign-ins',num(activity.signins)],['Failed sign-ins',num(activity.failed_signins)],['Clips made',num(activity.clips_made)],['Clips watched',num(activity.clips_watched)],['Clips downloaded',num(activity.clips_downloaded)],['Share links',num(activity.share_links)]])+(activity.truncated?'<p>Audit limit reached; counts are lower bounds.</p>':''):'<p class="muted">Activity unavailable</p>')+'<details><summary>Clip storage</summary>'+(clipDisk?pairs([['Clips',num(clipDisk.clips)],['Storage',gb(clipDisk.bytes)],['Saved clips',num(clipDisk.saved)],['Saved storage',gb(clipDisk.saved_bytes)]]):'<p>Unavailable</p>')+'</details>'
  const a=s.about||{},dd=m.docker_disk
  $('about').innerHTML=pairs([['PostHog web image',a.posthog_image],['ClickHouse version',a.clickhouse_version],['Docker engine',a.docker_version],['Status service uptime',a.uptime_s==null?null:Math.floor(a.uptime_s/60)+' minutes'],['Check interval',a.interval_s==null?null:a.interval_s+' s'],['Last check duration',a.took_ms==null?null:a.took_ms+' ms'],['Alerts',a.alerts==null?null:a.alerts==='off'?'Off: no webhook in the status page settings':'On ('+a.alerts.format+', after '+a.alerts.after_minutes+' min)'+(a.alerts.last_sent_at?', last sent '+new Date(a.alerts.last_sent_at).toLocaleString():', none sent yet')+(a.alerts.alerting&&a.alerts.alerting.length?', open: '+a.alerts.alerting.join('; '):'')+(a.alerts.last_error?'. Last failure: '+a.alerts.last_error:'')]])+'<details><summary>Docker disk usage · cached 10 minutes</summary>'+(dd?pairs([['Images',gb(dd.images_bytes)],['Containers (writable layers)',gb(dd.containers_bytes)],['Volumes',gb(dd.volumes_bytes)],['Build cache',gb(dd.build_cache_bytes)],['Measured',new Date(dd.at).toLocaleString()]]):'<p>Unavailable</p>')+'</details><p class="small muted">Large counts and table sizes refresh every five minutes. CPU is a share of the whole machine. Histories and recent changes are held in memory.</p>'
  $('c-title').textContent='All containers ('+box.length+')';table()}
async function tick(){try{const r=await fetch('/replays/system/api',{cache:'no-store'}),d=await r.json().catch(()=>({}));if(r.status===401)return location.reload();if(!r.ok)throw new Error('HTTP '+(d.upstream_status||r.status)+(d.upstream_status?'':d.error?' · '+d.error:''));
  $('system-results').hidden=false;draw(d)}
  catch(e){connectionError=e.message;freshness()}finally{document.querySelector('.skel-page')?.remove()}}
$('trends').ontoggle=function(){if(this.open&&lastStatus)charts(lastStatus.metrics||{})}
$('problems').onclick=e=>{if(e.target.closest?.('a[href="#about-section"]'))$('about-section').open=true}
tick();setInterval(tick,15000);setInterval(freshness,1000)
`
