// pnpm tsx scripts/routing-catalog.ts [output.json]
// Uses the captured PostHog fixture unless POSTHOG_MCP_URL is configured.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { config, ROOT } from '../src/core/config.ts'
import { rewriteResponse } from '../src/mcp/posthog-proxy.ts'
import { lensServerInfo } from '../src/mcp/server-info.ts'

// Registration opens the database, but this catalog never calls tools or touches deployment data.
const dir = mkdtempSync(join(tmpdir(), 'lens-routing-'))
process.env.TRIAGE_DB = join(dir, 'catalog.db')
const { db } = await import('../src/core/db.ts')
const { registerTools } = await import('../src/mcp/tools.ts')
const { serverInstructions } = await import('../src/mcp/instructions.ts')
const { appEvents } = await import('../src/core/appevents.ts')
const { lensToolNames } = await import('../src/mcp/tools.ts')
const info = { app: appEvents()?.app || 'the app', tools: lensToolNames() }
const lens = new McpServer(lensServerInfo, { instructions: serverInstructions(true) })
registerTools(lens)
const client = new Client({ name: 'routing-catalog', version: '0' })
const [a, b] = InMemoryTransport.createLinkedPair()
let posthog: Client | undefined
try {
    await Promise.all([lens.connect(a), client.connect(b)])
    let fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/posthog-mcp.json'), 'utf8'))
    if (config.posthog.mcpUrl) {
        if (!config.posthog.mcpApiKey) throw new Error('Set POSTHOG_MCP_API_KEY for the live catalog, or unset POSTHOG_MCP_URL to use the fixture')
        posthog = new Client({ name: 'routing-catalog', version: '0' })
        await posthog.connect(new StreamableHTTPClientTransport(new URL(config.posthog.mcpUrl), {
            requestInit: { headers: { Authorization: `Bearer ${config.posthog.mcpApiKey}` }, signal: AbortSignal.timeout(30_000) },
        }))
        fixture = {
            initialize: { result: { protocolVersion: 'live', serverInfo: posthog.getServerVersion(), instructions: posthog.getInstructions() } },
            tools_list: { result: await posthog.listTools() },
        }
    }
    const initialize = rewriteResponse(fixture.initialize, config.mcp.name, info) as typeof fixture.initialize
    const list = rewriteResponse(fixture.tools_list, config.mcp.name, info) as typeof fixture.tools_list
    const tools = (items: { name: string; description?: string }[]) => items.map(({ name, description }) => ({ name, description: description || '' }))
    const catalog = {
        servers: [
            { name: client.getServerVersion()!.name, serverInfo: client.getServerVersion(), instructions: client.getInstructions(), tools: tools((await client.listTools()).tools) },
            // The connection key is posthog, even when upstream serverInfo says PostHog.
            { name: 'posthog', serverInfo: initialize.result.serverInfo, instructions: initialize.result.instructions, tools: tools(list.result.tools) },
        ],
    }
    const output = JSON.stringify(catalog, null, 2) + '\n'
    if (process.argv[2]) writeFileSync(process.argv[2], output)
    else process.stdout.write(output)
} finally {
    await posthog?.close()
    await client.close()
    await lens.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
}
