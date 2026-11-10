// Pinned dashboards: a saved view (client task map or flow time, with its filters) that a person
// pinned from chat or the Dashboards page, and the people it is shared with. Who may pin, share and
// open them follows the dashboard roles (service/access.ts). Every change is in the activity log.
import { randomBytes } from 'node:crypto'

import { all, one, run, tx } from './db.ts'
import { audit } from '../service/access.ts'
import type { FlowTimeParams, TaskMapParams } from './taskstypes.ts'

export type DashboardKind = 'task_map' | 'flow_time'
export const DASHBOARD_KINDS: DashboardKind[] = ['task_map', 'flow_time']
export const KIND_TEXT: Record<DashboardKind, string> = { task_map: 'Client task map', flow_time: 'Flow time' }

export interface Dashboard {
    id: string
    owner: string
    kind: DashboardKind
    title: string
    params: TaskMapParams | FlowTimeParams // saved filters; a window may also be relative, see RelativeWindow
    via: 'chat' | 'page'
    created_at: string
    updated_at: string
    shared_with: string[]
}

// Pinned views usually mean "the last N days", so a window can be saved as relative and resolved on
// open: { last_days: 28 } (the window) and the baseline before it.
export interface RelativeWindow {
    last_days: number
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const row = (r: Record<string, unknown>): Dashboard => ({
    id: String(r.id), owner: String(r.owner), kind: r.kind as DashboardKind, title: String(r.title), params: JSON.parse(String(r.params)),
    via: r.via === 'chat' ? 'chat' : 'page', created_at: String(r.created_at), updated_at: String(r.updated_at),
    shared_with: all<{ email: string }>('SELECT email FROM dashboard_shares WHERE dashboard_id = ? ORDER BY email', String(r.id)).map((x) => x.email),
})

function check(kind: unknown, title: unknown, params: unknown): { kind: DashboardKind; title: string; params: Record<string, unknown> } {
    if (!DASHBOARD_KINDS.includes(kind as DashboardKind)) throw new Error('kind must be task_map or flow_time')
    const t = String(title ?? '').trim()
    if (!t || t.length > 120) throw new Error('Give a title of 1-120 characters.')
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('params must be an object')
    const text = JSON.stringify(params)
    if (text.length > 4000) throw new Error('params too large')
    if (kind === 'flow_time' && typeof (params as { task?: unknown }).task !== 'string') throw new Error('A flow time dashboard needs a task.')
    return { kind: kind as DashboardKind, title: t, params: params as Record<string, unknown> }
}

export function createDashboard(owner: string, input: { kind: unknown; title: unknown; params: unknown; via?: 'chat' | 'page' }): Dashboard {
    const c = check(input.kind, input.title, input.params)
    const id = randomBytes(6).toString('hex')
    const now = new Date().toISOString()
    tx(() => {
        if ((one<{ n: number }>('SELECT COUNT(*) AS n FROM dashboards WHERE owner = ?', owner.toLowerCase())?.n ?? 0) >= 200) throw new Error('At most 200 dashboards per person. Delete some first.')
        run('INSERT INTO dashboards (id, owner, kind, title, params, via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, owner.toLowerCase(), c.kind, c.title, JSON.stringify(c.params), input.via ?? 'page', now, now)
        audit(owner, 'dashboard.pinned', { dashboard: id, kind: c.kind, title: c.title, via: input.via ?? 'page' })
    })
    return getDashboard(id)!
}

export function getDashboard(id: string): Dashboard | undefined {
    if (!/^[0-9a-f]{12}$/.test(id)) return undefined
    const r = one<Record<string, unknown>>('SELECT * FROM dashboards WHERE id = ?', id)
    return r ? row(r) : undefined
}

/** May this person open it: the owner, anyone it is shared with, and admins. */
export const canOpen = (d: Dashboard, email: string, admin: boolean) => admin || d.owner === email.toLowerCase() || d.shared_with.includes(email.toLowerCase())
/** May this person change, share or delete it: the owner and admins. */
export const canManage = (d: Dashboard, email: string, admin: boolean) => admin || d.owner === email.toLowerCase()

/** Dashboards this person may open: their own, those shared with them, and every one for admins. */
export function listDashboards(email: string, admin: boolean): Dashboard[] {
    const e = email.toLowerCase()
    const rows = admin
        ? all<Record<string, unknown>>('SELECT * FROM dashboards ORDER BY updated_at DESC LIMIT 1000')
        : all<Record<string, unknown>>(`SELECT d.* FROM dashboards d WHERE d.owner = ? OR d.id IN (SELECT dashboard_id FROM dashboard_shares WHERE email = ?) ORDER BY d.updated_at DESC LIMIT 1000`, e, e)
    return rows.map(row)
}

export function updateDashboard(id: string, by: string, admin: boolean, change: { title?: unknown; params?: unknown }): Dashboard {
    const d = getDashboard(id)
    if (!d || !canManage(d, by, admin)) throw new Error('No such dashboard, or it is not yours to change.')
    const c = check(d.kind, change.title ?? d.title, change.params ?? d.params)
    tx(() => {
        run('UPDATE dashboards SET title = ?, params = ?, updated_at = ? WHERE id = ?', c.title, JSON.stringify(c.params), new Date().toISOString(), id)
        audit(by, 'dashboard.changed', { dashboard: id, title: c.title })
    })
    return getDashboard(id)!
}

export function deleteDashboard(id: string, by: string, admin: boolean): void {
    const d = getDashboard(id)
    if (!d || !canManage(d, by, admin)) throw new Error('No such dashboard, or it is not yours to delete.')
    tx(() => {
        run('DELETE FROM dashboards WHERE id = ?', id)
        audit(by, 'dashboard.deleted', { dashboard: id, title: d.title })
    })
}

/** Sets who it is shared with (the full list). People outside Lens's people can be named too; they
 * see it once an admin gives them a dashboard role. */
export function shareDashboard(id: string, by: string, admin: boolean, emails: unknown): Dashboard {
    const d = getDashboard(id)
    if (!d || !canManage(d, by, admin)) throw new Error('No such dashboard, or it is not yours to share.')
    if (!Array.isArray(emails) || emails.length > 200) throw new Error('Give a list of up to 200 emails.')
    const list = [...new Set(emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))]
    const bad = list.filter((e) => !EMAIL.test(e))
    if (bad.length) throw new Error(`Not emails: ${bad.slice(0, 3).join(', ')}`)
    tx(() => {
        const before = new Set(d.shared_with)
        run('DELETE FROM dashboard_shares WHERE dashboard_id = ?', id)
        const now = new Date().toISOString()
        for (const e of list) if (e !== d.owner) run('INSERT INTO dashboard_shares (dashboard_id, email, shared_by, at) VALUES (?, ?, ?, ?)', id, e, by.toLowerCase(), now)
        const added = list.filter((e) => !before.has(e) && e !== d.owner), removed = [...before].filter((e) => !list.includes(e))
        if (added.length || removed.length) audit(by, 'dashboard.shared', { dashboard: id, title: d.title, added, removed })
    })
    return getDashboard(id)!
}

/** The people Lens knows (for the share picker): anyone with a role of any kind, and anyone signed in. */
export function knownPeople(): string[] {
    return all<{ email: string }>(
        `SELECT email FROM people UNION SELECT email FROM survey_people UNION SELECT email FROM system_viewers
         UNION SELECT email FROM dashboard_people UNION SELECT DISTINCT who AS email FROM audit WHERE action = 'signin' ORDER BY email LIMIT 2000`
    ).map((r) => r.email).filter((e) => EMAIL.test(e))
}
