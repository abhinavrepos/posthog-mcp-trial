// Who may do what with replay clips.
//
// PostHog answers "who is this?": people sign in with their PostHog account (password, 2FA and
// deactivation all stay in PostHog), and PostHog owners and admins of the organization that owns
// the project are always admins here. This service answers "what may they do?": each person
// gets a role in run/access.json, set on the admin page.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'

import { config, ROOT } from '../core/config.ts'

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

const FILE = join(ROOT, 'run/access.json')
const AUDIT = join(ROOT, 'logs/audit.jsonl')
mkdirSync(join(ROOT, 'run'), { recursive: true })
mkdirSync(join(ROOT, 'logs'), { recursive: true })

export function loadAccess(): AccessFile {
    try {
        const a = JSON.parse(readFileSync(FILE, 'utf8')) as AccessFile
        return { default_role: a.default_role || 'none', allow_share_links: a.allow_share_links !== false, people: a.people || {} }
    } catch {
        return { default_role: 'none', allow_share_links: true, people: {} }
    }
}
export function saveAccess(a: AccessFile): void {
    writeFileSync(FILE + '.tmp', JSON.stringify(a, null, 2))
    writeFileSync(FILE, readFileSync(FILE + '.tmp'))
}

export function audit(who: string, action: string, details: Record<string, unknown> = {}): void {
    try {
        appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), who, action, ...details }) + '\n')
    } catch {}
}

export function readAudit(limit = 300): Record<string, unknown>[] {
    try {
        const lines = readFileSync(AUDIT, 'utf8').trimEnd().split('\n')
        return lines.slice(-limit).reverse().map((l) => JSON.parse(l) as Record<string, unknown>)
    } catch {
        return []
    }
}

// ------------------------------------------------------------------ PostHog identity
export interface Viewer {
    email: string
    name: string
    role: Role
    posthog_admin: boolean // owner or admin of the organization that owns the project
    in_replay_project: boolean // can open the project (and so every replay) in PostHog itself
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
    return { ...id, role: roleOf(id.email, id.posthog_admin), session }
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
