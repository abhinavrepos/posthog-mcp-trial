/** Validate saved exchange responses against the exact archived pass-1 requests and pipeline evidence. */
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { offlineCollect, type OfflineRequest, type OfflineResult } from '../../src/core/replay-vision-llm.ts'
import { ExchangeProvider } from '../../src/core/replay-vision-provider.ts'
import type { Aggregate, Moment } from '../../src/core/replay-vision-aggregate.ts'
import type { Candidate } from '../../src/core/replay-vision-detectors.ts'
import type { InsightDraft } from '../../src/core/replay-vision-validator.ts'
import type { PipelineOutput, PipelineInsight } from './pipeline.ts'

export interface Pass2Summary { directory: string; total: number; unique_responses: number; counts: Record<OfflineResult['state'], number>; results: (OfflineResult & { scope: string })[] }
function requestFacts(raw: unknown): Record<string, unknown> {
    const message = (raw as { messages?: { content?: { text?: string }[] }[] }).messages?.[0]?.content?.[0]?.text
    if (!message) throw new Error('pass2_request_missing_text')
    const at = message.indexOf('\n')
    const payload = JSON.parse(message.slice(at + 1)) as { insight?: Record<string, unknown> }
    if (!payload.insight) throw new Error('pass2_request_missing_insight')
    return payload.insight
}
function archivedAggregate(x: PipelineInsight, p: PipelineOutput, facts: Record<string, unknown>): Aggregate {
    if (facts.screen !== x.screen || facts.element !== x.element || facts.insight_ref !== x.id.slice(0, 8)) throw new Error(`pass2_request_pipeline_mismatch:${x.id}`)
    const members: Moment[] = x.members.map(m => {
        const candidate = p.sessions[m.session_id]?.analysis.candidates.find((c: Candidate) => c.kind === m.kind && c.start_ms === m.start_ms && c.end_ms === m.end_ms && c.event_ids[0] === m.event_ids[0]) as Candidate | undefined
        if (!candidate) throw new Error(`pass2_member_missing:${x.id}`)
        return { session_id: m.session_id, user_id: p.sessions[m.session_id]!.user, candidate, time_lost_ms: Number(candidate.facts.lost_ms) || 0, abandoned: false }
    })
    const confidence = /confidence (high|med|low)\.$/.exec(x.text)?.[1] as InsightDraft['confidence'] | undefined
    const draft: InsightDraft = {
        screen: x.screen, screen_name: members[0]?.candidate.screen_name, element: x.element,
        behaviour: String(facts.behaviour), outcome: String(facts.outcome), users_affected: x.users_affected,
        users_reached: x.users_reached, sessions_affected: x.sessions_affected, citations: x.citations,
        time_lost_ms: x.time_lost_ms, cause: '', fix: '', signals: facts.signals as string[],
        confidence: confidence ?? 'med', limitations: facts.coverage as string[], severity: x.severity as InsightDraft['severity'],
        single_session: x.users_affected === 1,
        single_moment: x.users_affected === 1 && x.members.length === 1 && ['D1','D3','D4','D5'].includes(x.members[0]!.kind),
    }
    return { id: x.id, draft, members } as Aggregate
}
/** This path needs only archived files; it neither contacts PostHog nor changes detector results. */
export async function collectPass2(directory: string): Promise<Pass2Summary> {
    const direct = isAbsolute(directory) ? directory : resolve(process.cwd(), directory)
    const dir = existsSync(join(direct, 'pipeline.json')) ? direct : resolve(dirname(fileURLToPath(import.meta.url)), directory)
    const exchange = join(dir, 'llm-exchange')
    const manifest = JSON.parse(await readFile(join(exchange, 'manifest.json'), 'utf8')) as (OfflineRequest & { scope: string })[]
    const pipeline = JSON.parse(await readFile(join(dir, 'pipeline.json'), 'utf8')) as PipelineOutput
    const provider = new ExchangeProvider(exchange, 0)
    const results: Pass2Summary['results'] = []
    for (const m of manifest) {
        const insight = pipeline.scopes[m.scope]?.insights.find(x => x.id === m.insight_id)
        if (!insight) throw new Error(`pass2_insight_missing:${m.scope}:${m.insight_id}`)
        const request = JSON.parse(await readFile(join(exchange, 'requests', `${m.custom_id}.json`), 'utf8'))
        const aggregate = archivedAggregate(insight, pipeline, requestFacts(request))
        const [result] = await offlineCollect([m], [aggregate], provider, 0)
        results.push({ ...result!, scope: m.scope })
    }
    const counts = { accepted: 0, rejected: 0, insufficient: 0, skipped_timeout: 0, failed: 0 }
    for (const r of results) counts[r.state]++
    const summary: Pass2Summary = { directory, total: results.length, unique_responses: new Set(manifest.map(m => m.custom_id)).size, counts, results }
    await writeFile(join(exchange, 'pass2-results.json'), JSON.stringify(summary, null, 2) + '\n')
    const section = ['## LLM pass 2 (archived exchange responses)', '',
        `Validated ${summary.total} manifest entries (${summary.unique_responses} unique response files) with offlineCollect: ${counts.accepted} accepted, ${counts.rejected} rejected, ${counts.insufficient} insufficient, ${counts.skipped_timeout} skipped, ${counts.failed} failed. This validates text only; detector and held-out scores above are unchanged.`, '',
        ...results.map(r => `- ${r.scope} / ${r.custom_id}: **${r.state}**${r.reason ? ` (${r.reason})` : ''}${r.state === 'accepted' ? ` — ${r.cause} ${r.fix}` : ''}`), ''].join('\n')
    const reportPath = join(dir, 'report.md')
    const report = await readFile(reportPath, 'utf8')
    const marker = '\n## LLM pass 2 (archived exchange responses)'
    await writeFile(reportPath, report.split(marker)[0]!.trimEnd() + '\n\n' + section)
    return summary
}
