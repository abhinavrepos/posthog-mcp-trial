// Surveys made from Lens: the spec in the app's words → a PostHog survey whose chain the browser
// engine (deploy/posthog/survey-engine/engine.js) accepts and follows.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test } from 'node:test'

import { parseAppEvents } from '../src/core/appevents.ts'
import { config } from '../src/core/config.ts'
import { compileSurvey, contrast, safeRegex, specOf, viewOf, type PostHogSurvey, type SurveySpec } from '../src/core/surveys.ts'
import reval from '../config/app-events.reval.json' with { type: 'json' }

const engine = createRequire(import.meta.url)('../deploy/posthog/survey-engine/engine.js')
const reg = parseAppEvents(reval)
const base: SurveySpec = {
    name: 'Hedge booking ease',
    questions: [{ type: 'rating', text: 'How easy was booking this hedge?' }],
    steps: [{ opens: 'DlgHedge' }, { button: 'Save', dialog: 'DlgHedge' }, { message: 'has been scheduled' }],
}
const errors = (c: ReturnType<typeof compileSurvey>) => c.problems.filter((p) => p.level === 'error')

describe('compile', () => {
    test('steps in the app words become events the browser engine follows, in order', () => {
        const c = compileSurvey({ ...base, reset_on: [{ closes: 'DlgHedge' }], within_minutes: 10 }, { reg, chainId: 'hedge-1', clientIds: ['ACME'] })
        assert.deepEqual(errors(c), [])
        assert.equal(c.chain.labels.join(' | '), 'Opens DlgHedge | Presses Save in DlgHedge | Sees a message containing "has been scheduled"')
        const conditions = c.body.conditions as Record<string, any>
        assert.equal(conditions.events.values[0].name, 'lens_chain:hedge-1')
        assert.equal((c.body.appearance as any).surveyPopupDelaySeconds, 0)
        // The engine accepts what Lens writes, and follows it.
        const m = engine.createMachine()
        m.setSurveys([{ start_date: 'x', end_date: null, conditions }])
        const who = 'C1|01|ACME|ann'
        const go = (event: string, properties: Record<string, unknown>, t: number, id = who) => m.consume({ event, properties: { ...properties, [config.properties.client]: 'ACME' } }, t, id).map((d: { id: string }) => d.id)
        assert.deepEqual(go('PageView', { dialog_id: 'DlgHedge', action: 'OPEN' }, 1), [])
        assert.deepEqual(go('Event', { dialog_id: 'DlgHedge', action_name: 'Save' }, 2), [])
        assert.deepEqual(go('Event', { dialog_id: 'toast', action_name: ['Report Has Been Scheduled'] }, 3), ['hedge-1'])
    })
    test('client audience follows CLIENT_FROM_DISTINCT_ID or the client property', () => {
        const c = compileSurvey(base, { reg, clientIds: ['ACME'] })
        const a = c.chain.audience as Record<string, unknown>
        assert.deepEqual(a.clients, ['ACME'])
        assert.ok('distinctIdPart' in a || 'eventProperty' in a)
        assert.equal(engine.normalizeChain(c.chain)?.audience?.clients[0], 'acme')
    })
    test('no clients: a warning, and every client', () => {
        const c = compileSurvey(base, { reg })
        assert.equal(c.chain.audience, undefined)
        assert.ok(c.problems.some((p) => p.level === 'warning' && p.where === 'clients'))
    })
    test('mistakes are errors, with where they are', () => {
        const c = compileSurvey({
            ...base,
            questions: [{ type: 'single', text: 'Which?', choices: ['A'] }, { type: 'rating', text: 'x', scale: 4 as 5 }],
            steps: [{ opens: 'A', button: 'Save' }, { dialog: 'D', opens: 'X' }, { event: '$pageview' }, { message_pattern: '(a+)+$' }, { event: 'E', properties: { 'bad key': 'x' } }],
            look: { background: 'red' },
        }, { reg })
        const where = errors(c).map((p) => p.where)
        assert.deepEqual(where.sort(), ['look.background', 'questions[0]', 'questions[1]', 'steps[0]', 'steps[1]', 'steps[2]', 'steps[3]', 'steps[4]'].sort())
    })
    test('poor colour contrast is a warning', () => {
        const c = compileSurvey({ ...base, look: { background: '#ffffff', text: '#dddddd' } }, { reg })
        assert.ok(c.problems.some((p) => p.level === 'warning' && /contrast/.test(p.text)))
        assert.ok(contrast('#000000', '#ffffff') > 20)
    })
    test('the regex rules match the browser engine', () => {
        for (const p of ['^Link Id [0-9]+ Added$', 'abc', 'a.*b'])
            assert.equal(safeRegex(p) === null, !!engine.normalizeChain({ version: 1, id: 'x', steps: [{ event: 'E', properties: { a: { operator: 'regex', values: [p] } } }] }), p)
        for (const p of ['(a+)+$', 'a*b*', '(?=x)', 'a{2}']) assert.notEqual(safeRegex(p), null, p)
    })
    test('every_time with one open step and every client warns', () => {
        const c = compileSurvey({ ...base, steps: [{ opens: 'DlgX' }], show: 'every_time' }, { reg })
        assert.ok(c.problems.some((p) => /very often/.test(p.text)))
        assert.equal(c.body.schedule, 'always')
    })
})

