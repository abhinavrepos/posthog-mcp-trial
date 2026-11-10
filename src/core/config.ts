// Settings come from the environment, with an env file filling anything unset: .secrets.env
// (git-ignored) by default, or the file TRIAGE_ENV_FILE names. .env.example lists every setting.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function loadEnvFile(path: string): void {
    if (!existsSync(path)) return
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq < 1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
        else value = value.replace(/\s+#.*$/, '') // "KEY=value   # comment"
        // An empty value in the file means "not set", so the default applies.
        if (value !== '' && process.env[key] === undefined) process.env[key] = value
    }
}
const envFile = process.env.TRIAGE_ENV_FILE || '.secrets.env'
export const ENV_FILE = isAbsolute(envFile) ? envFile : join(ROOT, envFile)
loadEnvFile(ENV_FILE)

const env = (k: string, d = ''): string => process.env[k] ?? d
const stripSlash = (s: string) => s.replace(/\/+$/, '')
// Property names go into HogQL as identifiers, so only plain names are allowed.
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/
function propName(key: string, fallback: string, optional = false): string {
    const v = env(key, fallback).trim()
    if (optional && (v === '' || v === 'none')) return ''
    if (!IDENT.test(v)) throw new Error(`${key} must be a plain property name (letters, digits, _ and $), got "${v}"`)
    return v
}

