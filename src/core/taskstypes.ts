// The contract between the task history (core/tasks.ts), the Dashboards pages (service/dashboards.ts)
// and the chat tools (mcp/dashboardtools.ts). Types only.
//
// A TASK is something a Reval user sets out to finish in one dialog: book a hedge designation, run a
// report, save a trade. It is identified by the dialog where the user submits (presses a submit button)
// and gets a good outcome (a completed or accepted message), e.g. t_DlgDetailFasLinkAdvanced. Its name is
// the dialog's title plus the most common finish ("Hedge Designation → Save → 'Link Id … Added'").
//
// An ATTEMPT is one try at a task inside a session episode (episodes split on search/menu navigation
// or 10 minutes idle, as in core/workflows.ts). It starts at the episode start (or right after the
// previous attempt in that episode ended) and ends at the first good reply to a submit in the task's
// dialog (outcome done), or at the episode end (failed when an error message was seen, else abandoned).
// Its PATH is the ordered dialogs opened during the attempt, consecutive repeats collapsed, menus and
// messages left out, ending with the task's dialog (at most 8; longer paths keep the first 3 and last 4
// with "…" between).

export type Outcome = 'done' | 'failed' | 'abandoned'

export interface TaskAttempt {
    day: string // YYYY-MM-DD (UTC) the session started
    client: string // client id ('' if unknown)
    user: string // user part of the distinct id, or the distinct id
    session_id: string
    task_id: string // 't_' + dialog code
    path: string[] // dialog codes
    started_at: string // ISO
    ended_at: string // ISO
    duration_s: number
    outcome: Outcome
    errors: number // error messages during the attempt
    first_error?: string // template of the first error message
    offset_s: number // seconds into the session recording, for a replay link
}

export interface Task {
    task_id: string
    dialog: string
    name: string
    attempts_90d: number
    clients_90d: number
}

// Durations are kept as counts per bucket so any period's median and p90 come from daily rows.
// Bucket i holds durations in [DURATION_BUCKETS[i], DURATION_BUCKETS[i+1]) seconds; the last is open.
export const DURATION_BUCKETS = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 2700, 3600, 7200]

export interface Window {
    from: string // YYYY-MM-DD inclusive
    to: string // YYYY-MM-DD inclusive
}

// ------------------------------------------------------------------ Dashboard A: client task map
export interface TaskMapParams {
    window: Window // the recent period
    baseline?: Window // compared with; default: the same length right before window
    client?: string // one client id; none: every client
    task?: string // one task id
    min_attempts?: number // baseline attempts for a task to be judged (default 5)
}
export type Flag = 'missing' | 'dropped' | 'slower' | 'failing' | 'new'
export interface TaskMapRow {
    client: string
    client_name: string
    task_id: string
    task_name: string
    now: { attempts: number; done: number; failed: number; abandoned: number; users: number; median_s: number | null; p90_s: number | null }
    before: { attempts: number; done: number; failed: number; abandoned: number; users: number; median_s: number | null; p90_s: number | null }
    flags: Flag[] // missing: done before (>= min_attempts) and none now; dropped: attempts down >= 50%;
    //              slower: median up >= 30% (and >= 10 s) with >= 5 done in both; failing: done rate down >= 15 points; new: none before
    typical_path: string[] // dialog labels of the most common path now (or before when missing)
}
export interface TaskMapClient {
    client: string
    client_name: string
    attempts_now: number
    attempts_before: number
    tasks_now: number
    tasks_before: number
    missing: number // tasks flagged missing
    slower: number
    score: number // how much needs attention, for sorting (higher first)
}
/** Which days of a period the history has fully processed. Flags are only given when both periods
 * are complete: a day not processed yet would otherwise look like work that stopped. */
export interface Coverage {
    complete: boolean
    unprocessed: string[] // days of the window or baseline not (fully) processed yet, at most 400
    text?: string // for people, when not complete
}
export interface TaskMap {
    coverage: Coverage
    params: Required<Pick<TaskMapParams, 'window' | 'baseline'>> & TaskMapParams
    clients: TaskMapClient[] // sorted by score
    rows: TaskMapRow[] // sorted: flagged first, then by attempts
    data_through: string | null // last fully processed day
    note: string
}

// ------------------------------------------------------------------ Dashboard B: flow time
export interface FlowTimeParams {
    task: string // task id
    window: Window
    client?: string // one client; none: every client
    granularity?: 'day' | 'week' // default week when the window is longer than 31 days
}
export interface FlowPoint {
    period: string // YYYY-MM-DD (start of day or ISO week)
    attempts: number
    done: number
    median_s: number | null
    p90_s: number | null
}
export interface FlowPath {
    path: string[] // dialog codes
    labels: string[] // dialog titles
    attempts: number
    share: number // of attempts, 0-1
    done_rate: number // 0-1
    median_s: number | null
}
export interface SlowAttempt {
    client: string
    user: string
    session_id: string
    started_at: string
    duration_s: number
    outcome: Outcome
    path: string[]
    labels?: string[] // dialog titles for path
    first_error?: string
    replay_url: string
}
export interface FlowTime {
    coverage: Coverage
    params: FlowTimeParams & { granularity: 'day' | 'week' }
    task: { task_id: string; name: string; dialog: string }
    client_name?: string
    summary: { attempts: number; done: number; done_rate: number | null; median_s: number | null; p90_s: number | null; users: number }
    all_clients: { median_s: number | null; p90_s: number | null; done_rate: number | null } // for comparison
    series: FlowPoint[] // this client (or all)
    series_all?: FlowPoint[] // every client, when a client is chosen
    paths: FlowPath[] // most common first, at most 8
    slowest: SlowAttempt[] // at most 10, done or not
    top_errors: { template: string; count: number }[] // at most 5
    data_through: string | null
    note: string
}

export interface IngestStatus {
    days_done: number
    first_day: string | null
    last_day: string | null
    behind_days: number // days in the retention window not processed yet
    attempts: number
    last_run: string | null
    last_error: string | null
    running: boolean
}
