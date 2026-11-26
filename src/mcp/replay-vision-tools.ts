/**
 * Replay Vision MCP tools (architecture "MCP contract"). Registered only when FEATURE_REPLAY_VISION=on,
 * for a personal token with the replay-insights grant; shared tokens and stdio never get them. Access is
 * re-checked on every call (grant revoked or token revoked → denied immediately). Answers carry
 * validated insights, coverage and replay links only: never raw rrweb, DOM, prompts, keys or images.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { all, one } from '../core/db.ts'
import { P } from '../core/props.ts'
import { hogql, replayUrl, getRecording } from '../core/posthog.ts'
import { resolveClient } from '../core/resolve.ts'
import { listInsights, scopeKeyOf } from '../core/replay-vision-insights.ts'
import { humanScreen } from '../core/replay-vision-aggregate.ts'
import { BUDGET, budgetRow, dayOf } from '../core/replay-vision-budget.ts'
import { providerStatus } from '../core/replay-vision-llm.ts'
import { hasInsightGrant, type ChatCaller } from '../service/access.ts'
import { forceRerun, queueReplayVision, replayVisionEnabled, replayVisionJobState } from '../service/replayvision-worker.ts'
import { jsonResult } from './result.ts'

export const replayVisionToolNames = () => (replayVisionEnabled() ? ['replay_friction', 'analyze_replay', 'replay_vision_status'] : [])
const COVERAGE = 'Clicks, input activity and scroll positions come from the recording; cursor movement is sampled (about 20 Hz); typed values are masked; cross-origin frames and canvas are unseen. Counts, severities and links are computed in code.'
const MAX_RESULT_CHARS = 18_000

/** Throws unless the caller is a live personal token whose person still holds the insights grant (or is admin). */
export function requireVisionAccess(caller: Partial<ChatCaller> | undefined): asserts caller is ChatCaller & { email: string; tokenId: string } {
    if (!replayVisionEnabled()) throw new Error('Replay Vision is switched off.')
    if (!caller?.email || !caller.tokenId || caller.shared || caller.tokenId === 'shared') throw new Error('Replay Vision needs a personal MCP token.')
    if (!caller.admin && !hasInsightGrant(caller.email)) throw new Error('Replay insights access required.')
    const token = one<{ revoked_at: string | null }>('SELECT revoked_at FROM mcp_tokens WHERE id = ? AND lower(email) = ?', caller.tokenId, caller.email.toLowerCase())
    if (!token || token.revoked_at) throw new Error('This personal token was revoked.')
}

function compactInsight(i: ReturnType<typeof listInsights>[number]) {
    return {
        severity: i.severity, severity_rule: i.severity_reason, screen: humanScreen(i.screen), element: i.element, step: i.step,
        users: `${i.users_affected} of ${i.users_reached ?? 'unknown'}`, n_source: i.reach_source, sessions: i.sessions_affected,
        median_time_lost_s: Math.round(i.time_lost_ms / 1000), abandoned_users: i.abandoned_users, calibrated_baseline: i.calibrated,
        insight: i.text, cause_source: i.cause_source, signals: i.signals, confidence: i.confidence, rubric: `${i.rubric_score}/18`, coverage_gaps: i.limitations,
        evidence: i.citations.map((c) => ({ url: c.url, at_s: Math.floor(c.offset_ms / 1000) })),
    }
}

