// Client privacy for AI (src/core/anonymise.ts), in the web app:
//   /replays/admin/privacy   admins: switch anonymisation on or off, choose what PostHog's MCP may do, and
//                            edit each client's codename and the other names it goes by
//   /replays/codenames       everyone who works with clients in Lens: who is who (codename ↔ client)
// Links the AI gives out carry a codename's slug (?client=client-100); codenameRedirect turns them back
// into the client for signed-in people.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { privacyRevision, numbering, previewNumbering, applyNumbering, anonSettings, privacyMode, anonymiseOn, AnonInputError, blockCounts, clientOfCodename, listCodenames, setAnonymise, setCodename } from '../core/anonymise.ts'
import { refreshRoster } from '../core/anonroster.ts'
import { all } from '../core/db.ts'
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
    req.setEncoding?.('utf8')
    let raw = ''
    for await (const c of req) { raw += c; if (raw.length > 20_000) throw new AnonInputError('Body too large.') }
    try { return JSON.parse(raw || '{}') } catch { throw new AnonInputError('Invalid JSON.') }
}
/** Who may see who is who: anyone who works with clients in Lens. */
export const canSeeCodenames = (v: Viewer) => can(v.role, 'watch') || canUseDashboards(v) || canConnect(v)

/** A link with a codename's slug where a client goes (?client=client-100): the same page for the client. */
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
.grp{font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;margin:16px 0 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:8px 40px}
.sw{appearance:none;-webkit-appearance:none;width:42px!important;height:24px;min-height:0!important;padding:0!important;border-radius:999px;background:var(--line-strong);position:relative;cursor:pointer;flex:none;margin:0;border:0!important;transition:background .15s}
.sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--card);box-shadow:0 1px 2px var(--line);transition:transform .15s}
.sw:checked{background:var(--accent)}
.sw:checked::after{transform:translateX(18px)}
.sw:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sw:disabled{opacity:.65;cursor:not-allowed}
.off-area{color:var(--muted)}
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
main .page-head{margin-bottom:24px;align-items:center}
main .page-head p{margin:4px 0 0;font-size:14px;line-height:20px}
main h3{font-size:14px;line-height:20px;font-weight:600;margin:0 0 8px}
main input:not([type=checkbox]):not([type=radio]),main select{height:36px;min-height:36px;padding:7px 10px;font-size:13px;line-height:20px;max-width:100%;box-sizing:border-box}
main button,main .btn{min-height:36px;font-size:13px;line-height:20px;white-space:nowrap;word-break:normal;overflow-wrap:normal}
main th{word-break:normal;overflow-wrap:normal}
main .table-wrap{max-width:100%;overflow-x:auto}
main .pager button{min-height:32px;padding:5px 10px;border:1px solid var(--line-strong);background:var(--card);color:var(--ink);font-weight:500}
main .pager select{height:32px;min-height:32px}
main .pager .pg>span{min-height:32px;display:inline-flex;align-items:center}
#people-msg:empty,#outcome-msg:empty,#audit-msg:empty,#keys-msg:empty,#msg:empty{display:none}
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
    const privacyLink = `<a class="tab-link"${privacy ? ' aria-current="page"' : ''} href="/replays/admin/privacy">Client privacy</a>`
    if (privacy) {
        return `<div class="tabs" role="navigation" aria-label="Admin sections">${sections.map(([id, label]) => `<a class="tab-link" href="/replays/admin#${id}">${label}</a>`).join('')}${privacyLink}</div>`
    }
    const tabs = sections.map(([id, label], i) => `<button class="tab-link" type="button" role="tab" id="t-${id}" data-tab="${id}" aria-controls="tab-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label}</button>`).join('')
    return `<div class="tabs"><div class="tab-group" role="tablist" aria-label="Admin sections">${tabs}</div>${privacyLink}</div>`
}

