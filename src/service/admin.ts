import { clientOutcomes, recordOutcome, OUTCOMES } from '../core/outcomes.ts'
import { tasksDb } from '../core/tasks.ts'
/** Clients seen in history, for picking one by name when recording an outcome. */
const knownClients = (): { client: string; name: string }[] => {
    try { return tasksDb.prepare("SELECT c.client,coalesce(n.name,c.client) AS name FROM (SELECT DISTINCT client FROM client_daily WHERE client!='') c LEFT JOIN client_names n USING(client) ORDER BY name LIMIT 2000").all() as { client: string; name: string }[] }
    catch { return [] }
}
import { briefingDeliveryStatus } from '../core/briefingdelivery.ts'
// Admin page for replay clip access: who can watch, who can download, the default for everyone
// else, share links, clips and the activity log. Only admins reach it: PostHog owners and admins
// of the organization that owns the project, plus anyone given the admin role here.
import type { IncomingMessage, ServerResponse } from 'node:http'

import { anonymiseOn } from '../core/anonymise.ts'
import { config } from '../core/config.ts'
import { all } from '../core/db.ts'
import { asViewer, audit, can, lastSeen, loadAccess, readAudit, removePerson, ROLE_TEXT, ROLES, roleOf, setAccessSettings, setPerson, setSurveyRole, resetSurveyRole, setSurveySettings, chatPolicy, setChatPolicy, SURVEY_ROLES, SURVEY_ROLE_TEXT, defaultSurveyRole, sharedTokenSurveyRole, surveyRoleOf, listMcpTokens, revokeMcpToken, chatUrl, setChatUrl, type SurveyRole, setSystemAccess, setInsightAccess, insightPeople, surveyPeople, systemViewers, type Role, type Viewer } from './access.ts'
import { dashboardPeople, dashboardRoleOf, setDashboardRole, resetDashboardRole, setDashboardSettings, defaultDashboardRole, sharedTokenDashboardRole, DASHBOARD_ROLES, DASHBOARD_ROLE_TEXT, type DashboardRole } from './access.ts'
import { adminTabs } from './privacy.ts'
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

    if (p === '/replays/admin/api/outcomes') {
        try {
            if (req.method === 'GET') { json(res,200,clientOutcomes()); return true }
            if (req.method === 'POST' || req.method === 'DELETE') {
                if (req.headers['x-clip-page'] !== '1') { json(res,403,{error:'A page request header is required.'}); return true }
                recordOutcome(v,await readJson(req),req.method === 'DELETE')
                json(res,200,{ok:true}); return true
            }
        } catch(e) { json(res,400,{error:(e as Error).message}); return true }
    }

    if (p === '/replays/admin/api/state' && req.method === 'GET') {
        const access = loadAccess()
        const [members, org] = await Promise.all([posthogMembers(v), replayOrg()])
        const seen = lastSeen()
        const space = storage()
        const held = new Map(space.per_person.map((x) => [x.email, x]))
        const sys = systemViewers()
        const ins = insightPeople()
        const srv = surveyPeople()
        const dash = dashboardPeople()
        const emails = new Set([...members.map((m) => m.email), ...Object.keys(access.people), ...sys.keys(), ...ins.keys(), ...srv.keys(), ...dash.keys()])
        const people = [...emails].sort().map((email) => {
            const ms = members.filter((m) => m.email === email)
            const inProject = ms.find((m) => m.org_id === org)
            const posthogAdmin = !!inProject && inProject.level >= 8
            const role = roleOf(email, posthogAdmin, access)
            return {
                // Admins always see System monitoring; for anyone else it is the tick on this page.
                system: can(role, 'admin') || sys.has(email),
                system_granted: sys.has(email),
                // Replay insights: admins always; anyone else only when ticked here.
                insights: can(role, 'admin') || ins.has(email),
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
        if (typeof body.insights === 'boolean') setInsightAccess(email, body.insights, v.email)
        if (typeof body.dashboard_role === 'string' && body.dashboard_role) setDashboardRole(email, body.dashboard_role as DashboardRole, v.email)
        if (typeof body.survey_role === 'string' && body.survey_role) setSurveyRole(email, body.survey_role as SurveyRole, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    // System monitoring and replay insights: switches of their own, so ticking one never touches a role.
    if (p === '/replays/admin/api/extra-access' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        if (!EMAIL.test(email) || (typeof body.system !== 'boolean' && typeof body.insights !== 'boolean')) return (json(res, 400, { error: 'Give an email and what to turn on or off.' }), true)
        if (typeof body.system === 'boolean') setSystemAccess(email, body.system, v.email)
        if (typeof body.insights === 'boolean') setInsightAccess(email, body.insights, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    // A person's survey role (separate from the replay clips role); "default" removes it so the default applies.
    if (p === '/replays/admin/api/survey-role' && req.method === 'POST') {
        const body = await readJson(req)
        const email = String(body.email || '').trim().toLowerCase()
        const role = String(body.role || '')
        if (!EMAIL.test(email) || !(role === 'default' || SURVEY_ROLES.includes(role as SurveyRole))) return (json(res, 400, { error: 'Give an email and a survey role.' }), true)
        if (role === 'default') resetSurveyRole(email, v.email)
        else setSurveyRole(email, role as SurveyRole, v.email)
        return (json(res, 200, { ok: true }), true)
    }

    // A person's dashboard role (separate from the replay clips role); "default" removes it so the default applies.
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
        if (body.chat_apps !== undefined || body.chat_note !== undefined) {
            try {
                return (json(res, 200, { ok: true, ...setChatPolicy({ apps: body.chat_apps, note: body.chat_note }, v.email) }), true)
            } catch (e) {
                return (json(res, 400, { error: (e as Error).message }), true)
            }
        }
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
    const e = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!)
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin · ${APP_NAME}</title><style>${PAGE_CSS()}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.table-wrap{overflow-x:auto}
td select{min-width:0;width:100%;max-width:160px}

.badge{display:inline-block;font-size:11.5px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--hover);white-space:normal}
label.check{display:inline-flex;gap:6px;align-items:center;font-weight:400;cursor:pointer}
label.check input{width:auto;margin:0}
details summary{cursor:pointer;font-weight:600}
ul.tight{margin:6px 0;padding-left:20px}
ul.tight li{margin:3px 0}
main .page-head h1{margin:0}
main .ghost{border-color:transparent;color:var(--ink)}
main table{table-layout:fixed}
main td,main th{overflow-wrap:anywhere}
main td{padding-top:12px;padding-bottom:12px}
.toolbar>div{min-width:140px!important;flex:1!important;white-space:normal!important}
.toolbar{display:flex;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px;gap:16px;margin-top:12px}
.access-help{margin:20px 0;color:var(--muted);font-size:13px}
.access-help summary{color:var(--ink)}
summary{cursor:pointer}
main> .access-help{padding:4px 0 20px;border-bottom:1px solid var(--line)}
.revoked-toggle input{width:auto;margin:0}
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
.tabs .tab-link{margin-left:0;color:var(--muted);text-decoration:none;font-weight:500;padding:8px 12px;border-bottom:2px solid transparent}
.tabs :is([aria-current],[aria-selected=true]){color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.chat-head,.token-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.settings,.access-help{margin:0;border-bottom:1px solid var(--line);padding:16px 0}
.chat-head{align-items:flex-start}
.chat-head>.settings{padding:0;border:0;max-width:100%}
.chat-head>.settings[open]{flex-basis:100%;order:2}
.chat-head h2{margin:0}
.revoked-toggle{display:flex;gap:8px;align-items:center;justify-content:flex-start;color:var(--muted);margin:0;min-height:36px}
.token-toolbar{margin-bottom:12px}
#tokens button.ghost{color:var(--err);font-weight:500}
#tokens tr:last-child td{border-bottom:0}
#tokens td:last-child,#tab-chat th:last-child,#tab-outcomes th:last-child,#outcome-rows td:last-child{text-align:right;font-weight:500;vertical-align:top}
#outcome-rows td:last-child button+button{margin-left:4px}
#outcome-rows td:last-child button:last-child,#clips td:last-child button{color:var(--err)}
#outcome-form{display:grid;grid-template-columns:minmax(220px,2fr) minmax(120px,1fr) 160px minmax(180px,1.5fr);gap:16px;align-items:end}
#outcome-form>div{min-width:0!important}
#outcome-form>button{grid-column:1/-1;justify-self:end}
#tab-outcomes caption{text-align:left;font-size:14px;line-height:20px;font-weight:600;padding:16px 24px 12px}
#outcome-rows td[colspan]{padding:32px 24px;text-align:center;color:var(--muted)}
#filter{max-width:360px}
#audit td:first-child{white-space:nowrap}
#audit td:last-child{color:var(--ink);font-size:13px;line-height:20px}
#audit pre{white-space:pre-wrap;overflow-wrap:anywhere}
.audit-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
.audit-footer #audit-pager{flex:1;min-width:0}
@media(max-width:560px){main table:not(.people-table){font-size:12px}
main th,main td{padding-left:3px;padding-right:3px}
main td button,main td .btn{font-size:12px;padding:6px 3px}
main .toolbar>div{min-width:min(100%,200px)!important}
main .toolbar{align-items:stretch}
main button{max-width:100%}
main input,main select{min-width:0}
#outcome-form{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:1100px){#outcome-form{grid-template-columns:repeat(2,minmax(0,1fr))}
}
/* People and add-person base styles. */
#tab-people{font-size:14px;container-type:inline-size}
.people-toolbar{display:grid;grid-template-columns:1fr auto;align-items:center;gap:12px}.people-search-row{grid-column:1/-1;display:flex;align-items:end;gap:16px;margin-bottom:4px}.people-search label{display:block;margin-bottom:6px}
.people-toolbar h2{margin:0;margin-right:auto;white-space:nowrap}
.people-search{flex:1;max-width:360px;min-width:0}
.people-search input{width:100%}
.people-toolbar a{white-space:nowrap}
.people-guidance{margin:12px 0 8px}.people-meanings{margin-bottom:16px}#tab-people .people-meanings summary{cursor:pointer;min-height:44px}.people-meanings p{margin:4px 0}
#tab-people :is(input:not([type=checkbox]),select,button){font-size:14px;min-height:40px}
#tab-people :is(input:not([type=checkbox]),select){height:40px}
.people-table{width:100%;table-layout:fixed;min-width:760px}
.people-table :is(td,th){text-align:left;overflow-wrap:normal;padding:12px 8px;vertical-align:top;font-size:14px}
.people-table th{text-align:left;overflow-wrap:normal}
.people-table :is(td,th):last-child{white-space:normal}
#tab-people .people-table select{width:100%;max-width:100%;white-space:normal;height:auto;min-height:40px;padding:7px 4px}
.people-table fieldset{border:0;padding:0;margin:0;min-width:0}
.people-table legend{display:none}
.people-table label.check{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-width:44px;min-height:44px;margin:0;cursor:pointer}
.people-table input[type=checkbox],.add-person input[type=checkbox]{width:16px;height:16px;margin:0}
.people-table label.check span{font-weight:400}
.identity-name{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-weight:600}.identity-name .badge{white-space:nowrap;flex-shrink:0;overflow-wrap:normal}
.person-header{display:flex;align-items:center;justify-content:space-between;gap:12px}
.mobile-last-seen{display:none}.person-meta{margin-top:4px}.identity-name+div{overflow-wrap:anywhere}
.control-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.control-wrap select{flex:1;min-width:0}
.control-wrap:has(label.check){justify-content:flex-start}
.control-wrap label.check{margin:0;flex-shrink:0}
.control-status{display:block;flex-basis:100%;font-size:13px;overflow-wrap:anywhere}
.control-status:empty{display:none}#tab-people .secondary-button{background:var(--card);color:var(--ink);border:1px solid var(--line-strong);border-radius:6px;padding:8px 12px}
#tab-people .link-button{display:inline;background:none;border:0;color:var(--accent);font:inherit;min-height:0;padding:0;white-space:normal;text-align:left;text-decoration:underline;cursor:pointer}
.person-source{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;white-space:normal;font-size:13px;margin-top:4px}.person-source .link-button{font-size:13px;min-height:24px;padding:2px 0}.included{font-size:14px;font-weight:400}.people-actions{display:flex;align-items:center;gap:16px}.mobile-guidance{display:none}.access-summary dl{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}.access-summary :is(dt,dd){margin:0}.access-summary dd{color:var(--ink)}
.access-summary,.mobile-editor{display:none}.edit-access{display:block;margin-top:12px}.editing .mobile-editor{display:grid;gap:16px;margin-top:16px}.mobile-editor legend{display:block;font-weight:600}.mobile-editor fieldset{min-width:0}
.people-settings{margin-top:24px}
.people-settings>details{border-bottom:1px solid var(--line);padding:0;color:var(--ink);font-size:14px}
#tab-people .people-settings summary{cursor:pointer;min-height:44px;align-content:center}
.people-settings summary:focus-visible{outline:2px solid var(--accent)}
#tab-people .small{font-size:13px}#tab-people .access-summary dd{font-size:14px}.add-person #new-features{display:grid;gap:16px}.editing .access-summary{display:none}.add-person{box-sizing:border-box;width:calc(100% - 32px);max-width:640px;max-height:calc(100dvh - 24px);overflow:hidden;margin:auto;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);padding:0}
.add-person::backdrop{position:fixed;inset:0;background:rgb(0 0 0 / 40%)}
.add-person form{display:flex;flex-direction:column;max-height:calc(100dvh - 24px);overflow:hidden}.add-header{display:block;width:auto;height:auto;flex-shrink:0;position:relative;padding:20px 24px 0}.add-header h2{margin:0 48px 8px 0}.add-header p{margin:0}.add-close{position:absolute;right:16px;top:16px;width:44px;height:44px}.add-body{flex:1;overflow-y:auto;min-height:0;padding:16px 24px;display:grid;gap:16px;scrollbar-gutter:stable}.add-body>div:not(#new-features),.add-section>div{display:grid;gap:6px}.add-body p{margin:0}.add-body label+select,.add-body label+input{margin-top:0}.add-person fieldset .check{min-height:44px;margin:0 0 8px}.add-person #new-clip{display:grid;gap:6px;margin-bottom:16px}.add-scroll-cue{font-size:12px;color:var(--muted);text-align:center;padding:4px;flex-shrink:0}.add-person label{font-size:14px}.add-person .small{font-size:13px}.add-person [hidden]{display:none}.add-person h2{margin:0 0 8px}.add-person-error:empty,#new-email-error:empty{display:none}
.add-person fieldset{border:0;padding:0;margin:0;min-width:0}
.add-person legend{font-weight:600;margin-bottom:12px}
.add-section{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.add-section .full{grid-column:1/-1}
.add-section :is(input[type=email],select){width:100%}
.add-section p{margin:4px 0 0}
.add-person .check{display:grid;grid-template-columns:16px 1fr;align-items:start;align-self:start;align-content:start;color:var(--ink);column-gap:10px;row-gap:4px;min-height:44px;cursor:pointer}.add-person .check input{grid-row:1/3;margin-top:3px}#tab-people .add-person input[type=radio]{width:16px;height:16px;min-height:16px;margin:3px 0 0}.add-person .check .small{grid-column:2}
.add-actions{flex-shrink:0;border-top:1px solid var(--line);background:var(--card);padding:16px;padding-bottom:max(16px,env(safe-area-inset-bottom));display:flex;justify-content:flex-end;gap:16px}
/* People responsive styles: cards, then single-column forms. */
@container(max-width:800px){.card>.table-wrap:has(.people-table){margin:0}
.mobile-last-seen{display:block}.people-table colgroup{display:none}
.people-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.people-table,.people-table tbody{display:block;min-width:0}
.people-table tr{display:block;padding:16px 0;border-bottom:1px solid var(--line)}
#people td{display:none;border:0;padding:0}
#people td:first-child{display:block}
.person-detail{display:none}
.access-summary{display:block;margin:16px 0 0}.access-summary p{margin:4px 0}
.edit-access{display:block;margin-top:12px;flex-shrink:0}
.editing .mobile-editor{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}
.mobile-editor legend{display:block;font-weight:600;margin-bottom:4px}
.mobile-editor .control-wrap:has(label.check){justify-content:flex-start}
.mobile-editor label.check{width:auto;justify-content:flex-start;margin:0;gap:8px}
.mobile-editor label.check span{position:static;width:auto;height:auto;clip-path:none}
.mobile-editor>button{justify-self:start}
#tab-people :is(button,select,.link-button){min-height:44px}.people-search{width:100%}}
@media(max-width:700px){.add-header{padding:16px 16px 0}.add-body{padding:16px}.add-person{width:calc(100% - 24px);margin:auto;padding:0}#tab-people .add-person :is(input,select){font-size:16px}.add-section,.editing .mobile-editor{grid-template-columns:minmax(0,1fr)}
.people-toolbar{gap:12px}
.people-search-row{flex-wrap:wrap;gap:12px}
.people-search{max-width:360px;flex-basis:100%;width:100%}
.people-actions{flex-basis:100%}.desktop-guidance{display:none}.mobile-guidance{display:block}}
</style></head>
<body>${headerHtml(v, 'Admin')}<main><div class="page-head"><div><h1>Admin</h1><p>Manage people and what they can use in Lens.</p></div></div>
${adminTabs()}

<div class="tabpanel" role="tabpanel" id="tab-people" data-panel="people">
<div class="card"><div class="people-toolbar"><h2 id="people-heading">People</h2><div class="people-actions"><button type="button" id="show-add-person" aria-haspopup="dialog" aria-controls="add-person-dialog">Grant access</button></div><div class="people-search-row"><div class="people-search"><label for="people-filter">Search people</label><input id="people-filter" type="search" placeholder="Name or email"></div><a href="#access-defaults" id="manage-access-defaults">Default permissions</a></div></div>
<p class="muted people-guidance">Changes save automatically. Administrators have all permissions.</p>
<dialog id="add-person-dialog" class="add-person" aria-labelledby="add-person-heading" aria-describedby="add-person-subtitle"><form id="add-person-form" novalidate><header class="add-header"><h2 id="add-person-heading">Grant access</h2><p id="add-person-subtitle" class="muted">Set access for a PostHog account connected to Lens.</p><button type="button" id="close-add-person" class="secondary-button add-close" aria-label="Close grant access">×</button></header><div class="add-body">
<div><label for="new-email">PostHog account email</label><input id="new-email" type="email" required placeholder="name@company.com" aria-describedby="new-email-help new-email-error"><p id="new-email-help" class="small muted">Enter the email address of that PostHog account.</p><p id="new-email-error" class="small err"></p></div>
<fieldset><legend>Account role</legend><label class="check" for="new-member"><input id="new-member" name="account-role" type="radio" checked><span>Member</span></label><label class="check" for="new-admin"><input id="new-admin" name="account-role" type="radio" aria-describedby="new-admin-help"><span>Administrator</span><span id="new-admin-help" class="small muted">Can manage people and use every Lens feature, including replay insights.</span></label></fieldset><fieldset><legend>Feature access</legend><div id="new-clip"><label for="new-role">Clip access</label><select id="new-role"></select></div>
<p id="new-admin-features" class="muted" hidden>All feature permissions: Allowed · Via administrator</p>
<div id="new-features"><label class="check" for="new-insights"><input id="new-insights" type="checkbox" aria-describedby="new-insights-help"><span>Replay insights</span><span id="new-insights-help" class="small muted">View findings about how clients’ people work, derived from session replays. Independent of clip access.</span></label><div class="add-section"><div><label for="new-surveys">Surveys</label><select id="new-surveys" aria-describedby="new-surveys-current"></select><p id="new-surveys-current" class="small muted"></p></div><div><label for="new-dashboards">Dashboards</label><select id="new-dashboards" aria-describedby="new-dashboards-current"></select><p id="new-dashboards-current" class="small muted"></p></div><label class="check" for="new-system"><input id="new-system" type="checkbox" aria-describedby="new-system-help"><span>System monitoring</span><span id="new-system-help" class="small muted">Server and container status</span></label></div></div>
</fieldset><p id="new-effective" hidden class="small" aria-live="polite"></p><div id="add-person-error" class="add-person-error err" role="alert" tabindex="-1"></div></div><div class="add-scroll-cue">Scroll to review all access settings</div><div class="add-actions"><button type="button" id="cancel-add-person" class="secondary-button">Cancel</button><button type="submit" id="add">Grant access</button></div></form></dialog>
<p id="people-msg" class="small" aria-live="polite"></p>
<span id="system-description" class="visually-hidden">Server and container status</span><span id="insights-description" class="visually-hidden">Client findings from session replays. Granted separately from clip access.</span>
<div class="table-wrap" role="region" aria-label="People access table"><table class="people-table" role="table"><colgroup><col style="width:28%"><col style="width:10%"><col style="width:12%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:10%"><col style="width:9%"></colgroup><thead><tr><th scope="col">Person</th><th scope="col">Account role</th><th scope="col">Clip access</th><th scope="col">Surveys</th><th scope="col">Dashboards</th><th scope="col">System monitoring</th><th scope="col" aria-describedby="insights-description">Replay insights</th><th scope="col">Last seen<br>in Lens</th></tr></thead><tbody id="people"><tr><td colspan="8" data-label="Person" class="muted">Loading…</td></tr></tbody></table></div><div id="people-pager"></div></div>

<section class="people-settings" aria-labelledby="people-settings-heading"><h3 id="people-settings-heading">Settings</h3><details class="settings" id="access-defaults"><summary>Default permissions</summary><p class="small muted">Changes save automatically.</p>
<div class="toolbar"><div><label for="default-role">Clip access for other PostHog users</label><select id="default-role"></select></div>
<div><label for="share">Share links</label><select id="share"><option value="1">Allowed (for people who can download)</option><option value="0">Not allowed</option></select></div>
<div><label for="survey-default">Survey role for other PostHog users</label><select id="survey-default"></select></div>
<div><label for="survey-shared">Survey role for chat with the shared team token</label><select id="survey-shared"></select></div>
<div><label for="dashboard-default">Dashboard role for other PostHog users</label><select id="dashboard-default"></select></div>
<div><label for="dashboard-shared">Dashboard role for chat with the shared team token</label><select id="dashboard-shared"></select></div></div>
<p id="settings-msg" class="small" aria-live="polite"></p></details>
<details class="access-help"><summary>How access works</summary>
<p>Clip access controls clips: No access, Watch clips, or Download clips. Surveys, Dashboards, System monitoring and Replay insights need separate feature grants. Administrators have every feature. PostHog owners and admins are administrators automatically.</p>
<p class="small muted">Replay insights: findings about how a client's people work, from session replays. Admins always have them; others only when ticked.</p>
<ul class="tight">
<li><b>Signing in is PostHog's job.</b> Everyone signs in with their PostHog account. Passwords, two-factor login and removing people all happen in PostHog. Removing someone from PostHog locks them out here within a minute.</li>
<li><b>What they may do is set here.</b> <i>Watch clips</i> lets a person make and watch clips on this site. <i>Download clips</i> adds MP4 downloads and share links. <i>Administrator</i> grants every feature. Other roles need separate feature grants.</li>
<li><b>System monitoring</b> shows whether the server and every container are up, with machine, ClickHouse and Lens numbers. It never shows replay or event content. Admins always see it. Tick <i>System monitoring</i> to let anyone else see it too, for example whoever looks after the server. It is separate from the role, so someone can see System monitoring with <i>No access</i> to clips.</li>
<li><b>Surveys</b> are made, launched and read only in Lens: PostHog's own survey screens and API are closed (they send people here). Each person has a survey role, separate from the replay clips role: <i>See surveys and results</i>, <i>Also make and change surveys</i>, or <i>Also launch and stop surveys</i> (what reaches Reval users). Admins always have the last. It applies on the Surveys page and in chat, except that launching is only possible on the Surveys page, never from chat.</li>
<li><b>Dashboards</b> have a separate role on the Dashboards page and in chat: <i>See dashboards</i> or <i>Also pin and share</i>. Admins always pin and share. The shared team token gets at most viewing access; pinning and sharing need a personal token.</li>
<li><b>Chat</b> knows who is asking only with a personal token, which each person makes on the <i>Chat</i> page (you can revoke any token below). The shared team token says nothing about who asks, so it gets the survey role you choose in Settings.</li>
<li><b>PostHog owners and admins</b> of the organization that owns the project are automatically administrators here, so nobody can be locked out.</li>
<li><b>Important:</b> on this PostHog plan, PostHog itself cannot limit replays per person. Anyone who is a member of the project's organization can watch every replay inside PostHog, whatever their role here. Their PostHog access line says “all recordings”. To keep someone to clips only, give them a PostHog account in a separate organization (for example "Clip viewers") with no access to this project, then give them a role here.</li>
<li><b>Storage.</b> A clip is stored once, however many people make the same part of the same recording. A clip nobody saved is deleted two weeks after it was last asked for. Saved clips stay until whoever saved them unsaves them, or you delete them here.</li>
<li>Clips attached to Jira tickets follow Jira's permissions. Share links work for anyone who has them until they expire, so turn them off below if you need tighter control.</li></ul></details></section>

</div>
<div class="tabpanel" role="tabpanel" id="tab-outcomes" data-panel="outcomes">
<section class="card"><h2>Client outcomes</h2><p class="small muted">Clients that left, shrank, renewed or stayed. The Scorecard checks which warnings came first.</p><form id="outcome-form" class="toolbar"><div><label for="outcome-client">Client</label><input id="outcome-client" name="client" required maxlength="256" list="outcome-clients" placeholder="Find a client"><datalist id="outcome-clients">${knownClients().map(c=>`<option value="${e(c.client)}">${e(c.name)}</option>`).join('')}</datalist></div><div><label for="outcome-kind">Outcome</label><select id="outcome-kind" name="outcome">${OUTCOMES.map(o=>`<option value="${o}">${o === 'contracted' ? 'Reduced' : o.charAt(0).toUpperCase()+o.slice(1)}</option>`).join('')}</select></div><div><label for="outcome-date">Decision date</label><input id="outcome-date" name="decided_on" type="date" required></div><div><label for="outcome-note">Note (optional)</label><input id="outcome-note" name="note" maxlength="500"></div><button type="submit">Save outcome</button></form><p id="outcome-msg" role="status" aria-live="polite"></p><div class="table-wrap"><table><colgroup><col style="width:25%"><col style="width:16%"><col style="width:17%"><col style="width:25%"><col style="width:16%"></colgroup><caption>Recorded client outcomes</caption><thead><tr><th>Client</th><th>Outcome</th><th>Decision date</th><th>Note</th><th>Actions</th></tr></thead><tbody id="outcome-rows"></tbody></table></div></section>
</div>
<div class="tabpanel" role="tabpanel" id="tab-chat" data-panel="chat">
<div class="card"><div class="chat-head"><h2>Chat keys</h2>
<details class="settings"><summary>Copilot settings</summary>
<p class="small muted">Briefing delivery: ${config.briefing.webhook ? `on (${e(config.briefing.kind)}, ${e(config.briefing.day)} at ${e(config.briefing.hour)}:00 UTC)` : 'off'} · Last sent: ${e(briefingDeliveryStatus().last_sent || 'never')}</p>
<div class="toolbar" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap"><div style="flex:1;min-width:220px"><label for="chat-url">Lens address for Copilot</label><input id="chat-url" placeholder="https://lens.example.com"></div><div><button type="button" id="chat-url-save">Save address</button></div></div>
<p class="small muted">The Chat page gives people this address. Leave empty for the default.</p><p id="chat-url-msg" class="small" aria-live="polite"></p>
<h3 style="font-size:15px;margin:18px 0 6px">Client privacy for AI</h3><p class="small">Client anonymisation is <b>${anonymiseOn() ? 'on' : 'off'}</b>${anonymiseOn() ? ': AI sees codenames, never client names or codes' : ''}. <a href="/replays/admin/privacy">Manage it and the codenames</a>.</p>
<h3 style="font-size:15px;margin:18px 0 6px">Approved chat apps</h3>
<p class="small muted">The Chat page warns everyone to connect their key only to these apps. One per line.</p>
<label for="chat-apps">Approved apps</label><textarea id="chat-apps" rows="3" style="width:100%;box-sizing:border-box"></textarea>
<label for="chat-note">Warning shown under the list</label><textarea id="chat-note" rows="2" style="width:100%;box-sizing:border-box"></textarea>
<div><button type="button" id="chat-policy-save">Save approved apps</button></div><p id="chat-policy-msg" class="small" aria-live="polite"></p>
</details></div><p class="small muted">Revoking a key stops its chat access immediately.</p><div class="token-toolbar"><label class="revoked-toggle small"><input type="checkbox" id="show-revoked"> <span id="show-revoked-text">Show revoked keys</span></label><span id="active-key-count" class="small muted"></span></div>
<div class="table-wrap"><table><colgroup><col style="width:27%"><col style="width:17%"><col style="width:23%"><col style="width:23%"><col style="width:10%"></colgroup><thead><tr><th scope="col">Person</th><th scope="col">Name</th><th scope="col">Created</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead><tbody id="tokens"><tr><td colspan="5">Loading tokens…</td></tr></tbody></table></div><div id="tokens-pager"></div></div>

</div>
<div class="tabpanel" role="tabpanel" id="tab-clips" data-panel="clips">
<div class="card"><h2>Clips</h2><p class="small muted" id="space"></p>
<div class="toolbar"><div><label for="clip-filter">Show</label><select id="clip-filter"><option value="">All clips</option><option value="saved">Saved only</option><option value="expiring">Deleted within 3 days</option></select></div></div>
<div class="table-wrap"><table><thead><tr><th scope="col">Clip</th><th scope="col">Who has it</th><th scope="col">Size</th><th scope="col">Kept until</th><th scope="col">Actions</th></tr></thead><tbody id="clips"><tr><td colspan="5">Loading clips…</td></tr></tbody></table></div><div id="clips-pager"></div></div>

</div>
<div class="tabpanel" role="tabpanel" id="tab-activity" data-panel="activity">
<div class="card"><h2>Activity</h2><p id="audit-msg" class="small" aria-live="polite"></p><div class="toolbar"><div><label for="filter">Search activity</label><input id="filter" placeholder="Person, action or clip"></div><span class="small muted">Activity is retained for one year.</span></div>
<div class="table-wrap"><table><colgroup><col style="width:15%"><col style="width:32%"><col style="width:19%"><col style="width:34%"></colgroup><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Details</th></tr></thead><tbody id="audit"><tr><td colspan="4">Loading activity…</td></tr></tbody></table></div><div class="audit-footer"><div id="audit-pager"></div><button type="button" id="audit-more" class="ghost" hidden>Load next 300 entries</button></div></div>
</div>
</main>
<script>
(()=>{const tabs=[...document.querySelectorAll('.tabs [data-tab]')],panels=[...document.querySelectorAll('.tabpanel')]
const show=(name,focus)=>{if(!panels.some(p=>p.dataset.panel===name))name='people';for(const t of tabs){const on=t.dataset.tab===name;t.setAttribute('aria-selected',on);t.tabIndex=on?0:-1;t.id='t-'+t.dataset.tab;t.setAttribute('aria-controls','tab-'+t.dataset.tab);if(on&&focus)t.focus()}for(const p of panels){p.hidden=p.dataset.panel!==name;p.setAttribute('aria-labelledby','t-'+p.dataset.panel)}}
tabs.forEach((t,i)=>{t.onclick=()=>{history.replaceState(null,'','#'+t.dataset.tab);show(t.dataset.tab)};t.onkeydown=e=>{const d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;e.preventDefault();const n=tabs[(i+d+tabs.length)%tabs.length];history.replaceState(null,'','#'+n.dataset.tab);show(n.dataset.tab,true)}})
show(location.hash.slice(1)||'people');addEventListener('hashchange',()=>show(location.hash.slice(1)))})()

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
const ACTIONS={'privacy.anonymise_set':'Changed client privacy','outcome.recorded':'Recorded client outcome','rescue.updated':'Updated client follow-up','signin':'Signed in','signout':'Signed out','signin.failed':'Failed sign in','recording.inspected':'Looked up a recording','clip.requested':'Asked for a clip','clip.created':'Clip made','clip.viewed':'Watched a clip','clip.downloaded':'Downloaded a clip','clip.link_shared':'Created a share link','clip.deleted':'Deleted a clip','clip.saved':'Saved a clip','clip.unsaved':'Unsaved a clip','clip.comment_added':'Commented on a clip','clip.comment_edited':'Edited a clip comment','clip.comment_deleted':'Deleted a clip comment','clips.pruned':'Old clips deleted','access.role_set':'Changed a role','access.role_removed':'Removed a role','access.settings':'Changed settings','access.system_set':'Changed System monitoring access','access.insights_set':'Changed replay insights access','access.surveys_set':'Changed Surveys page access','access.survey_role_set':'Changed a survey role','access.survey_role_reset':'Reset a survey role','access.survey_settings':'Changed survey settings','access.dashboard_role_set':'Changed a dashboard role','access.dashboard_role_reset':'Reset a dashboard role','access.dashboard_settings':'Changed dashboard settings','access.chat_url':'Changed the Copilot address','dashboard.pinned':'Pinned a dashboard','dashboard.changed':'Changed a dashboard','dashboard.deleted':'Deleted a dashboard','dashboard.shared':'Shared a dashboard','chat.token_created':'Made a chat token','chat.token_revoked':'Revoked a chat token','survey.created':'Made a survey','survey.changed':'Changed a survey','survey.launched':'Launched a survey','survey.stopped':'Stopped a survey','survey.archived':'Archived a survey'};
let S=null;
let statusSequence=0;
async function savePerson(email,url,options,message,control,previous){
 const key=control?.getAttribute('aria-label');const originalDescription=(control?.getAttribute('aria-describedby')||'').split(' ').filter(id=>!id.startsWith('control-status-')).join(' ');
 const status=control?.closest('.control-wrap')?.querySelector('.control-status')||document.createElement('span');status.className='control-status muted';status.id='control-status-'+(++statusSequence);status.setAttribute('role','status');(control?.closest('label.check')||control)?.after(status);status.textContent='Saving…';if(control?.type==='checkbox'){const text=control.closest('label.check')?.querySelector('span');if(text)text.textContent=control.dataset.permission==='role'?'Administrator':permissionState({[control.dataset.permission]:control.checked},control.dataset.permission);}
 try{await api(url,options)}catch(e){if(control?.type==='checkbox'){control.checked=previous;const text=control.closest('label.check')?.querySelector('span');if(text)text.textContent=control.dataset.permission==='role'?'Administrator':permissionState({[control.dataset.permission]:previous},control.dataset.permission);}else if(control?.tagName==='SELECT')control.value=previous;status.textContent=e.message;status.className='control-status err';control?.setAttribute('aria-describedby',(originalDescription+' '+status.id).trim());msg('people-msg',e.message);return}
 msg('people-msg',message,true);await load();const next=key?[...$('people').querySelectorAll('[aria-label]')].find(el=>el.getAttribute('aria-label')===key)||[...$('people').querySelectorAll('select')].find(el=>el.getAttribute('aria-label')==='Clip access for '+email):null;
 if(next){next.closest('.control-wrap')?.querySelector('.control-status')?.remove();(next.closest('label.check')||next).after(status);next.setAttribute('aria-describedby',originalDescription)}status.textContent='Saved';status.className='control-status ok';setTimeout(()=>{status.textContent=''},3000)
}

function identity(email){const box=document.createElement('div'),person=S?.people.find(p=>p.email===email),name=document.createElement('div');name.className='identity-name';name.textContent=person?.name||email;box.append(name);if(person?.name){const sub=document.createElement('div');sub.className='small muted';sub.textContent=email;box.append(sub)}if(email===S?.me){const badge=document.createElement('span');badge.className='badge';badge.textContent='You';name.append(badge)}return box}
const roleLabel=(id,fallback)=>({admin:'Administrator',watch:'Watch clips',download:'Download clips',none:'No access',view:'View',edit:'Manage',launch:'Launch',share:'Publish',default:'Default'}[id]||fallback);


function guardControls(){document.querySelectorAll('main button,main select,main input[type=checkbox]').forEach(el=>{for(const event of ['onclick','onchange']){const handler=el[event];if(!handler||handler.guarded)continue;const wrapped=async function(e){if(el.disabled)return;const label=el.getAttribute('aria-label'),id=el.id,focused=document.activeElement===el;el.disabled=true;try{await handler.call(el,e)}catch(err){msg('people-msg',err.message+' Reload the page to try again.')}finally{if(el.isConnected)el.disabled=false;if(focused&&(!el.isConnected||document.activeElement===el||document.activeElement===document.body)){const next=el.isConnected?el:id?$(id):label?[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===label):null;next?.focus()}}};wrapped.guarded=true;el[event]=wrapped}})}
function drawTokens(reset){const gone=S.chat_tokens.filter(t=>t.revoked_at).length;$('show-revoked-text').textContent='Include revoked ('+gone+')';const active=S.chat_tokens.length-gone;$('active-key-count').textContent=n(active,'active key');tokensPg.set($('show-revoked').checked?S.chat_tokens:S.chat_tokens.filter(t=>!t.revoked_at),reset)}
const tokensPg=makePager({mount:$('tokens-pager'),noun:'tokens',size:25,draw:slice=>{
 const tt=$('tokens');tt.innerHTML='';if(!slice.length)tt.innerHTML='<tr><td colspan="5" class="muted">No active keys. People make one on the Chat page.</td></tr>';
 slice.forEach(t=>{const tr=document.createElement('tr');cell(tr,identity(t.email));cell(tr,t.label);cell(tr,when(t.created_at),'small');cell(tr,t.revoked_at?'Revoked '+when(t.revoked_at)+' by '+t.revoked_by:when(t.last_used_at),'small');
  if(!t.revoked_at){const b=document.createElement('button');b.type='button';b.className='ghost';b.textContent='Revoke';b.setAttribute('aria-label','Revoke '+t.label+' token for '+t.email+' made '+when(t.created_at));b.onclick=async()=>{if(!confirm('Revoke the chat token '+t.label+' of '+t.email+'? Chat with it stops at once.'))return;try{await api('/replays/admin/api/chat-tokens/'+t.id,{method:'DELETE'});await load()}catch(e){msg('people-msg',e.message+' Try the action again.')}};cell(tr,b)}else cell(tr,'');tt.appendChild(tr)});

guardControls()}});
const expandedPeople=new Set();
const defaultText=role=> 'Use default — '+roleLabel(role,role);
function provenance(value,defaultRole){const source=document.createElement('div');source.className='person-source muted';source.textContent=(value?'Override · ':'')+'Default: '+roleLabel(defaultRole,defaultRole);return source}
const permissionState=(p,key)=>key==='role'?(p.role==='admin'?'Administrator':'Member'):p.role==='admin'?'Allowed':key==='system'||key==='insights'?(p[key]?'Allowed':'Not allowed'):(p[key]&&p[key]!=='none'?'Allowed':'Not allowed');
const peopleCards=()=>$('tab-people').clientWidth<=800;new ResizeObserver(()=>{for(const row of $('people').children)row._layout?.();const wrap=$('people').closest('.table-wrap');if(wrap.scrollWidth>wrap.clientWidth)wrap.tabIndex=0;else wrap.removeAttribute('tabindex')}).observe($('tab-people'));
const peoplePg=makePager({mount:$('people-pager'),noun:'people',size:10,draw:slice=>{
 const tb=$('people');tb.replaceChildren();
 slice.forEach(p=>{const tr=document.createElement('tr');tr.dataset.email=p.email;if(expandedPeople.has(p.email))tr.classList.add('editing');
  const who=identity(p.email),header=document.createElement('div');header.className='person-header';header.append(who.firstChild);who.prepend(header);cell(tr,who);
  const ph=document.createElement('div');ph.className='small muted person-meta';ph.textContent=p.posthog.includes('(owner)')?'PostHog owner':'PostHog member';who.append(ph);
  const fields=[];
  function controlWrap(node){const wrap=document.createElement('div'),status=document.createElement('span');wrap.className='control-wrap';status.className='control-status';status.setAttribute('role','status');wrap.append(node,status);return wrap}
  function accessField(label,node){if(node instanceof Element&&node.matches('select,label.check'))node=controlWrap(node);const field=document.createElement('fieldset'),legend=document.createElement('legend');legend.textContent=label;field.append(legend,node);fields.push(field);const td=cell(tr,field);td.className='access-control';return td}
  const admin=p.role==='admin';
  if(p.locked||admin&&p.email===S.me){const roleBox=document.createElement('div');roleBox.append(Object.assign(document.createElement('div'),{textContent:permissionState(p,'role')}),Object.assign(document.createElement('div'),{className:'small muted',textContent:p.locked?'Via PostHog':'Custom'}));accessField('Account role',roleBox)}else{
   const label=document.createElement('label'),cb=document.createElement('select');label.className='role-control';for(const [value,title] of [['member','Member'],['admin','Administrator']]){const option=document.createElement('option');option.value=value;option.textContent=title;cb.append(option)}cb.value=admin?'admin':'member';cb.dataset.permission='role';cb.setAttribute('aria-label','Account role for '+p.email);label.append(cb);
   cb.onchange=()=>{const on=cb.value==='admin';if(!confirm(on?'Make '+p.email+' an administrator? They can manage people and use every Lens feature, including replay insights.':p.email+' will no longer be an administrator and gets clip access: Watch clips. Other features keep their own settings.')){cb.value=admin?'admin':'member';return}return savePerson(p.email,'/replays/admin/api/person',{method:'POST',body:JSON.stringify({email:p.email,role:on?'admin':'watch'})},'Saved administrator access for '+p.email+'.',cb,admin?'admin':'member')};const roleBox=document.createElement('div');roleBox.append(controlWrap(label));roleBox.append(Object.assign(document.createElement('div'),{className:'small muted',textContent:'Custom'}));accessField('Account role',roleBox)
  }
  const sel=roleSelect(p.set_here?p.role:'default',false,true);sel.setAttribute('aria-label','Clip access for '+p.email);
  const base=document.createElement('div');
  if(admin){base.textContent=permissionState(p,'system');base.className='included';base.append(Object.assign(document.createElement('div'),{className:'small muted',textContent:'Via administrator'}))}else{base.append(controlWrap(sel),provenance(p.set_here,S.default_role));
  }
  accessField('Clip access',base);
  sel.onchange=()=>savePerson(p.email,'/replays/admin/api/person'+(sel.value==='default'?'?email='+encodeURIComponent(p.email):''),sel.value==='default'?{method:'DELETE'}:{method:'POST',body:JSON.stringify({email:p.email,role:sel.value})},'Saved clip access for '+p.email+'.',sel,p.role);
  for(const [kind,roles,defaultRole,value] of [['survey',S.survey_roles,S.survey_default_role,p.survey_role_set_here],['dashboard',S.dashboard_roles,S.dashboard_default_role,p.dashboard_role_set_here]]){
   if(p.role==='admin'){accessField(kind==='survey'?'Surveys':'Dashboards',Object.assign(document.createElement('span'),{textContent:'Allowed',className:'included',title:'Via administrator'}));continue}
   const select=document.createElement('select');select.setAttribute('aria-label',(kind==='survey'?'Survey':'Dashboard')+' role for '+p.email);[{id:'default',text:'Default'}].concat(roles).forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?defaultText(defaultRole):roleLabel(r.id,r.text);select.append(o)});select.value=value||'default';
   select.onchange=()=>savePerson(p.email,'/replays/admin/api/'+kind+'-role',{method:'POST',body:JSON.stringify({email:p.email,role:select.value})},'Saved: '+p.email+' '+kind+' role.',select,value||'default');const box=document.createElement('div');box.append(controlWrap(select),provenance(value,defaultRole));accessField(kind==='survey'?'Surveys':'Dashboards',box)}
  for(const [key,label] of [['system','System monitoring'],['insights','Replay insights']]){
   if(p.role==='admin'){accessField(label,Object.assign(document.createElement('span'),{textContent:'Allowed',className:'included',title:'Via administrator'}));continue}
   const sw=document.createElement('label');sw.className='check';const cb=document.createElement('input'),text=document.createElement('span');cb.type='checkbox';cb.setAttribute('aria-label',label+' for '+p.email);cb.checked=!!p[key];cb.dataset.permission=key;cb.setAttribute('aria-describedby',key==='system'?'system-description':'insights-description');text.textContent=permissionState(p,key);sw.append(cb,text);
   cb.onchange=()=>savePerson(p.email,'/replays/admin/api/extra-access',{method:'POST',body:JSON.stringify({email:p.email,[key]:cb.checked})},'Saved: '+label+' access for '+p.email+'.',cb,!!p[key]);const box=document.createElement('div');if(key==='insights')box.append(Object.assign(document.createElement('p'),{className:'small muted',textContent:'View findings about how clients’ people work, derived from session replays. Independent of clip access.'}));box.append(controlWrap(sw),Object.assign(document.createElement('div'),{className:'small muted',textContent:'Custom'}));accessField(label,box);
  }
  if(p.clips.clips){const c=document.createElement('div');c.className='small muted person-detail';c.textContent=n(p.clips.clips,'clip')+', '+p.clips.saved+' saved · '+mb(p.clips.bytes);who.appendChild(c)}
  function lastSeenNode(){if(!p.last_seen)return document.createTextNode('Never');const time=document.createElement('time'),date=new Date(p.last_seen);time.dateTime=date.toISOString();time.textContent=date.toLocaleDateString([], {month:'short',day:'numeric'});time.title=date.toLocaleString([], {dateStyle:'full',timeStyle:'long'});time.setAttribute('aria-label',time.title);return time}
  cell(tr,lastSeenNode(),'small');const seen=document.createElement('div');seen.className='small muted mobile-last-seen';seen.append('Last seen ',lastSeenNode());who.append(seen);
  const list=document.createElement('div');list.className='access-summary';const dl=document.createElement('dl');
  const summaryRows=[['Account role',permissionState(p,'role')],['Clip access',admin||p.role!=='none'?'Allowed':'Not allowed'],['Surveys',permissionState(p,'survey_role')],['Dashboards',permissionState(p,'dashboard_role')],['System monitoring',permissionState(p,'system')],['Replay insights',permissionState(p,'insights')]];
  for(const [label,value] of summaryRows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;const source=document.createElement('div');source.className='small muted';source.textContent=label==='Account role'?(p.locked?'Via PostHog':'Custom'):admin?'Via administrator':label==='Clip access'?(p.set_here?'Custom':'Default'):label==='Surveys'?(p.survey_role_set_here?'Custom':'Default'):label==='Dashboards'?(p.dashboard_role_set_here?'Custom':'Default'):'Custom';dd.append(source);dl.append(dt,dd)}list.append(dl);who.append(list);
  if(!p.locked&&!(admin&&p.email===S.me)){const edit=document.createElement('button');edit.type='button';edit.className='secondary-button edit-access';edit.textContent='Edit access';edit.setAttribute('aria-label','Edit access for '+p.email);edit.setAttribute('aria-expanded',tr.classList.contains('editing'));const editor=document.createElement('div');editor.className='mobile-editor';const hint=document.createElement('p');hint.className='small muted';hint.textContent='Changes save automatically';editor.append(hint);editor.id='person-editor-'+encodeURIComponent(p.email);edit.setAttribute('aria-controls',editor.id);
   const done=document.createElement('button');done.type='button';done.className='secondary-button';done.textContent='Close editor';done.onclick=()=>{tr.classList.remove('editing');expandedPeople.delete(p.email);edit.setAttribute('aria-expanded','false');edit.focus()};
   const layout=()=>{for(const [i,field] of fields.entries()){editor.append(field);const td=tr.querySelectorAll('.access-control')[i];td.replaceChildren(Object.assign(document.createElement('span'),{textContent:summaryRows[i][1]}));if(admin&&i>0)td.append(Object.assign(document.createElement('div'),{className:'small muted',textContent:'Via administrator'}))}editor.append(done);const cards=peopleCards();tr.setAttribute('role',cards?'listitem':'row');for(const td of tr.children)td.setAttribute('role',cards?'presentation':'cell');tb.setAttribute('role',cards?'list':'rowgroup');tb.closest('table').setAttribute('role',cards?'presentation':'table')};
   edit.onclick=()=>{const open=tr.classList.toggle('editing');if(open)expandedPeople.add(p.email);else expandedPeople.delete(p.email);edit.setAttribute('aria-expanded',open);if(open)editor.querySelector('select,input,button')?.focus()};who.append(edit,editor);tr._layout=layout;
  }
  tr.setAttribute('role','row');[...tr.children].forEach((td,i)=>{td.setAttribute('role','cell');td.dataset.label=['Person','Account role','Clip access','Surveys','Dashboards','System monitoring','Replay insights','Last seen in Lens'][i]});tb.appendChild(tr);if(!tr._layout)tr._layout=()=>{const cards=peopleCards();tr.setAttribute('role',cards?'listitem':'row');for(const td of tr.children)td.setAttribute('role',cards?'presentation':'cell');tb.setAttribute('role',cards?'list':'rowgroup');tb.closest('table').setAttribute('role',cards?'presentation':'table')};tr._layout()});

if(!slice.length){const tr=document.createElement('tr');const empty=cell(tr,'No people found. Change your search or grant access above.');empty.colSpan=8;empty.dataset.label='Person';tb.append(tr);}guardControls()}});
function renderPeople(keep=false){const q=$('people-filter').value.trim().toLowerCase();if(S){$('people-heading').textContent='People ('+S.people.length+')';peoplePg.set(S.people.filter(p=>(p.email+' '+p.name+' '+p.note).toLowerCase().includes(q)),keep)}}
$('people-filter').oninput=()=>renderPeople();

function roleSelect(value,disabled,withDefault=false){const s=document.createElement('select');(withDefault?[{id:'default',text:defaultText(S.default_role)},...S.roles.filter(r=>r.id!=='admin')]:S.roles.filter(r=>r.id!=='admin')).forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?r.text:roleLabel(r.id,r.text);if(r.id===value)o.selected=true;s.appendChild(o)});s.disabled=!!disabled;return s}
async function load(){const draft=!$('add-person-dialog').open?null:Object.fromEntries(['new-role','new-surveys','new-dashboards'].map(id=>[id,$(id).value]));const focused=document.activeElement;const focusLabel=focused?.getAttribute('aria-label');const previousAudit=S?.audit;S=await api('/replays/admin/api/state');if(previousAudit&&($('filter').value.trim()||previousAudit.length>300))S.audit=previousAudit;
 $('new-role').replaceChildren(...roleSelect('default',false,true).children);$('new-role').value=draft?.['new-role']||'default';
 $('default-role').innerHTML='';S.roles.filter(r=>r.id!=='admin').forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=roleLabel(r.id,r.text);if(r.id===S.default_role)o.selected=true;$('default-role').appendChild(o)});
 $('share').value=S.allow_share_links?'1':'0';
 const opts=(sel,list,value)=>{sel.replaceChildren();list.forEach(r=>{const o=document.createElement('option');o.value=r.id;o.textContent=r.id==='default'?r.text:roleLabel(r.id,r.text);if(r.id===value)o.selected=true;sel.appendChild(o)})};
 opts($('survey-default'),S.survey_roles.filter(r=>r.id!=='launch'),S.survey_default_role);opts($('survey-shared'),S.survey_roles,S.survey_shared_token_role);opts($('new-surveys'),[{id:'default',text:defaultText(S.survey_default_role)}].concat(S.survey_roles),'default');
 opts($('dashboard-default'),S.dashboard_roles.filter(r=>r.id!=='share'),S.dashboard_default_role);opts($('dashboard-shared'),S.dashboard_roles.filter(r=>r.id!=='share'),S.dashboard_shared_token_role);opts($('new-dashboards'),[{id:'default',text:defaultText(S.dashboard_default_role)}].concat(S.dashboard_roles),'default');
 if(draft)for(const [id,value] of Object.entries(draft))$(id).value=value;
 updateNewFeatures();drawTokens(true);renderPeople(true);
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
function clientLabel(value){const option=[...$('outcome-clients').options].find(o=>o.value===String(value));return option&&option.textContent!==String(value)?option.textContent+' ('+String(value)+')':String(value)}
function auditDetails(action,rest){const box=document.createElement('div'),technical=[];const labels={ip:'IP address',on:'Privacy',removed:'Outcome',decided_on:'Decision date',snooze_until:'Snoozed until',client:'Client',outcome:'Outcome',role:'Role',email:'Person',survey:'Survey',name:'Name',ticket:'Ticket',status:'Status',enabled:'Enabled'};
const order=action.startsWith('privacy.')?['on','lens','posthog','triage','codes','emails']:action.startsWith('outcome.')?['removed','outcome','client','decided_on','note']:action.startsWith('rescue.')?['status','client','snooze_until','note']:['name','survey','client','email','role','note'];const rank=k=>order.includes(k)?order.indexOf(k):order.length;for(const [key,value] of Object.entries(rest).sort(([a],[b])=>rank(a)-rank(b))){if(value==null)continue;if(/(^id$|_id$|uuid|token|survey_id)/i.test(key)||/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value))||typeof value==='object'){technical.push([key,value]);continue}const line=document.createElement('div');line.textContent=key==='on'?(value?'Enabled.':'Disabled.'):key==='removed'&&value?'Removed outcome.':(labels[key]||key.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase()))+': '+(typeof value==='boolean'?(value?'Yes':'No'):key==='outcome'?(value==='contracted'?'Reduced':String(value).replace(/^./,c=>c.toUpperCase())):key==='role'?roleLabel(value,value):key==='client'?clientLabel(value):String(value));if(/note|comment|description/i.test(key)||String(value).length>100){const d=document.createElement('details'),summary=document.createElement('summary');summary.textContent=/note|comment/i.test(key)?'Note':'More information';d.append(summary,line);box.append(d)}else box.append(line)}if(technical.length){const d=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent='Technical details';pre.className='small muted';pre.textContent=technical.map(([k,v])=>k+': '+(typeof v==='object'?JSON.stringify(v):v)).join('\\n');d.append(summary,pre);box.append(d)}return box}
function renderAudit(keep=false){auditPg.set(S.audit,keep);$('audit-more').hidden=S.audit.length%300!==0||!S.audit.length}
const auditPg=makePager({mount:$('audit-pager'),noun:'activity entries',size:25,draw:slice=>{const tb=$('audit');tb.innerHTML='';
 if(!slice.length)tb.innerHTML='<tr><td colspan="4" class="muted">No activity found. Try another search.</td></tr>';
 slice.forEach(e=>{const tr=document.createElement('tr');const time=document.createElement('time');time.dateTime=e.t;time.title=when(e.t);time.append(new Date(e.t).toLocaleDateString([], {month:'short',day:'numeric'}),document.createElement('br'),new Date(e.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));cell(tr,time,'small');cell(tr,identity(e.who));cell(tr,ACTIONS[e.action]||e.action);const {t,who,action,...rest}=e;cell(tr,auditDetails(e.action,rest),'audit-detail');tb.appendChild(tr)})}});
let searchVersion=0;
async function searchAudit(more=false){const version=++searchVersion;msg('audit-msg','Loading…',true);try{const q=$('filter').value.trim();const audit=(await api('/replays/admin/api/audit?q='+encodeURIComponent(q)+'&offset='+(more?S.audit.length:0))).audit;if(version!==searchVersion)return;S.audit=more?S.audit.concat(audit):audit;renderAudit(more);msg('audit-msg',audit.length?'Activity loaded.':'No activity found. Try another search.',true)}catch(e){if(version===searchVersion)msg('audit-msg',e.message+' Try the search again.')}}
$('audit-more').onclick=()=>searchAudit(true);
let searchTimer;$('filter').oninput=()=>{++searchVersion;clearTimeout(searchTimer);searchTimer=setTimeout(()=>searchAudit(),250)};
function updateNewFeatures(){const admin=$('new-admin').checked;$('new-clip').hidden=admin;$('add').textContent=admin?'Grant administrator access':'Grant access';$('new-features').hidden=admin;$('new-admin-features').hidden=!admin;updateEffective()}
function updateEffective(){if(!S)return;for(const kind of ['surveys','dashboards']){$('new-'+kind+'-current').textContent=$('new-'+kind).value==='default'?'Default: '+roleLabel(S[kind==='surveys'?'survey_default_role':'dashboard_default_role'],'No access'):''}$('new-effective').textContent=''}
for(const id of ['new-role','new-surveys','new-dashboards','new-insights','new-system'])$(id).addEventListener('change',updateEffective);
$('new-admin').onchange=updateNewFeatures;$('new-member').onchange=updateNewFeatures;
$('new-email').oninput=()=>{$('new-email-error').textContent='';$('new-email').removeAttribute('aria-invalid')};
const addBody=document.querySelector('.add-body'),scrollCue=document.querySelector('.add-scroll-cue');function updateScrollCue(){const more=addBody.scrollHeight-addBody.clientHeight-addBody.scrollTop>2;scrollCue.hidden=!more;document.querySelector('.add-actions').style.boxShadow=more?'0 -6px 12px rgb(0 0 0 / 6%)':'none'}addBody.addEventListener('scroll',updateScrollCue);new ResizeObserver(updateScrollCue).observe(addBody);
function closeAddPerson(){$('add-person-dialog').close()}
$('show-add-person').onclick=()=>{$('add-person-error').textContent='';if(!$('new-email').value)$('new-role').value='default';updateNewFeatures();$('add-person-dialog').showModal();$('new-email').focus()};
$('cancel-add-person').onclick=closeAddPerson;$('close-add-person').onclick=closeAddPerson;
$('add-person-dialog').addEventListener('close',()=>$('show-add-person').focus());
$('manage-access-defaults').onclick=event=>{event.preventDefault();$('access-defaults').open=true;$('access-defaults').scrollIntoView({behavior:'smooth'});$('access-defaults').querySelector('summary').focus()};
$('add-person-form').onsubmit=async event=>{event.preventDefault();if($('add').disabled)return;$('add').disabled=true;const email=$('new-email').value.trim();if(!$('new-email').checkValidity()||!email){$('new-email-error').textContent='Enter a valid email address.';$('new-email').setAttribute('aria-invalid','true');$('new-email').focus();$('add').disabled=false;return;}$('add').textContent='Granting access…';const clipValue=$('new-role').value;try{if($('new-admin').checked)$('new-role').append(Object.assign(document.createElement('option'),{value:'admin',textContent:'Administrator',selected:true}));await api('/replays/admin/api/person',{method:'POST',body:JSON.stringify({email,role:$('new-admin').checked?'admin':$('new-role').value==='default'?S.default_role:$('new-role').value,system:$('new-system').checked,insights:$('new-insights').checked,dashboard_role:$('new-dashboards').value==='default'?'':$('new-dashboards').value,survey_role:$('new-surveys').value==='default'?'':$('new-surveys').value})});if(!$('new-admin').checked&&$('new-role').value==='default')await api('/replays/admin/api/person?email='+encodeURIComponent(email),{method:'DELETE'});$('new-email').value='';$('new-admin').checked=false;$('new-member').checked=true;$('new-role').value='default';$('new-system').checked=false;$('new-insights').checked=false;$('new-surveys').value='default';$('new-dashboards').value='default';msg('people-msg','Granted Lens access for '+email+'.',true);closeAddPerson();await load()}catch(e){$('add-person-error').textContent=e.message;$('add-person-error').focus()}finally{if($('new-role').value==='admin')$('new-role').value=clipValue;$('new-role').querySelectorAll('option[value=admin]').forEach(option=>option.remove());$('add').disabled=false;updateNewFeatures()}};
$('show-revoked').onchange=()=>drawTokens(true);
$('chat-url').value=${JSON.stringify(chatUrl()).replace(/</g, '\\u003c')};
{const p=${JSON.stringify(chatPolicy()).replace(/</g, '\\u003c')};$('chat-apps').value=p.apps.join('\\n');$('chat-note').value=p.note}
$('chat-policy-save').onclick=async()=>{try{const r=await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({chat_apps:$('chat-apps').value,chat_note:$('chat-note').value})});$('chat-apps').value=r.apps.join('\\n');$('chat-note').value=r.note;msg('chat-policy-msg','Saved. The Chat page shows this now.',true)}catch(e){msg('chat-policy-msg',e.message)}};
$('chat-url-save').onclick=async()=>{try{const r=await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({chat_url:$('chat-url').value})});$('chat-url').value=r.chat_url;msg('chat-url-msg','Saved.',true)}catch(e){msg('chat-url-msg',e.message)}};
$('default-role').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({default_role:$('default-role').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('share').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({allow_share_links:$('share').value==='1'})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('survey-default').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_default_role:$('survey-default').value})});msg('settings-msg','Saved.',true);await load()}catch(e){msg('settings-msg',e.message)}};
$('survey-shared').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({survey_shared_token_role:$('survey-shared').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
$('dashboard-default').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({dashboard_default_role:$('dashboard-default').value})});msg('settings-msg','Saved.',true);await load()}catch(e){msg('settings-msg',e.message)}};
$('dashboard-shared').onchange=async()=>{try{await api('/replays/admin/api/settings',{method:'POST',body:JSON.stringify({dashboard_shared_token_role:$('dashboard-shared').value})});msg('settings-msg','Saved.',true)}catch(e){msg('settings-msg',e.message)}};
guardControls();
async function loadOutcomes(){const rows=await api('/replays/admin/api/outcomes');const body=$('outcome-rows');body.replaceChildren();if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.className='muted';td.textContent='No outcomes recorded. Record a client decision above to compare it with earlier signals.';tr.append(td);body.append(tr)}for(const o of rows){const tr=document.createElement('tr');for(const key of ['client','outcome','decided_on','note']){const td=document.createElement('td');td.textContent=key==='outcome'?(o[key]==='contracted'?'Reduced':o[key].charAt(0).toUpperCase()+o[key].slice(1)):o[key];tr.append(td)}const td=document.createElement('td');for(const action of ['Edit','Remove']){const b=document.createElement('button');b.type='button';b.textContent=action;b.setAttribute('aria-label',action+' outcome for '+o.client);b.onclick=async()=>{try{if(action==='Edit'){for(const key of ['client','outcome','decided_on','note'])$('outcome-form').elements.namedItem(key).value=o[key];$('outcome-client').focus()}else{await api('/replays/admin/api/outcomes',{method:'DELETE',body:JSON.stringify({client:o.client})});await loadOutcomes()}}catch(e){$('outcome-msg').textContent=e.message}};td.append(b)}tr.append(td);body.append(tr)}}
$('outcome-client').oninput=()=>{const field=$('outcome-client'),option=[...$('outcome-clients').options].find(o=>o.value===field.value);let helper=$('resolved-client');if(!helper){helper=document.createElement('div');helper.id='resolved-client';helper.className='small muted';field.parentElement.append(helper)}helper.textContent=option?option.textContent+' · '+option.value:''};
$('outcome-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;try{await api('/replays/admin/api/outcomes',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});$('outcome-msg').textContent='Outcome saved.';form.reset();await loadOutcomes()}catch(err){$('outcome-msg').textContent=err.message}}
loadOutcomes().catch(e=>{$('outcome-msg').textContent=e.message})
load().catch(e=>{msg('people-msg',e.message+' Reload the page to try again.');$('people').innerHTML='<tr><td colspan="8" class="err"></td></tr>';$('people').querySelector('td').textContent=e.message});
</script></body></html>`
}
