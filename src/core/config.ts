// Settings come from the environment, with .secrets.env (git-ignored) filling anything unset.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
        if (process.env[key] === undefined) process.env[key] = value
    }
}
loadEnvFile(join(ROOT, '.secrets.env'))

const env = (k: string, d = ''): string => process.env[k] ?? d
const stripSlash = (s: string) => s.replace(/\/+$/, '')

export const config = {
    posthog: {
        // Where this service reaches the PostHog API (same machine, through Caddy).
        host: stripSlash(env('POSTHOG_HOST', 'http://localhost')),
        // Where browsers reach PostHog, and the base for replay links in reports.
        publicHost: stripSlash(env('POSTHOG_PUBLIC_HOST', env('POSTHOG_HOST', 'http://localhost'))),
        projectId: env('POSTHOG_PROJECT_ID'),
        projectToken: env('POSTHOG_PROJECT_TOKEN'), // phc_… public ingestion token
        personalApiKey: env('POSTHOG_PERSONAL_API_KEY'), // phx_… read access for queries and snapshots
    },
    jira: {
        baseUrl: stripSlash(env('JIRA_BASE_URL', 'http://localhost:4000')),
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
        model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    },
}

export function requirePosthog(): void {
    const missing = (['projectId', 'personalApiKey'] as const).filter((k) => !config.posthog[k])
    if (missing.length) {
        throw new Error(`PostHog is not configured: set ${missing.map((k) => (k === 'projectId' ? 'POSTHOG_PROJECT_ID' : 'POSTHOG_PERSONAL_API_KEY')).join(', ')} in .secrets.env`)
    }
}
