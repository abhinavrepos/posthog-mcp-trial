// MCP over stdio, for Claude Code and Claude Desktop on the same machine.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { shutdownClips } from '../core/clip.ts'
import { warmClientResolver } from '../core/resolve.ts'
import { config } from '../core/config.ts'
import { lensServerInfo } from './server-info.ts'
import { registerTools } from './tools.ts'
import { serverInstructions } from './instructions.ts'

// stdout belongs to the protocol. Anything else that logs goes to stderr.
console.log = console.error

if (!config.features.lensMcp) {
    console.error(`${config.app.name}'s MCP tools are switched off (FEATURE_LENS_MCP=off).`)
    process.exit(1)
}

const server = new McpServer(lensServerInfo, { instructions: serverInstructions() })
registerTools(server)
warmClientResolver()
const transport = new StdioServerTransport()
await server.connect(transport)

const stop = async () => {
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', stop)
