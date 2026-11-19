// Claude Code cuts instructions at 2,048 characters. Keep privacy first.
import { P } from '../core/props.ts'
import { appEvents } from '../core/appevents.ts'
import { anonFor, privacyMode } from '../core/anonymise.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { surveyToolNames } from './surveytools.ts'
import { dashboardToolNames } from './dashboardtools.ts'
import type { SurveyRole, DashboardRole } from '../service/access.ts'

export const INSTRUCTIONS_LIMIT = 2048

export function serverInstructions(withPosthog = posthogMcpActive(), surveyRole: SurveyRole = 'launch', dashboardRole: DashboardRole = 'share', insights = true): string {
    const p = config.properties
    const client = p.clientFromDistinctId ? `part ${p.clientFromDistinctId} of the distinct id` : `the event property ${p.client}`
    const app = appEvents()?.app || 'the app'
    const surveys = surveyToolNames(surveyRole)
    const dashboards = dashboardToolNames(dashboardRole, surveyRole, insights)
    // Client anonymisation (Admin → Client privacy for AI): codenames only.
    const privacy = anonFor('lens') ? `Clients are known here only by numbered codename (e.g. Client 100). Never write a real client name or code, even if the person does: ask for the codename (Lens → Codenames).\n` : ''
    return `${privacy}Replays are private: never call PostHog's session-recording-*, query-session-recordings-list or vision-* tools. Use get_replay_link; give the person the link, never view replay content.

Lens (${config.mcp.name}) = ${app} clients/users, tasks, flows, trades, dialogs, sessions, Jira, releases, client risk, app errors.
${withPosthog ? `Use ${config.posthog.mcpViaLens && posthogMcpActive() ? 'posthog_exec in Lens' : "PostHog's server"} for trends, funnels, retention, insights, dashboards, flags, experiments, annotations, error-tracking admin, docs${anonFor('lens') ? '; SQL is refused in private mode' : ' and SQL (execute-sql)'}. It takes a command string. ${privacyMode() === 'open' ? 'Person reads allowed' : 'Person lists refused'}; sessions, error investigation, messaging, surveys: use Lens. SQL client: ${P.client}.
` : ''}Privacy: ${privacyMode()}; ${privacyMode() === 'open' ? 'source identities/amounts visible' : 'people/amounts masked'}. Call Lens tools with JSON.

Client = ${client}.
Tools; poll jobs: get_job_result:
- client by name/id/email: resolve_client; problems: find_client_incidents
- screen_usage; who hit an error: error_blast_radius; silent struggle: find_silent_issues
- Jira: triage_ticket
${config.features.jira ? '- releases: list_releases, release_outcomes; one ticket: ticket_evidence; complaints: client_feedback\n- record_verdict, correct_ticket_link, refresh_releases' : ''}${appEvents() ? `
- reval_brief first; dictionary: describe_app_events; top_pains; dialog_friction failures; message_doctor messages; session_story; attempt_timings waits; find_trade ids; client_signals risk; discover_workflows, workflow_completion; counts: aggregate_events` : ''}${dashboards.some(t => t === 'task_map') ? `
- "how is <client> doing": ${dashboards.includes('client_experience') ? 'client_experience first, then ' : ''}client_story, handover_pack; before churn: client_activity_changes, compare_client_patterns; ${dashboards.includes('friction_hotspots') ? 'screen friction: friction_hotspots; ' : ''}${dashboards.includes('watch_highlights') ? `watched clients: watch_highlights, session_moments, repeated_problems${dashboards.includes('watch_client') ? ', watch_client' : ''}; ` : ''}weekly: monday_brief, signal_scorecard; rescue_queue${dashboards.includes('draft_rescue_survey') ? ', draft_rescue_survey' : ''}${dashboards.includes('set_rescue_status') ? ', set_rescue_status' : ''}; tasks: task_map, flow_time, find_task; pins: ${dashboards.filter((t) => /pin|share|list/.test(t) && !t.startsWith('watch')).join(', ') || 'none'}` : appEvents() ? `
- dashboards (task map, flow time): this person has no access; a Lens admin grants it` : ''}${dashboards.includes('pin_chart') && !dashboards.includes('task_map') ? `
- pins: pin_chart, list_dashboards${dashboards.includes('share_dashboard') ? ', share_dashboard' : ''}` : ''}${surveys.length ? `
- in-app surveys for ${app} users (only here, never PostHog): ${surveys.join(', ')}. Launching: only on the Lens Surveys page, never from chat${surveyRole === 'launch' ? '' : '. More needs a higher survey role (Lens admin)'}` : surveyToolNames().length ? `
- in-app surveys: this person has no survey access in Lens; a Lens admin grants it (never use PostHog for surveys)` : ''}`
}
