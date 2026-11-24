import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test, type TestContext } from 'node:test'

// The production survey that showed to no one (2026-11): Reval's client is part of the user id
// (ENV|SITE|CLIENT|USER) and never on its events, so with the default CLIENT_FROM_DISTINCT_ID=0 a survey limited to
// clients read `client_id` from events and matched nobody; and a report's "opens" step used the dialog's name
// instead of the menu id the report opens under. Both must now be visible before launch, as warnings, while the
// survey, the engine and every existing behaviour stay as they were.
process.env.TRIAGE_ENV_FILE = '/tmp/lens-resilience-surveys-absent.env'
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { config } = await import('../src/core/config.ts')
const { appEvents } = await import('../src/core/appevents.ts')
const { compileSurvey, invalidateSurveyCache } = await import('../src/core/surveys.ts')
const { surveyEvidence, similarity, foundMismatch } = await import('../src/core/surveychecks.ts')
const { resetPosthogBreaker } = await import('../src/core/posthog.ts')
const engine = createRequire(import.meta.url)('../deploy/posthog/survey-engine/engine.js')
const reg = appEvents()!

// A stand-in for Reval's last 30 days in PostHog. Only the facts the checks read.
const store = {
    events: 120_000,
    clientProperty: 0, // events carrying client_id: Reval sends none
    idParts: 120_000, // user ids with at least the asked-for number of parts
    chosenClients: 900,
    opened: [
        { id: 'LinkListReqv', name: 'Hedge Designation', opens: 40, closes: 38, n: 90 },
        { id: 'DlgDetailIRSwap', name: 'IR Swap', opens: 300, closes: 290, n: 700 },
        { id: 'DlgList', name: 'UNKNOWN', opens: 50, closes: 50, n: 100 },
    ],
    workedIn: ['DlgHedgeDesigListReport', 'DlgDetailIRSwap'],
    buttons: [['Save', 900], ['Run', 400], ['Save As', 30], ['Export', 20]] as [string, number][],
    fields: ['Trade Date', 'Notional'],
    eventNames: ['PageView', 'Event', 'ReportScheduled'],
}
type Q = { query: string; values: Record<string, unknown> }
const seen: Q[] = []
function answer(query: string, values: Record<string, unknown> = {}): Record<string, unknown>[] {
    seen.push({ query, values })
    if (query.includes('AS carried')) return [{ n: store.events, carried: query.includes('properties.client_id') ? store.clientProperty : store.idParts, chosen: store.chosenClients }]
    if (query.includes('GROUP BY id, name')) return store.opened
    if (query.includes('IN {ids} GROUP BY id')) return store.workedIn.filter((d) => (values.ids as string[]).includes(d)).map((id) => ({ id, n: 10 }))
    if (query.includes('properties.action_name) AS v')) return store.buttons.map(([v, n]) => ({ v, n }))
    if (query.includes('properties.action) AS v')) return store.fields.filter((f) => (values.list as string[]).includes(f.toLowerCase())).map((v) => ({ v, n: 5 }))
    if (query.startsWith('SELECT event AS v')) return store.eventNames.filter((e) => (values.list as string[]).includes(e.toLowerCase())).map((v) => ({ v, n: 5 }))
    if (query.startsWith('SELECT count() AS n FROM events')) return [{ n: store.events }]
    return []
}
const query = async (q: string, v?: Record<string, unknown>) => answer(q, v)
const chainOf = (steps: object[], clientIds: string[] = [], extra = {}) => compileSurvey({ name: 'Drill', questions: [{ type: 'rating', text: 'How was it?' }], steps, ...extra } as never, { reg, clientIds, chainId: 'drill-1' })

