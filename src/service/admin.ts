// Admin page for replay clip access: who can watch, who can download, the default for everyone
// else, share links, clips and the activity log. Only admins reach it: PostHog owners and admins
// of the organization that owns the project, plus anyone given the admin role here.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { config } from '../core/config.ts'
import { all } from '../core/db.ts'
import { asViewer, audit, can, lastSeen, loadAccess, readAudit, removePerson, ROLE_TEXT, ROLES, roleOf, setAccessSettings, setPerson, setSurveyRole, resetSurveyRole, setSurveySettings, SURVEY_ROLES, SURVEY_ROLE_TEXT, defaultSurveyRole, sharedTokenSurveyRole, surveyRoleOf, listMcpTokens, revokeMcpToken, chatUrl, setChatUrl, type SurveyRole, setSystemAccess, surveyPeople, systemViewers, type Role, type Viewer } from './access.ts'
import { dashboardPeople, dashboardRoleOf, setDashboardRole, resetDashboardRole, setDashboardSettings, defaultDashboardRole, sharedTokenDashboardRole, DASHBOARD_ROLES, DASHBOARD_ROLE_TEXT, type DashboardRole } from './access.ts'
import { APP_NAME, deleteClip, headerHtml, PAGER_JS, listClips, PAGE_CSS, setSaved, storage } from './replays.ts'

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
        const dash = dashboardPeople()
        const emails = new Set([...members.map((m) => m.email), ...Object.keys(access.people), ...sys.keys(), ...srv.keys(), ...dash.keys()])
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
                dashboard_role: dashboardRoleOf(email, role),
                dashboard_role_set_here: dash.get(email)?.role ?? null,
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
            dashboard_roles: DASHBOARD_ROLES.map((r) => ({ id: r, text: DASHBOARD_ROLE_TEXT[r] })),
            dashboard_default_role: defaultDashboardRole(),
            dashboard_shared_token_role: sharedTokenDashboardRole(),
            survey_shared_token_role: sharedTokenSurveyRole(),
            chat_tokens: listMcpTokens(),
            roles: ROLES.map((r) => ({ id: r, text: ROLE_TEXT[r] })),
            people,
            clips: listClips({ limit: -1 }),
            storage: space,
            audit: readAudit(300),
        })
        return true
    }

    if (p === '/replays/admin/api/person' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        const role = String(body.role || '') as Role
        if (!EMAIL.test(email) || !ROLES.includes(role)) return (json(res, 400, { error: 'Give an email and a role.' }), true)
        if (email === v.email && !can(role, 'admin') && !v.posthog_admin) return (json(res, 400, { error: 'You cannot remove your own admin role.' }), true)
        if (body.dashboard_role && !DASHBOARD_ROLES.includes(body.dashboard_role as DashboardRole)) return (json(res, 400, { error: 'Give a dashboard role.' }), true)
        setPerson(email, role, v.email, String(body.note || '').slice(0, 200) || undefined)
        if (typeof body.system === 'boolean') setSystemAccess(email, body.system, v.email)
        if (typeof body.dashboard_role === 'string' && body.dashboard_role) setDashboardRole(email, body.dashboard_role as DashboardRole, v.email)
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

    // A person's dashboard role (separate from the clip role); "default" removes it so the default applies.
    if (p === '/replays/admin/api/dashboard-role' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        const role = String(body.role || '')
        if (!EMAIL.test(email) || !(role === 'default' || DASHBOARD_ROLES.includes(role as DashboardRole))) return (json(res, 400, { error: 'Give an email and a dashboard role.' }), true)
        if (role === 'default') resetDashboardRole(email, v.email)
        else setDashboardRole(email, role as DashboardRole, v.email)
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
        if (body.chat_url !== undefined) {
            try {
                return (json(res, 200, { ok: true, chat_url: setChatUrl(body.chat_url, v.email) }), true)
            } catch (e) {
                return (json(res, 400, { error: (e as Error).message }), true)
            }
        }
        if (body.survey_default_role !== undefined || body.survey_shared_token_role !== undefined) {
            try {
                setSurveySettings({ default_role: body.survey_default_role as SurveyRole | undefined, shared_token_role: body.survey_shared_token_role as SurveyRole | undefined }, v.email)
            } catch (e) {
                return (json(res, 400, { error: (e as Error).message }), true)
            }
        }
        if (body.dashboard_default_role !== undefined || body.dashboard_shared_token_role !== undefined) {
            try {
                setDashboardSettings({ default_role: body.dashboard_default_role as DashboardRole | undefined, shared_token_role: body.dashboard_shared_token_role as DashboardRole | undefined }, v.email)
            } catch (e) {
                return (json(res, 400, { error: (e as Error).message }), true)
            }
        }
        setAccessSettings(change, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    if (p === '/replays/admin/api/audit' && req.method === 'GET') {
        const integer = (key: string, fallback: number) => {
            const n = Number(url.searchParams.get(key) ?? fallback)
            return Number.isSafeInteger(n) && n >= 0 ? n : fallback
        }
        const offset = integer('offset', 0), limit = Math.min(300, Math.max(1, integer('limit', 300)))
        const q = url.searchParams.get('q')?.trim().toLowerCase()
        const like = '%' + (q || '').replace(/[\\%_]/g, c => '\\' + c) + '%'
        const where = q ? "WHERE (LOWER(who) LIKE ? ESCAPE '\\' OR LOWER(action) LIKE ? ESCAPE '\\' OR LOWER(details) LIKE ? ESCAPE '\\')" : ''
        const rows = all<{ t: string; who: string; action: string; details: string }>(
            `SELECT t, who, action, details FROM audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            ...(q ? [like, like, like] : []), limit, offset
        )
        const entries = rows.map(({ t, who, action, details }) => ({ t, who, action, ...JSON.parse(details) }))
        return (json(res, 200, { audit: entries }), true)
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
.people-table{table-layout:fixed;width:100%;min-width:1150px}.table-wrap{overflow-x:auto}.people-table td select{max-width:none}.people-table td:last-child button{padding:6px 4px;white-space:nowrap;overflow-wrap:normal}td select{min-width:0;width:100%;max-width:160px}#people td{overflow-wrap:anywhere}#people td:nth-child(3),#people td:nth-child(5),#people td:nth-child(6){width:13%;max-width:160px}.badge{white-space:normal}label.check{display:inline-flex;gap:6px;align-items:center;font-weight:400;cursor:pointer}label.check input{width:auto;margin:0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.toolbar>div{flex:1;min-width:160px}details summary{cursor:pointer;font-weight:600}ul.tight{margin:6px 0;padding-left:20px}ul.tight li{margin:3px 0}
main{min-width:0}main .card{border:0;border-radius:0;background:transparent;padding:24px 0;margin:0;border-bottom:1px solid var(--line)}
main h1{margin:8px 0 0}main button:not(.ghost){background:var(--ink);border-color:var(--ink);color:var(--card)}main .ghost{border-color:transparent;color:var(--ink)}main table{table-layout:fixed}main td,main th{overflow-wrap:anywhere}main td{padding-top:14px;padding-bottom:14px}main .table-wrap{overflow:visible}
.people-table{min-width:0}.people-table td select{max-width:100%;font-size:13px;padding:7px 4px}.people-table td{font-size:13px}.people-table td:first-child b{font-weight:600}
#people-filter{max-width:360px}.add-person{margin:16px 0}.add-person[open] summary,.settings[open] summary{margin-bottom:16px}.toolbar>div{min-width:140px!important;flex:1!important;white-space:normal!important}.toolbar{gap:16px;margin-top:12px}
.access-help{margin:20px 0;color:var(--muted);font-size:13px}.access-help summary{color:var(--ink)}summary{cursor:pointer}main> .access-help{padding:4px 0 20px;border-bottom:1px solid var(--line)}
@media(max-width:1000px){.people-table colgroup{display:none}.people-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.people-table,.people-table tbody{display:block}.people-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;padding:20px 0;border-bottom:1px solid var(--line)}.people-table td{display:block;border:0;padding:0;max-width:none!important;width:auto!important;min-width:0}.people-table td:first-child,.people-table td:nth-child(2){grid-column:1/-1}.people-table td[data-label]:before{content:attr(data-label);display:block;color:var(--muted);font-size:12px;margin-bottom:4px}.people-table td:first-child:before{display:none}.people-table td select{max-width:none}.people-table td[colspan]{grid-column:1/-1}}
@media(max-width:560px){main table:not(.people-table){font-size:12px}main th,main td{padding-left:3px;padding-right:3px}main td button,main td .btn{font-size:12px;padding:6px 3px}main .toolbar>div{min-width:min(100%,200px)!important}main .toolbar{align-items:stretch}main button{max-width:100%}main input,main select{min-width:0}}
</style></head>
<body>${headerHtml(v, 'Admin')}<main style="max-width:1280px"><h1>Admin</h1>

<div class="card"><h2>People</h2><p class="small muted">Changes to access save automatically.</p><label for="people-filter">Find a person</label><input id="people-filter" type="search" placeholder="Name or email">
<details class="add-person"><summary>Add a person</summary><div class="toolbar"><div><label for="new-email">PostHog email</label><input id="new-email" type="email" placeholder="name@company.com"></div>
<div><label for="new-role">Role</label><select id="new-role"></select></div><div style="flex:0;white-space:nowrap"><label class="check" for="new-system"><input id="new-system" type="checkbox"> System page</label></div><div style="flex:0"><label for="new-surveys">Surveys</label><select id="new-surveys"></select></div><div style="flex:0"><label for="new-dashboards">Dashboards</label><select id="new-dashboards"></select></div><div style="flex:0"><button type="button" id="add">Add person</button></div></div></details>
<p id="people-msg" class="small" aria-live="polite"></p>
<div class="table-wrap" role="region" aria-label="People access table" tabindex="0"><table class="people-table" role="table"><colgroup><col style="width:15%"><col style="width:13%"><col style="width:13%"><col style="width:10%"><col style="width:13%"><col style="width:13%"><col style="width:6%"><col style="width:9%"><col style="width:8%"></colgroup><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Person</th><th scope="col" role="columnheader">In PostHog</th><th scope="col" role="columnheader">Role here</th><th scope="col" role="columnheader">System page</th><th scope="col" role="columnheader">Surveys role</th><th scope="col" role="columnheader">Dashboards</th><th scope="col" role="columnheader">Clips</th><th scope="col" role="columnheader">Last activity</th><th scope="col" role="columnheader">Actions</th></tr></thead><tbody id="people" role="rowgroup"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody></table></div><div id="people-pager"></div></div>

<section class="card"><details><summary>Access defaults</summary><p class="small muted">Changes save automatically.</p>
<div class="toolbar"><div><label for="default-role">Role for other PostHog users</label><select id="default-role"></select></div>
<div><label for="share">Share links</label><select id="share"><option value="1">Allowed (for people who can download)</option><option value="0">Turned off</option></select></div>
<div><label for="survey-default">Survey role for other PostHog users</label><select id="survey-default"></select></div>
<div><label for="survey-shared">Survey role for chat with the shared team token</label><select id="survey-shared"></select></div>
<div><label for="dashboard-default">Dashboard role for other PostHog users</label><select id="dashboard-default"></select></div>
<div><label for="dashboard-shared">Dashboard role for chat with the shared team token</label><select id="dashboard-shared"></select></div></div>
<details class="access-help"><summary>How this works</summary><p class="small muted">The defaults apply to anyone who signs in with a PostHog account and is not listed above. "No access" is the safe choice. The shared team token cannot tell who asks: give it at most "See surveys and results", and give people personal tokens for more.</p></details><p id="settings-msg" class="small" aria-live="polite"></p></details></section>
<details class="access-help"><summary>How access works</summary>
<ul class="tight">
<li><b>Signing in is PostHog's job.</b> Everyone signs in with their PostHog account. Passwords, two-factor login and removing people all happen in PostHog. Removing someone from PostHog locks them out here within a minute.</li>
<li><b>What they may do is set here.</b> <i>Watch clips</i> lets a person make and watch clips on this site. <i>Watch, download and share</i> adds MP4 downloads and share links. <i>Admin</i> adds this page.</li>
<li><b>The System page</b> shows whether the server and every container are up, with machine, ClickHouse and Lens numbers. It never shows replay or event content. Admins always see it. Tick <i>System page</i> to let anyone else see it too, for example whoever looks after the server. It is separate from the role, so someone can see the System page with <i>No access</i> to clips.</li>
<li><b>Surveys</b> are made, launched and read only in Lens: PostHog's own survey screens and API are closed (they send people here). Each person has a survey role, separate from the clip role: <i>See surveys and results</i>, <i>Also make and change surveys</i>, or <i>Also launch and stop surveys</i> (what reaches Reval users). Admins always have the last. It applies on the Surveys page and in chat.</li>
<li><b>Dashboards</b> have a separate role on the Dashboards page and in chat: <i>See dashboards</i> or <i>Also pin and share</i>. Admins always pin and share. The shared team token gets at most viewing access; pinning and sharing need a personal token.</li>
<li><b>Chat</b> knows who is asking only with a personal token, which each person makes on the <i>Chat</i> page (you can revoke any token below). The shared team token says nothing about who asks, so it gets the survey role you choose in Settings.</li>
<li><b>PostHog owners and admins</b> of the organization that owns the project are always admins here, so nobody can be locked out.</li>
<li><b>Important:</b> on this PostHog plan, PostHog itself cannot limit replays per person. Anyone who is a member of the project's organization can watch every replay inside PostHog, whatever their role here. Those people are marked <span class="badge warn">sees all replays in PostHog</span>. To keep someone to clips only, give them a PostHog account in a separate organization (for example "Clip viewers") with no access to this project, then give them a role here.</li>
<li><b>Storage.</b> A clip is stored once, however many people make the same part of the same recording. A clip nobody saved is deleted two weeks after it was last asked for. Saved clips stay until whoever saved them unsaves them, or you delete them here.</li>
<li>Clips attached to Jira tickets follow Jira's permissions. Share links work for anyone who has them until they expire, so turn them off below if you need tighter control.</li></ul></details>

<div class="card"><h2>Chat keys</h2>
<details class="settings"><summary>Copilot settings</summary>
<div class="toolbar" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><div style="flex:1;min-width:220px"><label for="chat-url">Lens address for Copilot</label><input id="chat-url" placeholder="https://lens.example.com"></div><div><button type="button" id="chat-url-save">Save address</button></div></div>
<p class="small muted">The Chat page gives people this address. Leave empty for the default.</p><p id="chat-url-msg" class="small" aria-live="polite"></p>
</details><p class="small muted">Revoking a key stops its chat access immediately.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">Person</th><th scope="col">Name</th><th scope="col">Made</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead><tbody id="tokens"><tr><td colspan="5">Loading tokens…</td></tr></tbody></table></div><div id="tokens-pager"></div></div>

<div class="card"><h2>Clips</h2><p class="small muted" id="space"></p>
<div class="toolbar"><div><label for="clip-filter">Show</label><select id="clip-filter"><option value="">All clips</option><option value="saved">Saved only</option><option value="expiring">Deleted within 3 days</option></select></div></div>
<div class="table-wrap"><table><thead><tr><th scope="col">Clip</th><th scope="col">Who has it</th><th scope="col">Size</th><th scope="col">Kept until</th><th scope="col">Actions</th></tr></thead><tbody id="clips"><tr><td colspan="5">Loading clips…</td></tr></tbody></table></div><div id="clips-pager"></div></div>

<div class="card"><h2>Activity</h2><p class="small muted">Kept for a year. Search all activity; load older results below.</p><p id="audit-msg" class="small" aria-live="polite"></p><div class="toolbar"><div><label for="filter">Search</label><input id="filter" placeholder="Person, action or clip"></div></div>
<div class="table-wrap"><table><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Details</th></tr></thead><tbody id="audit"><tr><td colspan="4">Loading activity…</td></tr></tbody></table></div><div id="audit-pager"></div><button type="button" id="audit-more" class="ghost" hidden>Load older activity</button></div>
</main>
<script>
${PAGER_JS}
const $=id=>document.getElementById(id);const api=(path,opts={})=>fetch(path,{...opts,headers:{'content-type':'application/json','x-clip-page':'1'}}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||('Error '+r.status));return b});
const when=t=>t?new Date(t).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}):'never';
const day=t=>new Date(t).toLocaleDateString([], {dateStyle:'medium'});
const mb=b=>!b?'0 KB':b>=1048576?(b/1048576).toFixed(1)+' MB':Math.max(1,Math.round(b/1024))+' KB';
const n=(k,w)=>Number(k).toLocaleString()+' '+w+(k===1?'':'s');
const clock=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
const short=e=>(e||'').replace(/@.*/,'');
const cell=(tr,t,cls)=>{const td=document.createElement('td');if(t instanceof Node)td.appendChild(t);else td.textContent=t??'';if(cls)td.className=cls;tr.appendChild(td);return td};
const msg=(id,t,ok)=>{$(id).textContent=t;$(id).className='small '+(ok?'ok':'err');$(id).setAttribute('role',ok?'status':'alert')};
const ACTIONS={'signin':'Signed in','signout':'Signed out','signin.failed':'Failed sign in','recording.inspected':'Looked up a recording','clip.requested':'Asked for a clip','clip.created':'Clip made','clip.viewed':'Watched a clip','clip.downloaded':'Downloaded a clip','clip.link_shared':'Created a share link','clip.deleted':'Deleted a clip','clip.saved':'Saved a clip','clip.unsaved':'Unsaved a clip','clip.comment_added':'Commented on a clip','clip.comment_edited':'Edited a clip comment','clip.comment_deleted':'Deleted a clip comment','clips.pruned':'Old clips deleted','access.role_set':'Changed a role','access.role_removed':'Removed a role','access.settings':'Changed settings','access.system_set':'Changed System page access','access.surveys_set':'Changed Surveys page access','access.survey_role_set':'Changed a survey role','access.survey_role_reset':'Reset a survey role','access.survey_settings':'Changed survey settings','access.dashboard_role_set':'Changed a dashboard role','access.dashboard_role_reset':'Reset a dashboard role','access.dashboard_settings':'Changed dashboard settings','access.chat_url':'Changed the Copilot address','dashboard.pinned':'Pinned a dashboard','dashboard.changed':'Changed a dashboard','dashboard.deleted':'Deleted a dashboard','dashboard.shared':'Shared a dashboard','chat.token_created':'Made a chat token','chat.token_revoked':'Revoked a chat token','survey.created':'Made a survey','survey.changed':'Changed a survey','survey.launched':'Launched a survey','survey.stopped':'Stopped a survey','survey.archived':'Archived a survey'};
let S=null;

function guardControls(){document.querySelectorAll('main button,main select,main input[type=checkbox]').forEach(el=>{for(const event of ['onclick','onchange']){const handler=el[event];if(!handler||handler.guarded)continue;const wrapped=async function(e){if(el.disabled)return;const label=el.getAttribute('aria-label'),id=el.id,focused=document.activeElement===el;el.disabled=true;try{await handler.call(el,e)}catch(err){msg('people-msg',err.message+' Reload the page to try again.')}finally{if(el.isConnected)el.disabled=false;if(focused){const next=el.isConnected?el:id?$(id):label?[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===label):null;next?.focus()}}};wrapped.guarded=true;el[event]=wrapped}})}
const tokensPg=makePager({mount:$('tokens-pager'),noun:'tokens',size:25,draw:slice=>{
 const tt=$('tokens');tt.innerHTML='';if(!slice.length)tt.innerHTML='<tr><td colspan="5" class="muted">No personal tokens yet. People can make one on the Chat page.</td></tr>';
 slice.forEach(t=>{const tr=document.createElement('tr');cell(tr,t.email);cell(tr,t.label);cell(tr,when(t.created_at),'small');cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at)+' by '+t.revoked_by:when(t.last_used_at),'small');
  if(!t.revoked_at){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent='Revoke';b.setAttribute('aria-label','Revoke '+t.label+' token for '+t.email+' made '+when(t.created_at));b.onclick=async()=>{if(!confirm('Revoke the chat token '+t.label+' of '+t.email+'? Chat with it stops at once.'))return;try{await api('/replays/admin/api/chat-tokens/'+t.id,{method:'DELETE'});await load()}catch(e){msg('people-msg',e.message+' Try the action again.')}};cell(tr,b)}else cell(tr,'');tt.appendChild(tr)});

guardControls()}});
const peoplePg=makePager({mount:$('people-pager'),noun:'people',size:25,draw:slice=>{
 const tb=$('people');tb.innerHTML='';
 slice.forEach(p=>{const tr=document.createElement('tr');
  const who=document.createElement('div');who.innerHTML='<b></b><div class="small muted"></div>';who.querySelector('b').textContent=p.email+(p.email===S.me?' (you)':'');who.querySelector('div').textContent=[p.name,p.note].filter(Boolean).join(' · ');cell(tr,who);
  const ph=document.createElement('div');ph.textContent=p.posthog;if(p.sees_all_replays_in_posthog){const b=document.createElement('div');b.innerHTML='<span class="badge warn">sees all replays in PostHog</span>';ph.appendChild(b)}cell(tr,ph,'small');
  const sel=roleSelect(p.role,p.locked);sel.setAttribute('aria-label','Clip role for '+p.email);if(p.locked){const w=document.createElement('div');w.appendChild(sel);const n=document.createElement('div');n.className='small muted';n.textContent='PostHog owner or admin';w.appendChild(n);cell(tr,w)}else{if(!p.set_here){const w=document.createElement('div');w.appendChild(sel);const n=document.createElement('div');n.className='small muted';n.textContent='Default';w.appendChild(n);cell(tr,w)}else cell(tr,sel)}
  sel.onchange=async()=>{try{await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email:p.email,role:sel.value})});msg('people-msg','Saved: '+p.email+' now has "'+sel.selectedOptions[0].textContent+'".',true);await load()}catch(e){msg('people-msg',e.message);await load()}};
  const sw=document.createElement('label');sw.className='check small';const cb=document.createElement('input');cb.type='checkbox';cb.setAttribute('aria-label','System page access for '+p.email);cb.checked=!!p.system;sw.append(cb,document.createTextNode(p.role==='admin'?' Always (admin)':' Can see it'));
  if(p.role==='admin'){cb.disabled=true;sw.title='Admins always see the System page'}
  cb.onchange=async()=>{try{await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email:p.email,role:p.role,system:cb.checked})});msg('people-msg',(cb.checked?'Saved: '+p.email+' can now see the System page.':'Saved: '+p.email+' can no longer see the System page.'),true);await load()}catch(e){msg('people-msg',e.message);await load()}};
  cell(tr,sw);
  const ss=document.createElement('select');ss.setAttribute('aria-label','Survey role for '+p.email);[{id:'default',text:'Default'}].concat(S.survey_roles).forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?'Default ('+(S.survey_roles.find(x=>x.id===S.survey_default_role)||{}).text+')':r.text;ss.appendChild(o)});
  ss.value=p.role==='admin'?'launch':(p.survey_role_set_here||'default');if(p.role==='admin'){ss.disabled=true;ss.title='Admins can always launch and stop surveys'}
  ss.onchange=async()=>{try{await api('/replays/admin/api/survey-role',{method:'POST',body:JSON.stringify({email:p.email,role:ss.value})});msg('people-msg','Saved: '+p.email+' survey role is now "'+ss.selectedOptions[0].textContent+'".',true);await load()}catch(e){msg('people-msg',e.message);await load()}};
  cell(tr,ss);
  const ds=document.createElement('select');ds.setAttribute('aria-label','Dashboard role for '+p.email);[{id:'default',text:'Default'}].concat(S.dashboard_roles).forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?'Default ('+(S.dashboard_roles.find(x=>x.id===S.dashboard_default_role)||{}).text+')':r.text;ds.appendChild(o)});
  ds.value=p.role==='admin'?'share':(p.dashboard_role_set_here||'default');if(p.role==='admin'){ds.disabled=true;ds.title='Admins can always pin and share dashboards'}
  ds.onchange=async()=>{try{await api('/replays/admin/api/dashboard-role',{method:'POST',body:JSON.stringify({email:p.email,role:ds.value})});msg('people-msg','Saved: '+p.email+' dashboard role is now "'+ds.selectedOptions[0].textContent+'".',true);await load()}catch(e){msg('people-msg',e.message);await load()}};
  cell(tr,ds);
  cell(tr,p.clips.clips?n(p.clips.clips,'clip')+', '+p.clips.saved+' saved · '+mb(p.clips.bytes):'none','small');
  cell(tr,when(p.last_seen),'small');
  if(p.set_here&&!p.locked){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent='Reset';b.setAttribute('aria-label','Reset clip role for '+p.email);b.title='Remove the role set here, so the default applies';b.onclick=async()=>{if(!confirm('Reset the clip role for '+p.email+' to the default?'))return;try{await api('/replays/admin/api/person?email='+encodeURIComponent(p.email),{method:'DELETE'});msg('people-msg','Removed the role for '+p.email+'.',true);await load()}catch(e){msg('people-msg',e.message)}};cell(tr,b)}else cell(tr,'');
  tr.setAttribute('role','row');[...tr.children].forEach((td,i)=>{td.setAttribute('role','cell');td.dataset.label=['Person','In PostHog','Clip role','System page','Surveys','Dashboards','Clips','Last activity','Actions'][i]});tb.appendChild(tr)});

if(!slice.length)$('people').innerHTML='<tr><td colspan="9">No people found. Change your search or add a person above.</td></tr>';guardControls()}});
function renderPeople(keep=false){const q=$('people-filter').value.trim().toLowerCase();if(S)peoplePg.set(S.people.filter(p=>(p.email+' '+p.name+' '+p.note).toLowerCase().includes(q)),keep)}
$('people-filter').oninput=()=>renderPeople();

function roleSelect(value,disabled){const s=document.createElement('select');S.roles.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===value)o.selected=true;s.appendChild(o)});s.disabled=!!disabled;return s}
async function load(){const focused=document.activeElement;const focusLabel=focused?.getAttribute('aria-label');const previousAudit=S?.audit;S=await api('/replays/admin/api/state');if(previousAudit&&($('filter').value.trim()||previousAudit.length>300))S.audit=previousAudit;
 $('new-role').innerHTML='';S.roles.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id==='watch')o.selected=true;$('new-role').appendChild(o)});
 $('default-role').innerHTML='';S.roles.filter(r=>r.id!=='admin').forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===S.default_role)o.selected=true;$('default-role').appendChild(o)});
 $('share').value=S.allow_share_links?'1':'0';
 const opts=(sel,list,value)=>{sel.innerHTML='';list.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.text;if(r.id===value)o.selected=true;sel.appendChild(o)})};
 opts($('survey-default'),S.survey_roles.filter(r=>r.id!=='launch'),S.survey_default_role);opts($('survey-shared'),S.survey_roles,S.survey_shared_token_role);opts($('new-surveys'),[{id:'default',text:'Default'}].concat(S.survey_roles),'default');
 opts($('dashboard-default'),S.dashboard_roles.filter(r=>r.id!=='share'),S.dashboard_default_role);opts($('dashboard-shared'),S.dashboard_roles.filter(r=>r.id!=='share'),S.dashboard_shared_token_role);opts($('new-dashboards'),[{id:'default',text:'Default'}].concat(S.dashboard_roles),'default');
 tokensPg.set(S.chat_tokens,true);renderPeople(true);
 const st=S.storage;$('space').textContent=n(st.clips,'clip')+' using '+mb(st.bytes)+' on the server. Saved: '+st.saved+' ('+mb(st.saved_bytes)+'). Unsaved clips expire two weeks after their last request.';
 renderClips();
 renderAudit(true);guardControls();if(focusLabel){const next=[...document.querySelectorAll('[aria-label]')].find(el=>el.getAttribute('aria-label')===focusLabel);next?.focus()}}
function renderClips(keep=true){const f=$('clip-filter').value;const soon=Date.now()+3*86400000;const cb=$('clips');cb.innerHTML='';
 const list=S.clips.filter(c=>!f||(f==='saved'?c.saved_by.length:c.expires_at&&Date.parse(c.expires_at)<soon));
 clipsPg.set(list,keep)}
const clipsPg=makePager({mount:$('clips-pager'),noun:'clips',size:25,draw:slice=>{const cb=$('clips');cb.innerHTML='';
 if(!slice.length)cb.innerHTML='<tr><td colspan="5" class="muted">No clips found. Change the filter or make a clip on the Replay clips page.</td></tr>';
 slice.forEach(c=>{const tr=document.createElement('tr');
  const what=document.createElement('div');what.innerHTML='<b></b><div class="small muted"></div>';what.querySelector('b').textContent=(c.client||'Unknown client')+' · '+clock(c.start_s)+'–'+clock(c.end_s);what.querySelector('div').textContent=[short(c.user),'made '+day(c.created_at)].filter(Boolean).join(' · ');cell(tr,what);
  const who=document.createElement('div');c.holders.forEach(e=>{const line=document.createElement('div');line.className='small';const saved=c.saved_by.includes(e);line.textContent=(saved?'★ ':'')+e+(saved?' (saved)':'');
   if(saved){const x=document.createElement('button');x.type='button';x.className='ghost small';x.style.padding='0 6px';x.style.marginLeft='6px';x.textContent='Unsave';x.title='The clip then gets deleted two weeks from now, unless someone else saved it';x.onclick=async()=>{if(!confirm('Unsave this clip for '+e+'? It may then expire.'))return;try{await api('/replays/admin/api/clips/'+encodeURIComponent(c.name)+'/unsave',{method:'POST',body:JSON.stringify({email:e})});await load()}catch(err){msg('people-msg',err.message+' Try the action again.')}};line.appendChild(x)}
   who.appendChild(line)});cell(tr,who);
  cell(tr,mb(c.bytes),'small');
  cell(tr,c.expires_at?day(c.expires_at):'Saved',c.expires_at?'small':'small ok');
  const w=document.createElement('a');w.className='btn ghost';w.textContent='Watch';w.href='/replays?clip='+encodeURIComponent(c.name);const d=document.createElement('button');d.type='button';d.className='ghost';d.textContent='Delete';d.onclick=async()=>{if(!confirm('Delete this clip for everyone who has it? Its share links stop working.'))return;try{await api('/replays/admin/api/clips/'+encodeURIComponent(c.name),{method:'DELETE'});await load()}catch(e){msg('people-msg',e.message+' Try the action again.')}};
  const box=document.createElement('div');box.style.display='flex';box.style.gap='6px';box.style.flexWrap='wrap';box.append(w,d);cell(tr,box);cb.appendChild(tr)});guardControls()}});
$('clip-filter').onchange=()=>renderClips(false);
function renderAudit(keep=false){auditPg.set(S.audit,keep);$('audit-more').hidden=S.audit.length%300!==0||!S.audit.length}
const auditPg=makePager({mount:$('audit-pager'),noun:'activity entries',size:25,draw:slice=>{const tb=$('audit');tb.innerHTML='';
 if(!slice.length)tb.innerHTML='<tr><td colspan="4" class="muted">No activity found. Try another search.</td></tr>';
 slice.forEach(e=>{const tr=document.createElement('tr');cell(tr,when(e.t),'small');cell(tr,e.who);cell(tr,ACTIONS[e.action]||e.action);const {t,who,action,...rest}=e;cell(tr,Object.entries(rest).map(([k,v])=>k+': '+(typeof v==='object'?JSON.stringify(v):v)).join(' · '),'small muted');tb.appendChild(tr)})}});
let searchVersion=0;
async function searchAudit(more=false){const version=++searchVersion;msg('audit-msg','Loading…',true);try{const q=$('filter').value.trim();const audit=(await api('/replays/admin/api/audit?q='+encodeURIComponent(q)+'&offset='+(more?S.audit.length:0))).audit;if(version!==searchVersion)return;S.audit=more?S.audit.concat(audit):audit;renderAudit(more);msg('audit-msg',audit.length?'Activity loaded.':'No activity found. Try another search.',true)}catch(e){if(version===searchVersion)msg('audit-msg',e.message+' Try the search again.')}}
$('audit-more').onclick=()=>searchAudit(true);
let searchTimer;$('filter').oninput=()=>{++searchVersion;clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchAudit(),250)};
$('add').onclick=async()=>{const email=$('new-email').value.trim();if(!$('new-email').reportValidity()||!email){msg('people-msg','Enter a valid email address.');return;}try{await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email,role:$('new-role').value,system:$('new-system').checked,dashboard_role:$('new-dashboards').value==='default'?'':$('new-dashboards').value,survey_role:$('new-surveys').value==='default'?'':$('new-surveys').value})});$('new-email').value='';$('new-system').checked=false;$('new-surveys').value='default';$('new-dashboards').value='default';msg('people-msg','Added '+email+'.',true);await load()}catch(e){msg('people-msg',e.message)}};
$('chat-url').value=${JSON.stringify(chatUrl()).replace(/</g, '\\u003c')};
$('chat-url-save').onclick=async()=>{try{const r=await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({chat_url:$('chat-url').value})});$('chat-url').value=r.chat_url;msg('chat-url-msg','Saved.',true)}catch(e){msg('chat-url-msg',e.message)}};
$('default-role').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({default_role:$('default-role').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('share').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({allow_share_links:$('share').value==='1'})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('survey-default').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_default_role:$('survey-default').value})});msg('settings-msg','Saved.',true);await load()}catch(e){msg('settings-msg',e.message)}};
$('survey-shared').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_shared_token_role:$('survey-shared').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('dashboard-default').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({dashboard_default_role:$('dashboard-default').value})});msg('settings-msg','Saved.',true);await load()}catch(e){msg('settings-msg',e.message)}};
$('dashboard-shared').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({dashboard_shared_token_role:$('dashboard-shared').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
guardControls();
load().catch(e=>{msg('people-msg',e.message+' Reload the page to try again.');$('people').innerHTML='<tr><td colspan="9" class="err"></td></tr>';$('people').querySelector('td').textContent=e.message});
</script></body></html>`
}
