// MCP over stdio, for Claude Code and Claude Desktop on the same machine.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { makeAi } from '../core/ai.ts'
import { shutdownClips } from '../core/clip.ts'
import { serverInstructions } from './instructions.ts'
import { registerTools } from './tools.ts'

// stdout belongs to the protocol. Anything else that logs goes to stderr.
console.log = console.error

const server = new McpServer({ name: 'ticket-triage', version: '0.1.0' }, { instructions: serverInstructions() })
registerTools(server, makeAi())
await server.connect(new StdioServerTransport())

const stop = async () => {
    await shutdownClips().catch(() => {})
    process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.stdin.on('close', stop)
