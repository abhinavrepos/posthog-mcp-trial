// Dashboard tools in chat: placeholder until Agent 3 fills it in.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ChatCaller } from '../service/access.ts'
export const DASHBOARD_TOOLS: string[] = []
export function registerDashboardTools(_server: McpServer, _caller?: Pick<ChatCaller, 'who' | 'email' | 'dashboardRole' | 'admin'>): void {}
