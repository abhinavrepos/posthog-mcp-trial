// Client privacy for AI (src/core/anonymise.ts), in the web app:
//   /replays/admin/privacy   admins: switch anonymisation on or off, choose what PostHog's MCP may do, and
//                            edit each client's codename and the other names it goes by
//   /replays/codenames       everyone who works with clients in Lens: who is who (codename ↔ client)
// Links the AI gives out carry a codename's slug (?client=amber-falcon); codenameRedirect turns them back
// into the client for signed-in people.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { anonymiseOn, AnonInputError, blockCounts, clientOfCodename, listCodenames, posthogMode, setAnonymise, setCodename } from '../core/anonymise.ts'
import { refreshRoster } from '../core/anonroster.ts'
import { audit, can, canUseDashboards, type Viewer } from './access.ts'
import { canConnect } from './connect.ts'
import { APP_NAME, headerHtml, PAGE_CSS } from './replays.ts'

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

const STYLE = `.lede{color:var(--muted);max-width:760px}.state{display:flex;gap:16px;flex-wrap:wrap;align-items:end;margin:12px 0}.state label{display:block;font-weight:600;margin-bottom:4px}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px}.pill.on{background:#e6f4ea;color:#14532d}.pill.off{background:var(--chip);color:var(--muted)}
table.cn{width:100%;table-layout:fixed;border-collapse:collapse}table.cn th,table.cn td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
table.cn input{width:100%;min-width:0}.row-actions{display:flex;gap:6px;flex-wrap:wrap}.row-actions button,table.cn td button{white-space:nowrap}.counts{display:flex;gap:24px;flex-wrap:wrap}.counts div b{display:block;font-size:22px}
@media(max-width:760px){table.cn thead{display:none}table.cn tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}table.cn td{display:block;border:0;padding:4px 0}table.cn td[data-l]::before{content:attr(data-l);display:block;font-size:12px;color:var(--muted)}}`