function intSetting(key: string, fallback: number, min: number, max: number): number {
    const v = env(key).trim()
    if (v === '') return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be a whole number from ${min} to ${max}, got "${v}"`)
    return n
}

// A one-character separator; it goes into HogQL as a string literal, so quotes and backslashes are refused.
function separator(key: string, fallback: string): string {
    const v = env(key, fallback)
    if (v.length !== 1 || /['"\\\s]/.test(v)) throw new Error(`${key} must be one character (not a quote, backslash or space), got "${v}"`)
    return v
}

/** An on/off switch: on, off, true, false, yes, no, 1 or 0. Anything else stops the service at start. */
export function flag(key: string, fallback: boolean): boolean {
    const v = env(key).trim().toLowerCase()
    if (v === '') return fallback
    if (['on', 'true', 'yes', '1'].includes(v)) return true
    if (['off', 'false', 'no', '0'].includes(v)) return false
    throw new Error(`${key} must be on or off, got "${env(key)}"`)
}

/** MCP client keys and serverInfo use the same plain name. */
export function mcpName(value: string): string {
    if (!/^[a-z0-9-]{1,64}$/.test(value) || value === 'posthog')
        throw new Error('LENS_MCP_NAME must be a plain lowercase name (1-64 characters: a-z, 0-9, hyphens), other than posthog')
    return value
}

export interface Screen {
    path: string
    name: string
    aliases: string[]
}
/** Your app's screens, so tickets that say "the invoices page" find /invoices. From SCREENS_FILE (JSON). */
function loadScreens(): Screen[] | undefined {
    const file = env('SCREENS_FILE')
    if (!file) return undefined
    const path = isAbsolute(file) ? file : join(ROOT, file)
    const list = JSON.parse(readFileSync(path, 'utf8')) as Screen[]
    if (!Array.isArray(list) || !list.every((x) => typeof x.path === 'string' && x.path.startsWith('/') && typeof x.name === 'string'))
        throw new Error(`${file} must be a JSON list of {"path": "/invoices", "name": "Invoices", "aliases": ["billing"]}`)
    return list.map((x) => ({ path: x.path, name: x.name, aliases: (x.aliases || []).map((a) => String(a).toLowerCase()) }))
}

export const config = {
    mcp: { name: mcpName(env('LENS_MCP_NAME', 'lens')) },
    posthog: {
        // Where this service reaches the PostHog API (same machine, through Caddy).
        host: stripSlash(env('POSTHOG_HOST', 'http://localhost')),
        // Where browsers reach PostHog, and the base for replay links in reports.
        publicHost: stripSlash(env('POSTHOG_PUBLIC_HOST', env('POSTHOG_HOST', 'http://localhost'))),
        projectId: env('POSTHOG_PROJECT_ID'),
        projectToken: env('POSTHOG_PROJECT_TOKEN'), // phc_… public ingestion token
        personalApiKey: env('POSTHOG_PERSONAL_API_KEY'), // phx_… read access for queries and snapshots
        // Only used by setup and load-test scripts, never by the service.
        adminEmail: env('POSTHOG_ADMIN_EMAIL'),
        adminPassword: env('POSTHOG_ADMIN_PASSWORD'),
        // PostHog's own MCP server, if Claude should have it too (pnpm mcp:config writes .mcp.json).
        // https://mcp.posthog.com/mcp for PostHog Cloud, or your own copy for a self-hosted PostHog.
        mcpUrl: env('POSTHOG_MCP_URL'),
        mcpViaLens: flag('POSTHOG_MCP_VIA_LENS', true),
        mcpApiKey: env('POSTHOG_MCP_API_KEY'), // a separate personal key, without session_recording:read
    },
    // Which MCP servers Claude gets. Each can be switched off on its own; both are on by default.
    features: {
        // This service's MCP tools (replay links, tickets, clients, releases): /mcp over HTTP, the
        // stdio server, and its entry in .mcp.json.
        lensMcp: flag('FEATURE_LENS_MCP', true),
        // PostHog's own MCP server in .mcp.json, and the instructions that send Claude to it. Takes
        // effect only with POSTHOG_MCP_URL and POSTHOG_MCP_API_KEY set.
        posthogMcp: flag('FEATURE_POSTHOG_MCP', true),
    },
    // How your events name things. The defaults match the demo app.
    properties: {
        client: propName('PROP_CLIENT_ID', process.env.RELEASES_CLIENT_PROPERTY || 'client_id'), // event property: client id
        clientName: propName('PROP_CLIENT_NAME', 'client_name', true), // event property: client display name, '' if none (the id is shown)
        version: propName('PROP_APP_VERSION', process.env.RELEASES_VERSION_PROPERTY ?? 'app_version', true), // event property: release, '' if none
        personEmail: propName('PROP_PERSON_EMAIL', 'email'), // person property: the user's email
        // When the client is part of the user id instead of a property, e.g. Reval's
        // ENV|SITE|CLIENT|USER: the part number (1 = first) and the separator. 0 = use PROP_CLIENT_ID.
        clientFromDistinctId: intSetting('CLIENT_FROM_DISTINCT_ID', 0, 0, 9),
        distinctIdSeparator: separator('DISTINCT_ID_SEPARATOR', '|'),
    },
    // The app's own events (dialogs, buttons, messages): a JSON file, see config/app-events.reval.json.
    appEventsFile: env('APP_EVENTS_FILE'),
    screens: loadScreens(),
    app: {
        name: env('APP_NAME', 'PostHog Lens'),
        tag: env('APP_TAG', 'for ION'),
    },
    jira: {
        baseUrl: stripSlash(env('JIRA_BASE_URL')),
        email: env('JIRA_EMAIL'),
        apiToken: env('JIRA_API_TOKEN'),
        webhookSecret: env('JIRA_WEBHOOK_SECRET'),
        // Issue types that get triaged, and how each is reported.
        rciIssueType: env('JIRA_RCI_ISSUE_TYPE', 'RCI'),
        riskIssueType: env('JIRA_RISK_ISSUE_TYPE', 'MMT Risk'),
    },
    service: {
        port: Number(env('SERVICE_PORT', '8080')),
        // Base URL people use to open clip links (served by the triage service).
        publicUrl: stripSlash(env('SERVICE_PUBLIC_URL', 'http://localhost:8080')),
        // Bearer token for /mcp and signing key for clip links. Required for anything but localhost.
        mcpToken: env('MCP_TOKEN'),
        clipLinkSecret: env('CLIP_LINK_SECRET'),
        clipLinkTtlHours: Number(env('CLIP_LINK_TTL_HOURS', '168')),
        // The status page (deploy/status), which the System page reads.
        statusUrl: stripSlash(env('STATUS_URL', 'http://127.0.0.1:8090')),
        statusPassword: env('STATUS_PASSWORD'),
    },
    clip: {
        cacheDir: env('CLIP_CACHE_DIR', join(ROOT, '.cache')),
        outDir: env('CLIP_OUT_DIR', join(ROOT, 'clips')),
        chromePath: env('CHROME_HEADLESS_SHELL', ''),
        // Hosts the replay page may resolve. Everything else is blocked, because recordings are
        // untrusted content. Comma-separated.
        allowedHosts: env('CLIP_ALLOWED_HOSTS', 'localhost'),
        maxCacheMb: Number(env('CLIP_CACHE_MAX_MB', '2048')),
    },
    anthropic: {
        apiKey: env('ANTHROPIC_API_KEY'),
        model: env('ANTHROPIC_MODEL', 'claude-opus-5-5'),
    },
}

/** PostHog's MCP server is in use: switched on and configured. */
/** Jira is connected: a site and a login. Without it, webhooks answer 503 and release outcomes keep the numbers they have. */
export const jiraConfigured = () => !!config.jira.baseUrl && !!config.jira.email && !!config.jira.apiToken

export const posthogMcpActive = (): boolean => config.features.posthogMcp && !!config.posthog.mcpUrl && !!config.posthog.mcpApiKey

export function requirePosthog(): void {
    const missing = (['projectId', 'personalApiKey'] as const).filter((k) => !config.posthog[k])
    if (missing.length) {
        throw new Error(`PostHog is not configured: set ${missing.map((k) => (k === 'projectId' ? 'POSTHOG_PROJECT_ID' : 'POSTHOG_PERSONAL_API_KEY')).join(', ')} in .secrets.env`)
    }
}
