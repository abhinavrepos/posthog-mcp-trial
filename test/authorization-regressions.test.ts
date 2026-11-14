import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-authorization-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const access = await import('../src/service/access.ts')
const { canConnect } = await import('../src/service/connect.ts')
const { config } = await import('../src/core/config.ts')
const { clipUrl, verifyClipLink } = await import('../src/core/links.ts')
const { db } = await import('../src/core/db.ts')
after(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const tools = readFileSync('src/mcp/tools.ts', 'utf8')

// Evaluate the real handlers with fake downstream work, without Chrome, PostHog or service workers.
function callback(start: string, end: string, deps: Record<string, unknown>, source = tools) {
    const code = source.slice(source.indexOf(start), source.indexOf(end)).replace(/\n    \)\s*$/, '')
    return new Function(...Object.keys(deps), 'return ' + stripTypeScriptTypes(code))(...Object.values(deps))
}

test('Connect and personal keys accept the same clip, survey and dashboard roles', () => {
    access.setAccessSettings({ default_role: 'none' }, 'test')
    for (const role of ['none', 'watch', 'download', 'admin'] as const) {
        for (const surveys of ['none', 'view', 'edit', 'launch'] as const) {
            for (const dashboards of ['none', 'view', 'share'] as const) {
                const email = `${role}-${surveys}-${dashboards}@test.com`
                access.setPerson(email, role, 'test')
                access.setSurveyRole(email, surveys, 'test')
                access.setDashboardRole(email, dashboards, 'test')
                const viewer = { email, role, surveys, dashboards, posthog_admin: false }
                const { token } = access.createMcpToken(viewer, 'test')
                const expected = role !== 'none' || surveys !== 'none' || dashboards !== 'none'
                assert.equal(canConnect(viewer as never), expected)
                assert.equal(!!access.chatCaller(token, ''), expected)
                if (dashboards !== 'none' && role === 'none' && surveys === 'none') {
                    access.setDashboardRole(email, 'none', 'test')
                    assert.equal(access.chatCaller(token, ''), undefined, 'removing the last role invalidates the key')
                }
            }
        }
    }
})

test('MCP triage replaces signed MP4 links with a registered authenticated clip page', async () => {
    const name = 'session_0-30.mp4'
    for (const caller of [undefined, { who: 'watch@test' }, { who: 'survey@test' }, { who: 'admin@test', admin: true }]) {
        let recorded = false
        const handler = callback('async ({ summary, description, kind, reporter_timezone, clip })', '\n    // ------------------------------------------------------------------ release outcomes', {
            triage: async () => ({ clip: { name, url: 'https://test/clips/signed?sig=secret' } }),
            ai: undefined, caller, config,
            recordClip: async (clip: { name: string }) => { assert.equal(clip.name, name); recorded = true },
            renderReport: (r: { clip: { url: string } }) => r.clip.url,
            reportResult: (r: { clip: { url: string } }) => r.clip.url,
            text: (s: string) => s,
        })
        assert.equal(await handler({ summary: 'test', clip: true }), `${config.service.publicUrl}/replays?clip=${name}`)
        assert.ok(recorded)
    }
})

test('existing signed links stop streaming when sharing is disabled and resume when enabled', async () => {
    const source = readFileSync('src/service/server.ts', 'utf8')
    let streamed = 0
    const handler = callback('async function serveClip', '\nfunction featureState', {
        basename, join, config, verifyClipLink, loadAccess: access.loadAccess,
        existsSync: () => true, getClip: () => undefined, audit: () => {},
        streamMp4: () => { streamed++ }, send: (_res: unknown, status: number) => status,
    }, source)
    config.service.clipLinkSecret = 'test-secret'
    const url = new URL(clipUrl('session_0-30.mp4'), 'http://test')
    for (const enabled of [true, false, true]) {
        access.setAccessSettings({ allow_share_links: enabled }, 'test')
        const before = streamed
        const result = await handler({ headers: {} }, {}, url)
        assert.equal(streamed - before, enabled ? 1 : 0)
        if (!enabled) assert.equal(result, 403)
    }
    url.searchParams.set('sig', 'bad')
    assert.equal(await handler({ headers: {} }, {}, url), 403)
})

