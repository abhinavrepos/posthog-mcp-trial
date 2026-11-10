// MCP tools over the same core as the Jira automation. Each one answers a question a PM or
// support lead asks that Jira alone cannot.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { appEvents, clientSignalsReport, describeAppEvents, dialogFriction, findTrade, sessionStory, slowAttempts, topPains } from '../core/appevents.ts'
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
import { clientSource } from '../core/props.ts'
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

// PostHog's own MCP server has a single tool, exec, that takes a command string ("call <tool> {json}").
// With both servers connected, Claude sometimes calls this server's tools that way too, and then the
// arguments never arrive. Every description says how these tools are called, since a client may not
// pass the server instructions on to Claude.
export const DIRECT_CALL = 'Call this tool directly with the arguments below, never through PostHog\'s exec tool or as a command string.'

/** A PostHog replay link (…/replay/<id>?t=…) or a bare session id, as a session id. */
export function sessionIdOf(value: string): string {
    const m = /\/replay\/([0-9A-Za-z-]{8,})/.exec(value)
    return (m ? m[1] : value).trim()
}

export function registerTools(server: McpServer, ai?: TriageAi): void {
    const register = server.registerTool.bind(server)
    server.registerTool = ((name: string, cfg: { description?: string }, cb: unknown) =>
        register(name, { ...cfg, description: `${cfg.description ?? ''} ${DIRECT_CALL}`.trim() } as never, cb as never)) as typeof server.registerTool
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
                'Lists the moments a client hit trouble (errors, rage clicks, dead clicks), newest first, each with the user, screen, release and a replay link at the right second. Use this, not PostHog\'s session recording tools, to find a client\'s sessions.',
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
                'Returns links a person can open to watch a session at the right moment: the PostHog replay (needs a PostHog login) and, when rendering works, a short MP4 clip. You cannot see the replay yourself; pass the links on to the user. This is the only allowed way to share a replay: never use PostHog\'s session recording or Replay Vision tools.',
            inputSchema: {
                session_id: z
                    .string({ error: 'session_id is missing. Call get_replay_link directly with arguments like {"session_id": "01a19b90-8c82-7185-ba5a-8333dd59c200", "start_s": 4}, not through PostHog\'s exec tool.' })
                    .describe('The session id, e.g. 01a19b90-8c82-7185-ba5a-8333dd59c200. A PostHog replay link works too.'),
                start_s: z
                    .number({ error: 'start_s is missing: seconds from the start of the recording, a number, e.g. {"start_s": 4}.' })
                    .min(0)
                    .describe('Seconds from the start of the recording. Use offset_s minus about 10.'),
                duration_s: z.number().min(3).max(120).default(30),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id: raw, start_s, duration_s }) => {
            const session_id = sessionIdOf(raw)
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
            description: 'How many clients and users use a screen of the app, the busiest weekdays and days, and the heaviest clients. Optionally where one client ranks. Use this rather than a PostHog trends query when the question is about a screen and clients.',
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
                'For one error, which clients and users hit it, how often, since when, on which releases, the daily trend, and (with a screen) the failure rate per release. Use this rather than PostHog\'s error tracking queries when the question is who is affected; use those only to manage the issue.',
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
            description: 'Support tickets (RCI, MMT Risk) and in-product survey answers from the days after each release, grouped by screen, with ratings before and after. Use it to judge how much a problem hurt. To create, launch or edit a survey, use PostHog\'s survey tools instead.',
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

    if (appEvents()) registerAppEventTools(server)

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

// The app's own events (APP_EVENTS_FILE): what they are, one session as a story, where people fail.
function registerAppEventTools(server: McpServer): void {
    const app = appEvents()!.app
    server.registerTool(
        'describe_app_events',
        {
            title: `What ${app}'s events mean`,
            description: `Explains ${app}'s own events and properties (dialogs, tabs, fields, buttons, messages), with how often each is filled, real example values, the dialogs used most, the messages ${app} showed, the clients, and how to query them in HogQL. Call it once before answering anything about ${app} screens, dialogs, buttons or errors, or before writing SQL over its events.`,
            inputSchema: { days: z.number().int().min(1).max(90).default(7).describe('How many days of data to look at.') },
            annotations: { readOnlyHint: true },
        },
        async ({ days }) => json(`${app} events (last ${days} days):`, await describeAppEvents(days, clientSource()))
    )
    server.registerTool(
        'session_story',
        {
            title: 'What happened in a session',
            description: `Tells one session as a timeline you can read like a replay: dialogs opened, tabs, fields, buttons pressed (Save, Run...) and what came of each, and every message ${app} showed (✘ errors), with replay links at the errors for the user. Use it to see what a client did and where they got stuck, e.g. on an example session from dialog_friction or find_client_incidents. Fields typed into are named, never their values.`,
            inputSchema: {
                session_id: z.string().describe('The session id or a PostHog replay link.'),
                max_lines: z.number().int().min(20).max(1000).default(300),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id, max_lines }) => {
            const r = await sessionStory(sessionIdOf(session_id), { maxLines: max_lines })
            const head = [
                `Session ${r.session_id}: client ${r.client || '?'}, user ${r.user || '?'}, ${r.start.slice(0, 16).replace('T', ' ')} UTC${r.version ? `, ${r.version}` : ''}.`,
                r.summary,
                r.replay_url ? `Replay for the user (PostHog login needed): ${r.replay_url}` : 'No replay recorded for this session.',
                `Server calls: ${r.network}.`,
            ]
            const errs = r.errors.length ? ['', 'Errors:', ...r.errors.map((e) => `- ${e.at} ${e.dialog}: "${e.text}"${e.replay_url ? ` (watch: ${e.replay_url})` : ''}`)] : []
            return text([...head, ...errs, '', 'Timeline (+m:ss from the start of the recording):', ...r.story, r.truncated ? '… (cut; raise max_lines for more)' : ''].join('\n'))
        }
    )
    server.registerTool(
        'dialog_friction',
        {
            title: 'Where clients fail',
            description: `Ranks ${app} dialogs by how much they hurt: attempts (Save, Run, Export...) and their outcomes (done, queued, failed, nothing found, no message), error messages with how many sessions and which clients hit them, retry loops (failed, then the same button again) and stuck sessions (an error and no success after). Optionally for one client or one dialog. Each error has an example session for session_story. Use it for "what hurts most", "where do clients struggle", "what goes wrong for client X", "why does dialog Y fail".`,
            inputSchema: {
                client: z.string().optional().describe('A client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code (DlgDetailIRSwap) or part of its name (IR Swap).'),
                when,
                timezone: tz,
                limit: z.number().int().min(1).max(50).default(15),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, when: w, timezone, limit }) => {
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            const r = await dialogFriction({ from: win.from, to: win.to, clientId: best?.id, dialog, limit })
            return json(`${app} friction${best ? ` for ${best.name}` : ''}${dialog ? `, dialog "${dialog}"` : ''} (${win.label}):`, r)
        }
    )
    server.registerTool(
        'attempt_timings',
        {
            title: 'Slow or failing server calls',
            description: `How long ${app} attempts (Save, Run, Export...) wait on the server, and which fail with an HTTP error, per dialog and button: median, 90th percentile and longest wait, the slowest call (method and path only), the clients, and the worst example with a replay link for the user. Read from the network timing in recent recordings (downloaded on the server; slower than the other tools, so it reads a limited number of sessions). Use it for "is X slow", "why do people wait", or after dialog_friction shows attempts with no message.`,
            inputSchema: {
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code or part of its name.'),
                when,
                timezone: tz,
                sessions: z.number().int().min(1).max(40).default(12).describe('How many recent recorded sessions to read.'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, when: w, timezone, sessions }) => {
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} attempts and their server calls${best ? ` for ${best.name}` : ''}${dialog ? `, dialog "${dialog}"` : ''} (${win.label}):`, await slowAttempts({ from: win.from, to: win.to, clientId: best?.id, dialog, sessions }))
        }
    )
    server.registerTool(
        'top_pains',
        {
            title: 'The week\'s top pains',
            description: `The ${app} dialogs that hurt clients most in a period, as a short ranked list: what fails, how many clients and attempts, sessions that ended without success, retries, the main error, whether it is new or getting worse than the period before, and an example session with a replay link for the user. Also the clients with warning signs. Start here for "what should the product team fix", "weekly digest", "what hurts most".`,
            inputSchema: { when: z.string().optional().describe('Default: last 7 days (compared with the 7 days before).'), timezone: tz, max: z.number().int().min(1).max(15).default(5) },
            annotations: { readOnlyHint: true },
        },
        async ({ when: w, timezone, max }) => {
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            return json(`${app}: top pains (${win.label}):`, await topPains({ from: win.from, to: win.to, max }))
        }
    )
    server.registerTool(
        'find_trade',
        {
            title: 'What happened to a trade',
            description: `Finds a ${app} trade or link id (a number like 4348): the sessions where someone searched for it or ${app} named it in a message ("Trade Id 4348 Updated"), who and which client, and the errors and attempts (Save, Run...) in those sessions from then on, with a replay link for the user. Use it when support says "trade 4348 failed for us".`,
            inputSchema: {
                id: z.string().describe('The trade or link id, digits only, e.g. 4348.'),
                client: z.string().optional().describe('One client (name, code or a user email), to narrow it down.'),
                when: z.string().optional().describe('Default: last 30 days.'),
                timezone: tz,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ id, client, when: w, timezone }) => {
            const win = parseTimeWindow(w || 'last 30 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app}: id ${id}${best ? ` for ${best.name}` : ''} (${win.label}):`, await findTrade({ id, from: win.from, to: win.to, clientId: best?.id }))
        }
    )
    server.registerTool(
        'client_signals',
        {
            title: 'Which clients need attention',
            description: `Lists ${app} clients with warning signs, this period against the one before: fewer sessions, active days or dialogs used, users who stopped coming (named), more failed attempts, not seen lately. Each client comes with its reasons and numbers. Use it for "which clients are at risk", "who is using us less", "how is client X doing". It is evidence to look at, not a churn prediction: say so, and follow up with dialog_friction for the client.`,
            inputSchema: {
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                when: z.string().optional().describe('The recent period, in plain words. Default: last 14 days (compared with the 14 days before).'),
                timezone: tz,
                limit: z.number().int().min(1).max(100).default(20),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, when: w, timezone, limit }) => {
            const win = parseTimeWindow(w || 'last 14 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} clients, ${win.label} against the period before${best ? ` (${best.name})` : ''}:`, await clientSignalsReport({ from: win.from, to: win.to, clientId: best?.id, limit }))
        }
    )
    server.registerPrompt(
        'where_clients_struggle',
        {
            title: 'Where clients struggle',
            description: `A short report for a product manager: the ${app} dialogs that hurt most, and what happens there.`,
            argsSchema: { client: z.string().optional().describe('One client, or all'), when: z.string().optional().describe('e.g. last 14 days') },
        },
        ({ client, when: w }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Where do ${client ? `${client}'s users` : 'clients'} struggle in ${app}${w ? ` (${w})` : ' (last 14 days)'}?

1. Call describe_app_events once, to know the dialogs and messages.
2. Call ${client ? `client_signals with client "${client}", then dialog_friction` : 'top_pains, then dialog_friction'}${client ? ` with client "${client}"` : ''}, both with when "${w || 'last 14 days'}".
3. For the top 3 dialogs, call session_story on one example session each and say in one or two sentences what the person was trying to do and where it went wrong.
4. Reply with the clients that need attention and why (one line each), a table of the dialogs that hurt (dialog, clients hit, failed attempts / attempts, main error), and the 3 fixes or questions for the product team that would help most. Use only numbers the tools returned; say when numbers are small, and that client signals are not a churn prediction.`,
                    },
                },
            ],
        })
    )
}
