// Client privacy for AI (src/core/anonymise.ts), in the web app:
//   /replays/admin/privacy   admins: switch anonymisation on or off, choose what PostHog's MCP may do, and
//                            edit each client's codename and the other names it goes by
//   /replays/codenames       everyone who works with clients in Lens: who is who (codename ↔ client)
// Links the AI gives out carry a codename's slug (?client=amber-falcon); codenameRedirect turns them back
// into the client for signed-in people.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { anonSettings, anonymiseOn, AnonInputError, blockCounts, clientOfCodename, listCodenames, setAnonymise, setCodename } from '../core/anonymise.ts'
import { refreshRoster } from '../core/anonroster.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { audit, can, canUseDashboards, type Viewer } from './access.ts'
import { canConnect } from './connect.ts'
import { APP_NAME, headerHtml, PAGER_JS, PAGE_CSS } from './replays.ts'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}
function html(res: ServerResponse, body: string) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
    res.end(body)
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const c of req) { raw += c; if (raw.length > 20_000) throw new AnonInputError('Body too large.') }
    try { return JSON.parse(raw || '{}') } catch { throw new AnonInputError('Invalid JSON.') }
}
/** Who may see who is who: anyone who works with clients in Lens. */
export const canSeeCodenames = (v: Viewer) => can(v.role, 'watch') || canUseDashboards(v) || canConnect(v)

/** A link with a codename's slug where a client goes (?client=amber-falcon): the same page for the client. */
export function codenameRedirect(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET' || !url.search) return false
    let changed = false
    const out = new URL(url)
    for (const [k, value] of url.searchParams) {
        if (!/client/i.test(k)) continue
        const id = clientOfCodename(value)
        if (id && id !== value) { out.searchParams.set(k, id); changed = true }
    }
    if (!changed) return false
    res.writeHead(302, { location: out.pathname + out.search + out.hash, 'cache-control': 'no-store' })
    res.end()
    return true
}

