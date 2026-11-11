// The Connect chat page: each person makes their own chat (MCP) token, so Lens knows who asks in chat
// and applies their survey role there. The token is shown once; only its hash is kept. People see and
// revoke their own tokens here; admins see and revoke everyone's on the admin page.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, posthogMcpActive } from '../core/config.ts'
import { can, canSurvey, chatUrl, createMcpToken, listMcpTokens, revokeMcpToken, SURVEY_ROLE_TEXT, type Viewer } from './access.ts'
import { APP_NAME, headerHtml, PAGE_CSS } from './replays.ts'

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
@media (max-width:560px){.f{grid-template-columns:1fr auto}.f span{grid-column:1/-1}}</style></head>
<body>${headerHtml(v, 'Chat')}<main style="max-width:820px">
<div class="card"><h2>Connect GitHub Copilot</h2>
<ol class="steps">
<li><button id="make">Connect Copilot</button> <span id="msg" class="small"></span></li>
<li>In the Copilot app: cog → <b>MCP Servers</b> → <b>Add Server</b> → <b>+ Add Custom server</b>. Copy in the fields below${ph ? ', once per server' : ''}.<div id="add"></div></li>
<li>Start a new chat and ask, e.g. <i>"Which clients need attention this month?"</i></li>
</ol>
<p class="small muted">Copilot gets your access (survey role: ${role}). The key is shown once.</p>
</div>
<div class="card"><h2>Your keys</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
<p class="small muted">Revoke a key you no longer use.</p></div>
</main>
<script>
const $=id=>document.getElementById(id)
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'never'
function cell(tr,t){const td=document.createElement('td');if(t instanceof Node)td.appendChild(t);else td.textContent=t;tr.appendChild(td)}
function el(tag,attrs,text){const e=document.createElement(tag);Object.assign(e,attrs||{});if(text)e.textContent=text;return e}
async function load(){const d=await api('/replays/connect/api/tokens');const tb=$('rows');tb.innerHTML='';if(!d.tokens.length)tb.innerHTML='<tr><td colspan="4" class="muted">No keys yet.</td></tr>'
  d.tokens.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.label);cell(tr,when(t.created_at));cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at):when(t.last_used_at))
    if(!t.revoked_at){const b=document.createElement('button');b.className='ghost';b.textContent='Revoke';b.onclick=async()=>{if(!confirm('Revoke "'+t.label+'"? Chat with it stops at once.'))return;await api('/replays/connect/api/tokens/'+t.id,{method:'DELETE'});load()};cell(tr,b)}else cell(tr,'');tb.appendChild(tr)})}
$('make').onclick=async()=>{try{const t=await api('/replays/connect/api/tokens',{method:'POST',body:JSON.stringify({label:'GitHub Copilot'})})
  const list=[[t.name,t.url,'Server 1: ${APP_NAME}']];if(t.posthog_url)list.push(['posthog',t.posthog_url,'Server 2: PostHog'])
  const copyBtn=val=>{const b=el('button',{className:'ghost'},'Copy');b.onclick=async()=>{try{await navigator.clipboard.writeText(val);b.textContent='Copied'}catch{b.textContent='Select and copy'};setTimeout(()=>b.textContent='Copy',1500)};return b}
  const field=(box,label,val)=>{const r=el('div',{className:'f'});r.appendChild(el('span',null,label));r.appendChild(el('code',null,val));r.appendChild(copyBtn(val));box.appendChild(r)}
  const add=$('add');add.innerHTML='';add.className=''
  list.forEach(([n,u,title])=>{const s=el('div',{className:'srv'});s.appendChild(el('h3',null,title))
    field(s,'Name',n);field(s,'Transport','http');field(s,'URL',u);field(s,'Header name','Authorization');field(s,'Header value','Bearer '+t.token);add.appendChild(s)})
  $('make').textContent='Make a new key';$('msg').textContent='';load()}catch(e){$('msg').textContent=e.message;$('msg').className='small err'}}
load().catch(e=>{$('rows').innerHTML='<tr><td colspan="4" class="err"></td></tr>';$('rows').querySelector('td').textContent=e.message})
</script></body></html>`
}
