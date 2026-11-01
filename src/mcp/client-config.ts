// The MCP servers Claude Code gets from .mcp.json, following the two switches:
//   FEATURE_LENS_MCP     this service's tools (stdio), on by default
//   FEATURE_POSTHOG_MCP  PostHog's own MCP server (HTTP), on by default, used only when POSTHOG_MCP_URL
//                        and POSTHOG_MCP_API_KEY are set
// scripts/mcp-config.ts writes the result; scripts/doctor.ts compares it with .mcp.json.
import { config } from '../core/config.ts'

export const LENS_SERVER = 'ticket-triage'
export const POSTHOG_SERVER = 'posthog'

export interface McpClientConfig {
    mcpServers: Record<string, Record<string, unknown>>
}

export function mcpClientConfig(features = config.features, ph: { mcpUrl: string; mcpApiKey: string } = config.posthog): { file: McpClientConfig; notes: string[] } {
    const servers: McpClientConfig['mcpServers'] = {}
    const notes: string[] = []
    if (features.lensMcp) {
        servers[LENS_SERVER] = { command: 'node', args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/mcp/stdio.ts'] }
        notes.push(`${LENS_SERVER}: on (${config.app.name}'s tools, stdio)`)
    } else notes.push(`${LENS_SERVER}: off (FEATURE_LENS_MCP=off)`)
    if (!features.posthogMcp) notes.push(`${POSTHOG_SERVER}: off (FEATURE_POSTHOG_MCP=off)`)
    else if (!ph.mcpUrl || !ph.mcpApiKey) notes.push(`${POSTHOG_SERVER}: off (set POSTHOG_MCP_URL and POSTHOG_MCP_API_KEY to add it)`)
    else {
        servers[POSTHOG_SERVER] = { type: 'http', url: ph.mcpUrl, headers: { Authorization: `Bearer ${ph.mcpApiKey}` } }
        notes.push(`${POSTHOG_SERVER}: on (${ph.mcpUrl})`)
    }
    return { file: { mcpServers: servers }, notes }
}
