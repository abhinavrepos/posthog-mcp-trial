// MCP tools over the same core as the Jira automation. Each one answers a question a PM or
// support lead asks that Jira alone cannot.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { SCREENS } from '../core/catalog.ts'
import { renderClip } from '../core/clip.ts'
import { errorImpact } from '../core/impact.ts'
import { bestPerSession, findIncidents } from '../core/incidents.ts'
import { config } from '../core/config.ts'
import { replayUrl } from '../core/posthog.ts'
import {
    evidenceMarkdown,
    feedbackMarkdown,
    outcomesMarkdown,
    recompute,
    recordVerdict,
    releasesMarkdown,
    resolveScope,
    setLink,
    syncReleases,
    ticketRelease,
    evidenceMarkdown as ticketText,
    keptNames,
    quarters,
} from '../core/releases.ts'
import { addComment } from '../jira/client.ts'
import { renderReport } from '../core/report.ts'
import { resolveClient, resolveScreen } from '../core/resolve.ts'
import { struggleSessions } from '../core/silent.ts'
import { emailsIn } from '../core/text.ts'
import { parseTimeWindow } from '../core/timewindow.ts'
import { triage, type TriageAi } from '../core/triage.ts'
import { screenUsage } from '../core/usage.ts'
import { recordClip } from '../service/replays.ts'

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
                `${best.name}: ${incidents.length} trouble events in ${sessions.length} sessions (${win.label}). One row per session, most useful first. Use get_replay_link with session_id and recording.offset_s to see it.`,
                sessions
            )
        }
    )

    // Replays can show sensitive client data. This tool hands back links for people to open; it
    // never returns frames, video bytes or anything else from the recording itself.
    server.registerTool(
        'get_replay_link',
        {
            title: 'Link to a session replay',
            description:
                'Returns links a person can open to watch a session at the right moment: the PostHog replay (needs a PostHog login) and, when rendering works, a short MP4 clip. You cannot see the replay yourself; pass the links on to the user.',
            inputSchema: {
                session_id: z.string(),
                start_s: z.number().min(0).describe('Seconds from the start of the recording. Use offset_s minus about 10.'),
                duration_s: z.number().min(3).max(120).default(30),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id, start_s, duration_s }) => {
            const lines = [`Replay in PostHog from ${Math.floor(start_s)}s (PostHog login needed): ${replayUrl(session_id, start_s)}`]
            try {
                const clip = await renderClip({ sessionId: session_id, startOffsetS: start_s, durationS: duration_s })
                await recordClip(clip, 'claude (MCP)')
                lines.push(`MP4 clip, ${Math.round(clip.video_duration_s)} s, on the clip page (sign-in and the "Watch clips" role needed): ${config.service.publicUrl}/replays?clip=${encodeURIComponent(clip.name)}`)
            } catch (e) {
                lines.push(`No MP4 clip: rendering is not available (${(e as Error).message.split('\n')[0].slice(0, 120)}).`)
            }
            lines.push('These links are for the user to open. The replay content is not available to you.')
            return text(lines.join('\n'))
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

    // ------------------------------------------------------------------ release outcomes
    // Facts about the tickets each Jira release shipped, from the numbers the service stored
    // (src/core/releases.ts). The model judges what is risky; people's verdicts are saved.
    const scopeArg = z.string().optional().describe('A release like "26.10.0", a quarter like "Q3 2026", "last 3", a range like "26.5.0..26.8.0", or "all" (default).')
    const noScope = (q?: string) =>
        text(`Nothing called "${q}". Releases: ${keptNames().join(', ')}. Quarters: ${quarters().map((x) => x.label).join(', ')}. Or "all", "last 3", "26.5.0..26.8.0".`)
    const empty = () => text('No releases stored yet. Call refresh_releases first.')

    server.registerTool(
        'list_releases',
        {
            title: 'List releases',
            description: 'The kept Jira releases with their dates and headline facts (clients on the release, errors and rage clicks per 1,000 sessions before and after, support tickets, survey rating), and the quarters you can ask for.',
            inputSchema: {},
            annotations: { readOnlyHint: true },
        },
        async () => text(releasesMarkdown())
    )

    server.registerTool(
        'release_outcomes',
        {
            title: 'Tickets by outcome',
            description:
                'Every ticket shipped in a release, quarter or range, sorted into groups by what happened afterwards in PostHog: more errors, more rage clicks, clients complained, fixed something, adopted, low uptake, too new, no clear change, cannot measure. Each ticket comes with its numbers and any saved verdict. Facts only: deciding what is risky is up to you. Start here.',
            inputSchema: { scope: scopeArg },
            annotations: { readOnlyHint: true },
        },
        async ({ scope }) => {
            if (!keptNames().length) return empty()
            const sc = resolveScope(scope)
            return sc ? text(outcomesMarkdown(sc)) : noScope(scope)
        }
    )

    server.registerTool(
        'ticket_evidence',
        {
            title: 'One ticket in full',
            description: 'All evidence for one Jira ticket: what it is linked to in PostHog and why, use before and after week by week, errors and rage clicks on its screen, new error types, the support tickets and survey comments that followed (in the clients\' words), and earlier verdicts.',
            inputSchema: { key: z.string().describe('Jira key, e.g. ACP-230') },
            annotations: { readOnlyHint: true },
        },
        async ({ key }) => text(evidenceMarkdown(key.trim().toUpperCase()) || `${key} is not in the kept releases.`)
    )

    server.registerTool(
        'client_feedback',
        {
            title: 'What clients said',
            description: 'Support tickets (RCI, MMT Risk) and in-product survey answers from the days after each release, grouped by screen, with ratings before and after. Use it to judge how much a problem hurt.',
            inputSchema: { scope: scopeArg, screen: z.string().optional().describe('A screen path like /invoices, to narrow it down') },
            annotations: { readOnlyHint: true },
        },
        async ({ scope, screen }) => {
            if (!keptNames().length) return empty()
            const sc = resolveScope(scope)
            return sc ? text(feedbackMarkdown(sc, screen)) : noScope(scope)
        }
    )

    server.registerTool(
        'record_verdict',
        {
            title: 'Save a verdict',
            description:
                'Saves a verdict on a ticket: risky, watch or fine, with the reason. Future calls show it next to the ticket, so later reviews build on it. Only call this after the person agreed with the verdict, and pass their name in decided_by. Optionally posts it as a comment on the Jira ticket.',
            inputSchema: {
                key: z.string(),
                verdict: z.enum(['risky', 'watch', 'fine']),
                reason: z.string().min(5).describe('Why, citing the numbers or client words'),
                decided_by: z.string().describe('Who agreed to it, e.g. "Priya (PM)", or "claude" if nobody reviewed it'),
                post_to_jira: z.boolean().default(false),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        },
        async ({ key, verdict, reason, decided_by, post_to_jira }) => {
            const k = key.trim().toUpperCase()
            let row
            try {
                row = recordVerdict(k, verdict, reason, decided_by)
            } catch (e) {
                return text((e as Error).message)
            }
            let jira = ''
            if (post_to_jira) {
                try {
                    await addComment(k, `**Release review: ${verdict}** (${decided_by})\n\n${reason}\n\n_From PostHog Lens release outcomes._`)
                    jira = ' Posted to Jira.'
                } catch (e) {
                    jira = ` Saved, but Jira refused the comment: ${(e as Error).message.slice(0, 160)}`
                }
            }
            return text(`Saved: ${k} (${row.release}) is ${verdict}, by ${decided_by}.${jira}`)
        }
    )

    server.registerTool(
        'correct_ticket_link',
        {
            title: 'Fix how a ticket is linked',
            description:
                'When a ticket is linked to the wrong screen or event (or none), set the right one, then its numbers are recounted. screen_problems says whether errors, rage clicks and complaints on the screen count for this ticket ("auto" lets the rules decide). reset=true goes back to the automatic link.',
            inputSchema: {
                key: z.string(),
                screen: z.string().optional().describe('Screen path, e.g. /settings'),
                event: z.string().optional().describe('PostHog event name, e.g. theme_changed'),
                screen_problems: z.enum(['auto', 'count', 'ignore']).default('auto'),
                reset: z.boolean().default(false),
                changed_by: z.string().describe('Who asked for the change'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async ({ key, screen, event, screen_problems, reset, changed_by }) => {
            const k = key.trim().toUpperCase()
            const release = ticketRelease(k)
            if (!release) return text(`${k} is not in the kept releases.`)
            if (reset) setLink(k, null, changed_by)
            else {
                if (!screen && !event) return text('Give a screen, an event, or both (or reset=true).')
                if (screen && !screen.startsWith('/')) return text('A screen is a path that starts with /, e.g. /invoices.')
                setLink(k, { screen, event, ...(screen_problems === 'auto' ? {} : { risk: screen_problems === 'count' }) }, changed_by)
            }
            await recompute(release)
            return text(`Updated and recounted.\n\n${ticketText(k)}`)
        }
    )

    server.registerTool(
        'refresh_releases',
        {
            title: 'Refresh from Jira and PostHog',
            description: 'Reads the releases and tickets from Jira again and recounts everything in PostHog (about 15 seconds). The service also does this every 6 hours.',
            inputSchema: {},
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        },
        async () => {
            const r = await syncReleases()
            return text(`Refreshed ${r.releases.length} releases (${r.releases[0]} to ${r.releases.at(-1)}), ${r.tickets} tickets, in ${r.seconds} s.${r.dropped.length ? ` No longer kept: ${r.dropped.join(', ')}.` : ''}`)
        }
    )

    server.registerPrompt(
        'review_release',
        {
            title: 'Review a release',
            description: 'Judge which tickets in a release (or quarter) are risky, from the outcomes and what clients said.',
            argsSchema: { scope: z.string().optional().describe('e.g. 26.10.0, Q3 2026, last 3') },
        },
        ({ scope }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Review the release outcomes for ${scope || 'the latest release'} with the PostHog Lens tools.

1. Call release_outcomes${scope ? ` with scope "${scope}"` : ' with scope "last 1"'}. Then client_feedback for the same scope.
2. For each ticket in "More errors", "More rage clicks", "Clients complained" or "Low uptake", call ticket_evidence.
3. Decide for each of those tickets: risky, watch or fine. Weigh:
   - how many clients are affected, and whether they are large ones;
   - whether it blocks work (errors, failed exports) or only annoys (rage clicks);
   - whether it is growing or fading week by week, and whether a later release fixed it;
   - what clients actually said, in support tickets and surveys;
   - earlier verdicts on the same ticket, and why they were made.
   A ticket that shares a screen with others may not be the cause: say so.
4. Reply with a short table (ticket, verdict, one-line reason with numbers), then the 2 or 3 things to act on first. Mention what went well (adopted, fixed) in one line.
5. Ask me which verdicts to save. Only then call record_verdict, with decided_by set to who agreed. Do not invent numbers: use only what the tools returned.`,
                    },
                },
            ],
        })
    )
}
