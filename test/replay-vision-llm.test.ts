// Phase 5: B′ request builder, `exchange` and response guards, the text stage under the budget ledger,
// and the MCP access rules. No network: the `anthropic` provider is not called here (no key).
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forAll } from './rv-prop.ts'

const dir = mkdtempSync(join(tmpdir(), 'rv-llm-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.FEATURE_REPLAY_VISION = 'on'
test.after(() => rmSync(dir, { recursive: true, force: true }))

const PV = await import('../src/core/replay-vision-provider.ts')
const L = await import('../src/core/replay-vision-llm.ts')
const B = await import('../src/core/replay-vision-budget.ts')
const { storeFindings, refreshInsights, listInsights } = await import('../src/core/replay-vision-insights.ts')
const { runMetrics } = await import('../src/core/replay-vision-baseline.ts')
const { run, one } = await import('../src/core/db.ts')
type Cand = import('../src/core/replay-vision-detectors.ts').Candidate
type Win = import('../src/core/replay-timeline.ts').SanitizedWindow

const SECRET_SID = '01a21941-ae93-7fed-899a-f69c4136b425'
const window = (center: number): Win => ({ center_ms: center, start_ms: center - 20_000, end_ms: center + 20_000, dropped_pointer_samples: 3, coverage: [],
    events: [{ id: '41', t_ms: center, kind: 'click', label: 'Save', tag: 'button' }, { id: '42', t_ms: center + 300, kind: 'error', error: 'visible' }, { id: '43', t_ms: center + 2000, kind: 'input_activity', label: 'Debit To' }, { id: '44', t_ms: center + 4000, kind: 'click', label: 'Save', tag: 'button' }] })
const facts = { insight_ref: 'abcd1234', screen: 'sales invoice:new', element: 'Save', step: 'Save', signals: ['D4'], users_affected: 3, users_reached: 8, sessions_affected: 3, behaviour: 'clicked Save and got a visible validation error 2 times in a row', outcome: 'No abandonment observed; median 9 s lost per affected user', median_lost_s: 9, severity: 'Medium', coverage: [] }
const message = (body: unknown, over: Record<string, unknown> = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 200 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(body) }], ...over })

test('request params: Haiku 5.5, structured output schema, sanitized payload, stable custom id, exact body', () => {
    const w = [{ session_alias: PV.sessionAlias(SECRET_SID, 'salt'), window: window(10_000) }]
    const p = PV.buildExplanationParams(facts, w)
    assert.equal(p.model, 'claude-haiku-5-5')
    assert.deepEqual(p.output_config?.format?.type, 'json_schema')
    assert.equal((p.output_config?.format?.schema as { additionalProperties: boolean }).additionalProperties, false)
    assert.equal(p.max_tokens, PV.LIMITS.maxTokens)
    const body = PV.requestBody(p)
    assert.equal(body, JSON.stringify(p))
    assert.ok(!body.includes(SECRET_SID) && !body.includes('01a21941'), 'no session id, only an alias')
    assert.ok(!/https?:|@example|distinct/.test(body))
    assert.equal(PV.customIdFor('f'.repeat(24), p), PV.customIdFor('f'.repeat(24), PV.buildExplanationParams(facts, w)), 'deterministic')
    assert.match(PV.customIdFor('f'.repeat(24), p), /^rv_[a-f]{16}_[a-f0-9]{24}$/)
    assert.ok(PV.estimateInputTokens(p) < PV.LIMITS.maxInputTokens)
    assert.equal(PV.costMicros(1_000_000, 0, false), 100_000, '$0.10 per M input tokens')
    assert.equal(PV.costMicros(0, 1_000_000, true), 250_000, '$0.50 per M output, Batch 50% off')
})

