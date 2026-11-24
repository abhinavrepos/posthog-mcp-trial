// The Reval simulation, end to end: Lens saves and launches each flow's surveys on a stand-in PostHog, a
// headless Chrome runs the simulated Reval (real Ext JS classic and real posthog-js, with the surveys.js
// that survey-engine/build.mjs makes), acts like a user, and checks whether each survey appeared (the
// popover in the DOM) and "survey shown" reached PostHog, or that it correctly did not.
//
//   pnpm reval-sim [name filter] [--quick] [--concurrency N] [--json out.json] [--screens dir]
// REVAL_VENDOR (default /root/briefs/reval-vendor): extjs/ and posthog-js/ (Ext JS is GPL: not in this repo).
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FLOWS, type Act, type Expect, type Flow } from './flows.ts'
import { answerSurvey, dismissSurvey, sleep, startSim, surveysOnScreen, visit, type Sim, type Visit } from './harness.ts'
import { SCREENS } from './screens.ts'
import { missingVendor, StandInPostHog } from './server.ts'

export interface FlowResult {
    name: string
    expected: string
    ok: boolean
    result: string
    failures: string[]
    lens: Record<string, string[]> // warnings Lens gave per survey
    checks: string[]
    errors: string[]
    ms: number
    perf?: { screens: number; firstMs: number; lastMs: number; p95OverheadMs: number; maxOverheadMs: number }
}

const describe = (f: Flow) => f.acts.filter((a): a is ['expect', Expect] => a[0] === 'expect')
    .map(([, e]) => (e.shown ? `shows ${e.shown.join('+')}${e.notWhileMask ? ' (after the mask)' : ''}` : 'no survey') + (e.note ? ` (${e.note})` : '')).join('; then ')

interface Prepared { flow: Flow; projectId: string; ids: Record<string, string>; chains: Record<string, string>; lens: Record<string, string[]>; failures: string[]; ph: string }

/** Lens makes each flow's surveys, as a PM would: compile and check, save as a draft, launch. */
async function prepare(sim: Sim, flows: Flow[], alt: StandInPostHog): Promise<Prepared[]> {
    const out: Prepared[] = []
    const savedHost = sim.config.posthog.host, savedPart = sim.config.properties.clientFromDistinctId
    for (const [i, flow] of flows.entries()) {
        const projectId = String(100 + FLOWS.indexOf(flow))
        const p: Prepared = { flow, projectId, ids: {}, chains: {}, lens: {}, failures: [], ph: flow.versioned === 'original' ? alt.url : sim.posthog.url }
        sim.config.posthog.projectId = projectId
        sim.config.posthog.host = p.ph
        sim.config.properties.clientFromDistinctId = flow.clientFromDistinctId ?? 3
        try {
            for (const [key, def] of Object.entries(flow.surveys)) {
                const saved = await sim.lens.saveSurvey(def.spec, { clientIds: def.clients })
                const problems = saved.compiled.problems
                if (!saved.survey) { p.failures.push(`Lens refused survey ${key}: ${problems.map((x) => x.text).join('; ')}`); continue }
                p.lens[key] = problems.filter((x) => x.level === 'warning' && x.where !== 'clients').map((x) => `${x.where}: ${x.text}`)
                for (const re of flow.lensWarns?.[key] || []) if (!p.lens[key].some((t) => re.test(t))) p.failures.push(`Lens gave no warning matching ${re} for ${key} (warnings: ${p.lens[key].join(' | ') || 'none'})`)
                if (flow.lensQuiet?.includes(key)) { const steps = p.lens[key].filter((t) => /^(steps|reset_on)/.test(t)); if (steps.length) p.failures.push(`Lens warned about a correct survey ${key}: ${steps.join(' | ')}`) }
                p.ids[key] = saved.survey.id
                p.chains[key] = (saved.survey.conditions as { lensChain: { id: string } }).lensChain.id
                if (def.launch !== false) { await sim.lens.launchSurvey(saved.survey.id); await sleep(5) }
            }
        } catch (e) { p.failures.push(`Lens: ${(e as Error).message}`) }
        out.push(p)
        void i
    }
    sim.config.posthog.host = savedHost
    sim.config.properties.clientFromDistinctId = savedPart
    return out
}

