import { posthogMcpActive } from '../core/config.ts'
import type { SurveyRole, DashboardRole } from '../service/access.ts'
export const INSTRUCTIONS_LIMIT = 2048
export function serverInstructions(_withPosthog = posthogMcpActive(), _surveyRole: SurveyRole = 'launch', _dashboardRole: DashboardRole = 'share', _insights = true): string {
    return `Lens displays PostHog data and saved graph snapshots.
For analysis use posthog_exec: tools / info <tool> / call <tool> <json>. Poll get_job_result when a call returns a job_id.
For "what did client X do" or a replay of X doing Y: resolve_client, then find_sessions (recorded_only: true when they want a replay to watch). Preserve matched_user when resolution matches a user. Give both the PostHog replay URL and Lens clip page URL. Screen matches dialog/tab names or codes; what matches actions and messages. Windows may cover up to one year.
To save a graph use pin_graph; snapshots do not refresh. list_pinned lists saved graphs; unpin_graph deletes your own graphs (admins may delete any).
Survey tools design, save, list, stop and read results. Launch surveys on the Surveys page.`
}
