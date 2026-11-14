// The Connect chat page: each person makes their own chat (MCP) token, so Lens knows who asks in chat
// and applies their survey role there. The token is shown once; only its hash is kept. People see and
// revoke their own tokens here; admins see and revoke everyone's on the admin page.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { anonymiseOn } from '../core/anonymise.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { can, canSurvey, canDashboard, chatPolicy, DEFAULT_CHAT_APPS, chatUrl, createMcpToken, listMcpTokens, revokeMcpToken, SURVEY_ROLE_TEXT, type Viewer } from './access.ts'
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

/** Anyone with some use of Lens: a clip, survey or dashboard role. */
export const canConnect = (v: Viewer) => can(v.role, 'watch') || canSurvey(v.surveys, 'view') || canDashboard(v.dashboards, 'view')

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

const esc = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
function connectHtml(v: Viewer): string {
    const policy = chatPolicy()
    const surveyRole = can(v.role, 'admin') ? 'launch' : v.surveys || 'none'
    // Launching is only on the Surveys page, never from chat (src/mcp/surveytools.ts).
    const role = surveyRole === 'launch' ? 'Also make, change and stop surveys (launching is only on the Surveys page)' : SURVEY_ROLE_TEXT[surveyRole]
    const ph = posthogOn()
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect chat · ${APP_NAME}</title><style>${PAGE_CSS()}
table{width:100%;table-layout:fixed}
td,th{overflow-wrap:anywhere}
.srv h3{margin:0 0 6px;font-size:15px}
.policy{border:1px solid var(--err);background:var(--err-bg);color:var(--err);border-radius:8px;padding:12px 16px;margin:0 0 16px}
.policy p{margin:0}
.policy ul{margin:4px 0;padding-left:20px}
.info{background:var(--hover);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:12px 16px;margin:0 0 16px}
.info p{margin:0}
main .card+.card{margin-top:24px}
main .ghost{border-color:transparent;color:var(--ink)}
ol.steps{margin:20px 0 0;padding-left:24px}
ol.steps li{margin:0;padding:0 0 20px 8px;line-height:20px}
ol.steps li:last-child{padding-bottom:0}
ol.steps li::marker{color:var(--muted);font-weight:600}
.srv{border:0;border-radius:0;padding:16px 0;margin:8px 0}
.srv+.srv{border-top:1px solid var(--line)}
.f{display:grid;align-items:center;padding:4px 0;grid-template-columns:100px minmax(0,1fr) auto;gap:12px}
.f code{padding:5px 8px;border-radius:6px;overflow-wrap:anywhere;font-size:13px;background:var(--hover)}
main td{padding-top:12px;padding-bottom:12px;vertical-align:middle}
main{min-width:0}
main h1{font-size:24px;line-height:32px;font-weight:650;margin:0}
main .page-head{margin-bottom:24px;align-items:center}
main .page-head p{margin:4px 0 0;font-size:14px;line-height:20px}
main h2{font-size:16px;line-height:24px;font-weight:600;margin:0 0 12px}
main h3{font-size:14px;line-height:20px;font-weight:600;margin:0 0 8px}
main input:not([type=checkbox]):not([type=radio]),main select{height:36px;min-height:36px;padding:7px 10px;font-size:13px;line-height:20px;max-width:100%;box-sizing:border-box}
main button,main .btn{min-height:36px;font-size:13px;line-height:20px;white-space:nowrap;word-break:normal;overflow-wrap:normal}
main th{word-break:normal;overflow-wrap:normal}
main .table-wrap{min-width:0;max-width:100%;overflow-x:auto}main .card>.table-wrap{max-width:none}
main .pager button{min-height:32px;padding:5px 10px;border:1px solid var(--line-strong);background:var(--card);color:var(--ink);font-weight:500}
main .pager select{height:32px;min-height:32px}
main .pager .pg>span{min-height:32px;display:inline-flex;align-items:center}
#people-msg:empty,#outcome-msg:empty,#audit-msg:empty,#keys-msg:empty,#msg:empty{display:none}
.tabs{overflow-x:auto;max-width:100%}
.tabs :is(button,a){white-space:nowrap;flex-shrink:0}
.tabs .tab-link,.tabs .tab-link0{color:var(--muted);text-decoration:none;font-weight:500;padding:8px 12px;border-bottom:2px solid transparent}
.tabs :is([aria-current],[aria-selected=true]){color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
#revoked-box{margin-top:16px}
#rows button.ghost{color:var(--err);font-weight:500}
main table th:last-child,#rows td:last-child{text-align:right}
@media (max-width:560px){.f{grid-template-columns:1fr auto}
.f span{grid-column:1/-1}
}
@media(max-width:560px){.f{grid-template-columns:minmax(0,1fr) auto;gap:6px}
.f span{grid-column:1/-1}
main th,main td{padding-left:3px;padding-right:3px;font-size:13px}
main td button{padding:6px 3px}
ol.steps li{padding-left:2px}
main h1{font-size:24px}
}
</style></head>
<body>${headerHtml(v, 'Chat')}<main class="narrow">
<div class="page-head"><h1>Connect GitHub Copilot</h1></div><div class="card">
<div class="policy" role="note" aria-labelledby="policy-title"><p id="policy-title"><b>Approved apps only.</b></p>${policy.apps.length === 1 && policy.apps[0] === DEFAULT_CHAT_APPS[0] ? '<p>Use GitHub Copilot with your ION Microsoft enterprise account.</p>' : `<p>Connect your key only to:</p><ul>${policy.apps.map(a => `<li>${esc(a)}</li>`).join('')}</ul>`}${policy.note ? `<p>${esc(policy.note)}</p>` : ''}</div>${anonymiseOn() ? '<div class="info" role="note"><p><b>Client names are hidden from AI.</b> Copilot sees each client\'s codename, never its name or code. Ask about a client by its codename, and do not type client names into chat. <a href="/replays/codenames">Look up codenames</a>.</p></div>' : ''}
<p class="small muted">Your key is shown once and inherits your Lens access.${canSurvey(surveyRole, 'edit') ? ' You can create, edit and stop surveys in Copilot; launch them from Surveys.' : role ? ` Survey access: ${esc(role)}.` : ''}</p>
<ol class="steps">
<li><div>Make your personal key</div><button type="button" id="make">Connect Copilot</button> <span id="msg" class="small" aria-live="polite"></span></li>
<li>Open Copilot settings.<div>MCP Servers → Add Server → + Add Custom server</div><div id="add"><span class="small muted">Create your key above to see the fields to copy${ph ? ", once per server" : ""}.</span></div></li>
<li>Start a new chat: <span>“Which clients need attention this month?”</span></li>
</ol>
</div>
<div class="card"><h2>Your keys</h2><div class="table-wrap"><table><colgroup><col style="width:24%"><col style="width:29%"><col style="width:29%"><col style="width:18%"></colgroup><thead><tr><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div><div id="keys-pager"></div><p id="keys-msg" class="small" aria-live="polite"></p>
<details id="revoked-box" hidden><summary class="small muted" id="revoked-sum"></summary><ul id="revoked" class="small muted"></ul></details>
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
const keysPg=makePager({mount:$('keys-pager'),noun:'keys',size:25,draw:slice=>{const tb=$('rows');tb.innerHTML='';if(!slice.length)tb.innerHTML='<tr><td colspan="4" class="muted">No active keys. Choose Connect Copilot to make one.</td></tr>'
  slice.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.label);cell(tr,when(t.created_at));cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at):when(t.last_used_at))
    if(!t.revoked_at){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent='Revoke';b.setAttribute('aria-label','Revoke '+t.label+' key made '+when(t.created_at));b.onclick=async()=>{if(!confirm('Revoke "'+t.label+'"? Chat with it stops at once.'))return;b.disabled=true;try{await api('/replays/connect/api/tokens/'+t.id,{method:'DELETE'});await load();message('keys-msg','Key revoked.')}catch(e){message('keys-msg',e.message+' Try revoking again.',true)}finally{b.disabled=false;if(!b.isConnected)($('keys-pager').querySelector('button:not(:disabled)')||$('make')).focus()}};cell(tr,b)}else cell(tr,'');tb.appendChild(tr)})}})
async function load(){try{const d=await api('/replays/connect/api/tokens');const gone=d.tokens.filter(t=>t.revoked_at);keysPg.set(d.tokens.filter(t=>!t.revoked_at),true);$('revoked-box').hidden=!gone.length;$('revoked-sum').textContent='Revoked keys ('+gone.length+')';$('revoked').innerHTML='';gone.slice(0,50).forEach(t=>$('revoked').appendChild(el('li',null,t.label+' · made '+when(t.created_at)+' · revoked '+when(t.revoked_at))))}catch(e){message('keys-msg',e.message+' Reload the page to try again.',true)}}
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
