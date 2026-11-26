/**
 * Replay Vision Monitor page and API (/replays/vision, /replays/vision/api/*). Reached only when
 * FEATURE_REPLAY_VISION=on, after authentication and the central x-clip-page CSRF gate in
 * handleReplays(). Insight grantees read; only admins change configuration. Responses are no-store;
 * changes are audited. No raw replay, prompt or key ever leaves through this API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { all, run } from '../core/db.ts'
import { getRecording } from '../core/posthog.ts'
import { canSeeReplayInsights, audit, type Viewer } from './access.ts'
import { APP_NAME, esc, headerHtml, PAGE_CSS, loginHtml } from './replays.ts'
import { forceRerun, queueReplayVision, replayVisionEnabled, replayVisionJobState } from './replayvision-worker.ts'
import { browserKeyAllowed, providerKeyConfigured, storeProviderKey } from '../core/replay-vision-secrets.ts'
import { BUDGET, budgetRow, dayOf } from '../core/replay-vision-budget.ts'
import { dismissInsight, listInsights } from '../core/replay-vision-insights.ts'
import { humanScreen } from '../core/replay-vision-aggregate.ts'
import { providerStatus } from '../core/replay-vision-llm.ts'
import { setClientVisionOptIn } from '../core/replay-vision-frames.ts'

const json = (res: ServerResponse, status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let s = ''
    for await (const part of req) { s += part; if (s.length > 10_000) throw new Error('body_too_large') }
    try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
interface Watch { id: number; kind: string; value: string; enabled: number; max_sessions_per_day: number; created_by: string; created_at: string }


export function visionOverview() {
    const watches = all<Watch>('SELECT id, kind, value, enabled, max_sessions_per_day, created_by, created_at FROM rv_watch ORDER BY id DESC LIMIT 100')
    const scopes = all<{ scope_key: string; n: number }>(`SELECT scope_key, count(*) AS n FROM rv_insight WHERE dismissed_at IS NULL GROUP BY scope_key ORDER BY n DESC LIMIT 50`)
    const insights = scopes.flatMap((s) => listInsights(s.scope_key, 20).map((i) => ({ ...i, scope: s.scope_key })))
    const day = dayOf()
    const g = budgetRow(day, 'global')
    const provider = providerStatus()
    return {
        enabled: replayVisionEnabled(), mode: provider.mode, provider, provider_configured: providerKeyConfigured(), browser_key_allowed: browserKeyAllowed(),
        watches, insights, status: replayVisionJobState(),
        budget: { day, sessions: `${g.used_sessions}/${BUDGET.dailySessions}`, download_mb: `${(g.used_download_bytes / 1048576).toFixed(1)}/${(BUDGET.dailyDownloadBytes / 1048576).toFixed(0)}`, llm_calls: `${g.used_llm_calls}+${g.reserved_llm_calls} reserved/${BUDGET.dailyLlmCalls}`, cost_usd: `${(g.estimated_cost_micros / 1e6).toFixed(4)}+${(g.reserved_cost_micros / 1e6).toFixed(4)} reserved/${(BUDGET.dailyCostMicros / 1e6).toFixed(2)}` },
        coverage_note: 'Clicks, input activity and scroll positions are recovered from the recording; cursor movement is sampled (about 20 Hz), typed values are masked, cross-origin frames and canvas are unseen.',
    }
}

export async function handleReplayVision(req: IncomingMessage, res: ServerResponse, url: URL, v: Viewer | undefined): Promise<boolean> {
    const p = url.pathname
    if (p !== '/replays/vision' && !p.startsWith('/replays/vision/')) return false
    if (!v) {
        if (req.method === 'GET' && p === '/replays/vision') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(loginHtml('Replay Vision')) }
        else json(res, 401, { error: 'Sign in first.' })
        return true
    }
    if (!canSeeReplayInsights(v)) { json(res, 403, { error: 'Replay Vision access required.' }); return true }
    if (p === '/replays/vision' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' })
        res.end(visionHtml(v))
        return true
    }
    if (p === '/replays/vision/api/status' && req.method === 'GET') { json(res, 200, visionOverview()); return true }
    if (v.role !== 'admin') { json(res, 403, { error: 'Admin access required.' }); return true }
    try {
        if (p === '/replays/vision/api/watch' && req.method === 'POST') {
            const b = await body(req), kind = b.kind === 'client' ? 'client' : b.kind === 'distinct_id' ? 'distinct_id' : null, value = String(b.value ?? '').trim()
            const cap = Math.min(BUDGET.perWatchSessions, Math.max(1, Math.floor(Number(b.max_sessions_per_day) || BUDGET.perWatchSessions)))
            if (!kind || !/^[\w@.:+-]{2,120}$/.test(value)) { json(res, 400, { error: 'Choose an exact client id or distinct id.' }); return true }
            run(`INSERT INTO rv_watch(kind, value, created_by, created_at, max_sessions_per_day) VALUES(?,?,?,?,?) ON CONFLICT(kind, value) DO UPDATE SET enabled = 1, max_sessions_per_day = excluded.max_sessions_per_day`, kind, value, v.email, new Date().toISOString(), cap)
            audit(v.email, 'replay_vision.watch_added', { kind, value, cap })
            json(res, 200, { ok: true })
            return true
        }
        const remove = /^\/replays\/vision\/api\/watch\/(\d{1,9})$/.exec(p)
        if (remove && req.method === 'DELETE') {
            run('DELETE FROM rv_watch WHERE id = ?', Number(remove[1])) // links cascade; retention prunes runs no watch references
            audit(v.email, 'replay_vision.watch_removed', { id: Number(remove[1]) })
            json(res, 200, { ok: true })
            return true
        }
        const dismiss = /^\/replays\/vision\/api\/insight\/([a-f0-9]{24})\/dismiss$/.exec(p)
        if (dismiss && req.method === 'POST') {
            const ok = dismissInsight(dismiss[1]!, v.email)
            audit(v.email, 'replay_vision.insight_dismissed', { id: dismiss[1] })
            json(res, ok ? 200 : 404, ok ? { ok } : { error: 'Insight not found.' })
            return true
        }
        if (p === '/replays/vision/api/client-policy' && req.method === 'POST') {
            const b = await body(req), client = String(b.client ?? '').trim()
            if (!/^[\w@.:+-]{1,120}$/.test(client) || typeof b.vision_opt_in !== 'boolean') { json(res, 400, { error: 'Give an exact client id and vision_opt_in true or false.' }); return true }
            setClientVisionOptIn(client, b.vision_opt_in, v.email)
            audit(v.email, 'replay_vision.client_vision_policy', { client, vision_opt_in: b.vision_opt_in })
            json(res, 200, { ok: true })
            return true
        }
        if (p === '/replays/vision/api/provider-key' && req.method === 'POST') {
            try { const b = await body(req); storeProviderKey(String(b.key ?? ''), v.email); audit(v.email, 'replay_vision.provider_key_set'); json(res, 200, { configured: true }) }
            catch { json(res, 400, { error: 'The provider key could not be saved. Check the key format and that REPLAY_VISION_MASTER_KEY is configured.' }) }
            return true
        }
        if (p === '/replays/vision/api/analyze' && req.method === 'POST') {
            const b = await body(req), sid = String(b.session_id ?? '').trim()
            if (!/^[\w-]{8,120}$/.test(sid)) { json(res, 400, { error: 'Invalid session id.' }); return true }
            const meta = await getRecording(sid)
            const id = queueReplayVision(sid, meta.end_time, null, meta.distinct_id || null, [], v.email)
            if (b.force === true) forceRerun(id)
            audit(v.email, 'replay_vision.analyze_queued', { run: id, force: b.force === true })
            json(res, 200, { run_id: id, state: 'pending' })
            return true
        }
    } catch (e) {
        json(res, e instanceof Error && e.message === 'body_too_large' ? 413 : 502, { error: 'The request could not complete. Try again.' })
        return true
    }
    json(res, 404, { error: 'Not found.' })
    return true
}

const SEV_CLASS: Record<string, string> = { High: 'sev-high', Medium: 'sev-med', Low: 'sev-low' }
export function visionHtml(v: Viewer): string {
    const o = visionOverview()
    const admin = v.role === 'admin'
    const t = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
    const watchRows = o.watches.map((w) => `<tr><td>${esc(w.kind === 'client' ? 'Client' : 'Distinct id')}</td><td>${esc(w.value)}</td><td>${w.max_sessions_per_day}/day</td><td>${esc(w.created_by)}</td><td>${admin ? `<button data-remove="${w.id}" class="secondary">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5">No watched clients or users.</td></tr>'
    const cards = o.insights.map((i) => `<article class="card insight"><header><span class="pill ${SEV_CLASS[i.severity] ?? ''}">${esc(i.severity)}</span> <b>${esc(humanScreen(i.screen))} › ${esc(i.element)}</b> <span class="muted">${esc(i.step)} · ${esc(i.scope)}</span></header>
<p>${esc(`${i.users_affected} of ${i.users_reached ?? 'unknown'} users`)} · ${i.sessions_affected} sessions · median ${Math.round(i.time_lost_ms / 1000)} s lost per affected user · ${i.abandoned_users} abandoned</p>
<p>${esc(i.text.replace(/^\[\w+\] /, '').replace(/ Evidence:.*$/, ''))}</p>
<p class="muted small">Severity rule: ${esc(i.severity_reason)}. N source: ${esc(i.reach_source ?? 'unknown')}. Baseline: ${i.calibrated ? 'calibrated' : 'cold start (fewer than 20 sessions or 5 users)'}. Rubric ${i.rubric_score}/18, confidence ${esc(i.confidence)}.${i.limitations.length ? ` Coverage gaps: ${esc(i.limitations.join(', '))}.` : ''}</p>
<p>Evidence: ${i.citations.map((c) => `<a href="${esc(c.url)}" rel="noreferrer" target="_blank">replay @${t(c.offset_ms)}</a>`).join(' · ')}${admin ? ` <button class="secondary" data-dismiss="${esc(i.id)}">Dismiss</button>` : ''}</p></article>`).join('') || '<p class="muted">No validated insights yet. An insight needs the same friction on the same screen and element in at least two users, or two cited moments in one labelled session.</p>'
    const counts = Object.entries(o.status.counts).map(([k, n]) => `${esc(k)} ${n}`).join(' · ') || 'none yet'
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Replay Vision · ${esc(APP_NAME)}</title><style>${PAGE_CSS()}
.insight header{display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap}.pill{border-radius:999px;padding:.1rem .6rem;font-size:.8rem;font-weight:600;border:1px solid currentColor}.sev-high{color:#c62828}.sev-med{color:#b26a00}.sev-low{color:#546e7a}.small{font-size:.85rem}</style></head>
<body>${headerHtml(v, 'Replay Vision')}<main id="main" tabindex="-1"><h1>Replay Vision</h1>
<p>Friction found in session recordings of watched clients and users, ranked by severity. Mode: ${esc(o.mode)}. ${esc(o.coverage_note)}</p>
<section class="card"><h2>Ranked insights</h2>${cards}</section>
<section class="card"><h2>Status</h2><p>${esc(String(o.status.detail))}</p><p>Runs: ${counts}. Recordings without a trustworthy identity: ${o.status.unmatched_recordings}. Last scan: ${esc(o.status.last_scan_at ?? 'not yet')}.</p>
<p>Today (${esc(o.budget.day)} UTC): sessions ${esc(o.budget.sessions)} · downloads ${esc(o.budget.download_mb)} MB · LLM calls ${esc(o.budget.llm_calls)} · spend $${esc(o.budget.cost_usd)}</p>
<p>LLM provider: ${esc(o.provider.detail)}.</p><p class="muted small">Causes marked as model-written passed the same citation and rubric checks as the templates; all counts, severities and links are computed in code.</p>
${admin && o.browser_key_allowed ? '<form id="provider-key"><label>Anthropic API key <input name="key" type="password" autocomplete="off" required></label> <button>Save encrypted key</button></form>' : ''}</section>
<section class="card"><h2>Watch list</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Exact identity</th><th>Daily cap</th><th>Added by</th><th></th></tr></thead><tbody>${watchRows}</tbody></table></div>
${admin ? '<form id="watch"><select name="kind" aria-label="Kind"><option value="client">Client</option><option value="distinct_id">Distinct id</option></select> <input name="value" required maxlength="120" placeholder="Exact client id or distinct id" aria-label="Exact identity"> <button>Add watch</button></form>' : ''}</section>
${admin ? '<section class="card"><h2>Analyse one recording</h2><form id="analyze"><input name="session_id" required placeholder="Session id" aria-label="Session id"> <button>Queue analysis</button></form></section>' : ''}
<p id="msg" role="status"></p></main>
<script>const msg=t=>document.getElementById('msg').textContent=t;const call=(u,m,b)=>fetch(u,{method:m,headers:{'content-type':'application/json','x-clip-page':'1'},body:b?JSON.stringify(b):undefined}).then(async r=>{const j=await r.json().catch(()=>({}));msg(j.error||'Saved');if(r.ok)location.reload()});
for(const b of document.querySelectorAll('[data-remove]'))b.onclick=()=>call('/replays/vision/api/watch/'+b.dataset.remove,'DELETE');
for(const b of document.querySelectorAll('[data-dismiss]'))b.onclick=()=>call('/replays/vision/api/insight/'+b.dataset.dismiss+'/dismiss','POST');
for(const name of ['watch','analyze','provider-key']){const f=document.getElementById(name);if(f)f.onsubmit=e=>{e.preventDefault();call('/replays/vision/api/'+name,'POST',Object.fromEntries(new FormData(f)))}}</script></body></html>`
}
