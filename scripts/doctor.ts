// Checks a deployment's settings against the real services, before anything depends on them.
//
//   pnpm doctor                         # the settings in .secrets.env (or TRIAGE_ENV_FILE)
//   TRIAGE_ENV_FILE=/etc/lens.env pnpm doctor
//
// Exits 1 if anything is wrong. Warnings don't fail it. Prints no secrets.
import { existsSync } from 'node:fs'

import { config, ENV_FILE } from '../src/core/config.ts'

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
            `SELECT count(), countIf(notEmpty(toString(properties.${p.client}))), countIf(notEmpty(toString(properties.${p.clientName}))), ${
                p.version ? `countIf(notEmpty(toString(properties.${p.version})))` : '0'
            } FROM events WHERE timestamp > now() - INTERVAL 7 DAY`
        )) as number[]
        const share = (n: number) => (events ? `${Math.round((100 * n) / events)}% of ${events} events in 7 days` : 'no events in 7 days')
        say(!events ? 'warn' : withClient ? 'ok' : 'fail', `Client property "${p.client}" (PROP_CLIENT_ID)`, share(withClient))
        say(!events || withName ? 'ok' : 'warn', `Client name property "${p.clientName}" (PROP_CLIENT_NAME)`, share(withName))
        if (p.version) say(!events || withVersion ? 'ok' : 'warn', `Release property "${p.version}" (PROP_APP_VERSION)`, share(withVersion))
        else say('ok', 'Release property', 'none: releases are matched by date')
    } catch (e) {
        say('fail', `PostHog at ${ph.host}`, (e as Error).message)
    }
}
if (ph.publicHost && isLocal(ph.publicHost) && !isLocal(config.service.publicUrl)) say('warn', 'POSTHOG_PUBLIC_HOST is localhost', 'replay links will not open for other people')

// ------------------------------------------------------------------ PostHog's MCP server
if (ph.mcpUrl) {
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

// ------------------------------------------------------------------ Jira
const j = config.jira
if (!j.email || !j.apiToken) say('fail', 'Jira settings', 'set JIRA_EMAIL and JIRA_API_TOKEN')
else {
    try {
        const me = await get(`${j.baseUrl}/rest/api/3/myself`, { authorization: `Basic ${Buffer.from(`${j.email}:${j.apiToken}`).toString('base64')}` })
        say(me.status === 200 ? 'ok' : 'fail', `Jira at ${j.baseUrl}`, me.status === 200 ? `signed in as ${me.body?.displayName || me.body?.emailAddress || j.email}` : `→ ${me.status}`)
    } catch (e) {
        say('fail', `Jira at ${j.baseUrl}`, (e as Error).message)
    }
}
if (isLocal(j.baseUrl)) say('warn', 'Jira is the local mock', 'set JIRA_BASE_URL to your Jira Cloud site for real tickets')
if (!j.webhookSecret) say('fail', 'JIRA_WEBHOOK_SECRET', 'without it every Jira webhook is rejected')
else if (j.webhookSecret.length < 24) say('warn', 'JIRA_WEBHOOK_SECRET is short', 'use 24+ random characters')

// ------------------------------------------------------------------ This service
const s = config.service
for (const [name, v] of [['MCP_TOKEN', s.mcpToken], ['CLIP_LINK_SECRET', s.clipLinkSecret]] as const) {
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
