// MCP tools over the same core as the Jira automation. Each one answers a question a PM or
// support lead asks that Jira alone cannot.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { SCREENS } from '../core/catalog.ts'
import { clipFrames, renderClip } from '../core/clip.ts'
import { errorImpact } from '../core/impact.ts'
import { bestPerSession, findIncidents } from '../core/incidents.ts'
import { clipUrl } from '../core/links.ts'
import { replayUrl } from '../core/posthog.ts'
import { renderReport } from '../core/report.ts'
import { resolveClient, resolveScreen } from '../core/resolve.ts'
import { struggleSessions } from '../core/silent.ts'
import { emailsIn } from '../core/text.ts'
import { parseTimeWindow } from '../core/timewindow.ts'
import { triage, type TriageAi } from '../core/triage.ts'
import { screenUsage } from '../core/usage.ts'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const text = (t: string): { content: Content[] } => ({ content: [{ type: 'text', text: t }] })
const json = (label: string, value: unknown) => text(`${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``)

async function pickClient(client: string) {
    const matches = await resolveClient({ text: client, emails: emailsIn(client), clientHint: client })
    if (!matches.length) throw new Error(`No client matches "${client}". Try the client name, its id, or a user's email.`)
    return { best: matches[0], others: matches.slice(1, 4) }
}

function screenPath(screen?: string): string | undefined {
    if (!screen) return undefined
    if (screen.startsWith('/')) return screen
    const m = resolveScreen(screen)[0]
    if (!m) throw new Error(`No screen matches "${screen}". Known screens: ${SCREENS.map((s) => `${s.name} (${s.path})`).join(', ')}`)
    return m.path
}

const when = z.string().optional().describe('When, in plain words: "yesterday afternoon", "30 Oct around 14:00", "last 3 days". Default: last 7 days.')
const tz = z.string().optional().describe('IANA timezone the "when" is in, e.g. Europe/Berlin. Default UTC.')