test('a report "opens" step with the dialog name, or the title, is flagged with the menu id it really opens under', async () => {
    const byName = await surveyEvidence(chainOf([{ opens: 'DlgHedgeDesigListReport' }]).chain, { reg, query })
    assert.equal(byName.length, 1)
    assert.equal(byName[0].level, 'warning'); assert.equal(byName[0].where, 'steps[0]')
    assert.match(byName[0].text, /^Nobody opened a dialog with the id "DlgHedgeDesigListReport" in the last 30 days, although people work in it, so this step would never match\. Reports and some lists open under their menu id/)
    assert.match(byName[0].text, /Did you mean: LinkListReqv \("Hedge Designation"\)/)
    const byTitle = await surveyEvidence(chainOf([{ opens: 'Hedge Designation' }]).chain, { reg, query })
    assert.match(byTitle[0].text, /Steps need the dialog id \(dialog_id\), not its title.*Did you mean: LinkListReqv \("Hedge Designation"\)/)
    assert.ok(foundMismatch(byTitle))
})

test('buttons, fields, dialogs and events nobody used are flagged with close matches; exact ones pass', async () => {
    const c = chainOf([{ opens: 'DlgDetailIRSwap' }, { button: 'save', dialog: 'DlgDetailIRSwp' }, { field: 'Trade date' }, { event: 'reportScheduled' }], [], { reset_on: [{ closes: 'DlgDetailIRSwap' }] })
    const p = await surveyEvidence(c.chain, { reg, query })
    const at = (where: string) => p.filter((x) => x.where === where).map((x) => x.text)
    assert.deepEqual(at('steps[0]'), [], 'an id that is opened passes')
    assert.deepEqual(at('reset_on[0]'), [], 'an id that is closed passes')
    assert.match(at('steps[1]').join('\n'), /Nobody pressed a button labelled "save" .*including case.*Did you mean: "Save"/)
    assert.match(at('steps[1]').join('\n'), /No events in a dialog with the id "DlgDetailIRSwp" .*Did you mean: DlgDetailIRSwap \("IR Swap"\)/)
    assert.match(at('steps[2]')[0], /Nobody used a field labelled "Trade date" .*Did you mean: "Trade Date"\?$/)
    assert.match(at('steps[3]')[0], /No "reportScheduled" events arrived .*Did you mean: "ReportScheduled"\?$/)
    const good = await surveyEvidence(chainOf([{ opens: 'LinkListReqv' }, { button: 'Run', dialog: 'LinkListReqv' }, { field: 'Notional' }, { message: 'has been scheduled' }]).chain, { reg, query })
    assert.deepEqual(good, [])
    assert.equal(similarity('Save', 'save'), 1)
})

test('message texts and typed values are never read for suggestions', async () => {
    seen.length = 0
    await surveyEvidence(chainOf([{ button: 'Svae' }, { field: 'Trade dat' }]).chain, { reg, query })
    const buttons = seen.find((q) => q.query.includes('properties.action_name) AS v'))!
    assert.match(buttons.query, /NOT IN \{msg\}/); assert.deepEqual(buttons.values.msg, ['messagebox', 'toast'])
    const fields = seen.find((q) => q.query.includes('properties.action) AS v'))!
    assert.match(fields.query, /lower\(toString\(properties\.action\)\) IN \{list\}/, 'only the labels asked for')
})

