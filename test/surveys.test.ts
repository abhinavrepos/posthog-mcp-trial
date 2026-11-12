// Surveys made from Lens: the spec in the app's words → a PostHog survey whose chain the browser
// engine (deploy/posthog/survey-engine/engine.js) accepts and follows.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, test, type TestContext } from 'node:test'

import { parseAppEvents } from '../src/core/appevents.ts'
import { config } from '../src/core/config.ts'
import { compileSurvey, invalidateSurveyCache, contrast, safeRegex, specOf, viewOf, type PostHogSurvey, type SurveySpec } from '../src/core/surveys.ts'
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

describe('types, look and one survey at a time', () => {
    test('yes/no and thumbs compile to PostHog choices and ratings, and read back', async () => {
        const { kindOf } = await import('../src/core/surveys.ts')
        const c = compileSurvey({ ...base, questions: [{ type: 'yes_no', text: 'Did it work?' }, { type: 'thumbs', text: 'Good?' }, { type: 'yes_no', text: 'x', yes_label: 'Same', no_label: 'Same' }] }, { reg })
        const qs = c.body.questions as any[]
        assert.deepEqual([qs[0].type, qs[0].choices], ['single_choice', ['Yes', 'No']])
        assert.deepEqual([qs[1].type, qs[1].scale, qs[1].display], ['rating', 2, 'emoji'])
        assert.deepEqual(qs.slice(0, 2).map(kindOf), ['yes_no', 'thumbs'])
        assert.deepEqual(errors(c).map((p) => p.where), ['questions[2]'])
    })
    test('every look setting reaches PostHog, from a theme, and reads back', async () => {
        const { lookOf, THEMES } = await import('../src/core/surveys.ts')
        const c = compileSurvey({ ...base, look: { theme: 'dark', corner_radius: 8, shadow: 'none', padding: 'roomy', position: 'top_right', max_width: 400 } }, { reg })
        assert.deepEqual(errors(c), [])
        const a = c.body.appearance as Record<string, unknown>
        assert.equal(a.backgroundColor, THEMES.dark.background)
        assert.deepEqual([a.borderRadius, a.boxShadow, a.boxPadding, a.position, a.maxWidth, a.fontFamily], ['8px', 'none', '26px 28px', 'top_right', '400px', 'inherit'])
        assert.deepEqual(lookOf(a), { ...THEMES.dark, corner_radius: 8, shadow: 'none', padding: 'roomy', position: 'top_right', max_width: 400 })
        const bad = compileSurvey({ ...base, look: { background: 'linear-gradient(red, blue)', position: 'bottom' as any, corner_radius: 40 } }, { reg })
        assert.deepEqual(errors(bad).map((p) => p.where).sort(), ['look.background', 'look.corner_radius', 'look.position'])
    })
    test('chains are version 3, one at a time, with the sample the engine accepts', () => {
        const c = compileSurvey({ ...base, sample_percent: 33 }, { reg, clientIds: ['ACME'] })
        assert.equal(c.chain.version, 3)
        assert.equal(c.chain.maxPerUser, 2, 'SURVEYS_PER_USER defaults to 2')
        assert.equal(c.chain.audience?.sample, 33)
        const n = engine.normalizeChain(c.chain)
        assert.equal(n.limit, 2)
        assert.equal(n.audience.sample, 33)
        assert.ok(errors(compileSurvey({ ...base, sample_percent: 0 }, { reg })).length)
        assert.deepEqual(errors(compileSurvey({ ...base, days_between_surveys: 0 }, { reg })).map((p) => p.where), ['days_between_surveys'])
        assert.deepEqual([c.chain.gapHours, c.chain.quietDaysAfterClose, n.gapMs, n.quietMs], [24, 7, 24 * 3600000, 7 * 86400000])
    })
    test('queue alert: users already in two running surveys wait, and are told to come back later', async () => {
        const { conflictsFor, queueAlert } = await import('../src/core/surveys.ts')
        const running = (id: string, start: string, clients?: string[], sample?: number) => {
            const ch = compileSurvey({ ...base, name: id, ...(sample ? { sample_percent: sample } : {}) }, { reg, chainId: id, clientIds: clients ?? [] }).chain
            return { id, name: id, start_date: start, end_date: null, conditions: { lensChain: ch } } as unknown as PostHogSurvey
        }
        const list = [running('a', '2026-11-01T00:00:00Z', ['ACME']), running('b', '2026-11-02T00:00:00Z', ['ACME', 'BETA']), running('c', '2026-11-03T00:00:00Z', ['BETA'], 33), running('z', '2026-11-04T00:00:00Z', ['ZED'])]
        const mine = compileSurvey(base, { reg, chainId: 'new', clientIds: ['ACME', 'BETA', 'GAMMA'] }).chain
        const cs = conflictsFor(mine, {}, list)
        assert.deepEqual(cs.map((c) => c.survey_id), ['a', 'b', 'c'])
        const q = queueAlert(mine, cs)
        assert.equal(q.level, 'queued')
        assert.deepEqual([q.queued, q.some_wait], [['acme'], ['beta']])
        assert.match(q.alert, /⚠ Queued for ACME: their users are already taking part in 2 running surveys \("a", "b"\).*later/)
        assert.match(q.alert, /Some users of BETA may have to wait/)
        assert.match(q.alert, /at least 24 hours between any two surveys.*7 days/)
        const acmeOnly = compileSurvey(base, { reg, chainId: 'n2', clientIds: ['ACME'] }).chain
        assert.equal(queueAlert(acmeOnly, conflictsFor(acmeOnly, {}, list)).level, 'all_queued')
        const gamma = compileSurvey(base, { reg, chainId: 'n3', clientIds: ['GAMMA'] }).chain
        assert.equal(queueAlert(gamma, conflictsFor(gamma, {}, list)).level, 'clear')
        // One other survey is under the limit of two, but still a formal survey-fatigue notice.
        const zed = compileSurvey(base, { reg, chainId: 'n4', clientIds: ['ZED'] }).chain
        const qz = queueAlert(zed, conflictsFor(zed, {}, list))
        assert.equal(qz.level, 'overlap')
        assert.match(qz.alert, /^⚠ Survey fatigue: users of ZED are already taking part in another running survey \("z"\)\. Asking the same people/)
        // b was launched after a: only a counts for b.
        assert.deepEqual(conflictsFor(list[1].conditions!.lensChain!, list[1], list).map((c) => c.survey_id), ['a'])
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
    test('survey roles decide who sees and who launches, and the script parses', async () => {
        const { handleSurveys, surveysHtml } = await import('../src/service/surveyspage.ts')
        const { canUseSurveys } = await import('../src/service/access.ts')
        assert.equal(canUseSurveys({ role: 'admin' }), true)
        assert.equal(canUseSurveys({ role: 'download', surveys: 'none' }), false)
        assert.equal(canUseSurveys({ role: 'none', surveys: 'view' }), true)
        const call = async (method: string, path: string, surveys: string) => {
            const sent: { status?: number; body?: string } = {}
            const res = { writeHead: (s: number) => (sent.status = s), end: (b: string) => (sent.body = b) } as never
            await handleSurveys({ method } as never, res, new URL('http://x' + path), { email: 'a@b.c', role: 'watch', surveys } as never)
            return sent
        }
        assert.equal((await call('GET', '/replays/surveys/api/list', 'none')).status, 403)
        // Seeing results is not launching: a view or edit role cannot launch, stop or archive.
        for (const role of ['view', 'edit']) {
            const r = await call('POST', '/replays/surveys/api/survey/01a1c6d6-8086-0000-b54b-4feed4e4f2b0/launch', role)
            if (r.status !== 503) assert.match(String(r.body), /launch and stop surveys/)
        }
        const html = surveysHtml({ email: 'a@b.c', name: 'A', role: 'admin', posthog_admin: true, in_replay_project: true, session: 's' })
        const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
        for (const match of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(match[1]))
        assert.match(script, /const BRAND="Survey by ION"/)
    })
})


type SurveyQuery = { query: string; values: Record<string, unknown> }
const resultSurvey = {
    id: '01a1c6d6-8086-0000-b54b-4feed4e4f2b0', name: 'Results', type: 'popover',
    created_at: '2026-11-01T00:00:00Z', start_date: null, end_date: null,
    questions: [
        { id: 'nps', question: 'Recommend?', type: 'rating', scale: 10 },
        { id: 'thumb', question: 'Good?', type: 'rating', scale: 2, display: 'emoji' },
        { id: 'choice', question: 'Worked?', type: 'single_choice', choices: ['Yes', 'No'] },
        { id: 'multi', question: 'Which?', type: 'multiple_choice', choices: ['A', 'B'] },
        { id: 'written', question: "Why? ' quoted", type: 'open' },
        { question: 'Old question', type: 'open' },
    ],
} as PostHogSurvey
const queryResponse = (rows: Record<string, unknown>[]) => {
    const columns = [...new Set(rows.flatMap(Object.keys))]
    return new Response(JSON.stringify({ columns, results: rows.map((r) => columns.map((c) => r[c])) }))
}
function mockResults(t: TestContext, reply: (q: SurveyQuery) => Record<string, unknown>[], survey = resultSurvey) {
    invalidateSurveyCache()
    t.after(invalidateSurveyCache)
    const saved = { ...config.posthog }, enabled = config.surveys.enabled
    Object.assign(config.posthog, { projectId: '1', personalApiKey: 'read-test', surveyApiKey: 'survey-test' })
    config.surveys.enabled = true
    t.after(() => { Object.assign(config.posthog, saved); config.surveys.enabled = enabled })
    const seen: SurveyQuery[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (!init?.body) return new Response(JSON.stringify(survey))
        const q = JSON.parse(String(init.body)).query as SurveyQuery
        seen.push(q)
        return queryResponse(reply(q))
    })
    return seen
}

describe('survey results without submission sampling', () => {
    test('all-submission aggregates feed ratings, NPS, choices and written totals; clients exceed 100', async (t) => {
        const seen = mockResults(t, ({ query, values }) => {
            if (query.includes('GROUP BY event')) return [{ event: 'survey sent', n: 12000 }, { event: 'survey shown', n: 15000 }]
            if (query.includes('GROUP BY client')) return Array.from({ length: 125 }, (_, i) => ({ client: String(i), shown: 100, answered: 80, dismissed: 1 }))
            if (query.includes('GROUP BY day')) return []
            if (query.includes('numeric_answers')) return [{ r0_answers: 12000, r0_numeric_answers: 12000, r0_average: 8.126, r0_promoters: 8000, r0_detractors: 3000, r0_bin_0: 10, r0_bin_9: 5000, r0_bin_10: 3000,
                r1_answers: 12000, r1_numeric_answers: 12000, r1_bin_1: 10000, r1_bin_2: 2000 }]
            if (query.includes('GROUP BY label')) return values.key0 === '$survey_response_choice' ? [{ label: 'Yes', n: 9000 }, { label: 'No', n: 3000 }] : [{ label: 'A', n: 10000 }, { label: 'B', n: 8000 }]
            if (query.startsWith('SELECT count() AS answers')) return [{ answers: 12000 }]
            if (query.startsWith('SELECT count() AS total')) return [{ total: 9000 }]
            return [{ text: 'Long answer ' + 'x'.repeat(2500), client: 'ACME', at: '2026-11-10', submission: 's1', total: 9000 }]
        })
        const { surveyResults } = await import('../src/core/surveys.ts')
        const r = await surveyResults(resultSurvey.id)
        assert.equal(r.answered, 12000)
        assert.equal(r.response_rate, 80)
        assert.equal(r.questions[0].answers, 12000)
        assert.equal(r.questions[0].average, 8.13)
        assert.deepEqual(r.questions[0].nps, { score: 42, promoters: 8000, passives: 1000, detractors: 3000 })
        assert.equal(r.questions[0].distribution?.['10'], 3000)
        assert.deepEqual(r.questions[1].distribution, { 'Thumbs up': 10000, 'Thumbs down': 2000 })
        assert.deepEqual(r.questions[2].distribution, { Yes: 9000, No: 3000 })
        assert.deepEqual(r.questions[3].distribution, { A: 10000, B: 8000 })
        assert.equal(r.questions[4].answers, 9000)
        assert.equal(r.questions[4].recent?.[0].text.length, 2000, 'old preview stays bounded')
        assert.equal(r.by_client.length, 125)
        assert.equal(r.by_client_truncated, false)
        for (const q of seen.filter((q) => q.query.includes('AS answer_raw'))) {
            assert.match(q.query, /GROUP BY submission/)
            assert.match(q.query, /coalesce\(nullIf\(toString\(properties.\$survey_submission_id\)/)
            assert.match(q.query, /tupleElement\(argMax\(tuple\(coalesce\(/)
            assert.match(q.query, /tuple\(timestamp, uuid\)\), 1\) AS answer_raw/)
            assert.match(q.query, /JSONExtractRaw\(properties, \{key0\}\)/)
            assert.match(q.query, /arrayFirst\(x -> JSONExtractString\(x, 'question'\) = \{question_text\}/)
            assert.match(q.query, /'null'\), '\"\"'/)
            assert.doesNotMatch(q.query, /GROUP BY submission[^]*LIMIT 5000/)
            assert.ok(!q.query.includes("Why? ' quoted"), 'question text is bound')
        }
        assert.ok(seen.some((q) => q.values.key0 === '$survey_response_written' && q.values.key1 === '$survey_response_4'))
        assert.ok(seen.some((q) => q.values.key0 === '$survey_response_5' && q.values.key1 === undefined))
        assert.ok(seen.some((q) => q.values.limit === 31))
        const ratings = seen.filter((q) => q.query.includes('numeric_answers'))
        assert.equal(ratings.length, 1, 'rating questions share one scan')
        assert.equal(ratings[0].values.r0_key0, '$survey_response_nps')
        assert.equal(ratings[0].values.r1_key0, '$survey_response_thumb')
        assert.match(ratings[0].query, /argMax\(tuple\(coalesce\(/)
        for (const q of seen) {
            assert.match(q.query, /LIMIT/)
            assert.match(q.query, /timestamp > now\(\) - toIntervalDay\(\{days\}\)/)
            assert.doesNotMatch(q.query, /OFFSET/)
        }
    })

    test('other choice labels are paged as aggregates and client truncation is explicit', async (t) => {
        const seen = mockResults(t, ({ query, values }) => {
            if (query.includes('GROUP BY client')) return Array.from({ length: 5001 }, (_, i) => ({ client: String(i), shown: 1, answered: 1, dismissed: 0 }))
            if (query.includes('GROUP BY label')) return values.after === undefined ? Array.from({ length: 1000 }, (_, i) => ({ label: 'Other ' + i, n: 6 })) : [{ label: 'Last', n: 7 }]
            if (query.startsWith('SELECT count() AS answers')) return [{ answers: 6007 }]
            return []
        }, { ...resultSurvey, questions: [resultSurvey.questions[2]] })
        const { surveyResults } = await import('../src/core/surveys.ts')
        const r = await surveyResults(resultSurvey.id)
        assert.equal(r.questions[0].distribution?.Last, 7)
        assert.equal(r.questions[0].answers, 6007)
        assert.deepEqual(seen.filter((q) => q.query.includes('GROUP BY label')).map((q) => q.values.after), [undefined, 'Other 999'])
        for (const q of seen) assert.doesNotMatch(q.query, /OFFSET/, 'PostHog refuses OFFSET on API-key queries')
        assert.equal(r.by_client.length, 5000)
        assert.equal(r.by_client_truncated, true)
        assert.ok(seen.some((q) => /LIMIT 5001/.test(q.query)))
    })

    test('empty results keep zero bins and omit undefined averages and NPS', async (t) => {
        mockResults(t, ({ query }) => query.includes('numeric_answers') ? [{ answers: 0, numeric_answers: 0, average: null, promoters: 0, detractors: 0 }] : [])
        const { surveyResults } = await import('../src/core/surveys.ts')
        const r = await surveyResults(resultSurvey.id)
        assert.equal(r.response_rate, null)
        assert.equal(r.questions[0].average, undefined)
        assert.equal(r.questions[0].nps, undefined)
        assert.equal(r.questions[0].distribution?.['0'], 0)
        assert.equal(r.questions[0].distribution?.['10'], 0)
        assert.deepEqual(r.questions[2].distribution, { Yes: 0, No: 0 })
        assert.deepEqual(r.questions[4].recent, [])
        assert.equal(r.questions[4].answers, 0)
    })

    test('written pages return full text, stable ordering, totals and safe bounds, including old question ids', async (t) => {
        const full = 'x'.repeat(3000)
        const seen = mockResults(t, ({ query, values }) => {
            if (query.startsWith('SELECT count()')) return [{ total: 15000 }]
            const rows = Array.from({ length: Number(values.limit) }, (_, i) => ({ text: full, client: 'ACME', at: '2026-11-10T10:00:00.00' + i + 'Z', submission: 's' + i, total: 15000 }))
            return query.startsWith('SELECT value AS text') ? rows.reverse() : rows
        })
        const { surveyAnswers } = await import('../src/core/surveys.ts')
        const r = await surveyAnswers(resultSurvey.id, 'written', undefined, 900, 180)
        assert.equal(r.total, 15000)
        assert.equal(r.answers.length, 200, 'limit capped at 200')
        assert.deepEqual(r.answers[0], { text: full, client: 'ACME', at: '2026-11-10T10:00:00.000Z' })
        const page = seen.find((q) => q.query.includes('LIMIT {limit}'))!
        assert.equal(page.values.limit, 201, 'one extra row tells whether there is a next page')
        assert.equal(page.values.days, 180)
        assert.match(page.query, /ORDER BY last_at DESC, submission DESC LIMIT \{limit\}$/)
        assert.doesNotMatch(page.query, /OFFSET/)
        assert.match(page.query, /^SELECT last_at AS at, submission, total/)
        assert.match(page.query, /count\(\) OVER \(\) AS total/)
        assert.match(page.query, /argMax\(tuple\(isNotNull\(/)
        assert.doesNotMatch(page.query, /AS answer_raw|AS client|SELECT value AS text/)
        assert.match(page.query, /tuple\(timestamp, uuid\)\), 1\) AS answer_present/)
        const fetchPage = seen.find((q) => q.query.startsWith('SELECT value AS text'))!
        assert.doesNotMatch(fetchPage.query, /ORDER BY/)
        assert.match(fetchPage.query, /IN \{submissions\}/)
        assert.equal((fetchPage.values.submissions as string[]).length, 200)
        assert.match(page.query, /WHERE answer_present/)
        assert.ok(r.next, 'a next cursor when more rows exist')
        await surveyAnswers(resultSurvey.id, 'written', r.next, 50)
        const second = seen.filter((q) => q.query.startsWith('SELECT last_at AS at')).at(-1)!
        assert.equal(second.values.after_sub, 's199')
        assert.equal(second.values.after_at, '2026-11-10T10:00:00.00199Z'.replace('00199', '00199'))
        assert.match(second.query, /last_at < toDateTime64\(\{after_at\}, 6, 'UTC'\) OR \(last_at = toDateTime64\(\{after_at\}, 6, 'UTC'\) AND submission < \{after_sub\}\)/)
        await surveyAnswers(resultSurvey.id, '5', 'not-a-cursor', NaN)
        assert.equal(seen.at(-1)?.values.after_at, undefined, 'a bad cursor starts from the newest')
        assert.equal(seen.filter((q) => q.query.startsWith('SELECT last_at AS at')).at(-1)?.values.limit, 51)
        const before = seen.length
        await assert.rejects(surveyAnswers(resultSurvey.id, 'unknown'), /Question not found/)
        assert.equal(seen.length, before, 'invalid question does not query events')
    })

    test('answer endpoint uses the detail view roles, validates questions, and forwards paging', async (t) => {
        const seen = mockResults(t, ({ query }) => query.startsWith('SELECT count()') ? [{ total: 100 }] : [])
        const { handleSurveys } = await import('../src/service/surveyspage.ts')
        const call = async (surveys: string, suffix: string, method = 'GET') => {
            let status = 0, body = ''
            const res = { writeHead(s: number) { status = s }, end(b: string) { body = b } } as never
            await handleSurveys({ method } as never, res, new URL('http://x/replays/surveys/api/survey/' + resultSurvey.id + '/answers' + suffix), { email: 'a@b.c', role: 'watch', surveys } as never)
            return { status, body: JSON.parse(body) }
        }
        assert.equal((await call('none', '?question=written')).status, 403)
        assert.equal(seen.length, 0)
        for (const role of ['view', 'edit', 'launch']) {
            const r = await call(role, '?question=written&limit=50&days=20')
            assert.equal(r.status, 200)
            assert.deepEqual(r.body, { total: 100, answers: [] })
        }
        assert.ok(seen.some((q) => q.values.limit === 51 && q.values.days === 20))
        assert.equal((await call('view', '')).status, 400)
        assert.equal((await call('view', '?question=unknown')).status, 400)
        assert.equal((await call('launch', '?question=written', 'POST')).status, 404)
    })
})


test('written answer UI fetches successive server pages, keeps the shared pager, and retries failures', async () => {
    const { surveysHtml } = await import('../src/service/surveyspage.ts')
    const html = surveysHtml({ email: 'a@b.c', role: 'admin' } as never)
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'))
    const start = script.indexOf('    if(q.recent){')
    const end = script.indexOf('\n  })', start)
    const run = new Function('$', 'makePager', 'api', 'q', 'i', 'id', 'esc', 'num', 'period', 'when', script.slice(start, end))
    type Element = { innerHTML?: string; textContent?: string; disabled?: boolean; hidden?: boolean; onclick?: () => Promise<void> }
    const elements: Record<string, Element> = Object.fromEntries(['answers-0', 'answers-pager-0', 'answers-status-0', 'answers-more-0'].map((id) => [id, {}]))
    const urls: URL[] = [], batches: unknown[][] = []
    let fail = false
    run((id: string) => elements[id], (opts: { draw: (items: unknown[]) => void }) => ({ set(items: unknown[], keep: boolean) { assert.equal(keep, true); batches.push(items); opts.draw(items.slice(0, 25)) } }), async (path: string) => {
        const url = new URL(path, 'http://x');urls.push(url)
        if (fail) throw new Error('Unavailable')
        const after = url.searchParams.get('after')
        return { answers: Array.from({ length: after ? 10 : 50 }, (_, i) => ({ text: '<answer ' + ((after ? 50 : 0) + i) + '>', client: 'ACME', at: '2026-11-10' })), total: 60, ...(after ? {} : { next: 'cursor-1' }) }
    }, { id: 'written', recent: [] }, 0, resultSurvey.id, (s: string) => s.replaceAll('<', '&lt;'), String, '30', (t: string) => new Date(t).toISOString())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(urls[0].searchParams.get('after'), null)
    assert.equal(urls[0].searchParams.get('limit'), '50')
    assert.equal(urls[0].searchParams.get('days'), '30')
    assert.equal(urls[0].searchParams.get('question'), 'written')
    assert.equal(batches[0].length, 50)
    assert.match(elements['answers-0'].innerHTML!, /&lt;answer/)
    assert.equal(elements['answers-more-0'].hidden, false)
    fail = true
    await elements['answers-more-0'].onclick!()
    assert.match(elements['answers-status-0'].textContent!, /Unavailable.*Try again/)
    assert.equal(elements['answers-more-0'].disabled, false)
    fail = false
    await elements['answers-more-0'].onclick!()
    assert.equal(urls.at(-1)?.searchParams.get('after'), 'cursor-1', 'failed page did not advance')
    assert.equal(batches.at(-1)?.length, 60)
    assert.equal(elements['answers-more-0'].hidden, true)
    assert.equal(elements['answers-status-0'].textContent, '')
})

describe('shared survey read caches', () => {
    test('identical detail calls share a flight and warm calls issue no API or HogQL requests', async (t) => {
        const seen = mockResults(t, () => [], { ...resultSurvey, questions: [] })
        const { surveyResults } = await import('../src/core/surveys.ts')
        const results = await Promise.all(Array.from({ length: 20 }, () => surveyResults(resultSurvey.id)))
        assert.equal(seen.length, 3)
        results[0].survey.name = 'mutated by caller'
        assert.equal(results[1].survey.name, 'Results', 'callers own their result objects')
        assert.equal((await surveyResults(resultSurvey.id)).survey.name, 'Results')
        assert.equal(seen.length, 3)
        await surveyResults(resultSurvey.id, 14)
        assert.equal(seen.length, 6, 'different date windows have different cache keys')
    })

    test('metadata list paging is single-flight and expires after 30 seconds', async (t) => {
        mockResults(t, () => [])
        let calls = 0, now = Date.now()
        t.mock.method(Date, 'now', () => now)
        t.mock.method(globalThis, 'fetch', async (url: unknown) => {
            calls++
            const second = String(url).includes('cursor=next')
            return Response.json({ results: [{ ...resultSurvey, id: second ? 'next' : resultSurvey.id }], next: second ? null : 'http://posthog/api/surveys/?cursor=next' })
        })
        const { listSurveys } = await import('../src/core/surveys.ts')
        const lists = await Promise.all(Array.from({ length: 10 }, () => listSurveys()))
        assert.equal(calls, 2)
        assert.equal(lists[0].length, 2)
        lists[0][0].name = 'caller mutation'
        assert.equal((await listSurveys())[0].name, 'Results')
        assert.equal(calls, 2)
        now += 30_001
        await listSurveys()
        assert.equal(calls, 4)
    })

    test('overview uses one bounded count query for all surveys and never caches invented zeros on failure', async (t) => {
        mockResults(t, () => [])
        let gets = 0, queries = 0, fail = true
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
            if (!init?.body) { gets++; return Response.json({ results: [resultSurvey, { ...resultSurvey, id: 'another' }], next: null }) }
            queries++
            const q = JSON.parse(String(init.body)).query as SurveyQuery
            assert.match(q.query, /GROUP BY id LIMIT \{limit\}/)
            assert.match(q.query, /event IN \('survey shown', 'survey sent', 'survey dismissed'\)/)
            assert.equal(q.values.days, 30)
            assert.equal(q.values.limit, 2)
            if (fail) return new Response('unavailable', { status: 400 })
            return queryResponse([{ id: resultSurvey.id, shown: 7, answered: 3, dismissed: 1 }])
        })
        const { surveyOverview } = await import('../src/core/surveys.ts')
        await assert.rejects(surveyOverview(), /400/)
        fail = false
        const lists = await Promise.all([surveyOverview(), surveyOverview(30)])
        assert.equal(gets, 1)
        assert.equal(queries, 2)
        assert.deepEqual([lists[0][0].shown, lists[0][0].answered, lists[0][0].dismissed], [7, 3, 1])
        await surveyOverview()
        assert.equal(queries, 2)
    })

    test('expired analytics return marked stale immediately, refresh once, and expire after five minutes', async (t) => {
        const seen = mockResults(t, () => [], { ...resultSurvey, questions: [] })
        let now = Date.now()
        t.mock.method(Date, 'now', () => now)
        const { surveyResults } = await import('../src/core/surveys.ts')
        await surveyResults(resultSurvey.id)
        const original = now
        now += 60_001
        let release!: () => void, entered!: () => void
        const started = new Promise<void>((resolve) => { entered = resolve })
        const wait = new Promise<void>((resolve) => { release = resolve })
        let calls = 0
        t.mock.method(globalThis, 'fetch', async () => { calls++; entered(); await wait; return new Response('unavailable', { status: 503 }) })
        const reads = await Promise.all(Array.from({ length: 10 }, () => surveyResults(resultSurvey.id)))
        assert.deepEqual(reads[0].freshness, { stale: true, cached_at: new Date(original).toISOString() })
        await started
        assert.equal(calls, 1)
        release()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal((await surveyResults(resultSurvey.id)).freshness?.stale, true)
        assert.equal(calls, 1, 'failed refresh has a cooldown')
        assert.equal(seen.length, 3)
        now = original + 300_001
        await assert.rejects(surveyResults(resultSurvey.id), /503/, 'ancient data is not returned')
        assert.equal(calls, 2)
    })

    test('writes invalidate metadata, results, answers, and in-flight cache fills', async (t) => {
        mockResults(t, () => [])
        let gets = 0, patches = 0, queries = 0, state = { ...resultSurvey, questions: [], start_date: null } as PostHogSurvey
        let release!: () => void, entered!: () => void, block = false
        const started = new Promise<void>((resolve) => { entered = resolve })
        const wait = new Promise<void>((resolve) => { release = resolve })
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
            if (init?.method === 'PATCH') { patches++; state = { ...state, ...JSON.parse(String(init.body)) }; return Response.json(state) }
            if (init?.body) { queries++; return queryResponse([]) }
            gets++
            const snapshot = structuredClone(state)
            if (block) { block = false; entered(); await wait }
            return Response.json(snapshot)
        })
        const { getSurvey, launchSurvey, stopSurvey, archiveSurvey, surveyResults } = await import('../src/core/surveys.ts')
        await surveyResults(state.id)
        assert.equal(queries, 3)
        assert.equal((await launchSurvey(state.id)).start_date !== null, true)
        assert.equal(patches, 1)
        assert.equal((await getSurvey(state.id)).start_date !== null, true)
        await surveyResults(state.id)
        assert.equal(queries, 6)
        await stopSurvey(state.id)
        assert.ok((await getSurvey(state.id)).end_date)
        await archiveSurvey(state.id)
        assert.equal((await getSurvey(state.id)).archived, true)
        assert.equal(patches, 3)
        invalidateSurveyCache()
        block = true
        const oldRead = getSurvey(state.id)
        await started
        await archiveSurvey(state.id)
        release()
        await oldRead
        const before = gets
        await getSurvey(state.id)
        assert.equal(gets, before + 1, 'a read started before a write cannot fill the new cache')
    })

    test('scope, feature switch, and LRU eviction prevent inappropriate reuse', async (t) => {
        mockResults(t, () => [])
        let gets = 0
        t.mock.method(globalThis, 'fetch', async () => { gets++; return Response.json(resultSurvey) })
        const { getSurvey } = await import('../src/core/surveys.ts')
        await getSurvey(resultSurvey.id)
        config.posthog.projectId = '2'
        await getSurvey(resultSurvey.id)
        assert.equal(gets, 2)
        config.surveys.enabled = false
        await assert.rejects(getSurvey(resultSurvey.id), /switched off/)
        config.surveys.enabled = true
        for (let i = 0; i < 129; i++) await getSurvey(i.toString(16).padStart(8, '0'))
        const before = gets
        await getSurvey(resultSurvey.id)
        assert.equal(gets, before + 1, 'bounded entry count evicts the least recently used metadata')
    })

    test('answer caches normalize limits/cursors and background refresh replaces stale results', async (t) => {
        const seen = mockResults(t, ({ query, values }) => query.startsWith('SELECT count()') ? [{ total: 0 }] :
            Array.from({ length: Number(values.limit) || 0 }, (_, i) => ({ text: 'Answer', at: '2026-11-10', submission: 's' + i, total: 500, client: 'ACME' })))
        let now = Date.now()
        t.mock.method(Date, 'now', () => now)
        const { surveyAnswers } = await import('../src/core/surveys.ts')
        const first = await surveyAnswers(resultSurvey.id, 'written', 'bad', 999)
        await surveyAnswers(resultSurvey.id, 'written', undefined, 200)
        assert.equal(seen.length, 2, 'normalized cursors/limits share a cache entry')
        assert.equal(first.total, 500)
        now += 60_001
        const stale = await surveyAnswers(resultSurvey.id, 'written', undefined, 200)
        assert.equal(stale.freshness?.stale, true)
        await new Promise((resolve) => setImmediate(resolve))
        const fresh = await surveyAnswers(resultSurvey.id, 'written', undefined, 200)
        assert.equal(fresh.freshness, undefined)
        assert.equal(seen.length, 4)
    })

    test('byte budget evicts large entries even below the entry-count limit', async (t) => {
        mockResults(t, () => [])
        let gets = 0
        t.mock.method(globalThis, 'fetch', async () => { gets++; return Response.json({ ...resultSurvey, description: 'x'.repeat(1_100_000) }) })
        const { getSurvey } = await import('../src/core/surveys.ts')
        for (let i = 0; i < 9; i++) await getSurvey(i.toString(16).padStart(8, '0'))
        const before = gets
        await getSurvey('00000000')
        assert.equal(gets, before + 1)
    })

    test('different surveys never run HogQL concurrently and errors release the query queue', async (t) => {
        mockResults(t, () => [], { ...resultSurvey, questions: [] })
        let active = 0, peak = 0, queries = 0
        t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
            if (!init?.body) return Response.json({ ...resultSurvey, questions: [] })
            active++; peak = Math.max(peak, active); queries++
            await new Promise((resolve) => setImmediate(resolve))
            active--
            return queries === 1 ? new Response('bad query', { status: 400 }) : queryResponse([])
        })
        const { surveyResults } = await import('../src/core/surveys.ts')
        const results = await Promise.allSettled([surveyResults(resultSurvey.id), surveyResults('abcdef12')])
        assert.equal(results[0].status, 'rejected')
        assert.equal(results[1].status, 'fulfilled')
        assert.equal(peak, 1)
    })
})
