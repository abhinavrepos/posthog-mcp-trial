// Checks a deployment's settings against the real services, before anything depends on them.
//
//   pnpm doctor                         # the settings in .secrets.env (or TRIAGE_ENV_FILE)
//   TRIAGE_ENV_FILE=/etc/lens.env pnpm doctor
//
// Exits 1 if anything is wrong. Warnings don't fail it. Prints no secrets.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { config, ENV_FILE, ROOT } from '../src/core/config.ts'
import { appEvents } from '../src/core/appevents.ts'
import { clientSource, P } from '../src/core/props.ts'
import { mcpClientConfig, POSTHOG_SERVER } from '../src/mcp/client-config.ts'

type Level = 'ok' | 'warn' | 'fail'
const results: { level: Level; what: string; detail: string }[] = []
const say = (level: Level, what: string, detail = '') => {
    results.push({ level, what, detail })
    console.log(`${{ ok: '  ok ', warn: ' warn', fail: ' FAIL' }[level]}  ${what}${detail ? ` — ${detail}` : ''}`)
}
const get = async (url: string, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) })
    const text = await res.text()
    let body: any = undefined
    try {
        body = JSON.parse(text)
    } catch {}
    return { status: res.status, body, text }
}
// The event property names PostHog knows (names only, never values). Undefined when the key may not list them.
async function eventPropertyNames(host: string, projectId: string, headers: Record<string, string>): Promise<string[] | undefined> {
    try {
        const r = await get(`${host}/api/projects/${projectId}/property_definitions/?type=event&limit=1000`, headers)
        if (r.status !== 200) return undefined
        return ((r.body?.results || []) as { name: string }[]).map((x) => x.name).filter((n) => !n.startsWith('$'))
    } catch {
        return undefined
    }
}
function clientHint(names: string[] | undefined): string {
    if (!names) return 'Set PROP_CLIENT_ID in .secrets.env to the event property your app puts the client id in (add the property_definition:read scope to the key to list the candidates here).'
    const likely = names.filter((n) => /client|tenant|customer|account|company|org/i.test(n))
    const shown = (likely.length ? likely : names).slice(0, 12)
    return shown.length
        ? `Set PROP_CLIENT_ID in .secrets.env to one of the properties your events carry${likely.length ? ' that look like a client id' : ''}: ${shown.join(', ')}.`
        : 'Your events carry no custom properties: the app has to send the client id with each event.'
}
const isLocal = (u: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u)

console.log(`Settings file: ${ENV_FILE}${existsSync(ENV_FILE) ? '' : ' (not found: using the environment only)'}\n`)

