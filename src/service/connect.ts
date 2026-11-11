// The Connect chat page: each person makes their own chat (MCP) token, so Lens knows who asks in chat
// and applies their survey role there. The token is shown once; only its hash is kept. People see and
// revoke their own tokens here; admins see and revoke everyone's on the admin page.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, posthogMcpActive } from '../core/config.ts'
import { can, canSurvey, chatUrl, createMcpToken, listMcpTokens, revokeMcpToken, SURVEY_ROLE_TEXT, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGER_JS, PAGE_CSS } from './replays.ts'

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = ''
    for await (const c of req) {
        raw += c
        if (raw.length > 10_000) throw new Error('body too large')
    }
    try {
        return JSON.parse(raw || '{}')
    } catch {
        return {}
    }
}

/** Anyone with some use of Lens: a clip role, or a survey role. */
export const canConnect = (v: Viewer) => can(v.role, 'watch') || canSurvey(v.surveys, 'view')

/** PostHog's MCP server is reachable through Lens (/posthog-mcp), with the same personal token. */
const posthogOn = () => config.posthog.mcpViaLens && posthogMcpActive()

export async function handleConnect(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    if (!canConnect(v)) return (json(res, 403, { error: 'You have no access to Lens yet. Ask an admin.' }), true)
    if (p === '/replays/connect' || p === '/replays/connect/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(connectHtml(v))
        return true
    }
    if (!config.features.lensMcp) return (json(res, 503, { error: 'Chat tools are switched off (FEATURE_LENS_MCP=off).' }), true)
    if (p === '/replays/connect/api/tokens' && req.method === 'GET') return (json(res, 200, { tokens: listMcpTokens(v.email) }), true)
    if (p === '/replays/connect/api/tokens' && req.method === 'POST') {
        const body = await readJson(req)
        try {
            const t = createMcpToken(v, String(body.label || ''))
            return (json(res, 200, { ...t, url: `${chatUrl()}/mcp`, posthog_url: posthogOn() ? `${chatUrl()}/posthog-mcp` : null, name: config.mcp.name }), true)
        } catch (e) {
            return (json(res, 400, { error: (e as Error).message }), true)
        }
    }
    const m = /^\/replays\/connect\/api\/tokens\/([0-9a-f]{12})$/.exec(p)
    if (m && req.method === 'DELETE') return (json(res, revokeMcpToken(m[1], v.email, v.email) ? 200 : 404, { ok: true }), true)
    json(res, 404, { error: 'Not found.' })
    return true
}

