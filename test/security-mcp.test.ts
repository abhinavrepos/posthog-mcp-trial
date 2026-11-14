import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'lens-security-mcp-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.FEATURE_JIRA = 'off'
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { config, jiraConfigured } = await import('../src/core/config.ts')
const { registerTools, lensToolNames, RELEASE_TOOLS } = await import('../src/mcp/tools.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
const { db, run, one } = await import('../src/core/db.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

async function mcp(email?: string, admin = false) {
    const server = new McpServer({ name: 'security', version: '0' })
    registerTools(server, undefined, email ? { who: email, email, admin, surveyRole: 'view' } : undefined)
    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    return { client, close: async () => { await client.close(); await server.close() } }
}

test('Jira off hides release tools and prompts even with credentials', async () => {
    Object.assign(config.jira, { baseUrl: 'https://jira.example', email: 'bot@example.com', apiToken: 'secret' })
    assert.equal(jiraConfigured(), false)
    const session = await mcp()
    try {
        const names = (await session.client.listTools()).tools.map(t => t.name)
        for (const name of RELEASE_TOOLS) {
            assert.ok(!names.includes(name))
            assert.ok(!lensToolNames().includes(name))
            assert.ok(!serverInstructions().includes(name))
        }
        assert.ok(names.includes('triage_ticket'))
        const prompts = (await session.client.listPrompts()).prompts.map(p => p.name)
        assert.ok(!prompts.includes('review_release') && !prompts.includes('release_check'))
        const { syncReleases } = await import('../src/core/releases.ts')
        await assert.rejects(syncReleases(), /switched off/)
    } finally { await session.close() }
})

test('personal verdicts use the caller email and Jira posting needs admin', async () => {
    config.features.jira = true
    run("INSERT INTO releases (name, released_at, description, synced_at) VALUES ('test', '2026-01-01', '', '')")
    run("INSERT INTO release_tickets (key, release, type, summary, components, labels) VALUES ('ACP-1', 'test', 'Story', 'test', '[]', '[]')")
    const session = await mcp('caller@example.com')
    try {
        const args = { key: 'ACP-1', verdict: 'fine', reason: 'reviewed', decided_by: 'someone else' }
        await session.client.callTool({ name: 'record_verdict', arguments: args })
        assert.equal(one<{ source: string }>('SELECT source FROM release_verdicts')?.source, 'caller@example.com')
        const result = await session.client.callTool({ name: 'record_verdict', arguments: { ...args, post_to_jira: true } })
        assert.match(JSON.stringify(result), /requires admin/)
        assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM release_verdicts')?.n, 1)
    } finally { await session.close(); config.features.jira = false }
})

test('MCP clip admission skips full queues and hourly limits while preserving the replay link', async () => {
    // Evaluate the actual callback with a fake renderer so no Chrome or PostHog is needed.
    const source = readFileSync('src/mcp/tools.ts', 'utf8')
    const admission = source.slice(source.indexOf('const mcpRenders:'), source.indexOf('// Every Lens tool result goes through the AI-safety pass'))
    const callback = source.slice(source.indexOf('async ({ session_id: raw'), source.indexOf("\n    server.registerTool(\n        'screen_usage'")).replace(/\n    \)\s*$/, '')
    let pending = 3, renders = 0
    const handler = new Function('pendingRenders', 'renderClip', 'recordClip', 'sessionIdOf', 'replayUrl', 'config', 'text',
        stripTypeScriptTypes(admission.replace('export function', 'function') + '\nconst handler = ' + callback) + '\nreturn handler'
    )(() => pending, async () => { renders++; throw new Error('fake renderer') }, () => {}, (s: string) => s, () => 'https://posthog/replay', config, (s: string) => s)
    const call = () => handler({ session_id: 'test', start_s: 0, duration_s: 30 }) as Promise<string>
    assert.match(await call(), /queue is full/)
    assert.equal(renders, 0)
    pending = 0
    const old = process.env.CLIPS_PER_HOUR
    process.env.CLIPS_PER_HOUR = '2'
    try {
        await call(); await call()
        const result = await call()
        assert.match(result, /hourly MCP clip limit/)
        assert.match(result, /https:\/\/posthog\/replay/)
        assert.equal(renders, 2)
    } finally { if (old === undefined) delete process.env.CLIPS_PER_HOUR; else process.env.CLIPS_PER_HOUR = old }
})

test('render count includes running and waiting jobs and recovers after failure', async () => {
    const source = readFileSync('src/core/clip.ts', 'utf8')
    const serial = source.slice(source.indexOf('let pending ='), source.indexOf("/** The recording's snapshots"))
    const api = new Function(stripTypeScriptTypes(serial.replace('export const', 'const')) + '\nreturn { serial, pendingRenders }')() as {
        serial: (fn: () => Promise<void>) => Promise<void>; pendingRenders: () => number
    }
    let finish!: () => void
    const first = api.serial(() => new Promise<void>(resolve => { finish = resolve }))
    const second = api.serial(async () => { throw new Error('render failed') })
    const failed = assert.rejects(second, /render failed/)
    const third = api.serial(async () => {})
    assert.equal(api.pendingRenders(), 3)
    await Promise.resolve()
    finish()
    await Promise.all([first, failed, third])
    assert.equal(api.pendingRenders(), 0)
})
