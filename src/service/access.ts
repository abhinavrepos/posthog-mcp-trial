// Who may do what with replay clips.
//
// PostHog answers "who is this?": people sign in with their PostHog account (password, 2FA and
// deactivation all stay in PostHog), and PostHog owners and admins of the organization that owns
// the project are always admins here. This service answers "what may they do?": each person
// gets a role in the database (run/triage.db, see core/db.ts), set on the admin page.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { SQLInputValue } from 'node:sqlite'

import { config } from '../core/config.ts'
import { all, getSetting, one, run, setSetting, tx } from '../core/db.ts'

export type Role = 'none' | 'watch' | 'download' | 'admin'
export const ROLES: Role[] = ['none', 'watch', 'download', 'admin']
const RANK: Record<Role, number> = { none: 0, watch: 1, download: 2, admin: 3 }
export const can = (role: Role, needed: Role) => RANK[role] >= RANK[needed]

export const ROLE_TEXT: Record<Role, string> = {
    none: 'No access',
    watch: 'Watch clips',
    download: 'Watch, download and share',
    admin: 'Admin (manage access)',
}

export interface Person {
    role: Role
    note?: string
    updated_by: string
    updated_at: string
}
export interface AccessFile {
    default_role: Role // for PostHog users not listed
    allow_share_links: boolean
    people: Record<string, Person>
}

export function loadAccess(): AccessFile {
    const people: Record<string, Person> = {}
    for (const p of all<{ email: string; role: Role; note: string | null; updated_by: string; updated_at: string }>('SELECT * FROM people ORDER BY email')) {
        people[p.email] = { role: p.role, note: p.note ?? undefined, updated_by: p.updated_by, updated_at: p.updated_at }
    }
    return { default_role: getSetting<Role>('default_role', 'none'), allow_share_links: getSetting('allow_share_links', true), people }
}

export function personRole(email: string): Role | undefined {
    return one<{ role: Role }>('SELECT role FROM people WHERE email = ?', email.toLowerCase())?.role
}

