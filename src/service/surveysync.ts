import { config } from '../core/config.ts'
import { db, getSetting, one, run, setSetting, tx } from '../core/db.ts'
import { plainReason, type JobState } from '../core/jobhealth.ts'
import { retentionEnv } from './replayretention.ts'

const EVERY_MS = 10 * 60_000
const JOB = 'survey_sync'
const projectUrl = `${config.posthog.host}/api/projects/${config.posthog.projectId}/`
const snapshotKey = `${JOB}_previous:${projectUrl}`
const statusKey = `${JOB}_status:${projectUrl}`

type OptIn = boolean | null
interface Snapshot { previous: OptIn; turned_off_at: string }
interface Status {
    state?: 'synced off' | 'restored' | 'enabled' | 'error'
    last_run?: string
    last_ok_at?: string
    last_error?: { at: string; message: string }
}
interface Deps {
    fetch: typeof fetch
    env: Record<string, string | undefined>
    enabled: boolean
    now: () => Date
}

function settings(env = process.env) {
    const key = env.LENS_POSTHOG_SETTINGS_API_KEY?.trim() || retentionEnv(env).apiKey
    const inactive = env.LENS_SURVEY_SYNC?.trim().toLowerCase() === 'off' ? 'Disabled by LENS_SURVEY_SYNC'
        : !key ? 'Not configured (set LENS_POSTHOG_SETTINGS_API_KEY or LENS_REPLAY_RETENTION_API_KEY)'
        : !/^\d+$/.test(config.posthog.projectId) ? 'Not configured (set POSTHOG_PROJECT_ID)'
        : null
    return { key, inactive }
}

function saveSnapshot(snapshot: Snapshot) {
    // Flush the rollback value to disk before sending the remote write.
    const synchronous = one<{ synchronous: number }>('PRAGMA synchronous')!.synchronous
    db.exec('PRAGMA synchronous = FULL')
    try {
        tx(() => {
            if (!getSetting<Snapshot | null>(snapshotKey, null)) setSetting(snapshotKey, snapshot)
        })
    } finally {
        db.exec(`PRAGMA synchronous = ${synchronous}`)
    }
}

async function projectRequest(fetcher: typeof fetch, key: string, value?: OptIn): Promise<Response> {
    const response = await fetcher(projectUrl, {
        method: value === undefined ? 'GET' : 'PATCH',
        headers: { authorization: `Bearer ${key}`, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
        body: value === undefined ? undefined : JSON.stringify({ surveys_opt_in: value }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
    })
    if (!response.ok) {
        const body = await response.text()
        let message = body
        try {
            const error = JSON.parse(body)
            message = error?.detail ?? error?.message ?? body
        } catch { /* Some PostHog errors are plain text. */ }
        const detail = String(message).replaceAll(key, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 300)
        throw new Error(`PostHog HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return response
}

async function updateProject(fetcher: typeof fetch, key: string, value: OptIn) {
    const response = await projectRequest(fetcher, key, value)
    await response.body?.cancel()
}

let busy = false
export async function runSurveySync({
    fetch: fetcher = globalThis.fetch, env = process.env, enabled = config.surveys.enabled, now = () => new Date(),
}: Partial<Deps> = {}): Promise<void> {
    const { key, inactive } = settings(env)
    if (inactive || busy) return
    busy = true
    try {
        const at = now().toISOString()
        const status = getSetting<Status>(statusKey, {})
        try {
            const snapshot = getSetting<Snapshot | null>(snapshotKey, null)
            let state: Status['state']
            if (enabled) {
                if (snapshot) {
                    await updateProject(fetcher, key, snapshot.previous)
                    run('DELETE FROM settings WHERE key = ?', snapshotKey)
                }
                state = snapshot || status.state === 'restored' ? 'restored' : 'enabled'
            } else {
                const response = await projectRequest(fetcher, key)
                const current: unknown = (await response.json())?.surveys_opt_in
                if (current !== null && typeof current !== 'boolean') throw new Error('PostHog returned an invalid surveys_opt_in value')
                if (current !== false) {
                    if (!snapshot) saveSnapshot({ previous: current, turned_off_at: at })
                    await updateProject(fetcher, key, false)
                }
                state = 'synced off'
            }
            setSetting(statusKey, { ...status, state, last_run: at, last_ok_at: at })
        } catch (e) {
            const message = e instanceof Error && e.message.startsWith('PostHog ') ? e.message : plainReason(e)
            setSetting(statusKey, { ...status, state: 'error', last_run: at, last_error: { at, message } })
        }
    } finally {
        busy = false
    }
}

export function surveySyncJobState(now = new Date()): JobState {
    const { inactive } = settings()
    const status = getSetting<Status>(statusKey, {})
    const state = status.state ? status.state[0].toUpperCase() + status.state.slice(1) : 'Waiting for first run'
    const detail = [
        inactive ?? state,
        status.last_run ? `Last run ${status.last_run}` : 'No runs yet',
        status.last_error ? `Last error ${status.last_error.at} ${status.last_error.message}` : 'No errors',
    ].join(' · ')
    return {
        key: JOB, label: 'PostHog survey sync',
        level: inactive ? 'ok' : status.state === 'error' ? 'warn' : status.state ? 'ok' : 'waiting',
        reason: null, detail, since: status.last_run ?? now.toISOString(),
        last_ok_at: status.last_ok_at ?? null, last_error_at: status.last_error?.at ?? null,
    }
}

export function startSurveySync(): () => void {
    if (settings().inactive) return () => {}
    const tick = () => {
        void runSurveySync().catch((e) => console.error('Survey sync scheduler failed', plainReason(e)))
    }
    tick()
    const timer = setInterval(tick, EVERY_MS)
    timer.unref()
    return () => clearInterval(timer)
}
