// Claude Code cuts instructions at 2,048 characters. Keep privacy first.
import { appEvents } from '../core/appevents.ts'
import { anonFor } from '../core/anonymise.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { P } from '../core/props.ts'
import { surveyToolNames } from './surveytools.ts'
import { dashboardToolNames } from './dashboardtools.ts'
import type { SurveyRole, DashboardRole } from '../service/access.ts'

export const INSTRUCTIONS_LIMIT = 2048

export function serverInstructions(withPosthog = posthogMcpActive(), surveyRole: SurveyRole = 'launch', dashboardRole: DashboardRole = 'share'): string {
    const p = config.properties
    const client = p.clientFromDistinctId ? `part ${p.clientFromDistinctId} of the distinct id` : `the event property ${p.client}`
    const app = appEvents()?.app || 'the app'
    const surveys = surveyToolNames(surveyRole)
    const dashboards = dashboardToolNames(dashboardRole, surveyRole)
    // Client anonymisation (Admin → Client privacy for AI): codenames only.
    const privacy = anonFor('lens') ? `Clients are known here only by codename (two words, e.g. Teal Wren). Never write a real client name or code, even if the person does: ask for the codename (Lens → Codenames).\n` : ''
    return `${privacy}Replays are private: never call PostHog's session-recording-*, query-session-recordings-list or vision-* tools. Use get_replay_link; give the person the link, never view replay content.

Lens (${config.mcp.name}) = ${app} clients/users, tasks and flows, trades, dialogs/buttons, sessions, Jira tickets, releases, client risk and app errors.
${withPosthog ? `Use PostHog's server (posthog) for generic analytics, trends, funnels, retention, insights, PostHog dashboards, flags, experiments, cohorts, annotations, actions, error issues, exports, SDK docs and raw SQL (execute-sql).
PostHog's one tool, exec, takes a command string; call Lens tools directly with JSON, never via exec.
In PostHog SQL the client is ${P.client}.
` : 'Call Lens tools directly with JSON arguments. For other questions, say this server does not cover them.\n'}
A client is ${client}, not a person or cohort.
Lens tools:
- client name/id/email: resolve_client; recent problems: find_client_incidents
- screen use by clients: screen_usage; who hit an error: error_blast_radius; struggle without errors: find_silent_issues
- Jira triage: triage_ticket
- releases: list_releases, release_outcomes; one ticket: ticket_evidence; complaints after shipping: client_feedback
- agreed verdict: record_verdict; ticket link: correct_ticket_link; sync: refresh_releases${appEvents() ? `
- reval_brief first for PM questions; ${app}: describe_app_events vocabulary; top_pains; dialog_friction failures; message_doctor messages; session_story; attempt_timings waits; find_trade ids; client_signals risk; discover_workflows, workflow_completion` : ''}${dashboards.length ? `
- "how is <client> doing": client_experience first, then client_story, handover_pack; screen friction: friction_hotspots; weekly: monday_brief, signal_scorecard; rescue_queue${dashboards.includes('draft_rescue_survey') ? ', draft_rescue_survey' : ''}${dashboards.includes('set_rescue_status') ? ', set_rescue_status' : ''}; tasks: task_map, flow_time, find_task; pins: ${dashboards.filter((t) => /pin|share|list/.test(t)).join(', ') || 'none'}` : appEvents() ? `
- dashboards (task map, flow time): this person has no access; a Lens admin grants it` : ''}${surveys.length ? `
- in-app surveys for ${app} users (only here, never PostHog): ${surveys.join(', ')}. Launching: only on the Lens Surveys page, never from chat${surveyRole === 'launch' ? '' : '. More needs a higher survey role (Lens admin)'}` : surveyToolNames().length ? `
- in-app surveys: this person has no survey access in Lens; a Lens admin grants it (never use PostHog for surveys)` : ''}`
}
