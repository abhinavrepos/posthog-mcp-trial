// Admin page for replay clip access: who can watch, who can download, the default for everyone
// else, share links, clips and the activity log. Only admins reach it: PostHog owners and admins
// of the organization that owns the project, plus anyone given the admin role here.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { asViewer, audit, can, lastSeen, loadAccess, readAudit, removePerson, ROLE_TEXT, ROLES, roleOf, setAccessSettings, setPerson, setSurveyRole, resetSurveyRole, setSurveySettings, SURVEY_ROLES, SURVEY_ROLE_TEXT, defaultSurveyRole, sharedTokenSurveyRole, surveyRoleOf, listMcpTokens, revokeMcpToken, type SurveyRole, setSystemAccess, surveyPeople, systemViewers, type Role, type Viewer } from './access.ts'
import { APP_NAME, deleteClip, headerHtml, listClips, PAGE_CSS, setSaved, storage } from './replays.ts'

interface Member {
    email: string
    name: string
    level: number
    org: string
    org_id: string
}

async function posthogMembers(v: Viewer): Promise<Member[]> {
    const me = await asViewer<{ organizations?: { id: string; name: string }[] }>(v, '/api/users/@me/')
    const out: Member[] = []
    for (const org of me?.organizations || []) {
        const res = await asViewer<{ results?: { level: number; user: { email: string; first_name?: string } }[] }>(v, `/api/organizations/${org.id}/members/?limit=500`)
        for (const m of res?.results || []) out.push({ email: m.user.email.toLowerCase(), name: m.user.first_name || '', level: m.level, org: org.name, org_id: org.id })
    }
    return out
}

