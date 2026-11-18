import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const dir = mkdtempSync(join(tmpdir(), 'lens-dictionary-'))
Object.assign(process.env, {
    TRIAGE_ENV_FILE: '/dev/null', TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'),
    APP_EVENTS_FILE: 'config/app-events.reval.json', CLIENT_FROM_DISTINCT_ID: '3',
    POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'test', POSTHOG_MCP_URL: 'http://localhost/mcp', POSTHOG_MCP_API_KEY: 'test',
})
const { dataDictionary, DICTIONARY_LIMITS } = await import('../src/core/datadictionary.ts')
const { appEvents, parseAppEvents, describeAppEvents } = await import('../src/core/appevents.ts')
const { config } = await import('../src/core/config.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { routingBlock, execRoutingLine, rewriteResponse } = await import('../src/mcp/posthog-proxy.ts')
const { setAnonymise, syncClients } = await import('../src/core/anonymise.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

async function catalog() {
    const server = new McpServer({ name: 'test', version: '1' })
    registerTools(server)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    try { return (await client.listTools()).tools } finally { await client.close(); await server.close() }
}

test('configured properties, paths, Lens dimensions and live values share one dictionary', () => {
    const compact = dataDictionary({ format: 'compact' })
    const full = dataDictionary({ format: 'full', live: { properties: [{ name: 'dialog_id', examples: ['DlgSyntheticLive'] }] } })
    for (const prop of Object.values(appEvents()!.properties)) {
        for (const text of [compact, full]) { assert.ok(text.includes(prop.name)); assert.ok(text.includes('properties.' + prop.name)) }
    }
    for (const key of ['client', 'clientName', 'version'] as const) assert.ok(compact.includes('properties.' + config.properties[key]))
    assert.match(compact, /person.properties.email/)
    assert.match(full, /DlgSyntheticLive/)
    assert.doesNotMatch(compact, /DlgSyntheticLive/)
    assert.match(compact, /User is part 4/)
    assert.match(compact, /never by part 4 alone/) // part 4 alone counted 7 people, not 900 (final check 2026-11-18)
    assert.match(compact, /Client is part 3/)
    assert.match(compact, /timestamp \(UTC/)
    assert.match(compact, /Client clock, epoch seconds/)
    assert.match(compact, /\| action_name .*\| button \|/)
    const commands = compact.split('\n').filter((l) => l.startsWith('call '))
    assert.equal(commands.length, 5)
    const parsed = commands.map((l) => JSON.parse(l.slice(l.indexOf('{'))))
    assert.deepEqual(parsed[0].series[0].properties[0], { key: 'dialog_id', value: ['DlgTask35'], operator: 'exact', type: 'event' })
    assert.deepEqual(parsed[1].breakdownFilter, { breakdowns: [{ property: 'client_id', type: 'event' }] })
    assert.deepEqual(parsed[2].breakdownFilter, { breakdown: 'client_id', breakdown_type: 'event' })
    assert.equal(parsed[2].series.length, 2)
    assert.equal(parsed[3].pathsFilter.pathsHogQLExpression, 'toString(properties.dialog_id)')
    assert.match(parsed[4].query, /count\(\) AS events_count/)
})

test('all advertised surfaces fit budgets and omit roster identities in every mode', async () => {
    // Names from the existing privacy suite's synthetic roster.
    syncClients([{ id: 'ACME0', name: 'Zorblax Treasury 0' }])
    for (const mode of ['standard', 'open', 'private'] as const) {
        setAnonymise({ mode })
        const tools = await catalog()
        const exec = tools.find((t) => t.name === 'posthog_exec')!.description!
        const describe = tools.find((t) => t.name === 'describe_app_events')!.description!
        const compact = dataDictionary({ format: 'compact' })
        const route = routingBlock('lens')
        assert.ok(compact.length <= DICTIONARY_LIMITS.compact, String(compact.length))
        assert.ok(exec.length <= DICTIONARY_LIMITS.exec, String(exec.length))
        assert.ok(route.length <= DICTIONARY_LIMITS.routing, String(route.length))
        assert.ok(execRoutingLine('lens').length <= DICTIONARY_LIMITS.routing)
        assert.ok(describe.length <= DICTIONARY_LIMITS.describe)
        assert.ok(serverInstructions(true).length <= 2048)
        for (const prop of Object.values(appEvents()!.properties)) assert.ok(exec.includes(prop.name))
        assert.match(exec, /call describe_app_events/i)
        for (const text of [exec, route, ...tools.map((t) => t.description || '')]) {
            assert.doesNotMatch(text, /ACME0|Zorblax Treasury|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)
        }
        if (mode === 'private') {
            for (const text of [exec, route, dataDictionary({ format: 'full' })]) {
                assert.doesNotMatch(text, /call execute-sql|SELECT |count\(\) AS|C123|ENV\|01/)
                assert.match(text, /SQL is refused|execute-sql is refused/)
            }
        }
        const init = rewriteResponse({ result: { serverInfo: {}, protocolVersion: 'test' } }) as { result: { instructions: string } }
        assert.ok(init.result.instructions.includes(compact))
    }
    setAnonymise({ mode: 'standard' })
})

test('custom maps and missing maps never invent Reval properties or identity positions', () => {
    const compact = dataDictionary({ format: 'compact' })
    const none = dataDictionary({ format: 'compact', app: null, properties: { ...config.properties, clientFromDistinctId: 0 } })
    assert.ok(none.length < compact.length)
    assert.match(none, /No app event map configured/)
    assert.doesNotMatch(none, /PageView|dialog_id|part 4|call query/)
    const app = parseAppEvents({ events: { screen: 'Screen', interaction: 'Click' }, properties: { dialog: { name: 'window_code', meaning: 'Window key' } } })
    const custom = dataDictionary({ format: 'full', app, properties: { ...config.properties, client: 'tenant', distinctIdSeparator: ':', clientFromDistinctId: 0 } })
    assert.match(custom, /properties.window_code/)
    assert.match(custom, /properties.tenant/)
    assert.doesNotMatch(custom, /dialog_id|PageView|DlgTask35|ENV\|01/)
})

test('committed human dictionary is generated from the same source', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/data-dictionary.ts', '--check'], {
        cwd: new URL('..', import.meta.url), env: { ...process.env, TRIAGE_ENV_FILE: '/dev/null' }, encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(readFileSync(new URL('../docs/data-dictionary.md', import.meta.url), 'utf8'), /properties.dialog_id/)
})

test('describe_app_events returns the full dictionary in its structured data', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        const query = init?.body ? String(JSON.parse(String(init.body)).query?.query || '') : ''
        if (query.startsWith('SELECT count() AS n,')) return new Response(JSON.stringify({
            columns: ['n', 'f0', 't0'], results: [[1, 1, ['DlgSyntheticLive']]],
        }))
        return new Response(JSON.stringify({ columns: [], results: [] }))
    })
    const result = await describeAppEvents()
    for (const property of Object.values(appEvents()!.properties)) assert.ok(result.dictionary.includes(property.name))
    assert.match(result.dictionary, /DlgSyntheticLive/)
    assert.match(result.dictionary, /Retention uses retentionFilter/)
})
