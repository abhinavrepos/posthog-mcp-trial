import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'triage-instr-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { db } = await import('../src/core/db.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { serverInstructions, INSTRUCTIONS_LIMIT } = await import('../src/mcp/instructions.ts')
const { config } = await import('../src/core/config.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

// As Claude sees them with PostHog's MCP server on (FEATURE_POSTHOG_MCP and POSTHOG_MCP_URL set).
const server = new McpServer({ name: 'ticket-triage', version: '0' }, { instructions: serverInstructions(true) })
registerTools(server)
const client = new Client({ name: 'test', version: '0' })
const [a, b] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(a), client.connect(b)])

describe('instructions for using this server next to PostHog MCP', () => {
    test("are sent on connect and fit Claude Code's 2,048-character limit, with room for longer names", () => {
        const text = client.getInstructions() || ''
        assert.ok(text.length > 500)
        // Four property names of up to 50 characters, and a longer app name.
        assert.ok(text.length + 4 * 50 + 40 < INSTRUCTIONS_LIMIT, `instructions are ${text.length} characters`)
    })
    test('the replay rule comes first, before anything could be cut', () => {
        const text = client.getInstructions() || ''
        const rule = text.indexOf('Replays are private')
        assert.ok(rule > 0 && rule < 500)
        for (const t of ['session-recording-*', 'query-session-recordings-list', 'vision-*', 'get_replay_link']) assert.ok(text.includes(t), t)
    })
    test('every tool they name exists, and every question-answering tool is named', async () => {
        const text = client.getInstructions() || ''
        const names = new Set((await client.listTools()).tools.map((t) => t.name))
        const properties = new Set(Object.values(config.properties))
        const mentioned = [...text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((m) => m[0]).filter((w) => !properties.has(w))
        for (const m of mentioned) assert.ok(names.has(m), `instructions name ${m}, which is not a tool`)
        for (const n of names) if (n !== 'refresh_releases') assert.ok(text.includes(n), `${n} is not in the instructions`)
    })
    test('the overlapping tools say which PostHog tools not to use instead', async () => {
        const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description || '']))
        assert.match(tools.get_replay_link, /never use PostHog's session recording or Replay Vision tools/)
        assert.match(tools.find_client_incidents, /not PostHog's session recording tools/)
        assert.match(tools.error_blast_radius, /rather than PostHog's error tracking queries/)
        assert.match(tools.screen_usage, /rather than a PostHog trends query/)
        assert.match(tools.client_feedback, /use PostHog's survey tools instead/)
    })
})
