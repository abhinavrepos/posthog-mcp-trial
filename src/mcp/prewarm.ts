// Background pre-warm: the heaviest analysis answers chat asks most (with their default arguments) are
// computed every LENS_PREWARM_MINUTES (default 15; 0 turns it off), one at a time, through a real
// in-process MCP client, so they take exactly the path a chat question takes. The answers are kept until
// the next round, so the first question of the day is answered from memory. LENS_PREWARM_TOOLS lists the
// tools (comma-separated). A round never overlaps the next; failures are logged and left for chat.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { lensServerInfo } from './server-info.ts'
import { CACHED_TOOLS, registerTools, withPrewarm } from './tools.ts'
import { surveysActive } from '../core/config.ts'
import { surveyOverview } from '../core/surveys.ts'

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))
export const DEFAULT_PREWARM = ['reval_brief', 'top_pains', 'dialog_friction', 'client_signals', 'discover_workflows', 'message_doctor']

export function prewarmSettings(env = process.env): { minutes: number; tools: string[] } {
    const minutes = Math.min(1440, Math.max(0, Math.floor(Number(env.LENS_PREWARM_MINUTES ?? 15)) || 0))
    const tools = (env.LENS_PREWARM_TOOLS ? env.LENS_PREWARM_TOOLS.split(',').map((t) => t.trim()) : DEFAULT_PREWARM).filter((t) => CACHED_TOOLS.has(t))
    return { minutes, tools }
}

/** One round: each tool once, in order. Returns how long each took (ms) or its error. */
export async function prewarmRound(tools: string[], keepMs: number): Promise<Record<string, number | string>> {
    const server = new McpServer(lensServerInfo)
    registerTools(server, undefined, { who: 'prewarm', surveyRole: 'none', dashboardRole: 'none', admin: false })
    const client = new Client({ name: 'lens-prewarm', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    const out: Record<string, number | string> = {}
    try {
        for (const name of tools) {
            const t = Date.now()
            try {
                const r = await withPrewarm(keepMs, () => client.callTool({ name, arguments: {} }, undefined, { timeout: 300_000 }))
                out[name] = r.isError ? 'error: ' + JSON.stringify(r.content).slice(0, 120) : Date.now() - t
            } catch (e) { out[name] = 'error: ' + (e as Error).message.slice(0, 120) }
        }
    } finally { await client.close(); await server.close() }
    return out
}

// The survey list (Surveys page and list_surveys, 30 days by default) keeps answers 30-60 s and serves a
// marked stale one for 5 minutes while it refreshes; reading it every 4 minutes keeps it always ready.
// One light query and one API page; skipped when surveys are off or the pre-warm is off.
export const SURVEY_REFRESH_MS = 4 * 60_000
let surveyTimer: NodeJS.Timeout | undefined
function startSurveyRefresh(): void {
    if (surveyTimer || !surveysActive()) return
    const read = () => surveyOverview(30).catch((e) => log('survey refresh failed', { error: (e as Error).message }))
    setTimeout(read, 90_000).unref()
    surveyTimer = setInterval(read, SURVEY_REFRESH_MS)
    surveyTimer.unref()
}

let timer: NodeJS.Timeout | undefined, running = false
export function startPrewarm(): void {
    const { minutes, tools } = prewarmSettings()
    if (!minutes) return
    startSurveyRefresh()
    if (!tools.length || timer) return
    const keep = (minutes + 5) * 60_000
    const round = async () => {
        if (running) return
        running = true
        try { log('prewarm round', await prewarmRound(tools, keep)) } catch (e) { log('prewarm failed', { error: (e as Error).message }) } finally { running = false }
    }
    // First round two minutes after start, so the service and PostHog settle first.
    setTimeout(round, 120_000).unref()
    timer = setInterval(round, minutes * 60_000)
    timer.unref()
}