export function registerTools(server: McpServer, ai?: TriageAi): void {
    server.registerTool(
        'resolve_client',
        {
            title: 'Identify a client',
            description: 'Works out which client a name, id or user email refers to, from PostHog data. Use it when a ticket names a client loosely.',
            inputSchema: { query: z.string().describe('Client name, id, or a user email') },
            annotations: { readOnlyHint: true },
        },
        async ({ query }) => json(`Matches for "${query}":`, await resolveClient({ text: query, emails: emailsIn(query), clientHint: query }))
    )

    server.registerTool(
        'find_client_incidents',
        {
            title: 'When did this client hit a problem?',
            description:
                'Lists the moments a client hit trouble (errors, rage clicks, dead clicks), newest first, each with the user, screen, release and a replay link at the right second.',
            inputSchema: {
                client: z.string().describe('Client name, id or a user email'),
                when,
                timezone: tz,
                screen: z.string().optional().describe('Screen name or path, e.g. "invoices" or /invoices'),
                email: z.string().optional().describe('Only this user'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, when: w, timezone, screen, email }) => {
            const { best } = await pickClient(client)
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            const incidents = await findIncidents({ clientId: best.id, from: win.from, to: win.to, pathname: screenPath(screen), email, limit: 100 })
            const sessions = bestPerSession(incidents).slice(0, 10)
            return json(
                `${best.name}: ${incidents.length} trouble events in ${sessions.length} sessions (${win.label}). One row per session, most useful first. Use get_replay_clip with session_id and recording.offset_s to see it.`,
                sessions
            )
        }
    )

    server.registerTool(
        'get_replay_clip',
        {
            title: 'Clip a session replay',
            description:
                'Renders part of a session recording to MP4 and returns a link plus a few frames, so you can see what the user saw. Rendering takes 10 to 30 seconds the first time.',
            inputSchema: {
                session_id: z.string(),
                start_s: z.number().min(0).describe('Seconds from the start of the recording. Use offset_s minus about 10.'),
                duration_s: z.number().min(3).max(120).default(30),
                frames: z.number().int().min(0).max(4).default(3).describe('How many frames to return as images'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id, start_s, duration_s, frames }) => {
            const clip = await renderClip({ sessionId: session_id, startOffsetS: start_s, durationS: duration_s })
            const at = frames ? Array.from({ length: frames }, (_, i) => ((i + 0.5) * clip.video_duration_s) / frames) : []
            const images = await clipFrames(clip.file, at)
            return {
                content: [
                    {
                        type: 'text',
                        text: `Clip of ${session_id} from ${clip.start_offset_s}s to ${clip.end_offset_s}s: ${clipUrl(clip.name)}\nFull replay: ${replayUrl(session_id, clip.start_offset_s)}\n${clip.cached ? 'From cache.' : `Rendered in ${clip.render_s.toFixed(1)} s.`} Frames at ${at.map((t) => `${t.toFixed(0)}s`).join(', ')} follow.`,
                    },
                    ...images.map((b) => ({ type: 'image' as const, data: b.toString('base64'), mimeType: 'image/png' })),
                ],
            }
        }
    )

    server.registerTool(
        'screen_usage',
        {
            title: 'How is a screen used?',
            description: 'How many clients and users use a screen, the busiest weekdays and days, and the heaviest clients. Optionally where one client ranks.',
            inputSchema: {
                screen: z.string().describe('Screen name or path'),
                client: z.string().optional(),
                days: z.number().int().min(1).max(90).default(30),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ screen, client, days }) => {
            const path = screenPath(screen)!
            const c = client ? (await pickClient(client)).best : undefined
            return json(`Usage of ${path} over ${days} days${c ? ` (with ${c.name})` : ''}:`, await screenUsage(path, { clientId: c?.id, days }))
        }
    )

    server.registerTool(
        'error_blast_radius',
        {
            title: 'Is it just them?',
            description:
                'For one error, which clients and users hit it, how often, since when, on which releases, the daily trend, and (with a screen) the failure rate per release.',
            inputSchema: {
                issue_id: z.string().optional().describe('PostHog error tracking issue id, from find_client_incidents'),
                error_type: z.string().optional(),
                error_message: z.string().optional(),
                screen: z.string().optional(),
                days: z.number().int().min(1).max(90).default(30),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ issue_id, error_type, error_message, screen, days }) => {
            if (!issue_id && !error_type) throw new Error('Give issue_id, or error_type and error_message.')
            return json('Blast radius:', await errorImpact({ issue_id, error_type, error_message }, { days, pathname: screenPath(screen) }))
        }
    )

    server.registerTool(
        'find_silent_issues',
        {
            title: 'Problems without errors',
            description: 'Sessions where a client struggled without any error: rage clicks, dead clicks, the same action repeated, long stays. Use it when a ticket describes wrong data or confusion rather than a crash.',
            inputSchema: { client: z.string(), screen: z.string().optional(), when, timezone: tz },
            annotations: { readOnlyHint: true },
        },
        async ({ client, screen, when: w, timezone }) => {
            const { best } = await pickClient(client)
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            return json(`${best.name}: sessions with struggle signals and no error (${win.label}):`, await struggleSessions({ clientId: best.id, pathname: screenPath(screen), from: win.from, to: win.to }))
        }
    )

    server.registerTool(
        'triage_ticket',
        {
            title: 'Triage a ticket',
            description:
                'Runs the full triage the Jira automation runs: identifies the client, screen and time, finds the session, clips the replay, adds blast radius and usage, and suggests a priority. Returns the report as markdown.',
            inputSchema: {
                summary: z.string(),
                description: z.string().default(''),
                kind: z.enum(['rci', 'risk']).default('rci').describe('rci: a client-reported bug. risk: an MMT risk review of a screen.'),
                reporter_timezone: tz,
                clip: z.boolean().default(true),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ summary, description, kind, reporter_timezone, clip }) => {
            const report = await triage({ key: 'MCP', kind, summary, description, reporter: { timeZone: reporter_timezone } }, { ai, clip })
            return text(renderReport(report))
        }
    )
}