// ------------------------------------------------------------------ PostHog
const ph = config.posthog
const auth = { authorization: `Bearer ${ph.personalApiKey}` }
if (!ph.projectId || !ph.personalApiKey) say('fail', 'PostHog settings', 'set POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY')
else {
    try {
        const health = await fetch(`${ph.host}/_health`, { signal: AbortSignal.timeout(10_000) })
        say(health.ok ? 'ok' : 'fail', `PostHog answers at ${ph.host}`, health.ok ? '' : `/_health → ${health.status}`)
        const key = await get(`${ph.host}/api/personal_api_keys/@current/`, auth)
        if (key.status !== 200) say('fail', 'Personal API key', `PostHog says ${key.status}: ${key.body?.detail || key.text.slice(0, 120)}`)
        else {
            const scopes: string[] = key.body.scopes || []
            const need = ['query:read', 'session_recording:read', 'error_tracking:read', 'person:read', 'project:read']
            const missing = need.filter((s) => !scopes.includes(s) && !scopes.includes('*'))
            const writes = scopes.filter((s) => s === '*' || s.endsWith(':write'))
            say(missing.length ? 'fail' : 'ok', `Personal API key "${key.body.label}"`, missing.length ? `missing scopes: ${missing.join(', ')}` : scopes.join(', '))
            if (writes.length) say('warn', 'The key can write', `${writes.join(', ')}; a read-only key is enough`)
            const teams: number[] | null = key.body.scoped_teams
            if (!teams?.length) say('warn', 'The key works on every project', `scope it to project ${ph.projectId}`)
            else if (!teams.includes(Number(ph.projectId))) say('fail', 'The key is not allowed on the project', `scoped to ${teams.join(', ')}, POSTHOG_PROJECT_ID is ${ph.projectId}`)
        }
        const project = await get(`${ph.host}/api/projects/${ph.projectId}/`, auth)
        say(project.status === 200 ? 'ok' : 'fail', `Project ${ph.projectId}`, project.status === 200 ? `"${project.body.name}"` : `→ ${project.status}`)
        if (project.status === 200 && ph.projectToken && project.body.api_token !== ph.projectToken) say('fail', 'POSTHOG_PROJECT_TOKEN', 'is not this project’s token')

        // The property names must match what the events carry.
        const p = config.properties
        const hog = async (q: string) => {
            const r = await fetch(`${ph.host}/api/projects/${ph.projectId}/query/`, {
                method: 'POST',
                headers: { ...auth, 'content-type': 'application/json' },
                body: JSON.stringify({ query: { kind: 'HogQLQuery', query: q } }),
                signal: AbortSignal.timeout(30_000),
            })
            const j: any = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(j.detail || `query → ${r.status}`)
            return j.results?.[0] as unknown[]
        }
        const [events, withClient, withName, withVersion] = (await hog(
            `SELECT count(), countIf(notEmpty(toString(${P.client}))), ${p.clientName ? `countIf(notEmpty(toString(properties.${p.clientName})))` : '0'}, ${
                p.version ? `countIf(notEmpty(toString(properties.${p.version})))` : '0'
            } FROM events WHERE timestamp > now() - INTERVAL 7 DAY`
        )) as number[]
        const share = (n: number) => (events ? `${Math.round((100 * n) / events)}% of ${events} events in 7 days` : 'no events in 7 days')
        // A wrong name is a setting to fix, not a broken install: Lens runs, but cannot tell which client a
        // session belongs to. So a warning, with the property names the events do carry.
        const clientLabel = p.clientFromDistinctId ? `Client from the distinct id (CLIENT_FROM_DISTINCT_ID=${p.clientFromDistinctId})` : `Client property "${p.client}" (PROP_CLIENT_ID)`
        if (events && !withClient) {
            const names = await eventPropertyNames(ph.host, ph.projectId, auth)
            say('warn', clientLabel, `no event in 7 days has it (of ${events}). ${p.clientFromDistinctId ? `Read as ${clientSource()}.` : clientHint(names)}`)
        } else say(!events ? 'warn' : 'ok', clientLabel, share(withClient))
        if (p.clientName) say(!events || withName ? 'ok' : 'warn', `Client name property "${p.clientName}" (PROP_CLIENT_NAME)`, share(withName))
        else say('ok', 'Client name', 'none: the client id is shown')
        try {
            const a = appEvents()
            if (a) {
                const [n, withDialog] = (await hog(
                    `SELECT count(), countIf(notEmpty(toString(properties.${a.properties.dialog!.name}))) FROM events WHERE timestamp > now() - INTERVAL 7 DAY AND event IN ('${a.events.screen.replace(/'/g, '')}', '${a.events.interaction.replace(/'/g, '')}')`
                )) as number[]
                say(!events || withDialog ? 'ok' : 'warn', `${a.app} events (APP_EVENTS_FILE)`, n ? `${Math.round((100 * withDialog) / n)}% of ${n} ${a.app} events in 7 days have a dialog` : `no "${a.events.screen}" or "${a.events.interaction}" events in 7 days`)
            }
        } catch (e) {
            say('fail', 'APP_EVENTS_FILE', (e as Error).message)
        }
        if (p.version) say(!events || withVersion ? 'ok' : 'warn', `Release property "${p.version}" (PROP_APP_VERSION)`, share(withVersion))
        else say('ok', 'Release property', 'none: releases are matched by date')
    } catch (e) {
        say('fail', `PostHog at ${ph.host}`, (e as Error).message)
    }
}
if (ph.publicHost && isLocal(ph.publicHost) && !isLocal(config.service.publicUrl)) say('warn', 'POSTHOG_PUBLIC_HOST is localhost', 'replay links will not open for other people')