let projectOrgId: string | undefined
async function replayOrg(): Promise<string | undefined> {
    if (projectOrgId) return projectOrgId
    const res = await fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/`, { headers: { authorization: `Bearer ${config.posthog.personalApiKey}` } })
    if (res.ok) projectOrgId = ((await res.json()) as { organization?: string }).organization
    return projectOrgId
}

function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let data = ''
    for await (const c of req) {
        data += c
        if (data.length > 20_000) throw new Error('body too large')
    }
    return JSON.parse(data || '{}')
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer): Promise<boolean> {
    const p = url.pathname
    if (!can(v.role, 'admin')) {
        if (p === '/replays/admin' || p === '/replays/admin/') {
            res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
            res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin</title><style>${PAGE_CSS()}</style></head><body>${headerHtml(v, 'Admin')}<main><div class="card"><h2>Admins only</h2><p>Ask a PostHog owner or admin for access.</p></div></main></body></html>`)
        } else json(res, 403, { error: 'Admins only.' })
        return true
    }

    if (p === '/replays/admin' || p === '/replays/admin/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(adminHtml(v))
        return true
    }

    if (p === '/replays/admin/api/state' && req.method === 'GET') {
        const access = loadAccess()
        const [members, org] = await Promise.all([posthogMembers(v), replayOrg()])
        const seen = lastSeen()
        const space = storage()
        const held = new Map(space.per_person.map((x) => [x.email, x]))
        const sys = systemViewers()
        const srv = surveyPeople()
        const emails = new Set([...members.map((m) => m.email), ...Object.keys(access.people), ...sys.keys(), ...srv.keys()])
        const people = [...emails].sort().map((email) => {
            const ms = members.filter((m) => m.email === email)
            const inProject = ms.find((m) => m.org_id === org)
            const posthogAdmin = !!inProject && inProject.level >= 8
            const role = roleOf(email, posthogAdmin, access)
            return {
                // Admins always see the System page; for anyone else it is the tick on this page.
                system: can(role, 'admin') || sys.has(email),
                system_granted: sys.has(email),
                survey_role: surveyRoleOf(email, role),
                survey_role_set_here: srv.get(email)?.role ?? null,
                email,
                name: ms[0]?.name || '',
                posthog: ms.length ? ms.map((m) => `${m.org} (${m.level >= 15 ? 'owner' : m.level >= 8 ? 'admin' : 'member'})`).join(', ') : 'No PostHog account in your organizations',
                sees_all_replays_in_posthog: !!inProject,
                locked: posthogAdmin,
                role,
                set_here: access.people[email]?.role,
                note: access.people[email]?.note || '',
                last_seen: seen.get(email),
                clips: held.get(email) || { clips: 0, saved: 0, bytes: 0 },
            }
        })
        json(res, 200, {
            me: v.email,
            default_role: access.default_role,
            allow_share_links: access.allow_share_links,
            survey_roles: SURVEY_ROLES.map((r) => ({ id: r, text: SURVEY_ROLE_TEXT[r] })),
            survey_default_role: defaultSurveyRole(),
            survey_shared_token_role: sharedTokenSurveyRole(),
            chat_tokens: listMcpTokens(),
            roles: ROLES.map((r) => ({ id: r, text: ROLE_TEXT[r] })),
            people,
            clips: listClips({ limit: 300 }),
            storage: space,
            audit: readAudit(100),
        })
        return true
    }

    if (p === '/replays/admin/api/person' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        const role = String(body.role || '') as Role
        if (!EMAIL.test(email) || !ROLES.includes(role)) return (json(res, 400, { error: 'Give an email and a role.' }), true)
        if (email === v.email && !can(role, 'admin') && !v.posthog_admin) return (json(res, 400, { error: 'You cannot remove your own admin role.' }), true)
        setPerson(email, role, v.email, String(body.note || '').slice(0, 200) || undefined)
        if (typeof body.system === 'boolean') setSystemAccess(email, body.system, v.email)
        if (typeof body.survey_role === 'string' && body.survey_role) setSurveyRole(email, body.survey_role as SurveyRole, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    // A person's survey role (separate from the clip role); "default" removes it so the default applies.
    if (p === '/replays/admin/api/survey-role' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        const role = String(body.role || '')
        if (!EMAIL.test(email) || !(role === 'default' || SURVEY_ROLES.includes(role as SurveyRole))) return (json(res, 400, { error: 'Give an email and a survey role.' }), true)
        if (role === 'default') resetSurveyRole(email, v.email)
        else setSurveyRole(email, role as SurveyRole, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    // Revoke anyone's chat token.
    const tok = /^\/replays\/admin\/api\/chat-tokens\/([0-9a-f]{12})$/.exec(p)
    if (tok && req.method === 'DELETE') return (json(res, revokeMcpToken(tok[1], v.email) ? 200 : 404, { ok: true }), true)

    if (p === '/replays/admin/api/person' && req.method === 'DELETE') {
        const email = String(url.searchParams.get('email') || '').toLowerCase()
        if (email === v.email && !v.posthog_admin) return (json(res, 400, { error: 'You cannot remove yourself.' }), true)
        removePerson(email, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    if (p === '/replays/admin/api/settings' && req.method === 'POST') {
        const body = await readJson(req)
        const change: { default_role?: Role; allow_share_links?: boolean } = {}
        if (body.default_role !== undefined) {
            const r = String(body.default_role) as Role
            if (!ROLES.includes(r) || r === 'admin') return (json(res, 400, { error: 'The default cannot be admin.' }), true)
            change.default_role = r
        }
        if (body.allow_share_links !== undefined) change.allow_share_links = !!body.allow_share_links
        if (body.survey_default_role !== undefined || body.survey_shared_token_role !== undefined) {
            try {
                setSurveySettings({ default_role: body.survey_default_role as SurveyRole | undefined, shared_token_role: body.survey_shared_token_role as SurveyRole | undefined }, v.email)
            } catch (e) {
                return (json(res, 400, { error: (e as Error).message }), true)
            }
        }
        setAccessSettings(change, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    if (p === '/replays/admin/api/audit' && req.method === 'GET') {
        return (json(res, 200, { audit: readAudit({ q: url.searchParams.get('q') || undefined, limit: 300 }) }), true)
    }

    // An admin can unsave a clip for someone, so it falls back to the two-week rule.
    const u = /^\/replays\/admin\/api\/clips\/([^/]+)\/unsave$/.exec(p)
    if (u && req.method === 'POST') {
        const body = await readJson(req)
        const name = decodeURIComponent(u[1])
        const email = String(body.email || '').toLowerCase()
        const ok = !!setSaved(name, email, false)
        if (ok) audit(v.email, 'clip.unsaved', { clip: name, for: email })
        return (json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No such clip.' }), true)
    }

    const m = /^\/replays\/admin\/api\/clips\/([^/]+)$/.exec(p)
    if (m && req.method === 'DELETE') {
        const name = decodeURIComponent(m[1])
        const ok = deleteClip(name)
        if (ok) audit(v.email, 'clip.deleted', { clip: name })
        return (json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'No such clip.' }), true)
    }

    json(res, 404, { error: 'Not found.' })
    return true
}

function adminHtml(v: Viewer): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin · ${APP_NAME}</title><style>${PAGE_CSS()}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--chip);white-space:nowrap}.warn{background:#fef0c7;color:#7a2e0e}
td select{min-width:190px}label.check{display:inline-flex;gap:6px;align-items:center;font-weight:400;cursor:pointer}label.check input{width:auto;margin:0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.toolbar>div{flex:1;min-width:160px}details summary{cursor:pointer;font-weight:600}ul.tight{margin:6px 0;padding-left:20px}ul.tight li{margin:3px 0}</style></head>
<body>${headerHtml(v, 'Admin')}<main style="max-width:1100px">

<div class="card"><details><summary>How access works</summary>
<ul class="tight">
<li><b>Signing in is PostHog's job.</b> Everyone signs in with their PostHog account. Passwords, two-factor login and removing people all happen in PostHog. Removing someone from PostHog locks them out here within a minute.</li>
<li><b>What they may do is set here.</b> <i>Watch clips</i> lets a person make and watch clips on this site. <i>Watch, download and share</i> adds MP4 downloads and share links. <i>Admin</i> adds this page.</li>
<li><b>The System page</b> shows whether the server and every container are up, with machine, ClickHouse and Lens numbers. It never shows replay or event content. Admins always see it. Tick <i>System page</i> to let anyone else see it too, for example whoever looks after the server. It is separate from the role, so someone can see the System page with <i>No access</i> to clips.</li>
<li><b>Surveys</b> are made, launched and read only in Lens: PostHog's own survey screens and API are closed (they send people here). Each person has a survey role, separate from the clip role: <i>See surveys and results</i>, <i>Also make and change surveys</i>, or <i>Also launch and stop surveys</i> (what reaches Reval users). Admins always have the last. It applies on the Surveys page and in chat.</li>
<li><b>Chat</b> knows who is asking only with a personal token, which each person makes on the <i>Connect chat</i> page (you can revoke any token below). The shared team token says nothing about who asks, so it gets the survey role you choose in Settings.</li>
<li><b>PostHog owners and admins</b> of the organization that owns the project are always admins here, so nobody can be locked out.</li>
<li><b>Important:</b> on this PostHog plan, PostHog itself cannot limit replays per person. Anyone who is a member of the project's organization can watch every replay inside PostHog, whatever their role here. Those people are marked <span class="badge warn">sees all replays in PostHog</span>. To keep someone to clips only, give them a PostHog account in a separate organization (for example "Clip viewers") with no access to this project, then give them a role here.</li>
<li><b>Storage.</b> A clip is stored once, however many people make the same part of the same recording. A clip nobody saved is deleted two weeks after it was last asked for. Saved clips stay until whoever saved them unsaves them, or you delete them here.</li>
<li>Clips attached to Jira tickets follow Jira's permissions. Share links work for anyone who has them until they expire, so turn them off below if you need tighter control.</li></ul></details></div>

<div class="card"><h2>People</h2>
<div class="toolbar"><div><label for="new-email">Add a person (their PostHog email)</label><input id="new-email" type="email" placeholder="name@company.com"></div>
<div><label for="new-role">Role</label><select id="new-role"></select></div><div style="flex:0;white-space:nowrap"><label class="check"><input id="new-system" type="checkbox"> System page</label></div><div style="flex:0"><label for="new-surveys">Surveys</label><select id="new-surveys"></select></div><div style="flex:0"><button id="add">Add</button></div></div>
<p id="people-msg" class="small"></p>
<div class="table-wrap"><table><thead><tr><th>Person</th><th>In PostHog</th><th>Role here</th><th>System page</th><th>Surveys role</th><th>Clips</th><th>Last activity</th><th></th></tr></thead><tbody id="people"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody></table></div></div>

<div class="card"><h2>Settings</h2>
<div class="toolbar"><div><label for="default-role">Role for other PostHog users</label><select id="default-role"></select></div>
<div><label for="share">Share links</label><select id="share"><option value="1">Allowed (for people who can download)</option><option value="0">Turned off</option></select></div>
<div><label for="survey-default">Survey role for other PostHog users</label><select id="survey-default"></select></div>
<div><label for="survey-shared">Survey role for chat with the shared team token</label><select id="survey-shared"></select></div></div>
<p class="small muted">The defaults apply to anyone who signs in with a PostHog account and is not listed above. "No access" is the safe choice. The shared team token cannot tell who asks: give it at most "See surveys and results", and give people personal tokens for more.</p><p id="settings-msg" class="small"></p></div>

<div class="card"><h2>Chat tokens</h2><p class="small muted">Personal tokens people made on the Connect chat page. A revoked token stops working at once.</p>
<div class="table-wrap"><table><thead><tr><th>Person</th><th>Name</th><th>Made</th><th>Last used</th><th></th></tr></thead><tbody id="tokens"></tbody></table></div></div>

<div class="card"><h2>Clips</h2><p class="small muted" id="space"></p>
<div class="toolbar"><div><label for="clip-filter">Show</label><select id="clip-filter"><option value="">All clips</option><option value="saved">Saved only</option><option value="expiring">Deleted within 3 days</option></select></div></div>
<div class="table-wrap"><table><thead><tr><th>Clip</th><th>Who has it</th><th>Size</th><th>Kept until</th><th></th></tr></thead><tbody id="clips"></tbody></table></div></div>

<div class="card"><h2>Activity</h2><p class="small muted">Kept for a year. The search covers all of it.</p><div class="toolbar"><div><label for="filter">Search</label><input id="filter" placeholder="Person, action or clip"></div></div>
<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody id="audit"></tbody></table></div></div>
</main>
<script>
const $=id=>document.getElementById(id);const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'never';
const day=t=>new Date(t).toLocaleDateString([], {dateStyle:'medium'});
const mb=b=>!b?'0 KB':b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
const n=(k,w)=>k+' '+w+(k===1?'':'s');
const clock=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const short=e=>(e||'').replace(/@.*/,'');
const cell=(tr,t,cls)=>{const td=document.createElement('td');if(t instanceof Node)td.appendChild(t);else td.textContent=t??'';if(cls)td.className=cls;tr.appendChild(td);return td};
const msg=(id,t,ok)=>{$(id).textContent=t;$(id).className='small '+(ok?'ok':'err')};
const ACTIONS={'signin':'Signed in','signout':'Signed out','signin.failed':'Failed sign in','recording.inspected':'Looked up a recording','clip.requested':'Asked for a clip','clip.created':'Clip made','clip.viewed':'Watched a clip','clip.downloaded':'Downloaded a clip','clip.link_shared':'Created a share link','clip.deleted':'Deleted a clip','clip.saved':'Saved a clip','clip.unsaved':'Unsaved a clip','clip.comment_added':'Commented on a clip','clip.comment_edited':'Edited a clip comment','clip.comment_deleted':'Deleted a clip comment','clips.pruned':'Old clips deleted','access.role_set':'Changed a role','access.role_removed':'Removed a role','access.settings':'Changed settings','access.system_set':'Changed System page access','access.surveys_set':'Changed Surveys page access','access.survey_role_set':'Changed a survey role','access.survey_role_reset':'Reset a survey role','access.survey_settings':'Changed survey settings','chat.token_created':'Made a chat token','chat.token_revoked':'Revoked a chat token','survey.created':'Made a survey','survey.changed':'Changed a survey','survey.launched':'Launched a survey','survey.stopped':'Stopped a survey','survey.archived':'Archived a survey'};
let S=null;
function roleSelect(value,disabled){const s=document.createElement('select');S.roles.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===value)o.selected=true;s.appendChild(o)});s.disabled=!!disabled;return s}
async function load(){S=await api('/replays/admin/api/state');
 $('new-role').innerHTML='';S.roles.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id==='watch')o.selected=true;$('new-role').appendChild(o)});
 $('default-role').innerHTML='';S.roles.filter(r=>r.id!=='admin').forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===S.default_role)o.selected=true;$('default-role').appendChild(o)});
 $('share').value=S.allow_share_links?'1':'0';
 const opts=(sel,list,value)=>{sel.innerHTML='';list.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===value)o.selected=true;sel.appendChild(o)})};
 opts($('survey-default'),S.survey_roles.filter(r=>r.id!=='launch'),S.survey_default_role);opts($('survey-shared'),S.survey_roles,S.survey_shared_token_role);opts($('new-surveys'),[{id:'default',text:'Default'}].concat(S.survey_roles),'default');
 const tt=$('tokens');tt.innerHTML='';if(!S.chat_tokens.length)tt.innerHTML='<tr><td colspan="5" class="muted">No personal tokens yet.</td></tr>';
 S.chat_tokens.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.email);cell(tr,t.label);cell(tr,when(t.created_at),'small');cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at)+' by '+t.revoked_by:when(t.last_used_at),'small');
  if(!t.revoked_at){const b=document.createElement('button');b.className='ghost';b.textContent='Revoke';b.onclick=async()=>{if(!confirm('Revoke the chat token '+t.label+' of '+t.email+'? Chat with it stops at once.'))return;try{await api('/replays/admin/api/chat-tokens/'+t.id,{method:'DELETE'});load()}catch(e){alert(e.message)}};cell(tr,b)}else cell(tr,'');tt.appendChild(tr)});
 const tb=$('people');tb.innerHTML='';
 S.people.forEach(p=>{const tr=document.createElement('tr');
  const who=document.createElement('div');who.innerHTML='<b></b><div class="small muted"></div>';who.querySelector('b').textContent=p.email+(p.email===S.me?' (you)':'');who.querySelector('div').textContent=[p.name,p.note].filter(Boolean).join(' · ');cell(tr,who);
  const ph=document.createElement('div');ph.textContent=p.posthog;if(p.sees_all_replays_in_posthog){const b=document.createElement('div');b.innerHTML='<span class="badge warn">sees all replays in PostHog</span>';ph.appendChild(b)}cell(tr,ph,'small');
  const sel=roleSelect(p.role,p.locked);if(p.locked){const w=document.createElement('div');w.appendChild(sel);const n=document.createElement('div');n.className='small muted';n.textContent='PostHog owner or admin';w.appendChild(n);cell(tr,w)}else{if(!p.set_here){const w=document.createElement('div');w.appendChild(sel);const n=document.createElement('div');n.className='small muted';n.textContent='Default';w.appendChild(n);cell(tr,w)}else cell(tr,sel)}
  sel.onchange=async()=>{try{await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email:p.email,role:sel.value})});msg('people-msg','Saved: '+p.email+' now has "'+sel.selectedOptions[0].textContent+'".',true);load()}catch(e){msg('people-msg',e.message);load()}};
  const sw=document.createElement('label');sw.className='check small';const cb=document.createElement('input');cb.type='checkbox';cb.checked=!!p.system;sw.append(cb,document.createTextNode(p.role==='admin'?' Always (admin)':' Can see it'));
  if(p.role==='admin'){cb.disabled=true;sw.title='Admins always see the System page'}
  cb.onchange=async()=>{try{await api('/replays/admin/api/system',{method:'POST',body:JSON.stringify({email:p.email,on:cb.checked})});msg('people-msg',(cb.checked?'Saved: '+p.email+' can now see the System page.':'Saved: '+p.email+' can no longer see the System page.'),true);load()}catch(e){msg('people-msg',e.message);load()}};
  cell(tr,sw);
  const ss=document.createElement('select');[{id:'default',text:'Default'}].concat(S.survey_roles).forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?'Default ('+(S.survey_roles.find(x=>x.id===S.survey_default_role)||{}).text+')':r.text;ss.appendChild(o)});
  ss.value=p.role==='admin'?'launch':(p.survey_role_set_here||'default');if(p.role==='admin'){ss.disabled=true;ss.title='Admins can always launch and stop surveys'}
  ss.onchange=async()=>{try{await api('/replays/admin/api/survey-role',{method:'POST',body:JSON.stringify({email:p.email,role:ss.value})});msg('people-msg','Saved: '+p.email+' survey role is now "'+ss.selectedOptions[0].textContent+'".',true);load()}catch(e){msg('people-msg',e.message);load()}};
  cell(tr,ss);
  cell(tr,p.clips.clips?n(p.clips.clips,'clip')+', '+p.clips.saved+' saved · '+mb(p.clips.bytes):'none','small');
  cell(tr,when(p.last_seen),'small');
  if(p.set_here&&!p.locked){const b=document.createElement('button');b.className='ghost';b.textContent='Reset';b.title='Remove the role set here, so the default applies';b.onclick=async()=>{try{await api('/replays/admin/api/person?email='+encodeURIComponent(p.email),{method:'DELETE'});msg('people-msg','Removed the role for '+p.email+'.',true);load()}catch(e){msg('people-msg',e.message)}};cell(tr,b)}else cell(tr,'');
  tb.appendChild(tr)});
 const st=S.storage;$('space').textContent=n(st.clips,'clip')+' using '+mb(st.bytes)+' on the server. Saved: '+st.saved+' ('+mb(st.saved_bytes)+'). The rest are deleted two weeks after they were last asked for.';
 renderClips();
 renderAudit()}
