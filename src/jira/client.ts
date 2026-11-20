import { config } from '../core/config.ts'
import type { AdfNode } from './adf.ts'
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

export async function getIssue(key:string):Promise<JiraIssue> {return jira(`/rest/api/3/issue/${encodeURIComponent(key)}`)}