test('session story opts out of recording timings while keeping the event story', async () => {
    const source = readFileSync('src/core/appevents.ts', 'utf8')
    const code = source.slice(source.indexOf('export async function sessionStory'), source.indexOf('/** The server calls behind each attempt'))
    let reads = 0
    const deps = {
        required: () => ({ app: 'test', events: {} }), columns: () => '',
        hogql: async () => [{ ts: '2026-01-01T00:00:00Z' }], toRaw: (x: unknown) => x, toSteps: (x: unknown) => x,
        dialogNames: async () => new Map(), recordingSpans: async () => new Map([['s', { start: '2026-01-01T00:00:00Z' }]]),
        sessionTimings: async () => { reads++; return new Map() },
        renderStory: (_steps: unknown, _reg: unknown, opts: { timings?: unknown }) => ({ lines: ['Save pressed', ...(opts.timings ? ['server timing'] : [])], dialogs: 1, submits: 1, failed: 0, errors: [] }),
        nameLookup: () => ({}), replayUrl: () => 'https://test/replay',
    }
    const story = new Function(...Object.keys(deps), stripTypeScriptTypes(code.replace('export ', '')) + '\nreturn sessionStory')(...Object.values(deps))
    assert.deepEqual((await story('s', { network: false })).story, ['Save pressed'])
    assert.equal(reads, 0)
    assert.deepEqual((await story('s', { network: true })).story, ['Save pressed', 'server timing'])
    assert.equal(reads, 1)
})

test('MCP recording tools enforce insights and partition cached session stories', async () => {
    let reads = 0
    for (const insights of [false, true]) {
        const timings = callback('async ({ client, dialog, when: w, timezone, sessions })', "\n    server.registerTool(\n        'top_pains'", {
            insights, text: (s: string) => s, parseTimeWindow: () => ({}),
            slowAttempts: async () => { reads++; return {} }, json: () => 'timings', app: 'test',
        })
        assert.match(await timings({}), insights ? /timings/ : /require replay insights/)
        const story = callback('async ({ session_id, max_lines })', "\n    server.registerTool(\n        'dialog_friction'", {
            insights, sessionIdOf: (s: string) => s, text: (s: string) => s,
            sessionStory: async (_id: string, opts: { network: boolean }) => {
                assert.equal(opts.network, insights)
                return { session_id: 's', start: '', errors: [], story: ['event story'], network: 'private timing' }
            },
        })
        const result = await story({ session_id: 's', max_lines: 20 })
        assert.match(result, /event story/)
        assert.equal(result.includes('private timing'), insights)
    }
    assert.equal(reads, 1)
    // Exercise the registration wrapper to verify cache identity, including privileged-first calls.
    // The wrapper as registerTools uses it: wrapTools(server, insights), the safety pass stubbed out.
    const wrapper = tools.slice(tools.indexOf('export function wrapTools'), tools.indexOf('export function registerTools')).replace('export function', 'function')
        + '\nwrapTools(server, !!caller?.admin || caller?.insights === true)'
    const cache = new Map<string, unknown>()
    const cachedToolCall = async (name: string, args: unknown, run: () => unknown) => {
        const key = name + JSON.stringify(args)
        if (!cache.has(key)) cache.set(key, await run())
        return cache.get(key)
    }
    for (const caller of [{ insights: true }, { insights: false }, { admin: true }, undefined]) {
        const insights = !!caller?.admin || caller?.insights === true
        let call!: (args: unknown) => Promise<string>
        const server = { registerTool: (_name: string, _cfg: unknown, cb: typeof call) => { call = cb } }
        new Function('caller', 'server', 'CACHED_TOOLS', 'cachedToolCall', 'DIRECT_CALL', 'safeResult', stripTypeScriptTypes(wrapper))(caller, server, new Set(['session_story']), cachedToolCall, '', async (r: unknown) => r)
        server.registerTool('session_story', {}, async () => insights ? 'recording timing' : 'event only')
        assert.equal(await call({ session_id: 's' }), insights ? 'recording timing' : 'event only')
    }
})