const STYLE = `.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.top h1{margin:0}
.sub{color:var(--muted);margin:6px 0 16px}
.alert{background:var(--warn-bg);border:1px solid var(--warn);color:var(--warn);border-radius:8px;padding:10px 14px;margin:8px 0;font-size:14px}
.alert b{color:inherit}
.rows{margin:4px 0 0}
.set{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:48px;box-sizing:border-box;padding:6px 0;border-bottom:1px solid var(--line)}
.set:last-child{border-bottom:0}
.set label{margin:0;font-weight:500;color:var(--ink);font-size:13px;line-height:20px}
.grp{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;margin:4px 0 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:8px 40px}
.sw{appearance:none;-webkit-appearance:none;width:42px!important;height:24px;min-height:0!important;padding:0!important;border-radius:999px;background:var(--line-strong);position:relative;cursor:pointer;flex:none;margin:0;border:0!important;transition:background .15s}
.sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--card);box-shadow:0 1px 2px var(--line);transition:left .15s}
.sw:checked{background:var(--ok)}
.sw:checked::after{left:21px}
.sw:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sw:disabled{opacity:.5;cursor:default}
.off-area{opacity:.55}
.card .find{align-items:center;margin:0 0 16px}
.stats{color:var(--muted);font-size:13px;margin:12px 0 0;padding-top:12px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 24px}
table.cn{width:100%;table-layout:fixed;border-collapse:collapse}
table.cn th,table.cn td{text-align:left;padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:middle;overflow-wrap:anywhere}
table.cn th{background:transparent;font-size:12px;color:var(--muted);font-weight:500}
table.cn input{width:100%;min-width:0;margin:0}
.code{color:var(--muted);font-size:12px;line-height:16px;margin-top:2px;display:block}
.ic{width:32px;height:32px;min-height:32px!important;padding:7px;min-width:0;display:inline-flex;align-items:center;justify-content:center}
.ic svg,.copy-prompt svg{width:16px;height:16px;flex:none}
.copy-prompt{display:inline-flex;gap:6px;align-items:center}
.acts{display:flex;gap:4px;justify-content:flex-end}
.find{display:flex;justify-content:space-between;align-items:end;gap:12px;margin:8px 0}
.find>div{width:280px;max-width:100%}
.find input{width:100%;max-width:none}
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
.tabs .tab-link{margin-left:0;color:var(--muted);text-decoration:none;font-weight:500;padding:8px 12px;border-bottom:2px solid transparent}
.tabs :is([aria-current],[aria-selected=true]){color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.card>.top{align-items:flex-start}
.card>.top>label.set{margin:0;min-height:24px}
.set>span:first-child,.set label{font-size:13px;line-height:20px;font-weight:500;color:var(--ink)}
.set select{width:auto;min-width:0;height:36px}
.message-settings>details{margin:0}
.message-settings>details>summary{padding:4px 0}
.message-settings{border-top:1px solid var(--line);margin-top:16px;padding-top:12px}
table.cn :is(th,td):first-child{padding-left:0}
table.cn :is(th,td):last-child{padding-right:0}
table.cn td{height:56px;padding-top:8px;padding-bottom:8px;box-sizing:border-box}
table.cn .ac button.ghost{font-size:13px;font-weight:500;color:var(--muted)}
table.cn .ac button.ghost:hover{color:var(--accent)}
table.cn td.cn b{font-weight:600}
.access-help{margin:0;border-bottom:1px solid var(--line);padding:16px 0}
.card .acts{flex-wrap:wrap}
#pager{margin-top:0;padding-top:16px}
@media(max-width:760px){.cols{grid-template-columns:1fr}
}
@media(max-width:700px){table.cn,table.cn tbody{display:block;width:100%}
table.cn colgroup,table.cn thead{display:none}
table.cn tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 8px;border-bottom:1px solid var(--line);padding:10px 0}
table.cn td.cl,table.cn td.al{grid-column:1/-1}
table.cn td.cn{grid-column:1}
table.cn td.ac{grid-column:2;align-self:center}
.find{flex-wrap:wrap}
.find input{max-width:none}
table.cn td{display:block;border:0;padding:0;min-width:0;height:auto;min-height:32px}
.top{align-items:flex-start}
}
`

/** Keep both Admin entry points in the same navigation order. */
export function adminTabs(privacy = false): string {
    const sections = [['people', 'People'], ['outcomes', 'Client outcomes'], ['chat', 'Chat keys'], ['clips', 'Clips'], ['activity', 'Activity']]
    return `<div class="tabs"${privacy ? '' : ' role="tablist" aria-label="Admin sections"'}>${sections.map(([id, label]) => privacy ? `<a class="tab-link" href="/replays/admin#${id}">${label}</a>` : `<button class="tab-link" type="button" role="tab" data-tab="${id}">${label}</button>`).join('')}<a class="tab-link"${privacy ? ' aria-current="page"' : ''} href="/replays/admin/privacy">Client privacy</a></div>`
}

