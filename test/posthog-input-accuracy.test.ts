import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { closestNames, obsoleteCorrection, queryWarnings, toolNames, TRENDS_CORRECTION } = await import('../src/mcp/posthog-input.ts')
const { parseAppEvents } = await import('../src/core/appevents.ts')
const { posthogFailure, posthogPublicMessage } = await import('../src/mcp/posthog-error.ts')
const { toolError } = await import('../src/mcp/toolerror.ts')

const app = parseAppEvents({ app: 'Reval', events: { screen: 'PageView', interaction: 'Event' }, properties: { dialog: { name: 'dialog_id' } } })
const command = (input: unknown, tool = 'query-trends') => `call ${tool} ${JSON.stringify(input)}`
const properties = ['dialog_id', 'client_id', 'action_name']

test('structured validation publishes paths, expected types and enums, never rejected values or messages', () => {
    const issues = [
        { code: 'invalid_type', path: ['series', 0, 'event'], expected: 'string', received: 'undefined', message: 'private@example.com', input: 'SECRET' },
        { code: 'invalid_enum_value', path: ['interval'], options: ['day', 'week', 'month'], received: 'SECRET', message: 'SECRET' },
    ]
    for (const detail of [issues, `Invalid input: ${JSON.stringify(issues)}`, { code: -32602, message: `Input validation failed: ${JSON.stringify(issues)}` }, JSON.stringify({ type: 'validation_error', detail: JSON.stringify(issues) })]) {
        const e = posthogFailure(detail)
        assert.match(e.message, /series.0.event: expected string \(required\)/)
        assert.match(e.message, /interval: allowed day, week, month/)
        assert.doesNotMatch(e.message, /SECRET|private@|received|input:/)
        assert.equal(posthogPublicMessage(e.message), e.message)
        assert.equal(toolError(e, 'posthog_exec').kind, 'validation')
    }
    assert.match(posthogFailure(`Invalid input: ${JSON.stringify(issues)}`, 400).message, /series.0.event/)
})

test('SQL corrections keep the field or function the agent wrote but never a quoted literal', () => {
    const m = posthogFailure('Unable to resolve field dialog').message
    assert.match(m, /resolve field dialog/) // what makes the retry right
    for (const s of ["Syntax error near 'SECRET'", "Cannot convert 'SECRET value' to Int64", "Illegal type DateTime64(6, 'SECRET')"]) {
        const message = posthogFailure(s).message
        assert.doesNotMatch(message, /SECRET/)
        assert.equal(posthogPublicMessage(message), message)
    }
})

test('obsolete trends correction is specific to the real trends shape, not funnels', () => {
    // Static inputSchema field summaries extracted from the saved mix3-p19 / mix3-p10 responses.
    const fields = JSON.parse(readFileSync(new URL('./fixtures/posthog-breakdown-fields.json', import.meta.url), 'utf8'))
    assert.ok(fields['info query-trends'].breakdownFilter.fields.includes('breakdowns'))
    assert.ok(!fields['info query-trends'].breakdownFilter.fields.includes('breakdown_type'))
    assert.ok(fields['info query-funnel'].breakdownFilter.fields.includes('breakdown_type'))
    const input = { breakdownFilter: { breakdown_type: 'event', breakdown: 'SECRET' } }
    assert.equal(obsoleteCorrection(command(input)), TRENDS_CORRECTION)
    assert.equal(obsoleteCorrection(command(input, 'query-funnel')), undefined)
    assert.equal(obsoleteCorrection(command({ breakdownFilter: 'SECRET' })), undefined)
    assert.equal(obsoleteCorrection(command({ breakdownFilter: { breakdowns: [{ property: 'client_id', type: 'event' }] } })), undefined)
    const message = posthogFailure('Invalid input').message + ' ' + TRENDS_CORRECTION
    assert.equal(posthogPublicMessage(message), message)
})

test('tool suggestions rank shared words and edit distance from the actual supplied list only', () => {
    const names = toolNames({ content: [{ type: 'text', text: JSON.stringify(['experiment-list', 'experiment-get', 'query-trends', 'query-funnel']) }] })
    assert.equal(closestNames('experiments-get-all', names)[0], 'experiment-list') // "get all" is a list (graded run r40)
    assert.deepEqual(closestNames('query-trend', names).slice(0, 1), ['query-trends'])
    assert.ok(closestNames('experiment', names).length <= 3)
    assert.deepEqual(closestNames('something', []), [])
})