test('response guard: valid JSON passes; refusal, max_tokens, bad JSON, wrong schema and garbage never throw (property)', () => {
    const good = { decision: 'explain', likely_cause: 'Likely cause: x', fix: 'Fix: y', cited_event_ids: ['41'], confidence: 'med', unsupported: [] }
    const ok = PV.parseProviderMessage(message(good))
    assert.equal(ok.ok, true); assert.equal(ok.input_tokens, 1500)
    assert.equal(PV.parseProviderMessage(message(good, { stop_reason: 'refusal' })).error, 'refusal')
    assert.equal(PV.parseProviderMessage(message(good, { stop_reason: 'max_tokens' })).error, 'max_tokens')
    assert.equal(PV.parseProviderMessage(message(null, { content: [{ type: 'text', text: '{not json' }] })).error, 'invalid_json')
    assert.equal(PV.parseProviderMessage(message({ ...good, confidence: 'certain' })).error, 'schema_mismatch')
    assert.equal(PV.parseProviderMessage(message({ ...good, cited_event_ids: 'x' })).error, 'schema_mismatch')
    forAll(300, 9, (r) => {
        const junk = r.pick([null, 1, 'x', [], {}, { type: 'message' }, { type: 'message', role: 'assistant', content: r.pick([null, 'x', [{ type: 'text', text: r.pick(['', '{}', '[]', 'null', '"a"', JSON.stringify({ ...good, decision: r.pick(['x', 1, null]) })]) }]]) }])
        const out = PV.parseProviderMessage(junk)
        assert.equal(out.ok, false)
    })
})

test('exchange provider: atomic exact request file, bounded wait, expiry is a skip', async () => {
    const ex = new PV.ExchangeProvider(join(dir, 'ex1'), 200)
    const p = PV.buildExplanationParams(facts, [{ session_alias: 'S1', window: window(5000) }])
    await ex.submit('rv_test_custom_id_01', p)
    await ex.submit('rv_test_custom_id_01', p) // idempotent
    assert.equal(readFileSync(join(dir, 'ex1', 'requests', 'rv_test_custom_id_01.json'), 'utf8'), PV.requestBody(p))
    assert.deepEqual(readdirSync(join(dir, 'ex1', 'requests')), ['rv_test_custom_id_01.json'], 'no temp files left behind')
    const t0 = Date.now()
    assert.equal((await ex.poll('rv_test_custom_id_01', null, t0)).state, 'pending')
    assert.equal((await ex.wait('rv_test_custom_id_01', t0, 20)).state, 'expired')
    writeFileSync(join(dir, 'ex1', 'responses', 'rv_test_custom_id_01.json'), JSON.stringify(message({ decision: 'insufficient_evidence', likely_cause: '', fix: '', cited_event_ids: [], confidence: 'low', unsupported: [] })))
    assert.equal((await ex.poll('rv_test_custom_id_01', null, t0)).state, 'complete')
    writeFileSync(join(dir, 'ex1', 'responses', 'rv_test_custom_id_02.json'), '{oops')
    assert.deepEqual(await ex.poll('rv_test_custom_id_02', null, Date.now()), { state: 'failed', error: 'invalid_json_file' })
    await assert.rejects(ex.submit('../escape', p))
})

/** Three users with the same D4 loop, stored as runs + findings, refreshed into one insight. */
function seedInsight(prefix: string, element = 'Save') {
    const now = new Date().toISOString(), screen = 'sales invoice:new'
    const d4 = (s: number): Cand => ({ kind: 'D4', start_ms: s, end_ms: s + 8000, score: 4, screen, element, step: element, event_ids: ['41', '42'], facts: { cycles: 2, span_ms: 8000, lost_ms: 8000 }, limitations: [], strength: 'strong' })
    for (const u of ['a', 'b', 'c']) {
        const sid = `${prefix}-${u}-0000-4000-8000`
        run(`INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,client_id,distinct_id,state,completed_at,metrics_json) VALUES('1',?,?,?,?,?,?,'complete',?,?)`, sid, now, 'v', 'deterministic', prefix, `user-${u}`, now, JSON.stringify(runMetrics([screen], [d4(10_000)], 10, 100)))
        storeFindings(one<{ id: number }>('SELECT id FROM rv_run WHERE session_id = ?', sid)!.id, sid, [d4(10_000)])
    }
    refreshInsights({ client: prefix })
    return listInsights(`client:${prefix}`)[0]!
}
const answer = (exDir: string, customId: string, body: unknown, over: Record<string, unknown> = {}) => writeFileSync(join(exDir, 'responses', `${customId}.json`), JSON.stringify(message(body, over)))
const requests = (exDir: string) => existsSync(join(exDir, 'requests')) ? readdirSync(join(exDir, 'requests')) : []

