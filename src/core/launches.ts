// The safeguard before a survey reaches Reval users: the four rules of how it behaves, an explicit
// acknowledgement, and the Jira ticket it is launched under. The same on the Surveys page and in chat;
// every launch is recorded with the ticket and the rules shown.
import { all, run } from './db.ts'
import { config, jiraConfigured } from './config.ts'
import { getIssue } from '../jira/client.ts'
import type { QueueAlert, SurveyView } from './surveys.ts'

export const ACKNOWLEDGEMENT = 'I acknowledge that this launches a survey that Reval users will see, and that I have read the rules above.'

/** The four rules, filled in for this survey. */
export function launchRules(s: Pick<SurveyView, 'clients' | 'sample_percent' | 'steps' | 'show' | 'pacing'>, queue?: Pick<QueueAlert, 'level' | 'alert'>): string[] {
    const who = s.clients === 'all' ? 'every client' : s.clients.join(', ')
    const p = s.pacing ?? { per_user: config.surveys.perUser, gap_hours: config.surveys.gapHours, quiet_days_after_close: config.surveys.quietDaysAfterClose }
    return [
        `It reaches Reval users at once: ${s.sample_percent < 100 ? `${s.sample_percent}% of the users of ` : 'users of '}${who} see it in Reval, bottom right, as soon as they ${s.steps.length ? `finish the steps (${s.steps.join(' → ')})` : 'do its steps'} and the page has loaded${s.show === 'every_time' ? ', every time they do' : ', once per user'}.`,
        `Users are protected from survey fatigue: never more than ${p.per_user} running surveys per user at once, at least ${p.gap_hours} hours between any two, and those already in ${p.per_user} wait for this one.${queue && queue.level !== 'clear' ? ` Right now: ${queue.alert.replace(/^⚠\s*/, '').split('. ')[0]}.` : ''}`,
        `A user who presses × never sees it again and gets no survey for ${p.quiet_days_after_close} days; one who ignores it twice stops seeing it. Wording mistakes cannot be taken back from users who already answered.`,
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

export interface Launch { survey_id: string; survey_name: string; ticket: string; ticket_summary: string | null; launched_by: string; via: string; rules: string[]; at: string }

export function recordLaunch(l: Omit<Launch, 'at'>): void {
    run('INSERT INTO survey_launches (survey_id, survey_name, ticket, ticket_summary, launched_by, via, rules, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        l.survey_id, l.survey_name, l.ticket, l.ticket_summary, l.launched_by, l.via, JSON.stringify(l.rules), new Date().toISOString())
}

export function launchesOf(surveyId: string): Launch[] {
    return all<Record<string, unknown>>('SELECT * FROM survey_launches WHERE survey_id = ? ORDER BY at DESC LIMIT 50', surveyId).map((r) => ({
        survey_id: String(r.survey_id), survey_name: String(r.survey_name), ticket: String(r.ticket), ticket_summary: (r.ticket_summary as string) ?? null,
        launched_by: String(r.launched_by), via: String(r.via), rules: JSON.parse(String(r.rules)), at: String(r.at),
    }))
}

export const jiraTicketUrl = (key: string) => (config.jira.baseUrl ? `${config.jira.baseUrl.replace(/\/$/, '')}/browse/${encodeURIComponent(key)}` : undefined)
