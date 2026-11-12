// MCP tools over the same core as the Jira automation. Each one answers a question a PM or
// support lead asks that Jira alone cannot.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { appEvents, clientSignalsReport, describeAppEvents, dialogFriction, findTrade, sessionStory, slowAttempts, topPains } from '../core/appevents.ts'
import { completionWorkflow, discoverWorkflows, workflowCompletionReport } from '../core/workflowqueries.ts'
import { WORKFLOW_NAME_LIMIT } from '../core/workflows.ts'
import { SCREENS } from '../core/catalog.ts'
import { revalBrief } from '../core/brief.ts'
import { renderClip } from '../core/clip.ts'
import { errorImpact } from '../core/impact.ts'
import { bestPerSession, findIncidents } from '../core/incidents.ts'
import { messageDoctor } from '../core/messagedoctor.ts'
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
import { registerSurveyTools, surveyToolNames } from './surveytools.ts'
import { registerDashboardTools, dashboardToolNames } from './dashboardtools.ts'
import type { ChatCaller } from '../service/access.ts'

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

// The tracked app's name in descriptions (from APP_EVENTS_FILE): "which Reval client".
const A = appEvents()?.app || 'your app'

// Every tool name, for PostHog's proxied exec description ("use the lens server's tools (...)").
export const CORE_TOOLS = ['resolve_client', 'find_client_incidents', 'get_replay_link', 'screen_usage', 'error_blast_radius', 'find_silent_issues', 'triage_ticket', 'list_releases', 'release_outcomes', 'ticket_evidence', 'client_feedback', 'record_verdict', 'correct_ticket_link', 'refresh_releases']
export const APP_EVENT_TOOLS = ['reval_brief', 'describe_app_events', 'top_pains', 'dialog_friction', 'session_story', 'attempt_timings', 'find_trade', 'client_signals', 'discover_workflows', 'workflow_completion', 'message_doctor']
export const lensToolNames = (): string[] => [...CORE_TOOLS, ...(appEvents() ? APP_EVENT_TOOLS : []), ...surveyToolNames(), ...dashboardToolNames()]

