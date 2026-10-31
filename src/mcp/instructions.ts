// What this MCP server tells Claude when it connects. Claude reads these instructions next to the
// tool list, so this is where we say which server to use when PostHog's own MCP server is connected
// too. Both read the same PostHog project, and several of their tools look alike.
//
// Claude Code cuts instructions at 2,048 characters without warning, so the most important rules
// come first and a test keeps the text under the limit.
import { config } from '../core/config.ts'

export const INSTRUCTIONS_LIMIT = 2048

export function serverInstructions(): string {
    const p = config.properties
    const version = p.version ? `, release properties.${p.version}` : ''
    return `This server (${config.app.name}) covers clients, Jira tickets, releases and replay links for PostHog project ${config.posthog.projectId || '?'}. PostHog's own MCP server ("posthog") may be connected too, on the same project.

Replays are private: never call PostHog's session-recording-*, query-session-recordings-list or vision-* tools, even if offered. To show a session, use get_replay_link and give the person the link.

Use THIS server when the question names a Jira key, a client, a release or a screen:
- ticket, RCI, MMT Risk, "what happened to <client>": triage_ticket, or find_client_incidents
- which client a name, id or email means: resolve_client (a client is the event property "${p.client}", not a person, group or cohort)
- "is it just them?", who hit an error: error_blast_radius
- struggle with no error: find_silent_issues
- how a screen is used, by which clients: screen_usage
- releases ("26.10.0", "Q3 2026", "last 3"), what tickets did after shipping, client complaints, verdicts: release_outcomes, ticket_evidence, client_feedback, list_releases, record_verdict, correct_ticket_link

Use PostHog's server for everything else: ad-hoc SQL (execute-sql), trends, funnels, retention, insights, dashboards, feature flags, experiments, creating or editing surveys, cohorts, annotations, event definitions, managing error tracking issues, PostHog docs.

For a number this server lacks, use PostHog's execute-sql: client properties.${p.client}, name properties.${p.clientName}${version}, email person.properties.${p.personEmail}.`
}