export function registerReplayVisionTools(server: McpServer, caller?: Partial<ChatCaller>) {
    if (!replayVisionEnabled() || !caller?.insights || caller.shared || !caller.tokenId || caller.tokenId === 'shared') return

    server.registerTool('replay_vision_status', {
        description: 'Replay Vision status: whether analysis is on, analysis mode and LLM egress, queue counts, last scan, today\'s budget and coverage limits. No input. Example: {}',
        inputSchema: {}, annotations: { readOnlyHint: true },
    }, async () => {
        requireVisionAccess(caller)
        const g = budgetRow(dayOf(), 'global')
        return jsonResult('Replay Vision status', { ...replayVisionJobState(), provider: providerStatus(), budget_today: { sessions: `${g.used_sessions}/${BUDGET.dailySessions}`, llm_calls: `${g.used_llm_calls}/${BUDGET.dailyLlmCalls}`, spend_usd: (g.estimated_cost_micros / 1e6).toFixed(4) }, coverage: COVERAGE })
    })

    server.registerTool('replay_friction', {
        description: 'Ranked, validated friction insights from session recordings of one client (optionally one user): screen, element, behaviour with numbers, n of N users, severity with its rule, time lost, abandonment, likely cause, fix and timestamped replay links. Queues up to five recent unanalysed recordings unless analyze_missing is false. Example: {"client":"C08","limit":10}',
        inputSchema: {
            client: z.string().min(1).max(120), user: z.string().min(1).max(200).optional(),
            window_days: z.number().int().min(1).max(30).default(7), limit: z.number().int().min(1).max(20).default(10),
            cursor: z.string().regex(/^\d{1,4}$/).optional(), analyze_missing: z.boolean().default(true),
        },
        annotations: { readOnlyHint: false },
    }, async ({ client, user, window_days, limit, cursor, analyze_missing }) => {
        requireVisionAccess(caller)
        const to = new Date(), from = new Date(+to - window_days * 86_400_000)
        const matches = await resolveClient({ text: client, from, to })
        const match = matches.find((m: { id: string }) => m.id === client) ?? matches[0]
        if (!match) return jsonResult('Replay friction', { insights: [], note: `No client matches "${client}".` })
        const scope = user ? { user } : { client: match.id }
        const offset = cursor ? Number(cursor) : 0
        const rows = listInsights(scopeKeyOf(scope), limit + 1, offset)
        let queued = 0, skipped = 0
        if (analyze_missing) {
            // Up to five recent finished recordings of this client without a run, under the same caps (on-demand per person).
            const recent = await hogql(`SELECT toString(properties.$session_id) AS sid, max(timestamp) AS last, any(toString(distinct_id)) AS did FROM events
                WHERE timestamp >= {from} AND timestamp < {to} AND toString(${P.client}) = {client} ${user ? 'AND distinct_id = {user}' : ''} AND toString(properties.$session_id) != ''
                GROUP BY sid ORDER BY last DESC LIMIT 20`, { from: from.toISOString(), to: new Date(+to - 15 * 60_000).toISOString(), client: match.id, user: user ?? '' }, { timeoutMs: 10_000, retries: 0 })
            for (const r of recent) {
                if (queued >= 5) break
                const sid = String(r.sid)
                if (!/^[\w-]{8,120}$/.test(sid) || one('SELECT 1 FROM rv_run WHERE session_id = ? AND state <> \'superseded\'', sid)) continue
                try { const meta = await getRecording(sid); queueReplayVision(sid, meta.end_time, match.id, String(r.did || meta.distinct_id || ''), [], caller.email); queued++ } catch { skipped++ }
            }
        }
        const states = Object.fromEntries(all<{ state: string; n: number }>(`SELECT state, count(*) AS n FROM rv_run WHERE ${user ? 'distinct_id' : 'client_id'} = ? GROUP BY state`, user ?? match.id).map((x) => [x.state, x.n]))
        const out = { client: match.id, ...(user ? { user } : {}), window_days, insights: [] as ReturnType<typeof compactInsight>[], next_cursor: null as string | null, truncated: false, recordings: states, queued_now: queued, unavailable_now: skipped, coverage: COVERAGE, mode: providerStatus().mode }
        for (const i of rows.slice(0, limit)) {
            const c = compactInsight(i)
            if (JSON.stringify(out).length + JSON.stringify(c).length > MAX_RESULT_CHARS) { out.truncated = true; break }
            out.insights.push(c)
        }
        if (rows.length > limit || out.truncated) out.next_cursor = String(offset + out.insights.length)
        if (!out.insights.length) (out as Record<string, unknown>).note = queued ? `No validated insight yet; ${queued} recording(s) queued for analysis. Ask again in a few minutes.` : 'No validated insight: an insight needs the same friction on the same screen and element in at least two users (or two cited moments in one labelled session).'
        return jsonResult('Replay friction', out)
    })

    server.registerTool('analyze_replay', {
        description: 'Queue (or poll) bounded analysis of one recording and return its state, the moments found (detector, screen, element, time, replay link) and coverage. Call again with the same session_id to poll. force (admin) recomputes in place. Example: {"session_id":"01a21941-ae93-7fed-899a-f69c4136b425"}',
        inputSchema: { session_id: z.string().regex(/^[\w-]{8,120}$/), mode: z.enum(['deterministic', 'text', 'vision']).default('deterministic'), force: z.boolean().default(false) },
        annotations: { readOnlyHint: false },
    }, async ({ session_id, mode, force }) => {
        requireVisionAccess(caller)
        if (force && !caller.admin) throw new Error('force needs admin access.')
        if (mode === 'vision') return jsonResult('Replay analysis', { session_id, status: 'not_available', reason: 'Frame (vision) analysis needs a per-client opt-in and an admin-reviewed, redacted per-session frame approval; it is not offered through MCP.' })
        if (mode === 'text' && providerStatus().mode !== 'text') return jsonResult('Replay analysis', { session_id, status: 'not_available', reason: providerStatus().detail })
        let r = one<{ id: number; state: string; client_id: string | null; coverage_json: string; error_code: string | null }>(`SELECT id, state, client_id, coverage_json, error_code FROM rv_run WHERE session_id = ? AND state <> 'superseded' ORDER BY id DESC LIMIT 1`, session_id)
        if (!r || force) {
            const ident = await hogql(`SELECT uniqExact(toString(${P.client})) AS clients, any(toString(${P.client})) AS client, any(toString(distinct_id)) AS did FROM events WHERE toString(properties.$session_id) = {sid} AND timestamp >= now() - INTERVAL 30 DAY LIMIT 1`, { sid: session_id }, { timeoutMs: 10_000, retries: 0 })
            const row = ident[0]
            if (!row || Number(row.clients) !== 1 || !String(row.client || '')) throw new Error('This recording has no single, trustworthy client identity; it is not analysed.')
            const meta = await getRecording(session_id)
            const id = queueReplayVision(session_id, meta.end_time, String(row.client), String(row.did || meta.distinct_id || ''), [], caller.email)
            if (force) forceRerun(id)
            r = { id, state: force ? 'pending' : one<{ state: string }>('SELECT state FROM rv_run WHERE id = ?', id)!.state, client_id: String(row.client), coverage_json: '{}', error_code: null }
        }
        const moments = all<{ detector_codes_json: string; severity: string; screen_key: string; element_key: string; step_key: string; start_ms: number; evidence_json: string }>(
            'SELECT detector_codes_json, severity, screen_key, element_key, step_key, start_ms, evidence_json FROM rv_finding WHERE run_id = ? ORDER BY start_ms LIMIT 40', r.id)
            .map((f) => ({ detector: JSON.parse(f.detector_codes_json)[0], severity: f.severity, screen: humanScreen(f.screen_key), element: f.element_key, step: f.step_key, at_s: Math.floor(f.start_ms / 1000), facts: JSON.parse(f.evidence_json).facts, replay: replayUrl(session_id, Math.floor(f.start_ms / 1000)) }))
        const cov = JSON.parse(r.coverage_json || '{}')
        return jsonResult('Replay analysis', {
            run_id: r.id, session_id, state: r.state, error: r.error_code, replay_url: replayUrl(session_id), mode,
            coverage: { state: cov.state ?? 'not yet analysed', gaps: cov.reasons ?? [], snapshot_seen: cov.full_snapshot_seen ?? null },
            moments, note: ['pending', 'stable_wait', 'running', 'retry'].includes(r.state) ? 'Queued; call analyze_replay again with the same session_id to poll.' : 'Moments are single-session observations (Low until seen in more users); see replay_friction for validated cross-session insights.',
        })
    })
}
