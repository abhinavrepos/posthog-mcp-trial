// What a ticket says, in a form the triage pipeline can use. Structured Jira fields win; the
// free-text summary and description fill the gaps.
import { resolveScreen } from './resolve.ts'
import { emailsIn } from './text.ts'
import { parseTimeWindow, type TimeWindow } from './timewindow.ts'

export type TicketKind = 'rci' | 'risk'

export interface Ticket {
    key: string
    kind: TicketKind
    summary: string
    description: string // plain text
    reporter?: { name?: string; email?: string; timeZone?: string }
    created?: string
    // Optional structured fields (custom fields in a real Jira).
    fields?: { client?: string; userEmail?: string; screen?: string; occurredAt?: string }
}

export interface ParsedTicket {
    clientHint?: string
    emails: string[]
    screenPath?: string
    screenText: string
    window: TimeWindow
    timeZone: string
    sources: Record<'client' | 'email' | 'screen' | 'time', 'field' | 'text' | 'ai' | 'none'>
}

export function parseTicket(t: Ticket, now: Date = new Date()): ParsedTicket {
    const text = `${t.summary}\n${t.description}`
    const tz = t.reporter?.timeZone || 'UTC'
    // Emails of the reporter are client-services staff, not the client's user.
    const reporterEmail = t.reporter?.email?.toLowerCase()
    const textEmails = emailsIn(text).filter((e) => e !== reporterEmail)
    const emails = t.fields?.userEmail ? [t.fields.userEmail.toLowerCase()] : textEmails

    const screenFromField = t.fields?.screen ? resolveScreen(t.fields.screen)[0] : undefined
    const screenFromText = resolveScreen(text)[0]
    const screen = screenFromField || screenFromText

    const occurred = t.fields?.occurredAt ? new Date(t.fields.occurredAt) : undefined
    const window: TimeWindow =
        occurred && !Number.isNaN(occurred.getTime())
            ? {
                  from: new Date(occurred.getTime() - 30 * 60_000),
                  to: new Date(Math.min(now.getTime(), occurred.getTime() + 30 * 60_000)),
                  label: `${occurred.toISOString().slice(0, 16).replace('T', ' ')} UTC (from the ticket field)`,
                  precision: 'exact',
              }
            : parseTimeWindow(text, now, tz)

    return {
        clientHint: t.fields?.client,
        emails,
        screenPath: screen?.path,
        screenText: text,
        window,
        timeZone: tz,
        sources: {
            client: t.fields?.client ? 'field' : 'text',
            email: t.fields?.userEmail ? 'field' : textEmails.length ? 'text' : 'none',
            screen: screenFromField ? 'field' : screenFromText ? 'text' : 'none',
            time: occurred ? 'field' : window.precision === 'none' ? 'none' : 'text',
        },
    }
}