function adminPage(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Client privacy · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}
.privacy-page,.privacy-page :is(.card,p){overflow-wrap:anywhere}
.privacy-page .table-wrap table{min-width:600px}
.privacy-page :is(.table-wrap,#preview,.row)+p{margin-top:var(--space-4)}
.privacy-page .row label{margin:0;min-width:0}
.privacy-page .row label:first-child{flex:1 1 160px;max-width:260px}
.privacy-page input[type=number]{width:120px}
.privacy-page .row button{align-self:end}
#preview{white-space:pre-wrap;max-height:300px;overflow:auto}
#preview:empty{display:none}
</style></head><body>${headerHtml(v, 'Admin')}<main id="main" class="privacy-page">
<div class="page-head"><div><h1>Admin</h1><p>Privacy for AI</p></div></div>${adminTabs(true)}
<section class="card"><h2>Privacy mode: <span id="current"></span></h2><p>One setting covers Lens tools, ticket triage and PostHog results. Replay access stays the same in all modes.</p>
<div class="table-wrap" role="region" aria-label="Privacy modes" tabindex="0"><table><thead><tr><th>Mode</th><th>Client names/codes</th><th>Client users’ emails/names/IDs</th><th>Cash amounts</th><th>Trade IDs</th><th>PostHog SQL</th></tr></thead><tbody>
<tr><td><label><input type="radio" name="mode" value="open"> Open</label></td><td>Real</td><td>Visible</td><td>Visible</td><td>Visible</td><td>Allowed</td></tr>
<tr><td><label><input type="radio" name="mode" value="standard"> Standard (default)</label></td><td>Real</td><td>Masked</td><td>Masked</td><td>Visible</td><td>Allowed; results masked</td></tr>
<tr><td><label><input type="radio" name="mode" value="private"> Private</label></td><td>Numbered codenames</td><td>Masked</td><td>Masked</td><td>Visible</td><td>Refused</td></tr></tbody></table></div>
<p class="small muted">Open shows what the source still retains. Data stored already generalised, such as message templates, stays generalised. Names typed directly into chat are sent to AI; in private mode use codenames.</p>
<div id="private"><label>Other PostHog data <select id="posthog"><option value="block">Block data</option><option value="filter">Filter results</option></select></label> <label><input type="checkbox" id="round"> Round counts</label><p class="small muted">Filtering is best effort; transformed or encoded client names may evade it. Block data permits docs only.</p></div></section>
<section class="card"><h2>Numbered codenames</h2><p>Immutable ranks keep labels stable. Initial ranks are shuffled. Individual codename edits are removed; real-name aliases remain editable below.</p>
<div class="row"><label>Prefix <input id="prefix" maxlength="40"></label> <label>Start <input id="start" type="number" min="0" step="1"></label> <button id="show" class="secondary">Preview mapping</button> <button id="apply" disabled>Apply preview</button></div><pre id="preview" role="region" aria-label="Codename mapping preview" tabindex="0"></pre><p class="small muted">Old codenames stop resolving. A scheme that reassigns a current or retired label is refused.</p>
<div class="table-wrap" role="region" aria-label="Client codename aliases" tabindex="0"><table><thead><tr><th>Client</th><th>Codename</th><th>Real-name aliases</th><th></th></tr></thead><tbody id="clients"></tbody></table></div></section>
<section class="card"><h2>Privacy audit</h2><div id="audit"></div></section><p id="msg" role="status"></p></main><script>
const $=id=>document.getElementById(id);let state,preview;
async function api(path,body){const r=await fetch('/replays/admin/privacy/api/'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-clip-page':'1'},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.error);return d}
const attempt=f=>async()=>{try{await f();$('msg').textContent='Saved.'}catch(e){$('msg').textContent=e.message}};
async function load(){state=await api('state');const s=state.settings;$('current').textContent=s.mode;document.querySelectorAll('[name=mode]').forEach(e=>e.checked=e.value===s.mode);$('private').hidden=s.mode!=='private';$('posthog').value=s.posthog;$('round').checked=s.round;$('prefix').value=state.numbering.prefix;$('start').value=state.numbering.start;
$('clients').replaceChildren();for(const c of state.clients){const tr=document.createElement('tr');for(const text of [c.name||c.client,c.codename]){const td=document.createElement('td');td.textContent=text;tr.append(td)}const td=document.createElement('td'),input=document.createElement('input');input.value=c.aliases.join(', ');input.setAttribute('aria-label','Real-name aliases for '+(c.name||c.client));td.append(input);tr.append(td);const acts=document.createElement('td'),save=document.createElement('button');save.textContent='Save aliases';save.className='secondary';save.onclick=attempt(async()=>{await api('codename',{client:c.client,aliases:input.value});await load()});acts.append(save);tr.append(acts);$('clients').append(tr)}
$('audit').replaceChildren();for(const row of state.audit){const p=document.createElement('p');p.className='small';p.textContent=row.t+' · '+row.who+' · '+row.action+' · '+row.details;$('audit').append(p)}}
document.querySelectorAll('[name=mode]').forEach(e=>e.onchange=attempt(async()=>{await api('settings',{mode:e.value});await load()}));
for(const k of ['posthog','round'])$(k).onchange=attempt(async()=>{await api('settings',{[k]:k==='round'?$(k).checked:$(k).value});await load()});
const scheme=()=>({prefix:$('prefix').value,start:Number($('start').value)});
for(const k of ['prefix','start'])$(k).oninput=()=>{preview=undefined;$('apply').disabled=true};
$('show').onclick=attempt(async()=>{const p=scheme(),d=await api('numbering-preview',p);preview={...p,revision:d.revision};$('preview').textContent=d.clients.map(c=>(c.name||c.client)+': '+c.before+' → '+c.codename).join('\\n');$('apply').disabled=false});
$('apply').onclick=attempt(async()=>{await api('numbering',preview);preview=undefined;$('apply').disabled=true;await load()});
load().catch(e=>$('msg').textContent=e.message);
</script></body></html>`
}

function codenamesPage(v: Viewer): string {
    const on = anonymiseOn()
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codenames · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}</style></head>
<body>${headerHtml(v, 'Chat')}<main class="narrow" id="main">
<div class="top page-head"><div><h1>Codenames</h1>
<p class="sub">${on ? 'Copilot only knows clients by codename. Ask about a client using its codename.' : 'Numbered client codenames for private mode.'}</p></div><span class="badge ${on ? 'ok' : ''}">${esc(privacyMode())} mode</span></div>
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
            json(res, 200, { settings: anonSettings(), numbering: numbering(), revision: privacyRevision(), audit: all('SELECT * FROM audit WHERE action LIKE ? ORDER BY t DESC LIMIT 50', 'privacy.%'), counts: blockCounts(30), clients: listCodenames(), direct_posthog: !config.posthog.mcpViaLens && posthogMcpActive() })
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
        if ((p === '/replays/admin/privacy/api/numbering-preview' || p === '/replays/admin/privacy/api/numbering') && req.method === 'POST') {
            const b = await readJson(req)
            const scheme = { prefix: String(b.prefix ?? ''), start: Number(b.start) }
            if (p.endsWith('numbering-preview')) json(res, 200, { clients: previewNumbering(scheme), revision: privacyRevision() })
            else {
                if (b.revision !== privacyRevision()) throw new AnonInputError('Mapping changed; preview again before applying.')
                json(res, 200, applyNumbering(scheme, v.email, Number(b.revision)))
            }
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