function adminPage(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Client privacy for AI · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}</style></head>
<body>${headerHtml(v, 'Admin')}<main>
<p class="small"><a href="/replays/admin">← Admin</a></p>
<h1>Client privacy for AI</h1>
<p class="lede">When this is on, AI never gets client names or client codes from Lens: Copilot (through Lens's tools and PostHog's), and Claude's ticket triage, see each client's codename instead. Codenames that come back from the AI are turned into the real client inside Lens, and the links it gives open the right client here. People see real names only in Lens; the <a href="/replays/codenames">Codenames page</a> shows who is who.</p>
<section class="card"><h2>Setting</h2>
<div class="state"><div><label for="anon-on">Client anonymisation</label><select id="anon-on"><option value="0">Off: AI sees client names and codes</option><option value="1">On: AI sees codenames only</option></select></div>
<div><label for="anon-ph">PostHog's MCP while it is on</label><select id="anon-ph"><option value="block">Block data commands (recommended)</option><option value="filter">Allow them, hide names in plain results (not private)</option></select></div>
<div><span id="anon-state" class="pill off" aria-live="polite">Off</span></div></div>
<details><summary>What each choice means</summary><ul class="small">
<li><b>Block data commands</b>: Copilot can still search PostHog's documentation, but every PostHog query, list and insight is refused: a query can rebuild a name in ways no filter can recognise (joined, encoded, counted). Lens's own tools cover the questions about clients, with codenames.</li>
<li><b>Allow them, hide names in plain results</b>: queries run, codenames in them are turned into client codes, and client names and codes in the results are replaced. <b>This is not private</b>: an AI can write a query that returns names in disguise (reversed, encoded as hex, cut into pieces) and decode them itself. Use it only when the client data is not critical.</li>
<li><b>Turning it on mid-way</b>: it applies to the very next message, in chats already open too, and PostHog streams already open are cleaned from then on. But names the AI was given before stay in those chats' history: ask people to start new chats. Lens checks for new clients every minute while it is on (and every five minutes while it is off); a client field with a client Lens has not listed yet is masked as [client] until it has a codename.</li>
<li>Either way: a client name or code typed into a question is refused, with the same message for any name, so the refusal never confirms that a name is a client. What a person types into Copilot reaches the AI before Lens sees it: ask people to use codenames.</li></ul></details>
<p id="anon-msg" class="small" aria-live="polite"></p></section>
<section class="card"><h2>Blocked and hidden, last 30 days</h2><div class="counts" id="counts"></div><p class="small muted">Counts only: the text itself is never kept.</p></section>
<section class="card"><h2>Codenames</h2><p class="small muted">Each client gets a short random codename (two words, at most 11 letters, from a list of 10,000) the first time Lens sees it, also while this is off. It never hints at the name, and it stays until you change it. Other names: how people also write this client (short names, old names, abbreviations), so those are hidden too. Legal endings are covered already: "Northwind Treasury" also hides "Northwind".</p>
<p><label for="find">Find a client</label><input id="find" type="search" placeholder="Name, code or codename"></p>
<table class="cn"><caption class="sr-only">Clients and their codenames</caption><colgroup><col style="width:13%"><col style="width:21%"><col style="width:19%"><col style="width:22%"><col style="width:25%"></colgroup>
<thead><tr><th scope="col">Client code</th><th scope="col">Name</th><th scope="col">Codename</th><th scope="col">Other names</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody id="rows"><tr><td colspan="5">Loading…</td></tr></tbody></table>
<p id="rows-msg" class="small" aria-live="polite"></p></section>
</main>
<script>
const $=id=>document.getElementById(id);let S={clients:[]}
const api=async(path,opt={})=>{const r=await fetch(path,{...opt,headers:{'content-type':'application/json','x-clip-page':'1'}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Failed');return d}
const LABEL={lens_refused:'Lens questions refused',lens_cleaned:'Lens answers cleaned',posthog_refused:'PostHog commands refused',posthog_cleaned:'PostHog answers cleaned',triage_cleaned:'Tickets cleaned for Claude'}
function drawState(){$('anon-on').value=S.on?'1':'0';$('anon-ph').value=S.posthog;$('anon-state').textContent=S.on?'On':'Off';$('anon-state').className='pill '+(S.on?'on':'off')
  $('counts').replaceChildren(...Object.keys(LABEL).map(k=>{const d=document.createElement('div');const b=document.createElement('b');b.textContent=(S.counts[k]||0).toLocaleString();d.append(b,LABEL[k]);return d}))}
function drawRows(){const q=$('find').value.trim().toLowerCase();const list=S.clients.filter(c=>!q||[c.client,c.name,c.codename,...c.aliases].some(x=>String(x).toLowerCase().includes(q)));const body=$('rows');body.replaceChildren()
  if(!list.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent=S.clients.length?'No client matches.':'No clients yet: they appear once Lens has seen their events.';tr.append(td);body.append(tr);return}
  for(const c of list.slice(0,300)){const tr=document.createElement('tr')
    const cell=(l,node)=>{const td=document.createElement('td');td.dataset.l=l;if(typeof node==='string')td.textContent=node;else td.append(node);tr.append(td);return td}
    cell('Client code',c.client);cell('Name',c.name||'–')
    const cn=document.createElement('input');cn.value=c.codename;cn.setAttribute('aria-label','Codename for '+(c.name||c.client));cell('Codename',cn)
    const al=document.createElement('input');al.value=c.aliases.join(', ');al.placeholder=c.auto_aliases.length?'Also hidden: '+c.auto_aliases.join(', '):'Comma-separated';al.setAttribute('aria-label','Other names for '+(c.name||c.client));cell('Other names',al)
    const box=document.createElement('div');box.className='row-actions'
    const save=document.createElement('button');save.type='button';save.textContent='Save';save.setAttribute('aria-label','Save '+(c.name||c.client))
    save.onclick=async()=>{try{const r=await api('/replays/admin/privacy/api/codename',{method:'POST',body:JSON.stringify({client:c.client,codename:cn.value,aliases:al.value})});Object.assign(c,r);$('rows-msg').textContent='Saved: '+(c.name||c.client)+' is "'+r.codename+'".'}catch(e){$('rows-msg').textContent=e.message}}
    const gen=document.createElement('button');gen.type='button';gen.className='ghost';gen.textContent='New codename';gen.setAttribute('aria-label','New random codename for '+(c.name||c.client))
    gen.onclick=async()=>{if(!confirm('Give '+(c.name||c.client)+' a new codename? People who know "'+c.codename+'" will need the new one.'))return;try{const r=await api('/replays/admin/privacy/api/codename',{method:'POST',body:JSON.stringify({client:c.client,regenerate:true})});Object.assign(c,r);cn.value=r.codename;$('rows-msg').textContent='New codename: '+r.codename+'.'}catch(e){$('rows-msg').textContent=e.message}}
    box.append(save,gen);cell('',box);body.append(tr)}
  if(list.length>300){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent='Showing 300 of '+list.length+': narrow it with Find.';tr.append(td);body.append(tr)}}
async function load(){S=await api('/replays/admin/privacy/api/state');drawState();drawRows()}
const saveSetting=async body=>{try{const r=await api('/replays/admin/privacy/api/settings',{method:'POST',body:JSON.stringify(body)});Object.assign(S,r);drawState();$('anon-msg').textContent='Saved. '+(S.on?'AI now sees codenames only.':'AI sees client names again.')}catch(e){$('anon-msg').textContent=e.message;drawState()}}
$('anon-on').onchange=()=>{const on=$('anon-on').value==='1';if(!on&&!confirm('Turn client anonymisation off? AI will see client names and codes again.')){drawState();return}saveSetting({on})}
$('anon-ph').onchange=()=>saveSetting({posthog:$('anon-ph').value})
$('find').oninput=drawRows
load().catch(e=>{$('rows-msg').textContent=e.message})
</script></body></html>`
}

function codenamesPage(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codenames · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}${STYLE}</style></head>
<body>${headerHtml(v, 'Chat')}<main>
<h1>Client codenames</h1>
<p class="lede">${anonymiseOn() ? '<b>Client anonymisation is on.</b> Copilot never sees client names or codes: ask it about a client by its codename, such as “How is <i>Amber Falcon</i> doing?”. Its answers use codenames too, and its links open the real client here.' : 'Client anonymisation is off at the moment, so Copilot sees client names. Each client already has a codename for when an admin turns it on.'}</p>
<p><label for="find">Find a client</label><input id="find" type="search" placeholder="Name, code or codename"></p>
<table class="cn"><caption class="sr-only">Who is who</caption><thead><tr><th scope="col">Codename</th><th scope="col">Client</th><th scope="col">Client code</th><th scope="col"><span class="sr-only">Copy</span></th></tr></thead><tbody id="rows"><tr><td colspan="4">Loading…</td></tr></tbody></table>
<p id="msg" class="small" aria-live="polite"></p></main>
<script>
const $=id=>document.getElementById(id);let L=[]
function draw(){const q=$('find').value.trim().toLowerCase();const list=L.filter(c=>!q||[c.client,c.name,c.codename].some(x=>String(x).toLowerCase().includes(q)));const body=$('rows');body.replaceChildren()
  if(!list.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=4;td.textContent=L.length?'No client matches.':'No clients yet.';tr.append(td);body.append(tr);return}
  for(const c of list.slice(0,300)){const tr=document.createElement('tr');const cell=(l,t)=>{const td=document.createElement('td');td.dataset.l=l;if(typeof t==='string')td.textContent=t;else td.append(t);tr.append(td)}
    const b=document.createElement('b');b.textContent=c.codename;cell('Codename',b);cell('Client',c.name||'–');cell('Client code',c.client)
    const cp=document.createElement('button');cp.type='button';cp.className='ghost';cp.textContent='Copy a question';cp.setAttribute('aria-label','Copy a Copilot question about '+c.codename)
    cp.onclick=async()=>{const t='How is '+c.codename+' doing this month, and what needs attention?';try{await navigator.clipboard.writeText(t);$('msg').textContent='Copied: '+t}catch{$('msg').textContent=t}}
    cell('',cp);body.append(tr)}}
fetch('/replays/codenames/api',{headers:{'x-clip-page':'1'}}).then(r=>r.json()).then(d=>{L=d.clients||[];draw()}).catch(()=>{$('msg').textContent='Could not load the codenames.'})
$('find').oninput=draw
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
            json(res, 200, { on: anonymiseOn(), posthog: posthogMode(), counts: blockCounts(30), clients: listCodenames() })
            return true
        }
        if (req.method === 'POST' && req.headers['x-clip-page'] !== '1') { json(res, 403, { error: 'A page request header is required.' }); return true }
        if (p === '/replays/admin/privacy/api/settings' && req.method === 'POST') {
            const b = await readJson(req)
            const before = { on: anonymiseOn(), posthog: posthogMode() }
            setAnonymise({ on: typeof b.on === 'boolean' ? b.on : undefined, posthog: b.posthog === undefined ? undefined : String(b.posthog) })
            const after = { on: anonymiseOn(), posthog: posthogMode() }
            if (after.on !== before.on || after.posthog !== before.posthog) audit(v.email, 'privacy.anonymise_set', { on: after.on, posthog: after.posthog, before })
            if (after.on) await refreshRoster(0).catch(() => {})
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
