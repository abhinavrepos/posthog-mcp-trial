// Who may do what with replay clips.
//
// PostHog answers "who is this?": people sign in with their PostHog account (password, 2FA and
// deactivation all stay in PostHog), and PostHog owners and admins of the organization that owns
// the project are always admins here. This service answers "what may they do?": each person
// gets a role in the database (run/triage.db, see core/db.ts), set on the admin page.
import { createHash } from 'node:crypto'
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
    return { ...id, role: roleOf(id.email, id.posthog_admin), system: hasSystemGrant(id.email), session }
}

// ------------------------------------------------------------------ sign in and out through PostHog
const attempts = new Map<string, number[]>()

/** Signs in with a PostHog account. Returns the PostHog session id, or a reason. */
export async function signIn(ip: string, email: string, password: string): Promise<{ session?: string; csrf?: string; error?: string }> {
    const now = Date.now()
    const recent = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000)
    if (recent.length >= 10) return { error: 'Too many attempts. Wait 10 minutes.' }
    attempts.set(ip, [...recent, now])
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
    attempts.delete(ip)
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