/** Gives a person a role and records who did it, in one transaction. */
export function setPerson(email: string, role: Role, by: string, note?: string): void {
    tx(() => {
        const before = personRole(email)
        run(
            `INSERT INTO people (email, role, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (email) DO UPDATE SET role = excluded.role, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
            email.toLowerCase(), role, note ?? null, by, new Date().toISOString()
        )
        audit(by, 'access.role_set', { person: email.toLowerCase(), role, before: before ?? null })
    })
}

export function removePerson(email: string, by: string): void {
    tx(() => {
        const before = personRole(email)
        run('DELETE FROM people WHERE email = ?', email.toLowerCase())
        audit(by, 'access.role_removed', { person: email.toLowerCase(), before: before ?? null })
    })
}

// ------------------------------------------------------------------ the System page
// Admins always see it. Anyone else only when an admin ticked "System page" for them on the admin
// page. It is separate from the clip role: someone can see the System page with "No access" to clips.

export function systemViewers(): Map<string, { updated_by: string; updated_at: string }> {
    return new Map(all<{ email: string; updated_by: string; updated_at: string }>('SELECT * FROM system_viewers').map((r) => [r.email, r]))
}

export function hasSystemGrant(email: string): boolean {
    return !!one('SELECT 1 FROM system_viewers WHERE email = ?', email.toLowerCase())
}

export const canSeeSystem = (v: Pick<Viewer, 'role' | 'system'>) => can(v.role, 'admin') || v.system === true

// ------------------------------------------------------------------ replay insights
// How clients' people actually work, read from session replays (src/core/experience.ts): the Client story
// section and the chat tools client_experience and friction_hotspots. Admins always; anyone else only when
// an admin ticked "Replay insights" for them. Never through the shared chat token, never by a role change.
export const REPLAY_INSIGHT_TOOLS = ['client_experience', 'friction_hotspots']
export function insightPeople(): Map<string, { updated_by: string; updated_at: string }> {
    return new Map(all<{ email: string; updated_by: string; updated_at: string }>('SELECT * FROM replay_insight_people').map((r) => [r.email, r]))
}
export function hasInsightGrant(email: string): boolean {
    return !!one('SELECT 1 FROM replay_insight_people WHERE email = ?', email.toLowerCase())
}
export const canSeeReplayInsights = (v: Pick<Viewer, 'role' | 'insights'>) => can(v.role, 'admin') || v.insights === true
/** Lets a person see replay insights, or stops it, and records who did it. */
export function setInsightAccess(email: string, on: boolean, by: string): void {
    const e = email.toLowerCase()
    tx(() => {
        const before = hasInsightGrant(e)
        if (on) run('INSERT INTO replay_insight_people (email, updated_by, updated_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at', e, by, new Date().toISOString())
        else run('DELETE FROM replay_insight_people WHERE email = ?', e)
        if (before !== on) audit(by, 'access.insights_set', { person: e, insights: on })
    })
}

// ------------------------------------------------------------------ surveys
// Survey roles are separate from the clip role. Each includes the ones before it:
//   none    no Surveys page and no survey tools in chat
//   view    the Surveys page and results; list_surveys and survey_results in chat
//   edit    also design and save surveys (drafts, and changes to Lens surveys)
//   launch  also launch, stop and archive: what reaches Reval users
// Admins always have launch. People not listed get the default an admin sets (none unless changed).
export type SurveyRole = 'none' | 'view' | 'edit' | 'launch'
export const SURVEY_ROLES: SurveyRole[] = ['none', 'view', 'edit', 'launch']
const SURVEY_RANK: Record<SurveyRole, number> = { none: 0, view: 1, edit: 2, launch: 3 }
export const canSurvey = (role: SurveyRole | undefined, needed: SurveyRole) => SURVEY_RANK[role || 'none'] >= SURVEY_RANK[needed]
export const SURVEY_ROLE_TEXT: Record<SurveyRole, string> = {
    none: 'No access',
    view: 'See surveys and results',
    edit: 'Also make and change surveys',
    launch: 'Also launch and stop surveys',
}
const isSurveyRole = (r: unknown): r is SurveyRole => SURVEY_ROLES.includes(r as SurveyRole)

export function surveyPeople(): Map<string, { role: SurveyRole; updated_by: string; updated_at: string }> {
    return new Map(all<{ email: string; role: SurveyRole; updated_by: string; updated_at: string }>('SELECT * FROM survey_people').map((r) => [r.email, r]))
}
export const defaultSurveyRole = (): SurveyRole => {
    const r = getSetting<string>('survey_default_role', 'none')
    return isSurveyRole(r) && r !== 'launch' ? r : 'none'
}
/** The survey role chat gets with the shared team token (MCP_TOKEN), which says nothing about who asks. */
export const sharedTokenSurveyRole = (): SurveyRole => {
    const r = getSetting<string>('survey_shared_token_role', 'view')
    return isSurveyRole(r) ? r : 'none'
}
export function surveyRoleOf(email: string, lensRole: Role): SurveyRole {
    if (can(lensRole, 'admin')) return 'launch'
    const row = one<{ role: string }>('SELECT role FROM survey_people WHERE email = ?', email.toLowerCase())
    return row && isSurveyRole(row.role) ? row.role : defaultSurveyRole()
}
export const canUseSurveys = (v: Pick<Viewer, 'role' | 'surveys'>) => can(v.role, 'admin') || canSurvey(v.surveys, 'view')

/** Sets a person's survey role (none removes the row, so the default applies... unless the default is higher). */
export function setSurveyRole(email: string, role: SurveyRole, by: string): void {
    const e = email.toLowerCase()
    if (!isSurveyRole(role)) throw new Error('unknown survey role')
    tx(() => {
        const before = one<{ role: string }>('SELECT role FROM survey_people WHERE email = ?', e)?.role ?? null
        run('INSERT INTO survey_people (email, role, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role, updated_by = excluded.updated_by, updated_at = excluded.updated_at', e, role, by, new Date().toISOString())
        if (before !== role) audit(by, 'access.survey_role_set', { person: e, survey_role: role, before })
    })
}
export function resetSurveyRole(email: string, by: string): void {
    const e = email.toLowerCase()
    tx(() => {
        const before = one<{ role: string }>('SELECT role FROM survey_people WHERE email = ?', e)?.role
        run('DELETE FROM survey_people WHERE email = ?', e)
        if (before) audit(by, 'access.survey_role_reset', { person: e, before })
    })
}
/** The Lens address people put in their chat app (Copilot). Admins set it; default PUBLIC_URL. */
export const chatUrl = (): string => getSetting<string>('chat_url', '') || config.service.publicUrl
export function setChatUrl(value: unknown, by: string): string {
    const raw = String(value ?? '').trim().replace(/\/+$/, '')
    if (raw) {
        let u: URL
        try {
            u = new URL(raw)
        } catch {
            throw new Error('Give a full address, e.g. https://lens.example.com')
        }
        if (!/^https?:$/.test(u.protocol) || u.search || u.hash) throw new Error('Give a full address, e.g. https://lens.example.com')
    }
    tx(() => {
        setSetting('chat_url', raw)
        audit(by, 'access.chat_url', { url: raw || '(default)' })
    })
    return chatUrl()
}
/** Which chat apps may be connected with a Lens key. Central admins edit it; the Chat page shows it as a warning. */
export const DEFAULT_CHAT_APPS = ['GitHub Copilot with your ION Microsoft enterprise account']
export const DEFAULT_CHAT_NOTE = 'This is ION enterprise data. Other AI agents and chat apps are not approved: do not connect them with your key.'
export const chatPolicy = (): { apps: string[]; note: string } => ({
    apps: getSetting<string[]>('chat_apps', []).length ? getSetting<string[]>('chat_apps', []) : DEFAULT_CHAT_APPS,
    note: getSetting<string>('chat_note', '') || DEFAULT_CHAT_NOTE,
})
export function setChatPolicy(change: { apps?: unknown; note?: unknown }, by: string): { apps: string[]; note: string } {
    const apps = change.apps === undefined ? undefined : (Array.isArray(change.apps) ? change.apps : String(change.apps).split('\n')).map(a => String(a).trim()).filter(Boolean)
    if (apps && apps.length > 10) throw new Error('List at most 10 approved apps.')
    if (apps?.some(a => a.length > 100)) throw new Error('Keep each approved app under 100 characters.')
    const note = change.note === undefined ? undefined : String(change.note).trim()
    if (note && note.length > 400) throw new Error('Keep the warning under 400 characters.')
    tx(() => {
        if (apps) setSetting('chat_apps', apps)
        if (note !== undefined) setSetting('chat_note', note)
        audit(by, 'access.chat_policy', { apps: apps ?? '(unchanged)', note: note === undefined ? '(unchanged)' : note || '(default)' })
    })
    return chatPolicy()
}
export function setSurveySettings(change: { default_role?: SurveyRole; shared_token_role?: SurveyRole }, by: string): void {
    tx(() => {
        if (change.default_role !== undefined) {
            if (!isSurveyRole(change.default_role) || change.default_role === 'launch') throw new Error('The default survey role cannot be launch.')
            setSetting('survey_default_role', change.default_role)
        }
        if (change.shared_token_role !== undefined) {
            if (!isSurveyRole(change.shared_token_role)) throw new Error('unknown survey role')
            setSetting('survey_shared_token_role', change.shared_token_role)
        }
        audit(by, 'access.survey_settings', { default_role: defaultSurveyRole(), shared_token_role: sharedTokenSurveyRole() })
    })
}

// ------------------------------------------------------------------ dashboards
// Dashboard roles, separate from the clip and survey roles:
//   none   no Dashboards page and no dashboard tools in chat
//   view   the task map and flow time views, and dashboards shared with them
//   share  also pin dashboards (from chat or the page) and share them with people
// Admins always have share, and see every pinned dashboard. Others get the default (none unless changed).
export type DashboardRole = 'none' | 'view' | 'share'
export const DASHBOARD_ROLES: DashboardRole[] = ['none', 'view', 'share']
const DASHBOARD_RANK: Record<DashboardRole, number> = { none: 0, view: 1, share: 2 }
export const canDashboard = (role: DashboardRole | undefined, needed: DashboardRole) => DASHBOARD_RANK[role || 'none'] >= DASHBOARD_RANK[needed]
export const DASHBOARD_ROLE_TEXT: Record<DashboardRole, string> = { none: 'No access', view: 'See dashboards', share: 'Also pin and share dashboards' }
const isDashboardRole = (r: unknown): r is DashboardRole => DASHBOARD_ROLES.includes(r as DashboardRole)
export const defaultDashboardRole = (): DashboardRole => {
    const r = getSetting<string>('dashboard_default_role', 'none')
    return isDashboardRole(r) && r !== 'share' ? r : 'none'
}
export const sharedTokenDashboardRole = (): DashboardRole => {
    const r = getSetting<string>('dashboard_shared_token_role', 'view')
    return isDashboardRole(r) && r !== 'share' ? r : 'none' // pinning needs to know who pins
}
export function dashboardRoleOf(email: string, lensRole: Role): DashboardRole {
    if (can(lensRole, 'admin')) return 'share'
    const row = one<{ role: string }>('SELECT role FROM dashboard_people WHERE email = ?', email.toLowerCase())
    return row && isDashboardRole(row.role) ? row.role : defaultDashboardRole()
}
export function dashboardPeople(): Map<string, { role: DashboardRole; updated_by: string; updated_at: string }> {
    return new Map(all<{ email: string; role: DashboardRole; updated_by: string; updated_at: string }>('SELECT * FROM dashboard_people').map((r) => [r.email, r]))
}
export function setDashboardRole(email: string, role: DashboardRole, by: string): void {
    const e = email.toLowerCase()
    if (!isDashboardRole(role)) throw new Error('unknown dashboard role')
    tx(() => {
        const before = one<{ role: string }>('SELECT role FROM dashboard_people WHERE email = ?', e)?.role ?? null
        run('INSERT INTO dashboard_people (email, role, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role, updated_by = excluded.updated_by, updated_at = excluded.updated_at', e, role, by, new Date().toISOString())
        if (before !== role) audit(by, 'access.dashboard_role_set', { person: e, dashboard_role: role, before })
    })
}
export function resetDashboardRole(email: string, by: string): void {
    const e = email.toLowerCase()
    tx(() => {
        const before = one<{ role: string }>('SELECT role FROM dashboard_people WHERE email = ?', e)?.role
        run('DELETE FROM dashboard_people WHERE email = ?', e)
        if (before) audit(by, 'access.dashboard_role_reset', { person: e, before })
    })
}
export function setDashboardSettings(change: { default_role?: DashboardRole; shared_token_role?: DashboardRole }, by: string): void {
    tx(() => {
        if (change.default_role !== undefined) {
            if (!isDashboardRole(change.default_role) || change.default_role === 'share') throw new Error('The default dashboard role cannot be share.')
            setSetting('dashboard_default_role', change.default_role)
        }
        if (change.shared_token_role !== undefined) {
            if (!isDashboardRole(change.shared_token_role) || change.shared_token_role === 'share') throw new Error('The shared team token cannot pin or share: pinning needs to know who pins.')
            setSetting('dashboard_shared_token_role', change.shared_token_role)
        }
        audit(by, 'access.dashboard_settings', { default_role: defaultDashboardRole(), shared_token_role: sharedTokenDashboardRole() })
    })
}
export const canUseDashboards = (v: Pick<Viewer, 'role' | 'dashboards'>) => can(v.role, 'admin') || canDashboard(v.dashboards, 'view')

// ------------------------------------------------------------------ personal chat tokens
// A person makes their own token on the Connect page; chat sends it instead of the shared MCP_TOKEN,
// so Lens knows who asks and applies their survey role. Only a SHA-256 of the token is stored.
export interface McpToken { id: string; email: string; label: string; posthog_admin: boolean; created_at: string; last_used_at: string | null; revoked_at: string | null; revoked_by: string | null }
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex')
const tokenRow = (r: Record<string, unknown>): McpToken => ({ id: String(r.id), email: String(r.email), label: String(r.label), posthog_admin: !!r.posthog_admin, created_at: String(r.created_at), last_used_at: (r.last_used_at as string) ?? null, revoked_at: (r.revoked_at as string) ?? null, revoked_by: (r.revoked_by as string) ?? null })

export function createMcpToken(v: Pick<Viewer, 'email' | 'posthog_admin'>, label: string): { token: string; id: string } {
    const token = `lens_${randomBytes(24).toString('base64url')}`
    const id = randomBytes(6).toString('hex')
    const name = label.trim().slice(0, 60) || 'Chat'
    tx(() => {
        if ((one<{ n: number }>('SELECT COUNT(*) AS n FROM mcp_tokens WHERE email = ? AND revoked_at IS NULL', v.email)?.n ?? 0) >= 10) throw new Error('At most 10 active tokens per person. Revoke one first.')
        run('INSERT INTO mcp_tokens (id, email, hash, label, posthog_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, v.email.toLowerCase(), tokenHash(token), name, v.posthog_admin ? 1 : 0, new Date().toISOString())
        audit(v.email, 'chat.token_created', { token: id, label: name })
    })
    return { token, id }
}
export function listMcpTokens(email?: string): McpToken[] {
    const rows = email ? all<Record<string, unknown>>('SELECT * FROM mcp_tokens WHERE email = ? ORDER BY created_at DESC', email.toLowerCase()) : all<Record<string, unknown>>('SELECT * FROM mcp_tokens ORDER BY created_at DESC LIMIT 1000')
    return rows.map(tokenRow)
}
export function revokeMcpToken(id: string, by: string, onlyFor?: string): boolean {
    return tx(() => {
        const row = one<Record<string, unknown>>('SELECT * FROM mcp_tokens WHERE id = ?', id)
        if (!row || row.revoked_at || (onlyFor && row.email !== onlyFor.toLowerCase())) return false
        run('UPDATE mcp_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?', new Date().toISOString(), by, id)
        audit(by, 'chat.token_revoked', { token: id, person: row.email })
        return true
    })
}

/** Who a chat request is from: the shared token, or a person's own token. Undefined: refuse. */
export interface ChatCaller { who: string; email?: string; shared: boolean; surveyRole: SurveyRole; dashboardRole: DashboardRole; admin: boolean; insights: boolean }
export const ADMIN_FLAG_DAYS = 14
export function chatCaller(bearer: string | undefined, sharedToken: string): ChatCaller | undefined {
    if (!bearer) return undefined
    if (sharedToken) {
        const a = Buffer.from(bearer), b = Buffer.from(sharedToken)
        if (a.length === b.length && timingSafeEqual(a, b)) return { who: 'mcp (shared token)', shared: true, surveyRole: sharedTokenSurveyRole(), dashboardRole: sharedTokenDashboardRole(), admin: false, insights: false }
    }
    if (!/^lens_[A-Za-z0-9_-]{20,64}$/.test(bearer)) return undefined
    const row = one<Record<string, unknown>>('SELECT * FROM mcp_tokens WHERE hash = ? AND revoked_at IS NULL', tokenHash(bearer))
    if (!row) return undefined
    const t = tokenRow(row)
    // Personal keys require the same current access as the Connect page. PostHog-admin authority comes
    // from the owner's last sign-in to Lens (a key cannot ask PostHog), so it counts only while that is
    // recent: a demoted or departed PostHog admin keeps it at most ADMIN_FLAG_DAYS.
    const seen = Date.parse(String(row.posthog_admin_seen_at || row.created_at))
    const adminFresh = t.posthog_admin && Date.now() - seen < ADMIN_FLAG_DAYS * 86_400_000
    const lensRole: Role = adminFresh ? 'admin' : roleOf(t.email, false)
    if (!can(lensRole, 'watch') && !canSurvey(surveyRoleOf(t.email, lensRole), 'view') && !canDashboard(dashboardRoleOf(t.email, lensRole), 'view')) return undefined
    const now = new Date().toISOString()
    if (!t.last_used_at || Date.parse(now) - Date.parse(t.last_used_at) > 60_000) run('UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?', now, t.id)
    return { who: t.email, email: t.email, shared: false, surveyRole: surveyRoleOf(t.email, lensRole), dashboardRole: dashboardRoleOf(t.email, lensRole), admin: can(lensRole, 'admin'), insights: can(lensRole, 'admin') || hasInsightGrant(t.email) }
}

/** Lets a person see the System page, or stops it, and records who did it. */
export function setSystemAccess(email: string, on: boolean, by: string): void {
    const e = email.toLowerCase()
    tx(() => {
        const before = hasSystemGrant(e)
        if (on) run('INSERT INTO system_viewers (email, updated_by, updated_at) VALUES (?, ?, ?) ON CONFLICT (email) DO UPDATE SET updated_by = excluded.updated_by, updated_at = excluded.updated_at', e, by, new Date().toISOString())
        else run('DELETE FROM system_viewers WHERE email = ?', e)
        if (before !== on) audit(by, 'access.system_set', { person: e, system: on })
    })
}

export function setAccessSettings(change: { default_role?: Role; allow_share_links?: boolean }, by: string): void {
    tx(() => {
        if (change.default_role !== undefined) setSetting('default_role', change.default_role)
        if (change.allow_share_links !== undefined) setSetting('allow_share_links', change.allow_share_links)
        const a = loadAccess()
        audit(by, 'access.settings', { default_role: a.default_role, allow_share_links: a.allow_share_links })
    })
}

export function audit(who: string, action: string, details: Record<string, unknown> = {}): void {
    try {
        run('INSERT INTO audit (t, who, action, details) VALUES (?, ?, ?, ?)', new Date().toISOString(), who, action, JSON.stringify(details))
    } catch (e) {
        console.error(JSON.stringify({ t: new Date().toISOString(), msg: 'audit write failed', error: (e as Error).message }))
    }
}

export interface AuditQuery {
    limit?: number
    who?: string
    action?: string // prefix, e.g. "clip." or "signin"
    since?: string
    q?: string // free text: matches the person, the action or any detail
}
export function readAudit(q: AuditQuery | number = {}): Record<string, unknown>[] {
    const { limit = 300, who, action, since, q: text } = typeof q === 'number' ? { limit: q } : q
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (who) where.push('who = ?'), params.push(who.toLowerCase())
    if (action) where.push("action LIKE ? ESCAPE '\\'"), params.push(action.replace(/[\\%_]/g, (c) => '\\' + c) + '%')
    if (since) where.push('t >= ?'), params.push(since)
    if (text?.trim()) {
        const like = '%' + text.trim().toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%'
        where.push("(LOWER(who) LIKE ? ESCAPE '\\' OR LOWER(action) LIKE ? ESCAPE '\\' OR LOWER(details) LIKE ? ESCAPE '\\')")
        params.push(like, like, like)
    }
    const rows = all<{ t: string; who: string; action: string; details: string }>(
        `SELECT t, who, action, details FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
        ...params,
        Math.min(Math.max(1, limit), 100_000)
    )
    return rows.map((r) => ({ t: r.t, who: r.who, action: r.action, ...(JSON.parse(r.details) as Record<string, unknown>) }))
}

/** The last time each person did anything, from the audit table. */
export function lastSeen(): Map<string, string> {
    return new Map(all<{ who: string; t: string }>('SELECT who, MAX(t) AS t FROM audit GROUP BY who').map((r) => [r.who, r.t]))
}

// ------------------------------------------------------------------ PostHog identity
export interface Viewer {
    email: string
    name: string
    role: Role
    posthog_admin: boolean // owner or admin of the organization that owns the project
    in_replay_project: boolean // can open the project (and so every replay) in PostHog itself
    system?: boolean // an admin let this person see the System page (admins see it anyway)
    surveys?: SurveyRole // this person's survey role (admins: launch)
    dashboards?: DashboardRole // this person's dashboard role (admins: share)
    insights?: boolean // an admin let this person see replay insights (admins see them anyway)
    session: string // PostHog session id, used to call PostHog on the admin's behalf
}

function cookie(req: IncomingMessage, name: string): string | undefined {
    for (const part of String(req.headers.cookie || '').split(';')) {
        const [k, ...v] = part.trim().split('=')
        if (k === name) return decodeURIComponent(v.join('='))
    }
    return undefined
}
export const sessionCookie = (req: IncomingMessage) => cookie(req, 'sessionid')
export const csrfCookie = (req: IncomingMessage) => cookie(req, 'posthog_csrftoken')

let projectOrg: string | undefined
async function replayProjectOrg(): Promise<string | undefined> {
    if (projectOrg) return projectOrg
    const res = await fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/`, {
        headers: { authorization: `Bearer ${config.posthog.personalApiKey}` },
        signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) projectOrg = ((await res.json()) as { organization?: string }).organization
    return projectOrg
}

interface Identity {
    email: string
    name: string
    posthog_admin: boolean
    in_replay_project: boolean
}
const cache = new Map<string, { at: number; id?: Identity }>()

/** Asks PostHog who owns this session. Cached for a minute, so removals apply within a minute. */
async function identity(session: string): Promise<Identity | undefined> {
    const key = createHash('sha256').update(session).digest('hex')
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit.id
    let id: Identity | undefined
    try {
        const headers = { cookie: `sessionid=${session}`, accept: 'application/json' }
        const [me, project, org] = await Promise.all([
            fetch(`${config.posthog.host}/api/users/@me/`, { headers, signal: AbortSignal.timeout(10_000) }),
            fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/`, { headers, signal: AbortSignal.timeout(10_000) }),
            replayProjectOrg(),
        ])
        if (me.ok) {
            const u = (await me.json()) as { email: string; first_name?: string; is_active?: boolean; organizations?: { id: string; membership_level: number }[] }
            const level = u.organizations?.find((o) => o.id === org)?.membership_level ?? 0
            if (u.is_active !== false) {
                id = { email: u.email.toLowerCase(), name: u.first_name || u.email, posthog_admin: level >= 8, in_replay_project: project.ok }
            }
        }
    } catch {
        id = undefined
    }
    cache.set(key, { at: Date.now(), id })
    if (cache.size > 2000) cache.clear()
    return id
}