test('text stage: pass 1 writes requests and reserves; pass 2 validates, accepts, reconciles once; no double submit', async () => {
    const exDir = join(dir, 'ex-stage'), provider = new PV.ExchangeProvider(exDir, 60_000)
    const ins = seedInsight('CL1')
    assert.equal(ins.cause_source, 'template')
    const deps = { provider, windowsFor: async (_sid: string, offsets: number[]) => offsets.map(window) }
    const before = B.budgetRow(B.dayOf(), 'global')
    const r1 = await L.prepareExplanations('client:CL1', deps)
    assert.equal(r1.prepared, 1)
    const [file] = requests(exDir)
    const body = JSON.parse(readFileSync(join(exDir, 'requests', file!), 'utf8'))
    assert.equal(body.model, 'claude-haiku-5-5'); assert.equal(body.messages[0].content[0].type, 'text')
    assert.ok(!JSON.stringify(body).includes('CL1-a-0000'), 'session ids never leave')
    assert.equal(B.budgetRow(B.dayOf(), 'global').reserved_llm_calls, before.reserved_llm_calls + 1)
    // Restart / second pass before an answer: nothing is resubmitted, the request stays pending.
    assert.equal((await L.prepareExplanations('client:CL1', deps)).prepared, 0)
    assert.equal((await L.collectExplanations({ provider })).collected, 0)
    assert.equal(requests(exDir).length, 1)
    const customId = file!.replace(/\.json$/, '')
    const alias = body.messages[0].content[0].text.match(/"session":"(S[0-9a-f]{8})"/)[1]
    answer(exDir, customId, { decision: 'explain', likely_cause: 'Likely cause: the visible validation error after Save points at Debit To, which users edit only after the error appears (events 42→43).', fix: 'Fix: on Sales Invoice (new), mark Debit To as required before Save and show its error inline next to Debit To.', cited_event_ids: [`${alias}:42`, '43'], confidence: 'med', unsupported: [] })
    const r2 = await L.collectExplanations({ provider })
    assert.deepEqual([r2.collected, r2.accepted], [1, 1])
    const after = listInsights('client:CL1')[0]!
    assert.equal(after.cause_source, 'llm:claude-haiku-5-5 (validated)')
    assert.match(after.text, /Likely cause: the visible validation error after Save points at Debit To/)
    assert.equal(after.users_affected, 3, 'counts are never taken from the model')
    const g = B.budgetRow(B.dayOf(), 'global')
    assert.deepEqual([g.reserved_llm_calls, g.used_llm_calls - before.used_llm_calls, g.used_input_tokens - before.used_input_tokens], [before.reserved_llm_calls, 1, 1500])
    assert.equal(g.estimated_cost_micros - before.estimated_cost_micros, PV.costMicros(1500, 200, false))
    assert.equal((await L.collectExplanations({ provider })).collected, 0, 'settled exactly once')
    // Refreshing the insight keeps the accepted explanation (stable insight id).
    refreshInsights({ client: 'CL1' })
    assert.equal(listInsights('client:CL1')[0]!.cause_source, 'llm:claude-haiku-5-5 (validated)')
})

