import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'triage-instr-'))
process.env.FEATURE_JIRA = 'on'
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { db } = await import('../src/core/db.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { serverInstructions, INSTRUCTIONS_LIMIT } = await import('../src/mcp/instructions.ts')
const { lensServerInfo } = await import('../src/mcp/server-info.ts')
const { config } = await import('../src/core/config.ts')
after(async () => {
    await client.close()
    await server.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

// As Claude sees them with PostHog's MCP server on (FEATURE_POSTHOG_MCP and POSTHOG_MCP_URL set).
const server = new McpServer(lensServerInfo, { instructions: serverInstructions(true) })
registerTools(server)
const client = new Client({ name: 'test', version: '0' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])

describe('instructions for using this server next to PostHog MCP', () => {
    test("are sent on connect and fit Claude Code's 2,048-character limit, with room for longer names", () => {
        const text = client.getInstructions() || ''
        assert.ok(text.length > 500)
        // Preserve the existing 240-character margin for longer settings and server names.
        assert.ok(text.length + 4 * 50 + 40 < INSTRUCTIONS_LIMIT, `instructions are ${text.length} characters`)
    })
    test('serverInfo uses the configured name and describes the business scope', () => {
        assert.equal(client.getServerVersion()?.name, config.mcp.name)
        assert.equal(client.getServerVersion()?.title, 'PostHog Lens')
        assert.match(client.getServerVersion()?.description || '', /Reval clients/)
    })
    test('all tool descriptions lead with a short business sentence', async () => {
        for (const tool of (await client.listTools()).tools) {
            const first = tool.description?.split(/[.!?](?:\s|$)/)[0] || ''
            assert.ok(first.length > 10 && first.length + 1 <= 200, `${tool.name}: ${first.length + 1}`)
        }
    })
    test('routing fixture Lens targets are available, with a short first sentence for each', async () => {
        const cases = JSON.parse(readFileSync(new URL('./fixtures/routing-cases.json', import.meta.url), 'utf8')) as { q: string; server: string; tool: string }[]
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]))
        for (const item of cases.filter((item) => item.server === 'lens')) {
            const tool = tools.get(item.tool)
            assert.ok(tool, item.q)
            assert.ok((tool.description || '').split(/[.!?](?:\s|$)/)[0].length + 1 <= 200, item.tool)
        }
    })
    test('the replay rule comes first, before anything could be cut', () => {
        const text = client.getInstructions() || ''
        const rule = text.indexOf('Replays are private')
        assert.equal(rule, 0)
        for (const t of ['session-recording-*', 'query-session-recordings-list', 'vision-*', 'get_replay_link']) assert.ok(text.includes(t), t)
    })
    test('every tool they name exists, and every question-answering tool is named', async () => {
        const text = client.getInstructions() || ''
        const tools = (await client.listTools()).tools
        const names = new Set(tools.map((t) => t.name))
        const args = new Set(tools.flatMap((t) => Object.keys(t.inputSchema.properties || {})))
        const properties = new Set(Object.values(config.properties))
        const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]).filter((w) => !properties.has(w) && !args.has(w))
        for (const m of mentioned) assert.ok(names.has(m), `instructions name ${m}, which is not a tool`)
        for (const n of names) if (n !== 'refresh_releases') assert.ok(text.includes(n), `${n} is not in the instructions`)
    })
    test('the overlapping tools say which PostHog tools not to use instead', async () => {
        const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description || '']))
        assert.match(tools.get_replay_link, /never use PostHog's session recording or Replay Vision tools/)
        for (const name of ['find_client_incidents', 'error_blast_radius', 'screen_usage', 'client_feedback', 'describe_app_events'])
            assert.match(tools[name], /Use PostHog's exec instead for/, name)
    })
    test("every tool says it is called directly, not through PostHog's exec tool", async () => {
        for (const t of (await client.listTools()).tools) assert.match(t.description || '', /never through PostHog's exec tool/, t.name)
        assert.match(client.getInstructions() || '', /PostHog's one tool, exec, takes a command string/)
    })
})