function adminPage(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Client privacy for AI · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}</style></head>
<body>${headerHtml(v, 'Admin')}<main>
<div class="page-head"><div><h1>Admin</h1><p>Who can use Lens, and what it keeps.</p></div></div>
${adminTabs(true)}
<section class="card"><div class="top"><div><h2 style="margin:0">Client privacy for AI</h2><p class="sub" style="margin:4px 0 0">AI sees codenames instead of client names. People still see real names in Lens.</p></div><label class="set" style="border:0;padding:0" for="s-on"><span id="on-text">Off</span><input type="checkbox" role="switch" class="sw" id="s-on"></label></div>
<div id="alerts" aria-live="polite"></div>
<div id="opts" class="cols"><div>
<p class="grp">Covers</p><div class="rows">
<div class="set"><label for="s-lens">Lens tools in Copilot</label><input type="checkbox" role="switch" class="sw" id="s-lens"></div>
<div class="set"><label for="s-posthog">PostHog tools in Copilot</label><select id="s-posthog"><option value="block">Block data</option><option value="filter">Filter results</option><option value="off">Not covered</option></select></div>
<div class="set"><label for="s-triage">Claude ticket triage</label><input type="checkbox" role="switch" class="sw" id="s-triage"></div>
</div></div><div>
<p class="grp">Hides</p><div class="rows">
<div class="set"><span>Client names</span><span class="small muted">Always</span></div>
<div class="set"><label for="s-codes">Client codes</label><input type="checkbox" role="switch" class="sw" id="s-codes"></div>
<div class="set"><label for="s-emails">Client users' emails</label><input type="checkbox" role="switch" class="sw" id="s-emails"></div>
<div class="set"><label for="s-round">Round counts <span class="muted small">(148 → 150)</span></label><input type="checkbox" role="switch" class="sw" id="s-round"></div>
</div>
</div></div><div class="message-settings"><details><summary>Message to the AI</summary><p class="small muted">What the AI is told when it asks with a client name or code. Empty: the default.</p>
<label class="sr-only" for="s-message">Message to the AI</label><textarea id="s-message" rows="3" maxlength="500"></textarea>
<p><button type="button" id="msg-save">Save message</button></p></details>