// Answers of the read-only analysis tools, shared by every chat session: the same question within two
// minutes is answered from memory, and identical questions asked at once share one run. Only these
// tools: their answers do not depend on who asks or change anything. Errors are never kept.
export const CACHED_TOOLS = new Set(['reval_brief', 'describe_app_events', 'top_pains', 'dialog_friction', 'session_story', 'attempt_timings', 'find_trade', 'client_signals', 'discover_workflows', 'workflow_completion', 'message_doctor', 'screen_usage', 'find_silent_issues', 'error_blast_radius'])
// All of these read PostHog events only. Lens's own writes (record_verdict, correct_ticket_link,
// refresh_releases, triage_ticket) change releases, verdicts and ticket links, which only uncached tools
// read (release_outcomes, list_releases, ticket_evidence...), so a write never needs to drop these answers.
const TOOL_TTL_MS = Math.max(0, Number(process.env.LENS_TOOL_CACHE_SECONDS ?? 120)) * 1000
const TOOL_CACHE_BYTES = 16 * 1024 * 1024
const toolAnswers = new Map<string, { at: number; value: unknown; bytes: number; ttl: number }>()
const toolFlights = new Map<string, Promise<unknown>>()
let toolBytes = 0
// Arguments as text with object keys sorted at every level, so {a, b} and {b, a} are the same question.
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}`
    : JSON.stringify(v) ?? 'null'
export function clearToolAnswers(): void { toolAnswers.clear(); toolFlights.clear(); toolBytes = 0 }
// Calls made by the background pre-warm (src/mcp/prewarm.ts) recompute their answer and keep it until the
// next round. Only those calls: the flag travels with the pre-warm's own async work, so chat questions
// asked during a round still get the kept answer at once.
const prewarming = new AsyncLocalStorage<number>()
export function withPrewarm<T>(ttlMs: number, work: () => Promise<T>): Promise<T> {
    return prewarming.run(ttlMs, work)
}
function remember(key: string, value: unknown, ttl: number): void {
    const bytes = JSON.stringify(value).length
    if (bytes > TOOL_CACHE_BYTES / 8) return // one huge answer must not push everything else out
    const old = toolAnswers.get(key); if (old) { toolBytes -= old.bytes; toolAnswers.delete(key) }
    toolAnswers.set(key, { at: Date.now(), value, bytes, ttl }); toolBytes += bytes
    for (const [k, v] of toolAnswers) { if (toolBytes <= TOOL_CACHE_BYTES && toolAnswers.size <= 256) break; toolAnswers.delete(k); toolBytes -= v.bytes }
}
export async function cachedToolCall(name: string, args: unknown, run: () => Promise<unknown>): Promise<unknown> {
    if (!TOOL_TTL_MS) return run()
    const key = name + '\u0000' + stable(args ?? {})
    const prewarmTtl = prewarming.getStore() ?? 0
    const hit = toolAnswers.get(key), refreshing = prewarmTtl > 0
    if (hit && !refreshing && Date.now() - hit.at < hit.ttl) { toolAnswers.delete(key); toolAnswers.set(key, hit); return structuredClone(hit.value) }
    // A chat question while the pre-warm refreshes this answer gets the kept one rather than waiting.
    if (hit && !refreshing && toolFlights.has(key)) return structuredClone(hit.value)
    let flight = toolFlights.get(key)
    if (!flight) {
        const ttl = Math.max(TOOL_TTL_MS, prewarmTtl)
        flight = run().then((value) => {
            if (!(value as { isError?: boolean } | undefined)?.isError) remember(key, value, ttl)
            return value
        }).finally(() => toolFlights.delete(key))
        toolFlights.set(key, flight)
    }
    return structuredClone(await flight)
}

export function registerTools(server: McpServer, ai?: TriageAi, caller?: Pick<ChatCaller, 'who' | 'surveyRole'> & Partial<Pick<ChatCaller, 'email' | 'dashboardRole' | 'admin'>>): void {
    const register = server.registerTool.bind(server)
    server.registerTool = ((name: string, cfg: { description?: string }, cb: unknown) => {
        const call = cb as (a: unknown, e: unknown) => unknown
        const handler = typeof cb !== 'function' ? cb
            : CACHED_TOOLS.has(name) ? (args: unknown, extra: unknown) => cachedToolCall(name, args, () => Promise.resolve(call(args, extra)))
            : cb
        return register(name, { ...cfg, description: `${cfg.description ?? ''} ${DIRECT_CALL}`.trim() } as never, handler as never)
    }) as typeof server.registerTool
    server.registerTool(
        'resolve_client',
        {
            title: 'Identify a client',
            description: `Identifies which ${A} client a name, client code or user email belongs to. Use it when a ticket names a client loosely.`,
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
                `Finds the sessions where a ${A} client, or one of its users, hit errors, rage clicks or dead clicks, with screens, releases and replay links. Use PostHog's exec instead for generic session recording lists via metadata SQL; never retrieve replay content there.`,
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
                `Gives a person links to watch one ${A} session at the right moment, including a replay and, when available, an MP4 clip. You cannot see the replay yourself; pass the links to the user. This is the only allowed way to share a replay: never use PostHog's session recording or Replay Vision tools.`,
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
            description: `Shows how a ${A} screen is used, by which clients and users, on which days, and where one client ranks. Use PostHog's exec instead for generic trends, insights or product analytics.`,
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
                `Shows which ${A} clients and users hit an error message, how often, since when and on which releases. With a screen, includes failure rates per release. Use PostHog's exec instead for error tracking issue management, such as listing, assigning or resolving issues.`,
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
            description: `Finds sessions where a ${A} client struggled without errors: rage clicks, dead clicks, repeated actions or long stays. Use it for wrong data or confusion reported in a ticket.`,
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
                `Triages a ${A} Jira ticket by identifying its client, screen and time, finding the session, and adding replay links, impact, usage and a suggested priority. Returns the report as markdown.`,
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
            description: `Lists ${A} Jira releases, dates, available quarters and headline outcomes. Includes clients, errors and rage clicks per 1,000 sessions before and after, support tickets and survey ratings.`,
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
                `Shows what happened after ${A} tickets shipped in a release, quarter or range, grouped by outcome. Includes errors, rage clicks, complaints, adoption, improvements and saved verdicts. Facts only: deciding what is risky is up to you. Start here for release reviews.`,
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
            description: `Explains the evidence for one ${A} Jira ticket and its release outcome. Includes its screen/event link, use before and after, errors, rage clicks, support tickets, survey comments in clients' words and earlier verdicts.`,
            inputSchema: { key: z.string().describe('Jira key, e.g. ACP-230') },
            annotations: { readOnlyHint: true },
        },
        async ({ key }) => text(evidenceMarkdown(key.trim().toUpperCase()) || `${key} is not in the kept releases.`)
    )

    server.registerTool(
        'client_feedback',
        {
            title: 'What clients said',
            description: `Shows what ${A} clients complained about after a release, grouped by screen, from support tickets and survey answers with ratings before and after. Use PostHog's exec instead for generic trends or funnels. Surveys themselves are handled only by the Lens survey tools (never PostHog), and launched only on the Lens Surveys page.`,
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
                `Saves an agreed verdict on a ${A} Jira ticket: risky, watch or fine, with the reason. Future calls show it next to the ticket. Only call this after the person agreed, and pass their name in decided_by. Optionally posts a comment to Jira.`,
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
                `Fixes a ${A} Jira ticket's link to a screen or event, then recounts its release evidence. screen_problems controls whether screen errors, rage clicks and complaints count (auto lets the rules decide). reset=true restores the automatic link.`,
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
            description: `Refreshes ${A} releases and tickets from Jira and recounts their PostHog evidence (about 15 seconds). The service also does this every 6 hours.`,
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
    registerSurveyTools(server, caller)
    if (appEvents()) registerDashboardTools(server, caller && { who: caller.who, email: caller.email, dashboardRole: caller.dashboardRole ?? 'view', surveyRole: caller.surveyRole, admin: !!caller.admin })
}

// The app's own events (APP_EVENTS_FILE): what they are, one session as a story, where people fail.
function registerAppEventTools(server: McpServer): void {
    const app = appEvents()!.app
    server.registerTool(
        'reval_brief',
        {
            title: 'Brief me on Reval',
            description: 'Start here for any question a product manager asks about Reval: what to worry about, how a client is doing, a dialog, a trade, or a weekly brief. The server investigates and returns a concise brief with comparisons, evidence links, limits and next questions. Relay it as returned; add no invented facts. No setup or other tool calls needed.',
            inputSchema: {
                question: z.string().optional().describe('The PM’s question in their own words. Omit for a general brief.'),
                client: z.string().optional().describe('Client name, id or email, if already known.'),
                dialog: z.string().optional().describe('Dialog name or code, if already known.'),
                trade: z.string().regex(/^\d{1,15}$/).optional().describe('Trade/link id, if already known.'),
                when: z.string().optional().describe('Plain-language window; default last 14 days, or 30 for a trade.'),
                timezone: tz,
            },
            annotations: { readOnlyHint: true },
        },
        async (input) => text(await revalBrief(input))
    )
    server.registerTool(
        'discover_workflows',
        {
            title: 'Which tasks people do and finish',
            description: `Which tasks do people do in ${app}, and do they finish them? Discovers frequent ordered dialog chains ending in a submit, ranked by sessions × clients, with completed and queued counts, durations and top errors. Lens supplies names from dialog titles, the submit button and success message, plus stable ids; no setup needed.`,
            inputSchema: { when, client: z.string().optional(), limit: z.number().int().min(1).max(50).default(15) },
            annotations: { readOnlyHint: true },
        },
        async ({ when: w, client, limit }) => {
            const win = parseTimeWindow(w || 'last 7 days')
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} workflows (${win.label}):`, await discoverWorkflows({ from: win.from, to: win.to, clientId: best?.id, limit }))
        }
    )
    server.registerTool(
        'workflow_completion',
        {
            title: 'Do clients finish a workflow',
            description: `Which tasks do people do in ${app}, and do they finish them? Measures a discovered workflow id/name or ordered dialogs per client and overall: starts, funnel, done, failures, retries, abandonment, time, dropout errors and example replay links for the person. Compares the previous equal window. Give either workflow or dialogs. Discovered workflows count completed or queued as done and report them separately; dialog lists require completed.`,
            inputSchema: { workflow: z.string().trim().min(1).max(WORKFLOW_NAME_LIMIT).optional().describe('Discovered workflow id or exact name from discover_workflows.'), dialogs: z.array(z.string().min(1).max(80)).min(1).max(10).optional(), client: z.string().optional(), when },
            annotations: { readOnlyHint: true },
        },
        async ({ workflow, dialogs, client, when: w }) => {
            const win = parseTimeWindow(w || 'last 7 days')
            const best = client ? (await pickClient(client)).best : undefined
            const q = { from: win.from, to: win.to, clientId: best?.id }
            const definition = await completionWorkflow({ ...q, workflow, dialogs })
            return json(`${app} workflow completion (${win.label}):`, await workflowCompletionReport({ ...q, definition }))
        }
    )
    server.registerTool(
        'describe_app_events',
        {
            title: `What ${app}'s events mean`,
            description: `Explains ${app} dialogs, screens, buttons, fields and error messages using the app's event vocabulary. Includes coverage, real example values, common dialogs and messages, clients and HogQL guidance. Use for vocabulary details when drilling into events; reval_brief investigates directly. Use PostHog's exec instead for managing event definitions or ad-hoc SQL.`,
            inputSchema: { days: z.number().int().min(1).max(90).default(7).describe('How many days of data to look at.') },
            annotations: { readOnlyHint: true },
        },
        async ({ days }) => json(`${app} events (last ${days} days):`, await describeAppEvents(days, clientSource()))
    )
    server.registerTool(
        'session_story',
        {
            title: 'What happened in a session',
            description: `Explains what happened in one ${app} session: dialogs, tabs, fields, button presses, outcomes and error messages in time order. Uses events, with replay links for the person to open. Field names are shown, never typed values. Follow up on sessions from dialog_friction or find_client_incidents.`,
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
            description: `Explains why a ${app} dialog fails: button attempts, outcomes, error messages, affected clients, retry loops and stuck sessions. Optionally narrow to one client or dialog. Each error has an example session for session_story.`,
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
        'message_doctor',
        {
            title: 'Which error messages mislead',
            description: `Which of Reval's error messages leave people stuck, and what do they do to recover? Groups errors by template and dialog, learns the field labels touched, other dialogs opened and whether people search, then reports recovery, repeated failures and give-ups. Flags dead ends and messages pointing elsewhere, with counts and example sessions.`,
            inputSchema: {
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code or part of its name.'),
                message: z.string().optional().describe('Text to match in an error message or its template, ignoring case.'),
                when,
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, message, when: w }) => {
            const win = parseTimeWindow(w || 'last 7 days')
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} message doctor${best ? ` for ${best.name}` : ''} (${win.label}):`, await messageDoctor({ from: win.from, to: win.to, clientId: best?.id, dialog, message }))
        }
    )
    server.registerTool(
        'attempt_timings',
        {
            title: 'Slow or failing server calls',
            description: `Shows whether ${app} buttons such as Save, Run or Export are slow, and which server calls fail with HTTP errors. Includes median, 90th percentile and longest waits by dialog/button, method/path, clients and example replay links. Reads network timing on the server from a limited number of recent recordings.`,
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
            description: `Ranks where ${app} clients struggle most: failing dialogs, retries, unfinished attempts, error messages and clients at risk. Gives counts, changes against the previous period and example session links. Start here for a weekly product summary or what to fix first.`,
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
            description: `Finds what happened to a ${app} trade or link id, such as 4348, including clients, sessions, errors and button attempts. Matches searches and messages that name the id, with replay links for the person.`,
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
            description: `Shows which ${app} clients are at risk or using the app less: fewer sessions, active days or dialogs, absent users and more failed attempts. Compares periods with reasons and numbers. These are warning signs, not a churn prediction; say so and follow up with dialog_friction for the client.`,
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

Call reval_brief first with ${JSON.stringify({ question: 'Where do clients struggle?', ...(client ? { client } : {}), when: w || 'last 14 days' })}.
Relay the returned brief, including its evidence and limits. Add nothing invented. Replays are links for the person only.`,
                    },
                },
            ],
        })
    )
    const briefPrompt = (args: Record<string, string>) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const,
            text: `Call reval_brief first with ${JSON.stringify(args)}. Relay its brief, evidence and limits as returned. Add no invented facts or numbers. Replay links are for the person; never view replay content.`,
        } }],
    })
    server.registerPrompt('weekly_review', {
        title: 'Weekly Reval review', description: 'What should I worry about this week?',
    }, () => briefPrompt({ question: 'Brief me on what needs attention this week', when: 'last 7 days' }))
    server.registerPrompt('client_check', {
        title: 'Check a Reval client', description: 'How is this client doing?',
        argsSchema: { client: z.string().describe('Client name or id') },
    }, ({ client }) => briefPrompt({ question: 'How is this client doing?', client }))
    server.registerPrompt('release_check', {
        title: 'Check after a release', description: 'What needs attention after a release?',
        argsSchema: { release: z.string().optional().describe('Release name or version, if known') },
    }, ({ release }) => briefPrompt({ question: `What should I worry about after release ${release || 'the latest release'}?`, when: 'last 14 days' }))
}