describe('views', () => {
    test('a saved survey reads back in words, and as a spec that compiles to the same chain', () => {
        const c = compileSurvey({ ...base, within_minutes: 5 }, { reg, chainId: 'hedge-2', clientIds: ['ACME'] })
        const saved = { id: '0190-aaaa-bbbb', created_at: '2026-11-10T00:00:00Z', start_date: null, end_date: null, ...c.body } as unknown as PostHogSurvey
        const v = viewOf(saved)
        assert.equal(v.status, 'draft')
        assert.deepEqual(v.clients, ['ACME'])
        assert.equal(v.within_minutes, 5)
        assert.equal(v.steps.length, 3)
        const again = compileSurvey({ ...(specOf(saved) as SurveySpec), questions: base.questions }, { reg, chainId: 'hedge-2', clientIds: ['ACME'] })
        assert.deepEqual(again.chain.steps, c.chain.steps)
    })
    test('steps read back in the app words, so labels survive a change', async () => {
        const { stepSpecOf } = await import('../src/core/surveys.ts')
        const steps = [{ opens: 'DlgA' }, { closes: 'DlgA' }, { button: 'Save', dialog: 'DlgA' }, { button: 'Run' }, { field: 'Trade Date', dialog: 'DlgB' }, { message: 'has been scheduled' }, { message_pattern: '^Link Id [0-9]+ Added$' }, { event: 'Custom', properties: { x: 'y' } }]
        const c = compileSurvey({ ...base, steps }, { reg })
        assert.deepEqual(c.chain.steps.map((st) => stepSpecOf(st, reg)), [...steps.slice(0, 7), { event: 'Custom', properties: { x: { operator: 'exact', values: ['y'] } } }])
    })
    test('surveys made in PostHog show their trigger events', () => {
        const v = viewOf({ id: 'x', name: 'n', type: 'popover', questions: [], conditions: { events: { values: [{ name: 'clicked' }] } }, appearance: null, start_date: '2026-01-01', end_date: null, created_at: '' })
        assert.equal(v.made_by_lens, false)
        assert.deepEqual(v.steps, ['Event clicked'])
        assert.equal(v.status, 'running')
    })
})

describe('the Surveys page', () => {
    test('only admins and people ticked for it, and its script parses', async () => {
        const { handleSurveys, surveysHtml } = await import('../src/service/surveyspage.ts')
        const { canUseSurveys } = await import('../src/service/access.ts')
        assert.equal(canUseSurveys({ role: 'admin' }), true)
        assert.equal(canUseSurveys({ role: 'download', surveys: false }), false)
        assert.equal(canUseSurveys({ role: 'none', surveys: true }), true)
        const sent: { status?: number; body?: string } = {}
        const res = { writeHead: (s: number) => (sent.status = s), end: (b: string) => (sent.body = b) } as never
        await handleSurveys({ method: 'GET' } as never, res, new URL('http://x/replays/surveys/api/list'), { email: 'a@b.c', role: 'watch', surveys: false } as never)
        assert.equal(sent.status, 403)
        const html = surveysHtml({ email: 'a@b.c', name: 'A', role: 'admin', posthog_admin: true, in_replay_project: true, session: 's' })
        const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
        assert.doesNotThrow(() => new Function(script))
        assert.match(script, /const BRAND="Survey by ION"/)
    })
})
