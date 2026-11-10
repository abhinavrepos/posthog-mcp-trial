// Claude Code cuts instructions at 2,048 characters. Keep replay privacy first and routing next.
import { appEvents } from '../core/appevents.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { P } from '../core/props.ts'

export const INSTRUCTIONS_LIMIT = 2048

export function serverInstructions(withPosthog = posthogMcpActive()): string {
    const p = config.properties
    const client = p.clientFromDistinctId ? `part ${p.clientFromDistinctId} of the distinct id` : `the event property ${p.client}`
    const app = appEvents()?.app || 'the app'
    return `Replays are private: never call PostHog's session-recording-*, query-session-recordings-list or vision-* tools. Use get_replay_link; give the person the link, never view replay content.

Lens (${config.mcp.name}) = a named ${app} client or user, trade/link id, dialog/screen/button, one session, Jira ticket, release outcome, "where do clients struggle", "who is at risk", ${app}'s error messages and which clients any error hit.
${withPosthog ? `Use PostHog's server (posthog) for generic product analytics and PostHog objects: trends, funnels, retention, insights, dashboards, feature flags, experiments, surveys, cohorts, annotations, actions/event definitions, managing error-tracking issues, batch exports, docs/SDK help, raw SQL (execute-sql).
PostHog's one tool, exec, takes a command string; call Lens tools directly with JSON, never via exec.
In PostHog SQL the client is ${P.client}.
` : 'Call Lens tools directly with JSON arguments. For other questions, say this server does not cover them.\n'}
A client is ${client}, not a person or cohort.
Lens tools:
- client name/id/email: resolve_client; recent problems: find_client_incidents
- screen use by clients: screen_usage; who hit an error: error_blast_radius; struggle without errors: find_silent_issues
- Jira triage: triage_ticket
- releases: list_releases, release_outcomes; one ticket: ticket_evidence; complaints after shipping: client_feedback
- save an agreed verdict: record_verdict; fix a ticket link: correct_ticket_link; sync: refresh_releases${appEvents() ? `
- ${app} vocabulary: describe_app_events (once first); worst pains: top_pains; dialog failures: dialog_friction; misleading messages: message_doctor; one session timeline: session_story; slow buttons/HTTP failures: attempt_timings; trade/link id: find_trade; clients at risk: client_signals; workflows: discover_workflows, workflow_completion, save_workflow` : ''}`
}
