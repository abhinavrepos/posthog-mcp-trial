// Writes .mcp.json for Claude Code from the two switches in .secrets.env (FEATURE_LENS_MCP and
// FEATURE_POSTHOG_MCP). Run it again after changing either. .mcp.json is git-ignored: with PostHog's
// server direct it holds that server's API key; through Lens it holds MCP_TOKEN. Owner-readable only.
//
//   pnpm mcp:config
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../src/core/config.ts'
import { mcpClientConfig } from '../src/mcp/client-config.ts'

const { file, notes } = mcpClientConfig()
const path = join(ROOT, '.mcp.json')
writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 })
chmodSync(path, 0o600)
console.log(`Wrote ${path}`)
for (const n of notes) console.log(`  ${n}`)
if (!Object.keys(file.mcpServers).length) console.log('  No MCP server is on: Claude Code gets none from this folder.')
console.log('Restart Claude Code (or run /mcp) to pick up the change.')
