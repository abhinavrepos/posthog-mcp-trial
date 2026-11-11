// The Connect chat page: each person makes their own chat (MCP) token, so Lens knows who asks in chat
// and applies their survey role there. The token is shown once; only its hash is kept. People see and
// revoke their own tokens here; admins see and revoke everyone's on the admin page.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config, posthogMcpActive } from '../core/config.ts'
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
            return (json(res, 200, { ...t, url: `${config.service.publicUrl}/mcp`, posthog_url: posthogOn() ? `${config.service.publicUrl}/posthog-mcp` : null, name: config.mcp.name }), true)
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
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--chip);padding:10px 12px;border-radius:8px;font-size:13px}.once{border-left:4px solid var(--accent);padding:8px 12px;background:var(--chip);border-radius:6px}
table{width:100%;table-layout:fixed}td,th{overflow-wrap:anywhere}ol.steps{padding-left:20px}ol.steps li{margin:10px 0}
a.btn{display:inline-block;padding:8px 14px;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600;margin:4px 8px 4px 0}
details{margin-top:12px}summary{cursor:pointer;font-weight:600}</style></head>
<body>${headerHtml(v, 'Chat')}<main style="max-width:820px">
<div class="card"><h2>Connect GitHub Copilot</h2>
<p>Ask ${APP_NAME}${ph ? ' and PostHog' : ''} questions in Copilot Chat in VS Code, e.g. <i>"Which clients need attention this month?"</i>. It takes a minute and you do it once. Copilot then has your access: survey role <b>${role}</b>.</p>
<ol class="steps">
<li><b>Make your key.</b> <button id="make">Connect Copilot</button> <span id="msg" class="small"></span></li>
<li><b>Add to VS Code.</b> <span id="addHint" class="muted">The buttons appear after step 1.</span><div id="add"></div></li>
<li><b>Use it.</b> In VS Code open Copilot Chat, pick <b>Agent</b> mode, and ask. The first time, Copilot asks to allow the tools: allow them.</li>
</ol>
<div id="fresh"></div>
<p class="small muted">Nothing happens when you click a button? Use "Set it up by hand" above. Copilot shows no tools at all? Your company's Copilot admin must allow MCP servers (the "MCP servers in Copilot" policy).</p>
</div>
<div class="card"><h2>Your keys</h2><div class="table-wrap"><table><thead><tr><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div>
<p class="small muted">Revoke a key you no longer use, or if someone else may have seen it; then connect again. An admin can revoke any key.</p></div>
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
// VS Code's install link: it opens VS Code, which asks the person to install the server.
const install=(name,url,token)=>'vscode:mcp/install?'+encodeURIComponent(JSON.stringify({name,type:'http',url,headers:{Authorization:'Bearer '+token}}))
$('make').onclick=async()=>{try{const t=await api('/replays/connect/api/tokens',{method:'POST',body:JSON.stringify({label:'GitHub Copilot'})})
  const list=[[t.name,t.url,'1. Add Lens to VS Code']];if(t.posthog_url)list.push(['posthog',t.posthog_url,'2. Add PostHog to VS Code'])
  const add=$('add');add.innerHTML='';$('addHint').textContent='Click '+(list.length>1?'both, one at a time':'it')+'. VS Code opens: click Install.'
  list.forEach(([n,u,label])=>add.appendChild(el('a',{className:'btn',href:install(n,u,t.token)},label)))
  // By hand: user MCP settings, with the key kept in VS Code's secret storage (it asks once).
  const servers={};list.forEach(([n,u])=>servers[n]={type:'http',url:u,headers:{Authorization:'Bearer \${input:lens-key}'}})
  const cfg={inputs:[{type:'promptString',id:'lens-key',description:'Your ${APP_NAME} key',password:true}],servers}
  const claude=list.map(([n,u])=>'claude mcp add --transport http '+n+' '+u+' --header "Authorization: Bearer '+t.token+'"').join('\\n')
  const box=$('fresh');box.innerHTML=''
  const once=el('div',{className:'once'});once.appendChild(el('b',null,'Your key. It is shown only once; the buttons above already contain it.'));once.appendChild(el('pre',null,t.token))
  const d1=el('details');d1.appendChild(el('summary',null,'Set it up by hand (VS Code, Visual Studio, JetBrains)'))
  d1.appendChild(el('p',{className:'small'},'In VS Code: Command Palette → "MCP: Open User Configuration", paste this, save, and paste the key above when asked.'))
  d1.appendChild(el('pre',null,JSON.stringify(cfg,null,2)))
  const d2=el('details');d2.appendChild(el('summary',null,'Other chat apps (Claude Code)'));d2.appendChild(el('pre',null,claude))
  once.appendChild(d1);once.appendChild(d2);box.appendChild(once)
  $('make').textContent='Make a new key';$('msg').textContent='';load()}catch(e){$('msg').textContent=e.message;$('msg').className='small err'}}
load().catch(e=>{$('rows').innerHTML='<tr><td colspan="4" class="err"></td></tr>';$('rows').querySelector('td').textContent=e.message})
</script></body></html>`
}
