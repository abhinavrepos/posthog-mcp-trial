// The safeguard before a survey reaches Reval users: the four rules of how it behaves, an explicit
// acknowledgement, and the Jira ticket it is launched under. The same on the Surveys page and in chat;
// every launch is recorded with the ticket and the rules shown.
import { all, run } from './db.ts'
import { config, jiraConfigured } from './config.ts'
import { getIssue } from '../jira/client.ts'
import type { SurveyView } from './surveys.ts'

export const ACKNOWLEDGEMENT = 'I acknowledge that this launches a survey that Reval users will see, and that I have read the rules above.'

/** The four rules, filled in for this survey. */
export function launchRules(s: Pick<SurveyView, 'clients' | 'sample_percent' | 'steps' | 'show' | 'days_between_surveys' | 'type' | 'conditions'>): string[] {
    const who = s.clients === 'all' ? 'every client' : s.clients.join(', ')
    return [
        `This ${s.type} survey targets ${s.sample_percent}% of ${who}. ${s.steps.length ? `Native triggers: ${s.steps.join(', ')}.` : 'No event trigger is set.'} PostHog evaluates its conditions and targeting flag.`,
        `PostHog's native survey rules apply. The wait period after any survey is ${s.days_between_surveys} days. ${s.show === 'every_time' ? 'It can activate repeatedly.' : 'It is scheduled once.'}`,
        `Confirm the audience and trigger before launch. Wording mistakes cannot be taken back from users who already answered.`,
        'Answers are kept in PostHog and shown on the Surveys page to everyone with a survey role. It runs until someone stops it here or in chat; stopping keeps the answers.',
    ]
}

const TICKET = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/

/** A Jira ticket key, checked in Jira when Jira is connected. */
export async function checkTicket(raw: unknown): Promise<{ ok: true; key: string; summary?: string } | { ok: false; error: string }> {
    const key = String(raw ?? '').trim().toUpperCase()
    if (!TICKET.test(key)) return { ok: false, error: 'Give the Jira ticket ID this launch is for, like REVAL-1234.' }
    if (!jiraConfigured()) return { ok: true, key }
    try {
        const issue = await getIssue(key)
        return { ok: true, key, summary: String(issue.fields?.summary ?? '').slice(0, 200) }
    } catch (e) {
        return { ok: false, error: /404|does not exist|not found/i.test((e as Error).message) ? `Jira has no ticket ${key}.` : `Could not check ${key} in Jira: ${(e as Error).message}` }
    }
}

export interface Launch { survey_id: string; survey_name: string; ticket: string; ticket_summary: string | null; launched_by: string; via: string; rules: string[]; at: string; clients?: string[] | 'all' }

export function recordLaunch(l: Omit<Launch, 'at'>): void {
    run('INSERT INTO survey_launches (survey_id, survey_name, ticket, ticket_summary, launched_by, via, rules, at, clients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        l.survey_id, l.survey_name, l.ticket, l.ticket_summary, l.launched_by, l.via, JSON.stringify(l.rules), new Date().toISOString(), JSON.stringify(l.clients || []))
}

export function launchesOf(surveyId: string): Launch[] {
    return all<Record<string, unknown>>('SELECT * FROM survey_launches WHERE survey_id = ? ORDER BY at DESC LIMIT 50', surveyId).map((r) => ({
        survey_id: String(r.survey_id), survey_name: String(r.survey_name), ticket: String(r.ticket), ticket_summary: (r.ticket_summary as string) ?? null,
        launched_by: String(r.launched_by), via: String(r.via), rules: JSON.parse(String(r.rules)), at: String(r.at),
    }))
}

export const jiraTicketUrl = (key: string) => (config.jira.baseUrl ? `${config.jira.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` : undefined)