test('text stage guards: hallucinated citations, generic text and missing answers are never shown', async () => {
    const cases: [string, unknown, string][] = [
        ['CL2', { decision: 'explain', likely_cause: 'Likely cause: the Save button is broken (event 999).', fix: 'Fix: repair Save on the invoice.', cited_event_ids: ['999'], confidence: 'high', unsupported: [] }, 'hallucinated_citation'],
        ['CL3', { decision: 'explain', likely_cause: 'Likely cause: users were frustrated by Save.', fix: 'Fix: improve the UX of Save.', cited_event_ids: ['42'], confidence: 'high', unsupported: [] }, 'generic_claim'],
        ['CL4', { decision: 'explain', likely_cause: 'Likely cause: error 42 after Save.', fix: 'Fix: show the field.', cited_event_ids: ['42'], confidence: 'low', unsupported: [] }, 'fix_not_specific'],
    ]
    for (const [client, body, reason] of cases) {
        const exDir = join(dir, `ex-${client}`), provider = new PV.ExchangeProvider(exDir, 60_000)
        seedInsight(client)
        await L.prepareExplanations(`client:${client}`, { provider, windowsFor: async (_s, o) => o.map(window) })
        const [file] = requests(exDir)
        answer(exDir, file!.replace(/\.json$/, ''), body)
        const r = await L.collectExplanations({ provider })
        assert.equal(r.rejected, 1, client)
        assert.ok(String(one<{ error_code: string }>('SELECT error_code FROM rv_llm_explanation WHERE scope_key = ?', `client:${client}`)!.error_code).startsWith(reason), client)
        assert.equal(listInsights(`client:${client}`)[0]!.cause_source, 'template', `${client}: template stays`)
    }
    // No answer before the deadline: skipped, never faked; the reservation is released.
    const exDir = join(dir, 'ex-timeout'), provider = new PV.ExchangeProvider(exDir, 1)
    seedInsight('CL5')
    const reservedBefore = B.budgetRow(B.dayOf(), 'global').reserved_llm_calls
    await L.prepareExplanations('client:CL5', { provider, windowsFor: async (_s, o) => o.map(window) })
    await new Promise((r) => setTimeout(r, 10))
    const r = await L.collectExplanations({ provider })
    assert.equal(r.expired, 1)
    assert.equal(one<{ state: string }>("SELECT state FROM rv_llm_explanation WHERE scope_key = 'client:CL5'")!.state, 'skipped_timeout')
    assert.equal(B.budgetRow(B.dayOf(), 'global').reserved_llm_calls, reservedBefore)
    assert.equal(listInsights('client:CL5')[0]!.cause_source, 'template')
})

test('budget cap stops new requests; external analysis needs the explicit switch', async () => {
    seedInsight('CL6')
    const day = B.dayOf()
    run(`UPDATE rv_budget SET used_llm_calls = ? WHERE day_utc = ? AND scope = 'global'`, B.BUDGET.dailyLlmCalls, day)
    const exDir = join(dir, 'ex-cap')
    const r = await L.prepareExplanations('client:CL6', { provider: new PV.ExchangeProvider(exDir), windowsFor: async (_s, o) => o.map(window) })
    assert.deepEqual([r.prepared, r.skipped.budget], [0, 1])
    assert.equal(requests(exDir).length, 0, 'no request leaves when the cap is reached')
    delete process.env.REPLAY_VISION_ALLOW_EXTERNAL
    process.env.REPLAY_VISION_PROVIDER = 'exchange'; process.env.REPLAY_VISION_EXCHANGE_DIR = exDir
    assert.equal(L.externalAnalysisAllowed(), false)
    assert.equal(L.providerStatus().mode, 'deterministic')
    process.env.REPLAY_VISION_ALLOW_EXTERNAL = 'on'
    assert.equal(L.externalAnalysisAllowed(), true)
    assert.match(L.providerStatus().detail, /never typed values, page text, URLs, identities or raw recordings/)
    delete process.env.REPLAY_VISION_ALLOW_EXTERNAL; delete process.env.REPLAY_VISION_PROVIDER; delete process.env.REPLAY_VISION_EXCHANGE_DIR
})

