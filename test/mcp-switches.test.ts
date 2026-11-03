import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'triage-switches-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { flag } = await import('../src/core/config.ts')
const { serverInstructions, INSTRUCTIONS_LIMIT } = await import('../src/mcp/instructions.ts')
const { mcpClientConfig, LENS_SERVER, POSTHOG_SERVER } = await import('../src/mcp/client-config.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

const posthog = { mcpUrl: 'https://mcp.example.com/mcp', mcpApiKey: 'phx_test' }
// Lens on this machine with node (stdio); the container case has its own test.
const host = { container: false, port: 8080, token: '' }

describe('the two MCP switches', () => {
    test('accept on/off, true/false, yes/no, 1/0, default when unset, and refuse anything else', () => {
        for (const [v, want] of [['on', true], ['OFF', false], ['true', true], ['no', false], ['1', true], ['0', false]] as const) {
            process.env.TEST_SWITCH = v
            assert.equal(flag('TEST_SWITCH', !want), want, v)
        }
        delete process.env.TEST_SWITCH
        assert.equal(flag('TEST_SWITCH', true), true)
        assert.equal(flag('TEST_SWITCH', false), false)
        process.env.TEST_SWITCH = 'maybe'
        assert.throws(() => flag('TEST_SWITCH', true), /TEST_SWITCH must be on or off/)
        delete process.env.TEST_SWITCH
    })
    test('both on: .mcp.json has both servers, PostHog with its key as a header', () => {
        const { file } = mcpClientConfig({ lensMcp: true, posthogMcp: true }, posthog, host)
        assert.deepEqual(Object.keys(file.mcpServers).sort(), [LENS_SERVER, POSTHOG_SERVER].sort())
        assert.deepEqual(file.mcpServers[POSTHOG_SERVER], { type: 'http', url: posthog.mcpUrl, headers: { Authorization: 'Bearer phx_test' } })
    })
    test('each switch removes only its own server', () => {
        assert.deepEqual(Object.keys(mcpClientConfig({ lensMcp: false, posthogMcp: true }, posthog, host).file.mcpServers), [POSTHOG_SERVER])
        assert.deepEqual(Object.keys(mcpClientConfig({ lensMcp: true, posthogMcp: false }, posthog, host).file.mcpServers), [LENS_SERVER])
        assert.deepEqual(Object.keys(mcpClientConfig({ lensMcp: false, posthogMcp: false }, posthog, host).file.mcpServers), [])
    })
    test("PostHog's server needs its URL and key even when switched on", () => {
        const { file, notes } = mcpClientConfig({ lensMcp: true, posthogMcp: true }, { mcpUrl: '', mcpApiKey: '' }, host)
        assert.deepEqual(Object.keys(file.mcpServers), [LENS_SERVER])
        assert.ok(notes.some((n) => n.includes('set POSTHOG_MCP_URL')))
    })
    test("Lens as a container: its tools over HTTP with MCP_TOKEN, and off without one", () => {
        const on = mcpClientConfig({ lensMcp: true, posthogMcp: false }, posthog, { container: true, port: 8080, token: 'tok' })
        assert.deepEqual(on.file.mcpServers[LENS_SERVER], { type: 'http', url: 'http://127.0.0.1:8080/mcp', headers: { Authorization: 'Bearer tok' } })
        const off = mcpClientConfig({ lensMcp: true, posthogMcp: false }, posthog, { container: true, port: 8080, token: '' })
        assert.deepEqual(off.file.mcpServers, {})
        assert.ok(off.notes.some((n) => n.includes('set MCP_TOKEN')))
    })
    test("with PostHog's server off, the instructions keep the replay rule and stop sending Claude there", () => {
        const text = serverInstructions(false)
        assert.ok(text.indexOf('Replays are private') > 0 && text.indexOf('Replays are private') < 500)
        for (const t of ['session-recording-*', 'query-session-recordings-list', 'vision-*', 'get_replay_link']) assert.ok(text.includes(t), t)
        assert.ok(!text.includes('execute-sql') && !text.includes("Use PostHog's server") && !text.includes('may be connected too'))
        assert.ok(text.length < INSTRUCTIONS_LIMIT)
        const on = serverInstructions(true)
        assert.ok(on.includes('execute-sql') && on.includes("Use PostHog's server"))
    })
})