async function act(v: Visit, a: Act, r: FlowResult, ctx: { sim: Sim; alt: StandInPostHog; p: Prepared; t: number; shownCount: Map<string, number>; screensDir?: string }) {
    const page = v.page
    const R = <T>(fn: string, ...args: unknown[]) => page.evaluate((f, xs) => (window as any).Reval[f](...xs), fn, args) as Promise<T>
    const key = (k: string) => k
    switch (a[0]) {
        case 'open': return void (await R('open', a[1]))
        case 'press': {
            const id = await R<string | null>('button', key(a[1]), a[2])
            if (!id) { r.failures.push(`no button ${a[2]} in ${a[1]}`); return }
            await page.click(`#${id}`)
            return
        }
        case 'field': if (!(await R<boolean>('field', a[1], a[2], a[3]))) r.failures.push(`no field ${a[2]} in ${a[1]}`); return void (await sleep(150))
        case 'tab': if (!(await R<boolean>('tab', a[1], a[2]))) r.failures.push(`no tab ${a[2]} in ${a[1]}`); return void (await sleep(150))
        case 'mdi': if (!(await R<boolean>('mdi', a[1]))) r.failures.push(`no open tab ${a[1]}`); return void (await sleep(150))
        case 'close': if (!(await R<boolean>('close', a[1]))) r.failures.push(`cannot close ${a[1]}`); return void (await sleep(150))
        case 'wait': return sleep(a[1])
        case 'advance': return void (await page.evaluate((ms) => localStorage.setItem('__simClockOffset', String(Number(localStorage.getItem('__simClockOffset') || 0) + ms)), a[1]))
        case 'logout': return void (await R('logout'))
        case 'login': return void (await R('login', a[1], a[2]))
        case 'changeClient': {
            await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), R('changeClient', a[1], a[2])])
            await page.waitForFunction('!!window.Reval && !!window.__viewportAt', { timeout: 30_000 })
            return
        }
        case 'modal': return void (await R('modalWindow'))
        case 'closeModal': return void (await R('closeModal'))
        case 'msgOk': if (!(await R<boolean>('msgOk'))) r.failures.push('no message box to confirm'); return
        case 'iframeClick': {
            const frame = page.frames().find((f) => f.url().includes('/iframe.html'))
            if (!frame) { r.failures.push('no iframe'); return }
            await frame.click(a[2])
            return
        }
        case 'dismiss': if (!(await dismissSurvey(page))) r.failures.push('no survey to dismiss'); return
        case 'answer': if (!(await answerSurvey(page))) r.failures.push('could not answer the survey'); return
        case 'ready':
            await page.waitForFunction(() => !!(window as any).__PosthogExtensions__?.generateSurveys && !!(window as any).posthog?.__loaded, { timeout: 30_000 })
            await sleep(700) // the surveys list request
            return
        case 'openAll': return openAll(v, r)
        case 'expect': return expect(v, a[1], r, ctx)
    }
}

async function openAll(v: Visit, r: FlowResult) {
    const page = v.page
    const overhead: number[] = [], total: number[] = []
    const list = SCREENS.filter((s) => !s.stuck)
    for (const s of list) {
        const t0 = Date.now()
        const before = await page.evaluate(() => (window as any).__revalLog.length)
        await page.evaluate((m) => (window as any).Reval.open(m), s.menu)
        try {
            // Opened (OPEN sent) and settled (no mask; a modal window keeps its own).
            await page.waitForFunction((n, ev, modal) => (window as any).__revalLog.slice(n).some((e: any) => e.props.dialog_id === ev && e.props.action === 'OPEN') && (modal || (window as any).Reval.masks() === 0),
                { timeout: 15_000, polling: 20 }, before, s.event, s.kind === 'modal')
        } catch { r.failures.push(`screen ${s.menu} did not open within 15 s`) }
        const ms = Date.now() - t0
        total.push(ms)
        overhead.push(ms - (s.loadMs + s.settleMs))
        if (s.kind === 'modal') await page.evaluate(() => (window as any).Reval.closeModal())
    }
    const sorted = [...overhead].sort((a, b) => a - b)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    const first = mean(overhead.slice(0, 20)), last = mean(overhead.slice(-20))
    r.perf = { screens: list.length, firstMs: Math.round(first), lastMs: Math.round(last), p95OverheadMs: sorted[Math.floor(sorted.length * 0.95)], maxOverheadMs: sorted.at(-1)! }
    r.checks.push(`${list.length} screens: overhead beyond the screens' own delays ${Math.round(first)} ms (first 20) vs ${Math.round(last)} ms (last 20), p95 ${r.perf.p95OverheadMs} ms`)
    if (last > Math.max(2 * first, first + 150)) r.failures.push(`slowdown: opening a screen took ${Math.round(first)} ms extra at first and ${Math.round(last)} ms extra at the end`)
}