export function forgetSession(session: string): void {
    cache.delete(createHash('sha256').update(session).digest('hex'))
}

export function roleOf(email: string, posthogAdmin: boolean, a = loadAccess()): Role {
    if (posthogAdmin) return 'admin'
    return a.people[email.toLowerCase()]?.role ?? a.default_role
}

export async function currentViewer(req: IncomingMessage): Promise<Viewer | undefined> {
    const session = sessionCookie(req)
    if (!session || !/^[A-Za-z0-9:._-]{8,200}$/.test(session)) return undefined
    const id = await identity(session)
    if (!id) return undefined
    // Confirms (or drops) the PostHog-admin flag on this person's keys; at most once an hour per person.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    run('UPDATE mcp_tokens SET posthog_admin = ?, posthog_admin_seen_at = ? WHERE email = ? AND revoked_at IS NULL AND (posthog_admin != ? OR posthog_admin_seen_at IS NULL OR posthog_admin_seen_at < ?)', id.posthog_admin ? 1 : 0, new Date().toISOString(), id.email, id.posthog_admin ? 1 : 0, hourAgo)
    return { ...id, role: roleOf(id.email, id.posthog_admin), system: hasSystemGrant(id.email), insights: hasInsightGrant(id.email), surveys: surveyRoleOf(id.email, roleOf(id.email, id.posthog_admin)), dashboards: dashboardRoleOf(id.email, roleOf(id.email, id.posthog_admin)), session }
}