function connectHtml(v: Viewer): string {
    const role = SURVEY_ROLE_TEXT[can(v.role, 'admin') ? 'launch' : v.surveys || 'none']
    const ph = posthogOn()
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect chat · ${APP_NAME}</title><style>${PAGE_CSS()}
table{width:100%;table-layout:fixed}td,th{overflow-wrap:anywhere}ol.steps{padding-left:20px}ol.steps li{margin:10px 0}
.srv{border:1px solid var(--line,#ddd);border-radius:10px;padding:10px 12px;margin:10px 0}.srv h3{margin:0 0 6px;font-size:15px}
.f{display:grid;grid-template-columns:130px 1fr auto;gap:8px;align-items:center;padding:4px 0}.f code{background:var(--chip);padding:5px 8px;border-radius:6px;overflow-wrap:anywhere;font-size:13px}
@media (max-width:560px){.f{grid-template-columns:1fr auto}.f span{grid-column:1/-1}}
main{min-width:0}main .card{background:transparent;border:0;border-radius:0;padding:24px 0;margin:0}main .card+ .card{border-top:1px solid var(--line);margin-top:16px}main h1{margin-top:0}main button:not(.ghost){background:var(--ink);border-color:var(--ink);color:var(--card)}main .ghost{border-color:transparent;color:var(--ink)}
ol.steps{padding-left:24px}ol.steps li{padding:8px 0 16px 8px}ol.steps li::marker{color:var(--muted);font-weight:600}.srv{border:0;border-radius:0;padding:16px 0;margin:8px 0}.srv+.srv{border-top:1px solid var(--line)}.f{grid-template-columns:100px minmax(0,1fr) auto;gap:12px}.f code{background:var(--bg)}main .table-wrap{overflow:visible}main td{padding-top:14px;padding-bottom:14px}
@media(max-width:560px){.f{grid-template-columns:minmax(0,1fr) auto;gap:6px}.f span{grid-column:1/-1}main th,main td{padding-left:3px;padding-right:3px;font-size:13px}main td button{padding:6px 3px}ol.steps li{padding-left:2px}main h1{font-size:24px}}
</style></head>
<body>${headerHtml(v, 'Chat')}<main style="max-width:820px">
<div class="card"><h1>Connect GitHub Copilot</h1>
<p class="small muted">Your key is shown once. Copilot uses your Lens access (surveys: ${role}).</p>
<ol class="steps">
<li><button type="button" id="make">Connect Copilot</button> <span id="msg" class="small" aria-live="polite"></span></li>
<li>Open Copilot settings → <b>MCP Servers</b> → <b>Add Server</b> → <b>+ Add Custom server</b>. Copy these fields${ph ? ', once per server' : ''}.<div id="add"></div></li>
<li>Start a new chat: <i>"Which clients need attention this month?"</i></li>
</ol>
</div>
<div class="card"><h2>Your keys</h2><div class="table-wrap"><table><thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div><div id="keys-pager"></div><p id="keys-msg" class="small" aria-live="polite"></p>
</div>
</main>
<script>
${PAGER_JS}
const $=id=>document.getElementById(id)
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'never'
function cell(tr,t){const td=document.createElement('td');if(t instanceof Node)td.appendChild(t);else td.textContent=t;tr.appendChild(td)}
function el(tag,attrs,text){const e=document.createElement(tag);Object.assign(e,attrs||{});if(text)e.textContent=text;return e}
function message(id,text,error=false){$(id).textContent=text;$(id).className='small '+(error?'err':'');$(id).setAttribute('role',error?'alert':'status')}
const keysPg=makePager({mount:$('keys-pager'),noun:'keys',size:25,draw:slice=>{const tb=$('rows');tb.innerHTML='';if(!slice.length)tb.innerHTML='<tr><td colspan="4" class="muted">No keys yet. Choose Connect Copilot to make one.</td></tr>'
  slice.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.label);cell(tr,when(t.created_at));cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at):when(t.last_used_at))
    if(!t.revoked_at){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent='Revoke';b.setAttribute('aria-label','Revoke '+t.label+' key made '+when(t.created_at));b.onclick=async()=>{if(!confirm('Revoke "'+t.label+'"? Chat with it stops at once.'))return;b.disabled=true;try{await api('/replays/connect/api/tokens/'+t.id,{method:'DELETE'});await load();message('keys-msg','Key revoked.')}catch(e){message('keys-msg',e.message+' Try revoking again.',true)}finally{b.disabled=false;if(!b.isConnected)($('keys-pager').querySelector('button:not(:disabled)')||$('make')).focus()}};cell(tr,b)}else cell(tr,'');tb.appendChild(tr)})}})
async function load(){try{const d=await api('/replays/connect/api/tokens');keysPg.set(d.tokens,true)}catch(e){message('keys-msg',e.message+' Reload the page to try again.',true)}}
$('make').onclick=async()=>{$('make').disabled=true;message('msg','Making your key…');try{const t=await api('/replays/connect/api/tokens',{method:'POST',body:JSON.stringify({label:'GitHub Copilot'})})
  const list=[[t.name,t.url,'Server 1: ${APP_NAME}']];if(t.posthog_url)list.push(['posthog',t.posthog_url,'Server 2: PostHog'])
  const copyBtn=val=>{const b=el('button',{className:'ghost',type:'button'},'Copy');b.onclick=async()=>{b.disabled=true;try{await navigator.clipboard.writeText(val);b.textContent='Copied';message('msg','Copied.')}catch{b.textContent='Select and copy';message('msg','Copy failed. Select the value and copy it.',true)}finally{b.disabled=false};setTimeout(()=>b.textContent='Copy',1500)};return b}
  const field=(box,label,val)=>{const r=el('div',{className:'f'});r.appendChild(el('span',null,label));r.appendChild(el('code',null,val));const copy=copyBtn(val);copy.setAttribute('aria-label','Copy '+label+' for '+box.querySelector('h3').textContent);r.appendChild(copy);box.appendChild(r)}
  const add=$('add');add.innerHTML='';add.className=''
  list.forEach(([n,u,title])=>{const s=el('div',{className:'srv'});s.appendChild(el('h3',null,title))
    field(s,'Name',n);field(s,'Transport','http');field(s,'URL',u);field(s,'Header name','Authorization');field(s,'Header value','Bearer '+t.token);add.appendChild(s)})
  $('make').textContent='Make a new key';message('msg','Key ready. Copy the fields below.');await load();add.tabIndex=-1;add.focus()}catch(e){message('msg',e.message+' Try connecting again.',true)}finally{$('make').disabled=false}}
load()
</script></body></html>`
}