function renderClips(){const f=$('clip-filter').value;const soon=Date.now()+3*86400000;const cb=$('clips');cb.innerHTML='';
 const list=S.clips.filter(c=>!f||(f==='saved'?c.saved_by.length:c.expires_at&&Date.parse(c.expires_at)<soon));
 if(!list.length)cb.innerHTML='<tr><td colspan="5" class="muted">No clips.</td></tr>';
 list.forEach(c=>{const tr=document.createElement('tr');
  const what=document.createElement('div');what.innerHTML='<b></b><div class="small muted"></div>';what.querySelector('b').textContent=(c.client||'Unknown client')+' · '+clock(c.start_s)+'–'+clock(c.end_s);what.querySelector('div').textContent=[short(c.user),'made '+day(c.created_at)].filter(Boolean).join(' · ');cell(tr,what);
  const who=document.createElement('div');c.holders.forEach(e=>{const line=document.createElement('div');line.className='small';const saved=c.saved_by.includes(e);line.textContent=(saved?'★ ':'')+e+(saved?' (saved)':'');
   if(saved){const x=document.createElement('button');x.className='ghost small';x.style.padding='0 6px';x.style.marginLeft='6px';x.textContent='Unsave';x.title='The clip then gets deleted two weeks from now, unless someone else saved it';x.onclick=async()=>{try{await api('/replays/admin/api/clips/'+encodeURIComponent(c.name)+'/unsave',{method:'POST',body:JSON.stringify({email:e})});load()}catch(err){alert(err.message)}};line.appendChild(x)}
   who.appendChild(line)});cell(tr,who);
  cell(tr,mb(c.bytes),'small');
  cell(tr,c.expires_at?day(c.expires_at):'Saved',c.expires_at?'small':'small ok');
  const w=document.createElement('a');w.className='btn ghost';w.textContent='Watch';w.href='/replays?clip='+encodeURIComponent(c.name);const d=document.createElement('button');d.className='ghost';d.textContent='Delete';d.onclick=async()=>{if(!confirm('Delete this clip for everyone who has it? Its share links stop working.'))return;try{await api('/replays/admin/api/clips/'+encodeURIComponent(c.name),{method:'DELETE'});load()}catch(e){alert(e.message)}};
  const box=document.createElement('div');box.style.display='flex';box.style.gap='6px';box.append(w,d);cell(tr,box);cb.appendChild(tr)})}
