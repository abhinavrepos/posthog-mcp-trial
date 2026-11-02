// Jira Cloud REST v3 client: the handful of calls triage needs. Connecting a Jira site means setting
// JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { config } from '../core/config.ts'
import type { Ticket } from '../core/ticket.ts'
import { adfToText, markdownToAdf, type AdfNode } from './adf.ts'

/** Hidden marker in every triage comment, so a redelivered webhook does not post twice. */
export const TRIAGE_MARKER = 'ticket-triage'

function auth(): Record<string, string> {
    if (!config.jira.baseUrl || !config.jira.email || !config.jira.apiToken) throw new Error('Jira is not connected yet: set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN')
    return { authorization: 'Basic ' + Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64'), accept: 'application/json' }
}

async function jira<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${config.jira.baseUrl}${path}`, {
        ...init,
        headers: { ...auth(), ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...init.headers },
        signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`Jira ${init.method || 'GET'} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
}

export interface JiraIssue {
    key: string
    fields: {
        summary: string
        description?: AdfNode | string | null
        issuetype?: { name: string }
        reporter?: { displayName?: string; emailAddress?: string; timeZone?: string }
        created?: string
        labels?: string[]
        [custom: string]: unknown
    }
}

// Optional custom fields, e.g. JIRA_FIELD_CLIENT=customfield_10042
const FIELD = {
    client: process.env.JIRA_FIELD_CLIENT || 'customfield_client',
    userEmail: process.env.JIRA_FIELD_USER_EMAIL || 'customfield_user_email',
    screen: process.env.JIRA_FIELD_SCREEN || 'customfield_screen',
    occurredAt: process.env.JIRA_FIELD_OCCURRED_AT || 'customfield_occurred_at',
}

export async function getIssue(key: string): Promise<JiraIssue> {
    return jira<JiraIssue>(`/rest/api/3/issue/${encodeURIComponent(key)}`)
}

function fieldText(v: unknown): string | undefined {
    if (v == null || v === '') return undefined
    if (typeof v === 'string') return v
    if (typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value) // select fields
    if (typeof v === 'object' && 'type' in (v as object)) return adfToText(v as AdfNode).trim()
    return String(v)
}

/** Which kind of triage an issue gets, or undefined when it should be left alone. */
export function ticketKind(issue: JiraIssue): Ticket['kind'] | undefined {
    const type = issue.fields.issuetype?.name?.toLowerCase()
    if (type === config.jira.riskIssueType.toLowerCase()) return 'risk'
    if (type === config.jira.rciIssueType.toLowerCase()) return 'rci'
    return undefined
}

export function issueToTicket(issue: JiraIssue): Ticket | undefined {
    const kind = ticketKind(issue)
    if (!kind) return undefined
    const f = issue.fields
    return {
        key: issue.key,
        kind,
        summary: f.summary,
        description: adfToText(f.description as AdfNode),
        reporter: { name: f.reporter?.displayName, email: f.reporter?.emailAddress, timeZone: f.reporter?.timeZone },
        created: f.created,
        fields: {
            client: fieldText(f[FIELD.client]),
            userEmail: fieldText(f[FIELD.userEmail]),
            screen: fieldText(f[FIELD.screen]),
            occurredAt: fieldText(f[FIELD.occurredAt]),
        },
    }
}

export async function hasTriageComment(key: string): Promise<boolean> {
    const out = await jira<{ comments: { body: AdfNode }[] }>(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100`)
    return out.comments.some((c) => adfToText(c.body).includes(TRIAGE_MARKER))
}

export async function addComment(key: string, markdown: string): Promise<void> {
    await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { method: 'POST', body: JSON.stringify({ body: markdownToAdf(markdown) }) })
}

export async function addAttachment(key: string, file: string, contentType = 'video/mp4'): Promise<void> {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(file)], { type: contentType }), basename(file))
    await jira(`/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, { method: 'POST', body: form, headers: { 'X-Atlassian-Token': 'no-check' } })
}

export async function addLabels(key: string, labels: string[]): Promise<void> {
    await jira(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ update: { labels: labels.map((add) => ({ add })) } }) })
}

/**
 * Checks a Jira webhook's `X-Hub-Signature: sha256=<hex>` header, an HMAC-SHA256 of the raw body
 * with the webhook secret. Fails closed when no secret is configured.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, header: string | undefined, secret = config.jira.webhookSecret): boolean {
    if (!secret || !header) return false
    const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
    if (!m) return false
    const want = createHmac('sha256', secret).update(rawBody).digest()
    const got = Buffer.from(m[1], 'hex')
    return want.length === got.length && timingSafeEqual(want, got)
}

export function signWebhook(rawBody: Buffer | string, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
}

// ------------------------------------------------------------------ releases (read only)
export interface JiraVersion {
    id: string
    name: string
    description?: string
    releaseDate?: string // YYYY-MM-DD
    released: boolean
    archived?: boolean
}

/** A project's versions (Jira "releases"). */
export async function getVersions(projectKey: string): Promise<JiraVersion[]> {
    return jira<JiraVersion[]>(`/rest/api/3/project/${encodeURIComponent(projectKey)}/versions`)
}

/** Every issue matching a JQL query, following pages (Jira Cloud's /search/jql). */
export async function searchIssues(jql: string, fields: string[], limit = 1000): Promise<JiraIssue[]> {
    const out: JiraIssue[] = []
    let nextPageToken: string | undefined
    do {
        const page = await jira<{ issues: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>('/rest/api/3/search/jql', {
            method: 'POST',
            body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
        })
        out.push(...page.issues)
        nextPageToken = page.isLast === false || (page.nextPageToken && page.isLast !== true) ? page.nextPageToken : undefined
    } while (nextPageToken && out.length < limit)
    return out
}

/** Quotes a value for JQL. */
export const jqlString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