</div>
<p class="stats" id="stats"></p></section>
<section class="card"><div class="find"><h2 style="margin:0">Codenames</h2><div><label class="sr-only" for="find">Find a client</label><input id="find" type="search" placeholder="Find a client or codename"></div></div>
<p class="small muted">Settings save automatically. Save codename edits per row.</p><table class="cn"><caption class="sr-only">Clients and their codenames</caption><colgroup><col style="width:28%"><col style="width:28%"><col style="width:36%"><col style="width:8%"></colgroup>
<thead><tr><th scope="col">Client</th><th scope="col">Codename</th><th scope="col">Other names</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody></table>
<div id="pager"></div></section>
<p id="msg" class="small" role="status" aria-live="polite"></p>
<details class="access-help"><summary>How it works</summary><ul class="small">
<li>Every client gets a short random codename when Lens first sees it. It never hints at the name. Change it here any time.</li>
<li>Copilot's questions that use a codename reach the real client inside Lens; its links open the real client for signed-in people. PMs look codenames up on <a href="/replays/codenames">Codenames</a>.</li>
<li>A question with a real name or code is refused, the same way for any name.</li>
<li><i>Block data</i> lets Copilot search PostHog's docs only. <i>Filter results</i> runs PostHog queries and replaces names in the answers.</li>
<li>Other names: how people also write a client (short or old names). Legal endings, initials of long names (KFH) and one-letter typos are covered already.</li>
<li><i>Round counts</i> rounds numbers like events and users in answers, so an exact size cannot point to a client.</li>
<li>Not covered by Lens: what people type into Copilot, chats from before this was on, AI tools connected to PostHog with someone's own PostHog key, and PostHog's own AI features. Keep PostHog API keys to admins.</li></ul></details>
</main>
<script>
${PAGER_JS}
const $=id=>document.getElementById(id);let S={settings:{},clients:[],counts:{}}
const api=async(path,opt={})=>{const r=await fetch(path,{...opt,headers:{'content-type':'application/json','x-clip-page':'1'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Failed');return d}
const say=(t,error=false)=>{$('msg').textContent=t;$('msg').className='small '+(error?'err':'')}
function alerts(){const s=S.settings,out=[]
  if(s.on){out.push('Names entered directly into Copilot are still sent to AI. Use codenames and start a new chat after enabling privacy.')
    const gaps=[!s.lens&&'Lens tools',s.posthog==='off'&&'PostHog tools',!s.triage&&'Claude triage'].filter(Boolean)
    if(gaps.length)out.push('<b>Not covered:</b> '+gaps.join(', ')+'. AI sees real client names there.')
    if(s.posthog==='filter')out.push('<b>PostHog filter is not private.</b> A query can disguise names (reversed, encoded) and the AI can decode them.')
    if(!s.codes)out.push('<b>Client codes are visible</b> to the AI.')
    if(S.direct_posthog)out.push('<b>PostHog tools connect directly</b>, not through Lens (POSTHOG_MCP_VIA_LENS is off): Lens cannot hide names there.')
    if(!s.emails)out.push('<b>Client users’ emails are visible</b>: a domain names its company.')}
  $('alerts').innerHTML=out.map(t=>'<div class="alert" role="alert">'+t+'</div>').join('')}
function drawSettings(){const s=S.settings;$('s-on').checked=s.on;$('on-text').textContent=s.on?'On':'Off'
  $('s-lens').checked=s.lens;$('s-round').checked=!!s.round;$('s-triage').checked=s.triage;$('s-codes').checked=s.codes;$('s-emails').checked=s.emails;$('s-posthog').value=s.posthog
  if(document.activeElement!==$('s-message'))$('s-message').value=s.message||''
  $('opts').classList.toggle('off-area',!s.on);alerts()
  const c=S.counts,n=k=>(c[k]||0).toLocaleString()
  $('stats').replaceChildren(...['Last 30 days: '+n('lens_refused')+' questions refused',(+(c.lens_cleaned||0)+ +(c.posthog_cleaned||0)+ +(c.triage_cleaned||0)).toLocaleString()+' answers cleaned',n('posthog_refused')+' PostHog commands refused'].map(t=>{const el=document.createElement('span');el.textContent=t;return el}))}
async function save(body,done){try{S.settings=await api('/replays/admin/privacy/api/settings',{method:'POST',body:JSON.stringify(body)});drawSettings();say(done||'Saved.')}catch(e){say(e.message,true);drawSettings()}}
$('s-on').onchange=()=>{const on=$('s-on').checked;if(!on&&!confirm('Turn it off? AI will see client names again.')){$('s-on').checked=true;return}save({on},on?'On: AI now sees codenames.':'Off: AI sees client names.')}
for(const k of ['lens','triage','codes','emails','round'])$('s-'+k).onchange=()=>save({[k]:$('s-'+k).checked})
$('s-posthog').onchange=()=>save({posthog:$('s-posthog').value})
$('msg-save').onclick=()=>save({message:$('s-message').value},'Message saved.')
const pager=makePager({mount:$('pager'),noun:'clients',size:25,draw:slice=>{const body=$('rows');body.replaceChildren()
  if(!slice.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=4;td.className='muted';td.textContent=S.clients.length?'No client matches.':'No clients yet.';tr.append(td);body.append(tr);return}
  for(const c of slice){const tr=document.createElement('tr'),who=c.name||c.client
    const td=(cls,node)=>{const x=document.createElement('td');x.className=cls;x.append(node);tr.append(x);return x}
    const cl=document.createElement('div');const b=document.createElement('b');b.textContent=who;cl.append(b);if(c.name){const k=document.createElement('span');k.className='code';k.textContent=c.client;cl.append(k)}td('cl',cl)
    const cn=document.createElement('input');cn.value=c.codename;cn.setAttribute('aria-label','Codename for '+who);td('cn',cn)
    const al=document.createElement('input');al.value=c.aliases.join(', ');al.placeholder='Add another name';al.setAttribute('aria-label','Other names for '+who);const aliasCell=td('al',al);if(c.auto_aliases.length){const helper=document.createElement('div');helper.className='small muted';helper.textContent='Detected: '+c.auto_aliases.join(', ');aliasCell.append(helper)}
    const acts=document.createElement('div');acts.className='acts'
    const sv=document.createElement('button');sv.type='button';sv.className='save-row';sv.textContent='Save';sv.hidden=true;sv.setAttribute('aria-label','Save '+who)
    const dirty=()=>{sv.hidden=cn.value===c.codename&&al.value===c.aliases.join(', ')};cn.oninput=dirty;al.oninput=dirty
    sv.onclick=async()=>{try{Object.assign(c,await api('/replays/admin/privacy/api/codename',{method:'POST',body:JSON.stringify({client:c.client,codename:cn.value,aliases:al.value})}));dirty();say('Saved: '+who+' is '+c.codename+'.')}catch(e){say(e.message,true)}}
    const re=document.createElement('button');re.type='button';re.className='ghost ic';re.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M19 11a7 7 0 0 0-12-5L4 9m16 6-3 3A7 7 0 0 1 5 13"/></svg>';re.title='New random codename';re.setAttribute('aria-label','New random codename for '+who)
    re.onclick=async()=>{if(!confirm('New codename for '+who+'? People who know '+c.codename+' need the new one.'))return;try{Object.assign(c,await api('/replays/admin/privacy/api/codename',{method:'POST',body:JSON.stringify({client:c.client,regenerate:true})}));cn.value=c.codename;dirty();say(who+' is now '+c.codename+'.')}catch(e){say(e.message,true)}}
    acts.append(sv,re);td('ac',acts);body.append(tr)}}})
const filter=()=>{const q=$('find').value.trim().toLowerCase();pager.set(S.clients.filter(c=>!q||[c.client,c.name,c.codename,...c.aliases].some(x=>String(x).toLowerCase().includes(q))))}
$('find').oninput=filter
api('/replays/admin/privacy/api/state').then(d=>{S=d;drawSettings();filter()}).catch(e=>say(e.message,true))
</script></body></html>`
}

function codenamesPage(v: Viewer): string {
    const on = anonymiseOn()
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codenames · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}</style></head>
<body>${headerHtml(v, 'Chat')}<main class="narrow">
<div class="top"><h1>Codenames</h1><span class="badge ${on ? 'ok' : ''}">${on ? 'Client privacy is on' : 'Client privacy is off'}</span></div>
<p class="sub">${on ? 'Copilot only knows clients by codename. Ask about a client using its codename.' : 'Each client’s codename, ready for when an admin turns client privacy on.'}</p>
${on ? '<div class="alert" role="note">Names entered directly into Copilot are still sent to AI. Use codenames and start a new chat after enabling privacy.</div>' : ''}
<div class="find"><span id="client-count">Loading clients…</span><div><label class="sr-only" for="find">Find a client</label><input id="find" type="search" placeholder="Find a client or codename"></div></div>
<table class="cn"><caption class="sr-only">Who is who</caption><colgroup><col style="width:34%"><col style="width:46%"><col style="width:20%"></colgroup><thead><tr><th scope="col">Codename</th><th scope="col">Client</th><th scope="col"><span class="sr-only">Copy</span></th></tr></thead><tbody id="rows"><tr><td colspan="3">Loading…</td></tr></tbody></table>
<div id="pager"></div><p id="msg" class="small" role="status" aria-live="polite"></p></main>
<script>
${PAGER_JS}
const $=id=>document.getElementById(id);let L=[]
const pager=makePager({mount:$('pager'),noun:'clients',size:25,draw:slice=>{const body=$('rows');body.replaceChildren()
  if(!slice.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.className='muted';td.textContent=L.length?'No client matches.':'No clients yet.';tr.append(td);body.append(tr);return}
  for(const c of slice){const tr=document.createElement('tr');const cell=(cls,n)=>{const td=document.createElement('td');td.className=cls;td.append(n);tr.append(td)}
    const b=document.createElement('b');b.textContent=c.codename;cell('cn',b)
    const who=document.createElement('div');who.textContent=c.name||c.client;if(c.name){const k=document.createElement('span');k.className='code';k.textContent=c.client;who.append(k)}cell('cl',who)
    const cp=document.createElement('button');cp.type='button';cp.className='ghost copy-prompt';cp.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg><span>Copy prompt</span>';cp.setAttribute('aria-label','Copy a Copilot question about '+c.codename)
    cp.onclick=async()=>{const t='How is '+c.codename+' doing this month, and what needs attention?';try{await navigator.clipboard.writeText(t);const label=cp.querySelector('span');label.textContent='Copied';setTimeout(()=>label.textContent='Copy prompt',1500);$('msg').textContent='Copied: '+t}catch{$('msg').textContent=t}}
    const box=document.createElement('div');box.className='acts';box.append(cp);cell('ac',box);body.append(tr)}}})
const filter=()=>{const q=$('find').value.trim().toLowerCase();pager.set(L.filter(c=>!q||[c.client,c.name,c.codename].some(x=>String(x).toLowerCase().includes(q))))}
fetch('/replays/codenames/api',{headers:{'x-clip-page':'1'}}).then(r=>r.json()).then(d=>{L=d.clients||[];$('client-count').textContent=L.length+' clients';filter()}).catch(()=>{$('msg').textContent='Could not load the codenames.'})
$('find').oninput=filter
</script></body></html>`
}

export async function handlePrivacy(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    if (p === '/replays/codenames' || p === '/replays/codenames/api') {
        if (!canSeeCodenames(v)) { json(res, 403, { error: 'You do not work with clients in Lens. Ask an admin.' }); return true }
        await refreshRoster().catch(() => {})
        if (p === '/replays/codenames') html(res, codenamesPage(v))
        else json(res, 200, { on: anonymiseOn(), clients: listCodenames().map(({ client, name, codename }) => ({ client, name, codename })) })
        return true
    }
    if (!p.startsWith('/replays/admin/privacy')) return false
    if (!can(v.role, 'admin')) { json(res, 403, { error: 'Admins only.' }); return true }
    try {
        if (p === '/replays/admin/privacy' && req.method === 'GET') { html(res, adminPage(v)); return true }
        if (p === '/replays/admin/privacy/api/state' && req.method === 'GET') {
            await refreshRoster().catch(() => {})
            json(res, 200, { settings: anonSettings(), counts: blockCounts(30), clients: listCodenames(), direct_posthog: !config.posthog.mcpViaLens && posthogMcpActive() })
            return true
        }
        if (req.method === 'POST' && req.headers['x-clip-page'] !== '1') { json(res, 403, { error: 'A page request header is required.' }); return true }
        if (p === '/replays/admin/privacy/api/settings' && req.method === 'POST') {
            const b = await readJson(req)
            const before = anonSettings()
            const after = setAnonymise(b as Record<string, unknown>)
            const changed = Object.fromEntries(Object.entries(after).filter(([k, x]) => before[k as keyof typeof before] !== x).map(([k, x]) => [k, k === 'message' ? (x ? '(custom)' : '(default)') : x]))
            if (Object.keys(changed).length) audit(v.email, 'privacy.anonymise_set', changed)
            if (after.on && !before.on) await refreshRoster(0).catch(() => {})
            json(res, 200, after)
            return true
        }
        if (p === '/replays/admin/privacy/api/codename' && req.method === 'POST') {
            const b = await readJson(req)
            const r = setCodename(String(b.client || ''), { codename: b.codename === undefined ? undefined : String(b.codename), aliases: b.aliases as string | string[] | undefined, regenerate: b.regenerate === true }, v.email)
            audit(v.email, 'privacy.codename_set', { client: r.client, codename: r.codename, other_names: r.aliases.length })
            json(res, 200, r)
            return true
        }
        json(res, 404, { error: 'Not found.' })
    } catch (e) {
        json(res, e instanceof AnonInputError ? 400 : 500, { error: e instanceof AnonInputError ? e.message : 'Could not save.' })
    }
    return true
}
