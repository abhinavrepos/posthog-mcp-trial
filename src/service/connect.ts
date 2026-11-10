// The Connect chat page: each person makes their own chat (MCP) token, so Lens knows who asks in chat
// and applies their survey role there. The token is shown once; only its hash is kept. People see and
// revoke their own tokens here; admins see and revoke everyone's on the admin page.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { can, canSurvey, createMcpToken, listMcpTokens, revokeMcpToken, SURVEY_ROLE_TEXT, type Viewer } from './access.ts'
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
            return (json(res, 200, { ...t, url: `${config.service.publicUrl}/mcp`, posthog_url: `${config.service.publicUrl}/posthog-mcp`, name: config.mcp.name }), true)
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
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect chat · ${APP_NAME}</title><style>${PAGE_CSS()}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chip);padding:10px 12px;border-radius:8px;font-size:13px}.once{border-left:4px solid var(--accent);padding:8px 12px;background:var(--chip);border-radius:6px}
table{width:100%;table-layout:fixed}td,th{overflow-wrap:anywhere}</style></head>
<body>${headerHtml(v, 'Connect chat')}<main style="max-width:820px">
<div class="card"><h2>Connect chat to ${APP_NAME}</h2>
<p>Chat (Claude, Copilot or another MCP client) uses ${APP_NAME}'s tools with a token. With your own token, ${APP_NAME} knows it is you and gives you your access. Your survey role: <b>${role}</b>.</p>
<div class="toolbar" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><div style="flex:1;min-width:200px"><label for="label">Name it (where you use it)</label><input id="label" placeholder="e.g. Claude on my laptop" maxlength="60"></div><div><button id="make">Make a token</button></div></div>
<p id="msg" class="small"></p><div id="fresh"></div></div>
<div class="card"><h2>Your tokens</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
<p class="small muted">Revoke a token you no longer use, or if someone else may have seen it. An admin can revoke any token.</p></div>
</main>
<script>
const $=id=>document.getElementById(id)
const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b})
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'never'
function cell(tr,t){const td=document.createElement('td');if(t instanceof Node)td.appendChild(t);else td.textContent=t;tr.appendChild(td)}
async function load(){const d=await api('/replays/connect/api/tokens');const tb=$('rows');tb.innerHTML='';if(!d.tokens.length)tb.innerHTML='<tr><td colspan="4" class="muted">No tokens yet.</td></tr>'
  d.tokens.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.label);cell(tr,when(t.created_at));cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at):when(t.last_used_at))
    if(!t.revoked_at){const b=document.createElement('button');b.className='ghost';b.textContent='Revoke';b.onclick=async()=>{if(!confirm('Revoke "'+t.label+'"? Chat with it stops at once.'))return;await api('/replays/connect/api/tokens/'+t.id,{method:'DELETE'});load()};cell(tr,b)}else cell(tr,'');tb.appendChild(tr)})}
$('make').onclick=async()=>{try{const t=await api('/replays/connect/api/tokens',{method:'POST',body:JSON.stringify({label:$('label').value})})
  const cfg={mcpServers:{[t.name]:{type:'http',url:t.url,headers:{Authorization:'Bearer '+t.token}}}}
  const box=$('fresh');box.innerHTML='<div class="once"><b>Copy it now: it is shown only once.</b><pre></pre><p class="small">Claude Code:</p><pre></pre><p class="small">Or add this to your client\\'s MCP settings (.mcp.json):</p><pre></pre></div>'
  const pres=box.querySelectorAll('pre');pres[0].textContent=t.token;pres[1].textContent='claude mcp add --transport http '+t.name+' '+t.url+' --header "Authorization: Bearer '+t.token+'"';pres[2].textContent=JSON.stringify(cfg,null,2)
  $('label').value='';$('msg').textContent='';load()}catch(e){$('msg').textContent=e.message;$('msg').className='small err'}}
load().catch(e=>{$('rows').innerHTML='<tr><td colspan="4" class="err"></td></tr>';$('rows').querySelector('td').textContent=e.message})
</script></body></html>`
}
