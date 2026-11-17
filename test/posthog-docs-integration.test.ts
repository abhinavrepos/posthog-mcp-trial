import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dir = mkdtempSync(join(tmpdir(), 'lens-docs-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
const { posthogExec } = await import('../src/mcp/posthog-proxy.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('exec caches raw and compact metadata, hydrates abbreviated fields once, and never caches data', async t => {
    const options = { url: 'http://docs-integration.invalid/mcp', apiKey: 'test-only', name: 'lens' }
    const calls: string[] = []
    const raw = { content: [{ type: 'text', text: 'name: query-trends\ndescription: |-\n  Count events over time.\ninputSchema: ' + JSON.stringify(JSON.stringify({ type: 'object', required: ['series'], properties: {
        series: { type: 'array', items: 'union', hint: 'schema needed' }, interval: { type: 'string', enum: ['day', 'week'] },
    } })) }] }
    let fail = false
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
        if (init.method === 'DELETE') return new Response(null, { status: 202 })
        const body = JSON.parse(String(init.body))
        if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'docs-test' } })
        if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
        const command = body.params.arguments.command; calls.push(command)
        if (fail) return Response.json({ id: 2, result: { isError: true, content: [{ type: 'text', text: 'secret upstream value' }] } })
        const result = command === 'info query-trends' ? raw : command === 'schema query-trends series' ? { content: [{ type: 'text', text: JSON.stringify({ schema: { type: 'array', items: { type: 'object', required: ['event'], properties: { event: { type: 'string' }, math: { enum: ['total', 'dau'] } } } } }) }] } : { content: [{ type: 'text', text: 'Date|Count\n2026-09-27|1\n2026-10-04|2\n2026-10-11|3\njane@example.com paid 250000' }] }
        return Response.json({ id: 2, result })
    })
    const docs = await Promise.all([posthogExec('info query-trends', options), posthogExec('info query-trends', options)])
    assert.deepEqual(docs[0], docs[1]); assert.match(docs[0].content[0].text, /event\*: string/)
    assert.match(docs[0].content[0].text, /"total"\|"dau"/)
    assert.deepEqual(calls.sort(), ['info query-trends', 'schema query-trends series'])
    assert.deepEqual(await posthogExec('info query-trends full', options), raw)
    await posthogExec('schema query-trends series', options); assert.equal(calls.length, 2)
    const command = 'call query-trends {"interval":"week","dateRange":{"date_from":"2026-09-29","date_to":"2026-10-15"}}'
    for (let i = 0; i < 2; i++) {
        const data = await posthogExec(command, options)
        assert.doesNotMatch(JSON.stringify(data), /jane@|250000/)
        assert.match(JSON.stringify(data), /week start=Sunday/)
    }
    assert.equal(calls.filter(c => c === command).length, 2)
    fail = true
    await assert.rejects(posthogExec('call query-trends {}', options), error => {
        assert.doesNotMatch(String(error), /secret upstream value/); return true
    })
    fail = false
    await posthogExec('info query-trends', options)
    assert.equal(calls.filter(c => c === 'info query-trends').length, 2)
    assert.equal(calls.filter(c => c === 'schema query-trends series').length, 2)
    await posthogExec('info query-trends', { ...options, apiKey: 'another-test-key' })
    assert.equal(calls.filter(c => c === 'info query-trends').length, 3)
    raw.content[0].text = 'name: query-trends\ninputSchema: ' + JSON.stringify(JSON.stringify({ type: 'object', properties: { field: 'private-upstream-value' } }))
    await assert.rejects(posthogExec('info query-trends', { ...options, apiKey: 'malformed-test-key' }), error => {
        assert.doesNotMatch(String(error), /private-upstream-value/); return true
    })
})
