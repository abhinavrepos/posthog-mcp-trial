// Existing result, answer paging and cache coverage retained after removing the custom renderer.
import assert from 'node:assert/strict'
import {describe,test,type TestContext} from 'node:test'
import {config} from '../src/core/config.ts'
import {invalidateSurveyCache,type PostHogSurvey} from '../src/core/surveys.ts'

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
            assert.match(q.query, /timestamp > now\(\) - toIntervalDay\(\{days\}\)|timestamp >= \{history_from\} AND timestamp < \{history_to\}/)
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

// Colour check through MCP on a real PostHog (2026-11-18): every look was stored as asked; these three were not right.
