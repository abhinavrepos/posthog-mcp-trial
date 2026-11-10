// MCP over stdio, for Claude Code and Claude Desktop on the same machine.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { makeAi } from '../core/ai.ts'
import { shutdownClips } from '../core/clip.ts'
import { config } from '../core/config.ts'
import { lensServerInfo } from './server-info.ts'
import { serverInstructions } from './instructions.ts'
import { registerTools } from './tools.ts'

// stdout belongs to the protocol. Anything else that logs goes to stderr.
console.log = console.error

if (!config.features.lensMcp) {
    console.error(`${config.app.name}'s MCP tools are switched off (FEATURE_LENS_MCP=off). Run pnpm mcp:config to update .mcp.json.`)
    process.exit(1)
}

const server = new McpServer(lensServerInfo, { instructions: serverInstructions() })
registerTools(server, makeAi())
await server.connect(new StdioServerTransport())

const stop = async () => {
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', stop)