test('a client audience read from an event property the events never carry says so, with CLIENT_FROM_DISTINCT_ID from distinctIdParts', async () => {
    assert.equal(config.properties.clientFromDistinctId, 0, 'the default')
    const c = chainOf([{ opens: 'LinkListReqv' }], ['ACME'])
    assert.deepEqual(c.chain.audience, { clients: ['ACME'], eventProperty: 'client_id' }, 'the audience the engine gets is unchanged')
    const p = await surveyEvidence(c.chain, { reg, query })
    assert.equal(p.length, 1)
    assert.equal(p[0].where, 'clients'); assert.equal(p[0].level, 'warning')
    assert.equal(p[0].text, `The audience reads the client from the event property "client_id", but none of Reval's 120,000 events in the last 30 days carry it, so this survey would show to no one. Reval's user ids carry the client as part 3 (ENV|01|{client}|{user}): a Lens administrator should set CLIENT_FROM_DISTINCT_ID=3 in Lens's settings, then save this survey again so it reads the client from there.`)
    // And it is true: the engine never shows this chain to an ACME user whose events lack client_id.
    const m = engine.createMachine()
    m.setSurveys([{ start_date: 'x', end_date: null, conditions: c.body.conditions }])
    assert.deepEqual(m.consume({ event: 'PageView', properties: { dialog_id: 'LinkListReqv', action: 'OPEN' } }, 1, 'PROD|01|ACME|ann'), [])
    // The same survey with the client read from the user id passes the check, and the engine shows it.
    const old = config.properties.clientFromDistinctId
    config.properties.clientFromDistinctId = 3
    try {
        const fixed = chainOf([{ opens: 'LinkListReqv' }], ['ACME'])
        assert.deepEqual(await surveyEvidence(fixed.chain, { reg, query }), [])
        const m2 = engine.createMachine()
        m2.setSurveys([{ start_date: 'x', end_date: null, conditions: fixed.body.conditions }])
        assert.deepEqual(m2.consume({ event: 'PageView', properties: { dialog_id: 'LinkListReqv', action: 'OPEN' } }, 1, 'PROD|01|ACME|ann').map((d: { id: string }) => d.id), ['drill-1'])
    } finally { config.properties.clientFromDistinctId = old }
})

test('chosen clients with no events, and user ids without the client part, are flagged', async () => {
    const old = config.properties.clientFromDistinctId
    config.properties.clientFromDistinctId = 3
    try {
        const c = chainOf([{ opens: 'LinkListReqv' }], ['NOBODY'])
        store.chosenClients = 0
        assert.match((await surveyEvidence(c.chain, { reg, query }))[0].text, /^None of the chosen clients had any Reval events in the last 30 days/)
        store.idParts = 0
        assert.match((await surveyEvidence(c.chain, { reg, query }))[0].text, /^None of the user ids in the last 30 days have a part 3 when split on "\|"/)
    } finally { config.properties.clientFromDistinctId = old; store.chosenClients = 900; store.idParts = 120_000 }
})

test('PostHog down or no events: one plain warning that the check was skipped, never a failure', async () => {
    const down = await surveyEvidence(chainOf([{ opens: 'X' }]).chain, { reg, query: async () => { throw new TypeError('fetch failed') } })
    assert.deepEqual(down, [{ level: 'warning', where: 'steps', text: 'Lens could not check the steps and audience against recent events (PostHog is unreachable). Check the dialog ids and button labels with describe_app_events.' }])
    assert.equal(foundMismatch(down), false)
    const hung = await surveyEvidence(chainOf([{ opens: 'X' }]).chain, { reg, query: () => new Promise(() => {}), timeoutMs: 20 })
    assert.match(hung[0].text, /PostHog did not answer in time/)
    const quiet = await surveyEvidence(chainOf([{ opens: 'X' }]).chain, { reg, query: async (q) => q.startsWith('SELECT count() AS n') ? [{ n: 0 }] : [] })
    assert.deepEqual(quiet.map((p) => p.text), ['No Reval events arrived in the last 30 days, so the steps could not be checked against real use.'])
})

// --- through the tools and the page, with the stand-in behind PostHog's HTTP API
const survey = (conditions: unknown) => ({ id: '01a1c6d6-8086-0000-b54b-4feed4e4f2b0', name: 'Drill', description: '', type: 'popover', questions: [{ id: 'q1', type: 'rating', question: 'How was it?', scale: 5 }],
    conditions, appearance: {}, start_date: null, end_date: null, archived: false, created_at: new Date().toISOString(), responses_limit: null })