// ------------------------------------------------------------------ MCP switches
const f = config.features
say('ok', `FEATURE_LENS_MCP: ${f.lensMcp ? 'on' : 'off'}`, f.lensMcp ? `${config.app.name}'s tools for Claude (/mcp and stdio)` : '/mcp answers 503, stdio exits')
if (!f.posthogMcp) say('ok', 'FEATURE_POSTHOG_MCP: off', "PostHog's MCP server is left out of .mcp.json and of the instructions")
else if (!ph.mcpUrl) say('ok', 'FEATURE_POSTHOG_MCP: on, but POSTHOG_MCP_URL is not set', "so PostHog's MCP server is not used")
else say('ok', 'FEATURE_POSTHOG_MCP: on', ph.mcpUrl)
{
    const want = JSON.stringify(mcpClientConfig().file)
    const path = join(ROOT, '.mcp.json')
    let have = ''
    try {
        have = JSON.stringify(JSON.parse(readFileSync(path, 'utf8')))
    } catch {}
    if (!have) say('warn', '.mcp.json missing', 'run pnpm mcp:config so Claude Code in this folder gets the servers that are on')
    else if (have !== want && config.mcp.name !== 'ticket-triage' && JSON.parse(have)?.mcpServers?.['ticket-triage']) say('warn', '.mcp.json uses the outdated ticket-triage server name', 'run pnpm mcp:config')
    else if (have !== want) say('warn', '.mcp.json does not match the switches', 'run pnpm mcp:config')
    else say('ok', '.mcp.json matches the switches')
}

// ------------------------------------------------------------------ PostHog's MCP server
if (ph.mcpUrl && f.posthogMcp) {
    if (!ph.mcpApiKey) say('fail', 'POSTHOG_MCP_URL is set without POSTHOG_MCP_API_KEY')
    else {
        const key = await get(`${ph.host}/api/personal_api_keys/@current/`, { authorization: `Bearer ${ph.mcpApiKey}` }).catch(() => null)
        const scopes: string[] = key?.body?.scopes || []
        if (key?.status !== 200) say('warn', 'PostHog MCP key', 'could not be checked here (is it for another PostHog?)')
        else if (scopes.includes('*') || scopes.includes('session_recording:read') || scopes.includes('session_recording:write'))
            say('fail', 'PostHog MCP key can read replays', 'make a key without session_recording scopes: Claude must never see replays')
        else say('ok', 'PostHog MCP key has no replay access', scopes.join(', '))
    }
}