async function expect(v: Visit, e: Expect, r: FlowResult, ctx: { sim: Sim; alt: StandInPostHog; p: Prepared; t: number; shownCount: Map<string, number>; screensDir?: string }) {
    const page = v.page, p = ctx.p
    const keyOf = (id: string) => Object.entries(p.ids).find(([, x]) => x === id)?.[0] || `?${id.slice(0, 8)}`
    const started = Date.now()
    const within = e.within ?? (e.shown ? 8000 : 4000)
    let seen: string[] = [], firstAt = 0, masksAtShow = 0
    while (Date.now() - started < within) {
        const ids = await surveysOnScreen(page)
        if (ids.length && !firstAt) { firstAt = Date.now(); masksAtShow = await page.evaluate(() => (window as any).Reval.masks()) }
        seen = [...new Set([...seen, ...ids.map(keyOf)])]
        if (e.shown && firstAt && Date.now() - firstAt > 600) break
        await sleep(80)
    }
    const label = e.shown ? `shows ${e.shown.join('+')}` : 'no survey'
    if (e.none) {
        if (seen.length) r.failures.push(`expected no survey${e.note ? ` (${e.note})` : ''}, saw ${seen.join('+')}`)
        else r.checks.push(`no survey for ${Math.round(within / 1000)} s${e.note ? ` (${e.note})` : ''}`)
        return
    }
    const want = [...(e.shown || [])].sort().join('+'), got = [...seen].sort().join('+')
    if (want !== got) { r.failures.push(`expected ${label}, saw ${got || 'none'} within ${within / 1000} s`); return }
    const after = firstAt - started
    r.checks.push(`${label} after ${after} ms`)
    if (e.notWhileMask && masksAtShow) r.failures.push(`shown while ${masksAtShow} Ext mask(s) visible`)
    if (e.after && after < e.after) r.failures.push(`shown after ${after} ms, before ${e.after} ms (the mask was still up)`)
    if (ctx.screensDir && !r.checks.some((c) => c.startsWith('screenshot'))) {
        const file = join(ctx.screensDir, `${r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}.png`)
        await page.screenshot({ path: file })
        r.checks.push(`screenshot ${file}`)
    }
    // "survey shown" reaches PostHog (posthog-js sends in batches).
    for (const k of e.shown || []) {
        ctx.shownCount.set(k, (ctx.shownCount.get(k) || 0) + 1)
        const need = ctx.shownCount.get(k)!
        const until = Date.now() + 10_000
        let got: { distinct_id: string }[] = []
        while (Date.now() < until) {
            const store = p.ph === ctx.sim.posthog.url ? ctx.sim.posthog : ctx.alt
            got = store.events(p.projectId).filter((x) => x.event === 'survey shown' && x.properties.$survey_id === p.ids[k])
            if (got.length >= need) break
            await sleep(200)
        }
        if (got.length < need) r.failures.push(`"survey shown" for ${k} not captured (${got.length} of ${need})`)
        else if (e.by && got[need - 1].distinct_id !== e.by) r.failures.push(`"survey shown" for ${k} came from ${got[need - 1].distinct_id}, not ${e.by}`)
        else r.checks.push(`"survey shown" ${k} captured${e.by ? ` for ${e.by}` : ''}`)
    }
}