// ------------------------------------------------------------------ sign in and out through PostHog
const attempts = new Map<string, number[]>()
const emailAttempts = new Map<string, number[]>()
const recentFailures = (map: Map<string, number[]>, key: string) => (map.get(key) || []).filter(t => Date.now() - t < 10 * 60_000)
// Every attempt is counted when it starts (so many guesses sent at once cannot all pass before the
// first failure is recorded); a successful one is taken off again, so busy offices sharing one address
// are only ever limited by failures.
function countAttempt(ip: string, email: string): number {
    const at = Date.now()
    for (const [map, key] of [[attempts, ip], [emailAttempts, email]] as const) {
        const recent = recentFailures(map, key)
        map.delete(key)
        map.set(key, [...recent, at])
        if (map.size > 10_000) map.delete(map.keys().next().value!)
    }
    return at
}
function succeeded(ip: string, email: string, at: number): void {
    // Only this attempt's own entry in each counter: others (failures, or guesses still in flight from
    // other addresses) may carry the same millisecond and must keep counting.
    for (const [map, key] of [[attempts, ip], [emailAttempts, email]] as const) {
        const list = map.get(key) || [], i = list.lastIndexOf(at)
        if (i >= 0) list.splice(i, 1)
        if (!list.length) map.delete(key)
    }
}

