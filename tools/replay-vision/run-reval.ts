// Run R orchestration (Reval simulator), same protocol as run.ts for ERPNext:
//   npx tsx tools/replay-vision/run-reval.ts --smoke          one injected session, prints what the product saw
//   npx tsx tools/replay-vision/run-reval.ts --capture [--calibration-only]   capture missing seeds (calibration first, then held-out)
//   npx tsx tools/replay-vision/run-reval.ts --freeze-only    detectors + severity + calibration baselines -> frozen-config.json
//   npx tsx tools/replay-vision/run-reval.ts --rescore [--llm-pass1]   held-out analysis (refuses a different frozen hash), score, report
// The simulator (tools/reval-sim/server.ts RevalServer, real Ext JS 6.2 from REVAL_VENDOR) records into the REAL local
// PostHog. Replay Vision reads Reval's events through APP_EVENTS_FILE=config/app-events.reval.json; the deployment's
// visible labels (screen names, buttons, field labels, tabs of the simulated Reval) are REPLAY_VISION_LABELS.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import { checkApplication, labConfig, recordingOptIn } from './setup.ts'
import type { Readiness } from './capture.ts'
import { driveReval, HESITATION_LABEL, type RevalCaptured } from './reval-personas.ts'
import { R_ACCEPTED, R_CALIBRATION_REPEATS, R_COHORTS, R_CONTROL_SEEDS, rCohortSeed, revalPlans } from './reval-design.ts'

const base = dirname(fileURLToPath(import.meta.url)), smoke = process.argv.includes('--smoke')
const out = join(base, 'out', smoke ? 'reval-smoke' : 'reval-run-r'), c = labConfig()
const repo = join(base, '..', '..')
Object.assign(process.env, { POSTHOG_HOST: c.host, POSTHOG_PROJECT_ID: c.projectId, POSTHOG_PERSONAL_API_KEY: c.personalKey, POSTHOG_PROJECT_TOKEN: c.token, APP_EVENTS_FILE: join(repo, 'config/app-events.reval.json') })
const { SCREENS } = await import('../reval-sim/screens.ts')
process.env.REPLAY_VISION_LABELS = [...new Set([process.env.REPLAY_VISION_LABELS ?? '', ...SCREENS.flatMap((s) => [s.name, s.group, ...s.buttons, ...(s.fields ?? []), ...(s.tabs ?? [])]), HESITATION_LABEL, 'Close'].filter(Boolean))].join(',')