async function runFlow(sim: Sim, p: Prepared, alt: StandInPostHog, screensDir?: string): Promise<FlowResult> {
    const f = p.flow
    const r: FlowResult = { name: f.name, expected: describe(f), ok: false, result: '', failures: [...p.failures], lens: p.lens, checks: [], errors: [], ms: 0 }
    const t0 = Date.now()
    if (p.failures.length && !Object.keys(p.ids).length) { r.result = 'FAIL'; return r }
    const user = typeof f.user === 'function' ? f.user(p.chains) : f.user || 'SEMOPS'
    const ph = (f.slow ? `${p.ph}/slow${f.slow}` : p.ph)
    let v: Visit | undefined
    const shownCount = new Map<string, number>()
    try {
        v = await visit(sim, p.projectId, { client: f.client || 'SEM', user, init: f.init, ph })
        for (const a of f.acts) {
            await act(v, a, r, { sim, alt, p, t: t0, shownCount, screensDir })
            if (a[0] !== 'expect' && a[0] !== 'wait') await sleep(120)
        }
        // Nothing beyond what was expected reached PostHog: unload flushes posthog-js's queue.
        await v.page.goto('about:blank').catch(() => {})
        await sleep(800)
        const store = p.ph === sim.posthog.url ? sim.posthog : alt
        const appEvents = store.events(p.projectId).filter((x) => x.event === 'PageView' || x.event === 'Event')
        for (const ev of appEvents) {
            const props = ev.properties
            if (!['PageView', 'Event'].includes(ev.event) || Object.keys(props).some((key) => ['client', 'client_id', 'user', 'loginUser'].includes(key)))
                r.failures.push(`unexpected Reval event shape: ${ev.event} ${JSON.stringify(props).slice(0, 200)}`)
            if (ev.event === 'PageView' && !['OPEN', 'CLOSE'].includes(String(props.action)))
                r.failures.push(`unexpected PageView action: ${String(props.action)}`)
            if (ev.event === 'PageView' && props.dialog_id && !SCREENS.some((s) => s.event === props.dialog_id))
                r.failures.push(`unknown dialog_id: ${String(props.dialog_id)}`)
        }
        for (const [k, id] of Object.entries(p.ids)) {
            const n = store.events(p.projectId).filter((x) => x.event === 'survey shown' && x.properties.$survey_id === id).length
            if (n !== (shownCount.get(k) || 0)) r.failures.push(`"survey shown" for ${k}: ${n} captured, ${shownCount.get(k) || 0} expected`)
        }
        r.errors = v.errors.filter((x) => !/favicon/.test(x))
        if (r.errors.length) r.failures.push(`${r.errors.length} browser console errors or failed requests`)
    } catch (e) {
        r.failures.push(`harness: ${(e as Error).message.split('\n')[0]}`)
    } finally {
        await v?.close()
    }
    r.ok = !r.failures.length
    r.result = r.ok ? 'PASS' : 'FAIL'
    r.ms = Date.now() - t0
    return r
}

export async function runFlows(opts: { filter?: string; quick?: boolean; concurrency?: number; screensDir?: string; buildDir?: string; log?: (s: string) => void } = {}): Promise<FlowResult[]> {
    const log = opts.log || (() => {})
    const flows = FLOWS.filter((f) => (!opts.quick || f.quick) && (!opts.filter || f.name.toLowerCase().includes(opts.filter.toLowerCase())))
    const sim = await startSim({ buildDir: opts.buildDir || join(import.meta.dirname, '../../run/reval-sim/build') })
    const alt = await new StandInPostHog(join(opts.buildDir || join(import.meta.dirname, '../../run/reval-sim/build'))).start()
    alt.versioned = 'original'
    if (opts.screensDir) mkdirSync(opts.screensDir, { recursive: true })
    try {
        const prepared = await prepare(sim, flows, alt)
        const results: FlowResult[] = new Array(prepared.length)
        let next = 0
        await Promise.all(Array.from({ length: Math.min(opts.concurrency || 4, prepared.length) }, async () => {
            while (next < prepared.length) {
                const i = next++
                results[i] = await runFlow(sim, prepared[i], alt, opts.screensDir)
                log(`${results[i].ok ? 'PASS' : 'FAIL'}  ${results[i].name} (${(results[i].ms / 1000).toFixed(1)} s)${results[i].ok ? '' : '\n      ' + results[i].failures.join('\n      ')}`)
            }
        }))
        const unknown = [...new Set([...sim.posthog.unknown, ...alt.unknown])]
        if (unknown.length) log(`stand-in PostHog: requests it does not know: ${unknown.slice(0, 10).join(', ')}`)
        return results
    } finally {
        await alt.stop()
        await sim.stop()
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2)
    const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined }
    const quick = args.includes('--quick'); if (quick) args.splice(args.indexOf('--quick'), 1)
    const concurrency = Number(opt('--concurrency') || 4), jsonOut = opt('--json'), screensDir = opt('--screens') || process.env.REVAL_SCREENS || '/root/screens/reval'
    const skip = missingVendor()
    if (skip) { console.log(skip); process.exit(0) }
    const t0 = Date.now()
    const results = await runFlows({ filter: args[0], quick, concurrency, screensDir, log: (s) => console.log(s) })
    const failed = results.filter((r) => !r.ok)
    console.log(`\n${results.length - failed.length} of ${results.length} flows passed in ${Math.round((Date.now() - t0) / 1000)} s`)
    const file = jsonOut || join(import.meta.dirname, '../../run/reval-sim/results.json')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(results, null, 1))
    console.log(`details: ${file}`)
    process.exit(failed.length ? 1 : 0)
}