/** Signs in with a PostHog account. Returns the PostHog session id, or a reason. */
export async function signIn(ip: string, email: string, password: string): Promise<{ session?: string; csrf?: string; error?: string }> {
    email = email.trim().toLowerCase()
    if (recentFailures(attempts, ip).length >= 20 || recentFailures(emailAttempts, email).length >= 10) return { error: 'Too many attempts. Wait 10 minutes.' }
    const at = countAttempt(ip, email)
    const res = await fetch(`${config.posthog.host}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
    })
    const body = (await res.json().catch(() => ({}))) as { code?: string; detail?: string }
    if (!res.ok) {
        if (body.code === '2fa_required') return { error: 'Your account uses two-factor login. Sign in on the PostHog page instead, then come back.' }
        return { error: body.detail || 'Wrong email or password.' }
    }
    const cookies = res.headers.getSetCookie()
    const pick = (name: string) => cookies.map((c) => new RegExp(`^${name}=([^;]+)`).exec(c)?.[1]).find(Boolean)
    const session = pick('sessionid')
    if (!session) return { error: 'PostHog did not start a session.' }
    succeeded(ip, email, at)
    return { session, csrf: pick('posthog_csrftoken') }
}

/** Ends the PostHog session (which also logs the person out of PostHog). */
export async function signOut(session: string, csrf?: string): Promise<void> {
    forgetSession(session)
    try {
        await fetch(`${config.posthog.host}/logout`, {
            method: 'POST',
            headers: {
                cookie: `sessionid=${session}${csrf ? `; posthog_csrftoken=${csrf}` : ''}`,
                ...(csrf ? { 'x-csrftoken': csrf } : {}),
                referer: `${config.posthog.host}/`,
                'content-type': 'application/x-www-form-urlencoded',
            },
            body: csrf ? `csrfmiddlewaretoken=${encodeURIComponent(csrf)}` : '',
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000),
        })
    } catch {}
}

/** Calls the PostHog API as the signed-in person (for the admin page's member lists). */
export async function asViewer<T>(v: Viewer, path: string): Promise<T | undefined> {
    const res = await fetch(`${config.posthog.host}${path}`, { headers: { cookie: `sessionid=${v.session}`, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    return res.ok ? ((await res.json()) as T) : undefined
}