test('event/property warnings are advisory and never echo query values', () => {
    const input = { series: [{ event: '$pageview', properties: [{ key: 'dialog', type: 'event', value: 'SECRET' }, { key: 'client', value: 'SECRET' }, { key: '$browser', value: 'SECRET' }] }] }
    const warnings = queryWarnings(command(input), app, ['PageView', 'Event'], properties).join('\n')
    assert.match(warnings, /not been observed.*screen event is PageView.*interaction event is Event/)
    assert.match(warnings, /dialog_id/); assert.match(warnings, /client_id/)
    assert.doesNotMatch(warnings, /SECRET|\$browser/)
    assert.deepEqual(queryWarnings(command(input), null, ['Event'], properties), [])
    assert.equal(queryWarnings(command(input), app, undefined, properties).some(w => w.includes('requested event')), false)
    assert.deepEqual(queryWarnings(command({ series: [{ event: 'Custom' }] }), app, ['Custom'], properties), [])
    assert.deepEqual(queryWarnings(command({ series: [{ event: 'Event' }, { event: 'PageView' }] }), app, ['Event', 'PageView'], properties), [])
    assert.equal(queryWarnings(command({ series: [{ event: 'PageView' }] }), app, ['Event'], properties).length, 1)
    assert.equal(queryWarnings(command({ series: [{ event: 'PageView' }] }), app, [], properties).length, 1)
    assert.match(queryWarnings(command({ query: "SELECT properties.dialog FROM events WHERE event IN ('$pageview', 'SECRET')" }, 'execute-sql'), app, ['Event'], properties).join('\n'), /dialog_id/)
})

test('exec fetches real upstream tool names on unknown-tool errors and reuses the bounded cache', async t => {
    const { posthogExec } = await import('../src/mcp/posthog-proxy.ts')
    const seen: string[] = []
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'DELETE') return new Response(null, { status: 202 })
        const body = JSON.parse(String(init.body))
        if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const cmd = body.params.arguments.command
        seen.push(cmd)
        const result = cmd === 'tools' ? { content: [{ type: 'text', text: JSON.stringify(['query-trends', 'query-funnel']) }] }
            : { isError: true, content: [{ type: 'text', text: 'Unknown tool SECRET' }] }
        return Response.json({ id: body.id, result })
    })
    for (let i = 0; i < 2; i++) await assert.rejects(posthogExec('call query-trend {}', { url: 'http://synthetic-upstream/mcp', apiKey: 'synthetic-key', name: 'lens' }), e => {
        assert.ok(e instanceof Error)
        assert.match(e.message, /Closest tools: query-trends/)
        assert.doesNotMatch(e.message, /SECRET/)
        assert.equal(posthogPublicMessage(e.message), e.message)
        return true
    })
    assert.equal(seen.filter(c => c === 'tools').length, 1)
})

test('successful query results gain property warnings while retaining data privacy', async t => {
    const { config } = await import('../src/core/config.ts')
    const { posthogExec } = await import('../src/mcp/posthog-proxy.ts')
    const previous = config.appEventsFile
    config.appEventsFile = 'config/app-events.reval.json'
    t.after(() => { config.appEventsFile = previous })
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'DELETE') return new Response(null, { status: 202 })
        const body = JSON.parse(String(init.body))
        if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        return Response.json({ id: 2, result: { content: [{ type: 'text', text: 'user_email|events_count\nprivate@example.com|5' }] } })
    })
    const result = await posthogExec(command({ series: [{ event: 'PageView', properties: [{ key: 'dialog', type: 'event', value: 'SECRET' }] }] }), { url: 'http://synthetic-success/mcp', apiKey: 'synthetic-key', name: 'lens' })
    const text = JSON.stringify(result)
    assert.match(text, /Did you mean dialog_id/)
    assert.match(text, /events_count/)
    assert.doesNotMatch(text, /private@example.com|SECRET/)
    assert.equal(result.isError, undefined)
})

test('unknown event checks use one cached name-only read and fail open on unavailable vocabulary', async t => {
    const { config } = await import('../src/core/config.ts')
    const { clearPosthogCache } = await import('../src/core/posthog.ts')
    const { posthogInputWarnings } = await import('../src/mcp/posthog-input.ts')
    const previous = { ...config.posthog }
    Object.assign(config.posthog, { host: 'http://synthetic-vocabulary', projectId: '1', personalApiKey: 'synthetic-key' })
    t.after(() => { Object.assign(config.posthog, previous); clearPosthogCache() })
    clearPosthogCache()
    let reads = 0
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        reads++
        assert.equal(JSON.parse(String(init.body)).query.query, 'SELECT DISTINCT event FROM events LIMIT 1000')
        return Response.json({ columns: ['event'], results: [['PageView'], ['Event']] })
    })
    const cmd = command({ series: [{ event: '$pageview' }] })
    for (let i = 0; i < 2; i++) assert.match((await posthogInputWarnings(cmd)).join('\n'), /not been observed/)
    assert.equal(reads, 1)
    clearPosthogCache()
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('synthetic failure') })
    assert.deepEqual(await posthogInputWarnings(cmd), [])
})

test('unknown commands suggest tools about the same subject, with get-all and list treated alike', async () => {
    const { closestNames } = await import('../src/mcp/posthog-input.ts')
    const names = ['experiment-get', 'experiment-list', 'experiment-create', 'endpoints-get-all', 'actions-get-all', 'dashboards-get-all', 'insights-list']
    assert.equal(closestNames('experiments-get-all', names)[0], 'experiment-list')
    assert.ok(!closestNames('experiments-get-all', names).includes('endpoints-get-all'))
    assert.equal(closestNames('dashboard-list', names)[0], 'dashboards-get-all')
})