test('MCP: tools only for a live personal token with the insights grant; shared, revoked or ungranted are refused at call time', async () => {
    const T = await import('../src/mcp/replay-vision-tools.ts')
    const now = new Date().toISOString()
    run(`INSERT INTO mcp_tokens(id, email, hash, label, created_at) VALUES('tok1','pm@x.test','h1','t',?),('tok2','other@x.test','h2','t',?)`, now, now)
    run(`INSERT INTO replay_insight_people(email, updated_by, updated_at) VALUES('pm@x.test','admin@x.test',?)`, now)
    const pm = { tokenId: 'tok1', who: 'pm@x.test', email: 'pm@x.test', shared: false, admin: false, insights: true }
    assert.doesNotThrow(() => T.requireVisionAccess(pm))
    assert.throws(() => T.requireVisionAccess({ ...pm, tokenId: 'shared', shared: true }), /personal MCP token/)
    assert.throws(() => T.requireVisionAccess({ tokenId: 'tok2', who: 'other@x.test', email: 'other@x.test', shared: false, admin: false, insights: true }), /insights access/)
    run(`DELETE FROM replay_insight_people WHERE email = 'pm@x.test'`)
    assert.throws(() => T.requireVisionAccess(pm), /insights access/, 'grant revoked: denied immediately')
    run(`INSERT INTO replay_insight_people(email, updated_by, updated_at) VALUES('pm@x.test','admin@x.test',?)`, now)
    run(`UPDATE mcp_tokens SET revoked_at = ? WHERE id = 'tok1'`, now)
    assert.throws(() => T.requireVisionAccess(pm), /revoked/)
    const registered: string[] = []
    const fakeServer = { registerTool: (name: string) => { registered.push(name) } } as never
    T.registerReplayVisionTools(fakeServer, { ...pm, tokenId: 'shared', shared: true }); assert.deepEqual(registered, [])
    T.registerReplayVisionTools(fakeServer, { ...pm, insights: false }); assert.deepEqual(registered, [])
    T.registerReplayVisionTools(fakeServer, pm); assert.deepEqual(registered.sort(), ['analyze_replay', 'replay_friction', 'replay_vision_status'])
    process.env.FEATURE_REPLAY_VISION = 'off'
    assert.deepEqual(T.replayVisionToolNames(), [])
    registered.length = 0; T.registerReplayVisionTools(fakeServer, pm); assert.deepEqual(registered, [])
    process.env.FEATURE_REPLAY_VISION = 'on'
})

test('window mode in the worker thread returns only sanitized ±20 s windows from a real recording', async () => {
    const { analyzeFile } = await import('../src/core/replay-vision.ts')
    const file = 'test/fixtures/replay-lab/error-looping-01a1d034-6809-7f9f-b797-20853f82f9e3.jsonl'
    const first = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!)
    const start = new Date((first[1] ?? first).timestamp).toISOString()
    const raw = readFileSync(file, 'utf8')
    const r = await analyzeFile(file, { start_time: start }, 30_000, {}, [15_000])
    assert.equal(r.candidates.length, 0)
    const w = r.windows![0]!
    assert.equal(w.start_ms, 0); assert.equal(w.end_ms, 35_000)
    assert.ok(w.events.length > 0 && w.events.length <= 160)
    assert.ok(w.events.every((e) => e.t_ms >= w.start_ms && e.t_ms <= w.end_ms))
    assert.ok(w.events.every((e) => e.x === undefined || e.x % 25 === 0), 'coordinates rounded to 25 px')
    const text = JSON.stringify(w)
    for (const m of raw.matchAll(/"textContent":"([^"]{6,40})"/g)) assert.ok(!text.includes(m[1]!), `page text leaked: ${m[1]}`)
})
