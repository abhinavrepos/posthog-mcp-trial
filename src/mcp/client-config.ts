// The MCP servers Claude Code gets from .mcp.json, following the two switches:
//   FEATURE_LENS_MCP     this service's tools (stdio), on by default. LENS_CONTAINER=1 (a Lens without
//                        node outside it) would use its /mcp address over HTTP with MCP_TOKEN instead
//   FEATURE_POSTHOG_MCP  PostHog's own MCP server (HTTP), on by default, used only when POSTHOG_MCP_URL
//                        and POSTHOG_MCP_API_KEY are set; proxied when POSTHOG_MCP_VIA_LENS is on
// scripts/mcp-config.ts writes the result; scripts/doctor.ts compares it with .mcp.json.
import { config } from '../core/config.ts'

export const LENS_SERVER = config.mcp.name
export const POSTHOG_SERVER = 'posthog'

export interface McpClientConfig {
    mcpServers: Record<string, Record<string, unknown>>
}

export function mcpClientConfig(
    features = config.features,
    ph: { mcpUrl: string; mcpApiKey: string; mcpViaLens?: boolean } = config.posthog,
    lens: { container: boolean; port: number; token: string } = { container: process.env.LENS_CONTAINER === '1', port: config.service.port, token: config.service.mcpToken },
): { file: McpClientConfig; notes: string[] } {
    const servers: McpClientConfig['mcpServers'] = {}
    const notes: string[] = []
    if (features.lensMcp) {
        if (!lens.container) {
            servers[LENS_SERVER] = { command: 'node', args: ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'src/mcp/stdio.ts'] }
            notes.push(`${LENS_SERVER}: on (${config.app.name}'s tools, stdio)`)
        } else if (!lens.token) notes.push(`${LENS_SERVER}: off (set MCP_TOKEN: ${config.app.name} runs as a container, so Claude Code reaches its tools over HTTP)`)
        else {
            const url = `http://127.0.0.1:${lens.port}/mcp`
            servers[LENS_SERVER] = { type: 'http', url, headers: { Authorization: `Bearer ${lens.token}` } }
            notes.push(`${LENS_SERVER}: on (${config.app.name}'s tools, ${url})`)
        }
    } else notes.push(`${LENS_SERVER}: off (FEATURE_LENS_MCP=off)`)
    if (!features.posthogMcp) notes.push(`${POSTHOG_SERVER}: off (FEATURE_POSTHOG_MCP=off)`)
    else if (!ph.mcpUrl || !ph.mcpApiKey) notes.push(`${POSTHOG_SERVER}: off (set POSTHOG_MCP_URL and POSTHOG_MCP_API_KEY to add it)`)
    else {
        const viaLens = (ph.mcpViaLens ?? config.posthog.mcpViaLens) && (lens.container || !!lens.token)
        if (viaLens && !lens.token) notes.push(`${POSTHOG_SERVER}: off (set MCP_TOKEN for /posthog-mcp)`)
        else {
            const url = viaLens ? `http://127.0.0.1:${lens.port}/posthog-mcp` : ph.mcpUrl
            servers[POSTHOG_SERVER] = { type: 'http', url, headers: { Authorization: `Bearer ${viaLens ? lens.token : ph.mcpApiKey}` } }
            notes.push(`${POSTHOG_SERVER}: on (${url}${viaLens ? ', via Lens' : ''})`)
        }
    }
    return { file: { mcpServers: servers }, notes }
}
