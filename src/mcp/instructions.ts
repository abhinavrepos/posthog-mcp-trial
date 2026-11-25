import { posthogMcpActive } from '../core/config.ts'
import type { SurveyRole, DashboardRole } from '../service/access.ts'
export const INSTRUCTIONS_LIMIT = 2048
export function serverInstructions(_withPosthog = posthogMcpActive(), _surveyRole: SurveyRole = 'launch', _dashboardRole: DashboardRole = 'share', _insights = true): string {
    return `Lens displays PostHog data and saved graph snapshots.
Time: pass window {"last":"24h"|"7d"} (rolling to now; what "last N days" means), {"day":"YYYY-MM-DD"} or {"from","to"} (inclusive UTC dates). Results start with a context line: the window, filters and source used; quote it.
Counts: resolve_client gives all events of a client or user; for conditions (dialog, button, export label, message, active users) use posthog_exec recipe <name> <json> (run "recipe" to list) before writing SQL.
Call data_guide first before writing PostHog SQL; bound SQL with timestamp < now().
Resolve any person/client phrase (e.g. 'rib risk', 'sem ops') with resolve_client before reinterpreting the question.
Report only what tools returned; no speculation about variation or significance.
For "the year", "last year" or "all data", use data_guide coverage continuous_from..continuous_to (not data_starts..data_ends when there are gaps) and state the exact UTC bounds used; for complete weeks use only fully covered weeks.
On rate_limit wait retry_after_seconds once; do not repeat refused calls.
For analysis use posthog_exec: tools / info <tool> / call <tool> <json>. Poll get_job_result when a call returns a job_id.
For "what did client X do" or a replay of X doing Y: resolve_client, then find_sessions (recorded_only: true when they want a replay to watch). Preserve matched_user when resolution matches a user. Screen matches dialog/tab names or codes; what matches actions and messages. Windows may cover up to one year.
When you return a session or replay, always show both links: the PostHog replay link and the Lens clip link.
When asked to save, pin or keep a chart or result, call pin_graph and show its Pinned link. Snapshots do not refresh. list_pinned lists saved graphs; unpin_graph deletes your own graphs (admins may delete any).
To save a replay, call get_replay_link with save: true.
Survey tools design, save, list, stop and read results. Launch surveys on the Surveys page.`
}