// Check the same proxy endpoint the client will use, including upstream initialize.
const posthogEntry = mcpClientConfig().file.mcpServers[POSTHOG_SERVER]
if (ph.mcpViaLens && posthogEntry?.url === `http://127.0.0.1:${config.service.port}/posthog-mcp`) {
    try {
        const r = await fetch(String(posthogEntry.url), {
            method: 'POST',
            headers: { authorization: `Bearer ${config.service.mcpToken}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lens-doctor', version: '0' } } }),
            signal: AbortSignal.timeout(15_000),
        })
        const text = await r.text()
        say(r.ok && text.includes('Replays are private') ? 'ok' : 'fail', 'PostHog MCP proxy', r.ok ? (text.includes('Replays are private') ? 'answers with Lens routing instructions' : 'missing routing instructions') : `→ ${r.status}`)
        const session = r.headers.get('mcp-session-id')
        if (session) await fetch(String(posthogEntry.url), { method: 'DELETE', headers: { authorization: `Bearer ${config.service.mcpToken}`, 'mcp-session-id': session, 'mcp-protocol-version': '2025-06-18' }, signal: AbortSignal.timeout(3000) }).then((r) => r.body?.cancel()).catch(() => {})
    } catch {
        say('fail', 'PostHog MCP proxy', 'not answering; start the Lens service and check POSTHOG_MCP_URL')
    }
}

// ------------------------------------------------------------------ Jira
const j = config.jira
if (!j.baseUrl && !j.email && !j.apiToken) say('warn', 'Jira is not connected yet', 'webhooks and release outcomes stay off until JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are set')
else if (!j.baseUrl || !j.email || !j.apiToken) say('fail', 'Jira settings', 'set all three: JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN')
else {
    try {
        const me = await get(`${j.baseUrl}/rest/api/3/myself`, { authorization: `Basic ${Buffer.from(`${j.email}:${j.apiToken}`).toString('base64')}` })
        say(me.status === 200 ? 'ok' : 'fail', `Jira at ${j.baseUrl}`, me.status === 200 ? `signed in as ${me.body?.displayName || me.body?.emailAddress || j.email}` : `→ ${me.status}`)
    } catch (e) {
        say('fail', `Jira at ${j.baseUrl}`, (e as Error).message)
    }
}
if (!j.baseUrl) {
    // nothing more to check until Jira is connected
} else if (!j.webhookSecret) say('fail', 'JIRA_WEBHOOK_SECRET', 'without it every Jira webhook is rejected')
else if (j.webhookSecret.length < 24) say('warn', 'JIRA_WEBHOOK_SECRET is short', 'use 24+ random characters')

// ------------------------------------------------------------------ This service
const s = config.service
for (const [name, v] of [...(config.features.lensMcp ? [['MCP_TOKEN', s.mcpToken] as const] : []), ['CLIP_LINK_SECRET', s.clipLinkSecret] as const]) {
    if (!v) say('fail', name, 'not set (openssl rand -hex 32)')
    else if (v.length < 32) say('warn', `${name} is short`, `${v.length} characters; use 32+`)
    else say('ok', name, `${v.length} characters`)
}
if (!isLocal(s.publicUrl) && s.publicUrl.startsWith('http://')) say('warn', 'SERVICE_PUBLIC_URL is plain http', 'put HTTPS in front before sharing clip links or connecting Rovo or claude.ai')
else say('ok', 'SERVICE_PUBLIC_URL', s.publicUrl)
try {
    const r = await fetch(`http://localhost:${s.port}/healthz`, { signal: AbortSignal.timeout(3000) })
    say(r.ok ? 'ok' : 'warn', `Service on port ${s.port}`, r.ok ? 'running' : `→ ${r.status}`)
} catch {
    say('warn', `Service on port ${s.port}`, 'not running here (start it with scripts/stack.sh start service)')
}
if (config.screens) say('ok', 'SCREENS_FILE', `${config.screens.length} screens`)
else say('warn', 'SCREENS_FILE not set', 'using the demo app’s five screens')

// ------------------------------------------------------------------ Clips
const chrome = config.clip.chromePath
if (chrome && !existsSync(chrome)) say('fail', 'CHROME_HEADLESS_SHELL', `${chrome} does not exist`)
try {
    const ffmpeg = (await import('ffmpeg-static')).default as unknown as string | null
    say(ffmpeg && existsSync(ffmpeg) ? 'ok' : 'fail', 'ffmpeg for MP4 clips', ffmpeg || 'missing: run pnpm install')
} catch {
    say('fail', 'ffmpeg for MP4 clips', 'missing: run pnpm install')
}
if (!config.anthropic.apiKey) say('warn', 'ANTHROPIC_API_KEY not set', 'tickets are read with rules instead of Claude')

const fails = results.filter((r) => r.level === 'fail').length
const warns = results.filter((r) => r.level === 'warn').length
console.log(`\n${fails ? `${fails} problem(s)` : 'No problems'}${warns ? `, ${warns} warning(s)` : ''}.`)
process.exit(fails ? 1 : 0)