function posthog(t: TestContext, stored: ReturnType<typeof survey>) {
    invalidateSurveyCache(); resetPosthogBreaker()
    const saved = { ...config.posthog }, enabled = config.surveys.enabled
    Object.assign(config.posthog, { host: 'https://posthog.invalid', projectId: '1', personalApiKey: 'read-test', surveyApiKey: 'survey-test' })
    config.surveys.enabled = true
    t.after(() => { Object.assign(config.posthog, saved); config.surveys.enabled = enabled; invalidateSurveyCache() })
    t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
        const u = String(url)
        if (u.includes('/query/')) {
            const q = JSON.parse(String(init!.body)).query
            const rows = answer(q.query, q.values)
            const columns = rows.length ? Object.keys(rows[0]) : ['n']
            return Response.json({ columns, results: rows.map((r) => columns.map((c) => r[c])) })
        }
        if (u.includes('/surveys/') && init?.method && init.method !== 'GET') return Response.json({ ...stored, ...JSON.parse(String(init.body)) })
        if (/\/surveys\/[0-9a-f-]{8,}\/$/.test(u.split('?')[0])) return Response.json(stored)
        return Response.json({ results: [], next: null })
    })
}
function tools() {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown> }>> = {}
    return { handlers, server: { registerTool: (name: string, _def: unknown, cb: never) => { handlers[name] = cb } } }
}

test('design_survey and save_survey pass the warnings on; saving still works exactly as before', async (t) => {
    posthog(t, survey({}))
    const { registerSurveyTools } = await import('../src/mcp/surveytools.ts')
    const { handlers, server } = tools()
    registerSurveyTools(server as never)
    const spec = { name: 'Drill', questions: [{ type: 'rating', text: 'How was it?' }], steps: [{ opens: 'DlgHedgeDesigListReport' }] }
    const designed = await handlers.design_survey({ ...spec, days: 14, estimate: true })
    const all = JSON.stringify(designed)
    assert.match(all, /The survey checks out\. .*⚠ Some steps or the audience did not match anything in recent events/)
    assert.match(all, /Did you mean: LinkListReqv/)
    const saved = await handlers.save_survey(spec)
    const text = JSON.stringify(saved)
    assert.match(text, /Saved as a draft/)
    assert.match(text, /⚠ Some steps or the audience did not match anything/)
    assert.match(text, /"warnings":\[.*Did you mean: LinkListReqv/)
})

test('the Surveys page shows the warnings with reach and in the launch dialog', async (t) => {
    const c = chainOf([{ opens: 'DlgHedgeDesigListReport' }], ['ACME'])
    posthog(t, survey(c.body.conditions))
    const { handleSurveys, surveysHtml } = await import('../src/service/surveyspage.ts')
    const call = async (suffix: string) => {
        let status = 0, body = ''
        const res = { writeHead(s: number) { status = s }, end(b: string) { body = b } } as never
        await handleSurveys({ method: 'GET' } as never, res, new URL('http://x/replays/surveys/api/survey/01a1c6d6-8086-0000-b54b-4feed4e4f2b0/' + suffix), { email: 'a@b.c', role: 'admin', surveys: 'launch' } as never)
        return { status, body: JSON.parse(body) }
    }
    const reach = await call('reach')
    assert.equal(reach.status, 200)
    assert.ok('sessions' in reach.body && 'by_step' in reach.body, 'every reach field is still there')
    assert.deepEqual(reach.body.problems.map((p: { where: string }) => p.where), ['clients', 'steps[0]'])
    const check = await call('launch-check')
    assert.equal(check.status, 200)
    assert.equal(check.body.rules.length, 4, 'the launch rules are unchanged')
    assert.match(check.body.warnings[0].text, /CLIENT_FROM_DISTINCT_ID=3/)
    const html = surveysHtml({ email: 'a@b.c', role: 'admin' } as never)
    assert.match(html, /\(LAUNCH\.warnings\|\|\[\]\)\.map\(w=>'<div class="warnbox">'\+esc\(w\.text\)/, 'launch dialog renders warnings, escaped')
    assert.match(html, /\(x\.problems\|\|\[\]\)\.map\(p=>'<div class="conf">'\+esc\(p\.text\)/, 'reach panel renders warnings, escaped')
})