$('clip-filter').onchange=renderClips;
function renderAudit(){const tb=$('audit');tb.innerHTML='';
 if(!S.audit.length)tb.innerHTML='<tr><td colspan="4" class="muted">Nothing found.</td></tr>';
 S.audit.forEach(e=>{const tr=document.createElement('tr');cell(tr,when(e.t),'small');cell(tr,e.who);cell(tr,ACTIONS[e.action]||e.action);const {t,who,action,...rest}=e;cell(tr,Object.entries(rest).map(([k,v])=>k+': '+(typeof v==='object'?JSON.stringify(v):v)).join(' · '),'small muted');tb.appendChild(tr)})}
let searchTimer;$('filter').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{const q=$('filter').value.trim();try{S.audit=(await api('/replays/admin/api/audit'+(q?'?q='+encodeURIComponent(q):''))).audit;renderAudit()}catch(e){}},250)};
$('add').onclick=async()=>{const email=$('new-email').value.trim();if(!email)return;try{await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email,role:$('new-role').value,system:$('new-system').checked,survey_role:$('new-surveys').value==='default'?'':$('new-surveys').value})});$('new-email').value='';$('new-system').checked=false;$('new-surveys').value='default';msg('people-msg','Added '+email+'.',true);load()}catch(e){msg('people-msg',e.message)}};
$('default-role').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({default_role:$('default-role').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('share').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({allow_share_links:$('share').value==='1'})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('survey-default').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_default_role:$('survey-default').value})});msg('settings-msg','Saved.',true);load()}catch(e){msg('settings-msg',e.message)}};
$('survey-shared').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_shared_token_role:$('survey-shared').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
load().catch(e=>{$('people').innerHTML='<tr><td colspan="8" class="err"></td></tr>';$('people').querySelector('td').textContent=e.message});
</script></body></html>`
}
