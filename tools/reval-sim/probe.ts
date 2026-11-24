// Probe: one survey through Lens, one visit, print what happened (requests, events, survey shown).
import { startSim, visit, surveysOnScreen, sleep } from './harness.ts'

const sim = await startSim({ buildDir: 'run/reval-sim/build' })
try {
    sim.config.posthog.projectId = '1'
    const spec = { name: 'Probe', questions: [{ type: 'rating' as const, text: 'Q: How was it?' }], steps: [{ opens: 'LinkListReqv' }, { button: 'Export' }], clients: ['SEM'] }
    const out = await sim.lens.saveSurvey(spec, { clientIds: ['SEM'] })
    console.log('problems', out.compiled.problems)
    await sim.lens.launchSurvey(out.survey!.id)
    const v = await visit(sim, '1', { client: 'SEM', user: 'SEMOPS' })
    const t0 = Date.now()
    await sleep(Number(process.argv[2] || 3000))
    console.log('times', await v.page.evaluate(() => ({ vp: (window as any).__viewportAt, init: (window as any).__posthogInitAt, id: (window as any).__identifiedAt, ext: !!(window as any).__PosthogExtensions__?.generateSurveys })), t0)
    await v.page.evaluate(() => (window as any).Reval.open('report:LinkListReqv'))
    await sleep(1500)
    const id = await v.page.evaluate(() => (window as any).Reval.button('LinkListReqv', 'Export'))
    console.log('button', id)
    await v.page.click('#' + id)
    for (let i = 0; i < 20; i++) { await sleep(250); const s = await surveysOnScreen(v.page); if (s.length) { console.log('shown', s, i); break } }
    await sleep(500)
    console.log('requests', sim.posthog.project('1').requests)
    console.log('events', sim.posthog.events('1').map((e) => `${e.event} ${e.distinct_id} ${JSON.stringify(e.properties.dialog_id ?? e.properties.$survey_id ?? '')}`))
    console.log('unknown', sim.posthog.unknown)
    console.log('errors', v.errors)
    await v.page.screenshot({ path: 'run/reval-sim/probe.png' })
} finally { await sim.stop() }