async function load<T>(file: string): Promise<T[]> { try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((x) => JSON.parse(x)) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e } }
async function currentCaptures(): Promise<RevalCaptured[]> {
    const p = revalPlans(smoke), seeds = new Set([...p.calibration, ...p.heldout].map((x) => x.seed)), by = new Map<number, RevalCaptured>()
    for (const x of await load<RevalCaptured>(join(out, 'sessions.jsonl'))) if (seeds.has(x.plan.seed)) by.set(x.plan.seed, x)
    return [...by.values()]
}
async function capture() {
    const { RevalServer, missingVendor } = await import('../reval-sim/server.ts')
    const why = missingVendor(); if (why) throw new Error(why)
    await checkApplication({ ...c, app: c.host + '/_health' } as never).catch(() => {}) // PostHog health is checked by the API calls below
    const previous = await recordingOptIn(c)
    const reval = await new RevalServer().start()
    const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] })
    try {
        await recordingOptIn(c, true)
        const { captureSession } = await import('./capture.ts')
        const plan = revalPlans(smoke)
        const capturesFile = join(out, 'sessions.jsonl'), readinessFile = join(out, 'readiness.jsonl')
        const captures = await load<RevalCaptured>(capturesFile), readiness = await load<Readiness>(readinessFile)
        // --calibration-only: capture calibration, analyse and freeze before a single held-out session exists.
        for (const phase of (process.argv.includes('--calibration-only') ? ['calibration'] : ['calibration', 'heldout']) as ('calibration' | 'heldout')[]) {
            for (const p of plan[phase]) {
                if (captures.some((x) => x.plan.seed === p.seed && x.session_id)) continue
                const r = await driveReval(c, reval.url, p, browser)
                captures.push(r); await appendFile(capturesFile, JSON.stringify(r) + '\n')
                await writeFile(join(out, 'ground-truth', `${p.seed}.json`), JSON.stringify({ plan: p, session_id: r.session_id, distinct_id: r.distinct_id, truth: r.truth, steps: r.steps }, null, 2))
                console.log(JSON.stringify({ phase, seed: p.seed, cohort: p.cohort, session: r.session_id, truth: r.truth.map((t) => t.observed), steps: r.steps.map((s) => s.name + (s.ok ? '' : '!')).join(' '), app_log: r.app_log, errors: r.errors }))
            }
            const seeds = new Set(plan[phase].map((x) => x.seed))
            for (const r of captures.filter((x) => seeds.has(x.plan.seed))) {
                if (!r.session_id || readiness.some((x) => x.session_id === r.session_id && x.status === 'ready')) continue
                const ready = await captureSession(r.session_id, 75_000, r.ended_at)
                readiness.push(ready); await appendFile(readinessFile, JSON.stringify(ready) + '\n')
                console.log(JSON.stringify({ phase, session: ready.session_id, status: ready.status, events: ready.analysis.events, bytes: ready.snapshot_bytes, error: ready.error }))
            }
        }
    } finally { await browser.close().catch(() => {}); await reval.stop(); await recordingOptIn(c, previous).catch((e) => console.error('recording_opt_in_restore_failed', (e as Error).message)) }
}
const reportApp = () => ({
    title: 'Reval simulator (run R)',
    workflows: ['deal', 'hedge', 'amortisation'],
    done: (x: { plan: { workflow: string; injection?: string }; steps: { name: string; ok: boolean }[] }) => x.plan.workflow === 'deal' ? x.plan.injection === 'validation_loop' ? x.steps.some((s) => s.name === 'cap_given_up' && s.ok) : x.steps.some((s) => s.name === 'saved' && s.ok)
        : x.plan.workflow === 'hedge' ? x.plan.injection === 'slow_wait' ? x.steps.some((s) => s.name === 'opened_hedge' && s.ok) : x.steps.some((s) => s.name === 'report_export' && s.ok)
        : x.plan.injection === 'scroll_hunt' ? x.steps.some((s) => s.name === 'opened_trade_list' && s.ok) : x.steps.some((s) => s.name === 'report_export' && s.ok),
    design: `## Design

- Application: the Reval simulator (\`tools/reval-sim\`): real Ext JS classic 6.2 (Reval ships 7.8), one page whose URL never changes, MDI tabs, floating parameter windows, tabbed dialogs, grids with custom Ext.LoadMasks, message boxes and toasts, an iframe screen; Reval's real events \`PageView\`/\`Event\` with \`dialog_id\`/\`dialog_name\`/\`action\`/\`action_name\`. Recorded by the standard posthog-js snippet into the real local PostHog.
- Product configuration: \`APP_EVENTS_FILE=config/app-events.reval.json\` (screens from PageView OPEN/CLOSE by dialog name, message boxes as visible errors, submit buttons and examples as labels) and \`REPLAY_VISION_LABELS\` = the deployment's visible labels (screen names, menu groups, buttons, field labels, tabs).
- Calibration: ${R_CALIBRATION_REPEATS} clean repeats × 6 personas (users RVCAL0–5, distinct ids C1DEV|01|SEM|…) × 3 TRM workflows: deal entry (IR Swap: Trade Date, Counterparty, Notional, Cashflow tab, Recalc Cashflow, Save → toast), hedge designation (Hedge Relationship: tabs, Save, Approve; Hedge Designation report: parameters, Run, Export), amortisation (Loan: Amortisation tab; Cashflow Report: parameters, Run, scroll, XLSX Export). Screens are opened through the toolbar menus with real clicks.
- Held-out controls: users RVEVAL0–5 × 3 workflows (18 sessions). Held-out injected cohorts: ${R_COHORTS.length} cohorts, ${R_COHORTS.reduce((a, k) => a + k.users, 0)} sessions: I2 Cap / Floor Save rejected by Reval's "Strike must be greater than zero" message box, edits, retry, give up (1/3/6 users); I5 inert Apply button in the IR Swap toolbar (1/3/6); I6 hunting trade 37 in the Trade List grid by scrolling (1/3/6); I7 Counterparty lookup closed and reopened twice during deal entry (1/3/6); I3 Hedge Relationship opening in 2/6/15 s (3 users each; 2 s is the negative dose control); I1 IR Swap "Notional" relabelled "${HESITATION_LABEL}" with a seeded 3–9 s pause (3 users). Each cohort is one product scope (cohort + the 18 controls).
- Pipeline and protocol: identical to ERPNext (product code only; baselines from calibration only; hash frozen before held-out analysis; one-to-one matching, Wilson 95% intervals). No LLM output is produced by this harness.

`,
})
async function evaluate(freezeOnly: boolean) {
    const t0 = Date.now(), captures = await currentCaptures()
    const { runPipeline } = await import('./pipeline.ts')
    if (freezeOnly) {
        const p = await runPipeline(out, captures.filter((x) => x.plan.phase === 'calibration') as never, [], [], false, join(out, 'snapshots'), { freezeOnly: true })
        console.log(JSON.stringify({ frozen: p.frozen })); return
    }
    const preRegistered = JSON.parse(await readFile(join(out, 'frozen-config.json'), 'utf8')).hash as string
    const pipeline = await runPipeline(out, captures as never, R_COHORTS.map((k, i) => ({ id: k.id, seeds: Array.from({ length: k.users }, (_, j) => rCohortSeed(i, j)) })), R_CONTROL_SEEDS, process.argv.includes('--llm-pass1'), join(out, 'snapshots'), { expectHash: preRegistered })
    await writeFile(join(out, 'pipeline.json'), JSON.stringify(pipeline))
    await writeFile(join(out, 'session-ids.json'), JSON.stringify(captures.map((x) => ({ seed: x.plan.seed, phase: x.plan.phase, persona: x.plan.persona, user: x.plan.user, distinct_id: x.distinct_id, workflow: x.plan.workflow, injection: x.plan.injection ?? null, cohort: x.plan.cohort ?? null, session_id: x.session_id })), null, 1))
    const { score, calibrationSummary } = await import('./score.ts'), { writeReport } = await import('./report.ts')
    const cohorts = R_COHORTS.map((k) => ({ id: k.id, injection: k.injection as never, workflow: k.workflow as never, users: k.users, dose: k.dose, planned: k.planned }))
    const held = score(captures as never, pipeline, cohorts, R_CONTROL_SEEDS, R_ACCEPTED), cal = calibrationSummary(captures as never, pipeline)
    await writeFile(join(out, 'heldout-score.json'), JSON.stringify(held, null, 1)); await writeFile(join(out, 'calibration-score.json'), JSON.stringify(cal, null, 1))
    await writeReport(out, captures as never, pipeline, held, cal, { evaluate_ms: Date.now() - t0, peak_rss_mib: Math.round(process.resourceUsage().maxRSS / 1024) }, reportApp() as never)
    console.log(JSON.stringify({ evaluated: out, recall: held.recall, precision_moment_level: held.precision_moment_level }))
}
async function smokeReport() {
    const [x] = await currentCaptures()
    if (!x?.session_id) throw new Error('smoke session missing')
    const { getRecording, getSnapshotsJsonl } = await import('../../src/core/posthog.ts')
    const { replayAppEvents, analyzeFile } = await import('../../src/core/replay-vision.ts')
    const file = join(out, 'smoke.jsonl'); await getSnapshotsJsonl(x.session_id, file)
    const m = await getRecording(x.session_id), app = await replayAppEvents(x.session_id)
    const a = await analyzeFile(file, { start_time: m.start_time, app_events: app })
    console.log(JSON.stringify({ session: x.session_id, steps: x.steps.map((s) => s.name + (s.ok ? '' : '!')), truth: x.truth.map((t) => [t.kind, t.screen, t.observed]), app_screens: app.filter((e) => e.nav).map((e) => `${e.nav}:${e.screen}`), app_errors: app.filter((e) => e.error).length, coverage: a.coverage.state, reasons: a.coverage.reasons, screens: a.screens, candidates: a.candidates.map((k) => `${k.kind}:${k.element}@${k.screen}`) }, null, 1))
}
await mkdir(join(out, 'ground-truth'), { recursive: true })
if (process.argv.includes('--capture') || smoke) await capture()
if (smoke) await smokeReport()
else if (process.argv.includes('--freeze-only')) await evaluate(true)
else if (process.argv.includes('--rescore')) await evaluate(false)
