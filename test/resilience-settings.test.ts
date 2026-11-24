import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// Resilience drill: settings that are missing or wrong. A wrong value must either stop Lens at start with a
// message naming the setting, or keep the documented default; never silently break what it controls.
const dir = mkdtempSync(join(tmpdir(), 'lens-resilience-settings-'))
const badJson = join(dir, 'app-events.json')
writeFileSync(badJson, '{"app": "Reval", "events": {')
const stderr: string[] = []
const write = process.stderr.write.bind(process.stderr)
process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
Object.assign(process.env, {
    TRIAGE_ENV_FILE: '/tmp/lens-resilience-settings-absent.env', TRIAGE_DB: join(dir, 'triage.db'), TASKS_DB: join(dir, 'tasks.db'),
    CLIP_LINK_TTL_HOURS: 'one week', CLIP_CACHE_MAX_MB: '', APP_EVENTS_FILE: badJson, CLIP_LINK_SECRET: 'link-secret-for-test',
})
const { config } = await import('../src/core/config.ts')
process.stderr.write = write
const { clipUrl, verifyClipLink } = await import('../src/core/links.ts')
const { appEvents } = await import('../src/core/appevents.ts')
const { createBriefingScheduler } = await import('../src/core/briefingdelivery.ts')
const { registerJob, jobStates, resetJobs } = await import('../src/core/jobhealth.ts')
after(() => rmSync(dir, { recursive: true, force: true }))

test('a clip link lifetime that is not a number keeps the default instead of making every shared link invalid', () => {
    assert.equal(config.service.clipLinkTtlHours, 168)
    const url = new URL(clipUrl('clip.mp4', Date.now()))
    assert.match(url.searchParams.get('exp')!, /^\d+$/)
    assert.ok(verifyClipLink('clip.mp4', url.searchParams.get('exp'), url.searchParams.get('sig')), 'the link opens')
    assert.ok(stderr.some(l => /"setting ignored".*CLIP_LINK_TTL_HOURS must be a number; using the default 168/.test(l)), 'said on stderr')
})

test('an empty clip cache limit means the default, not "every recording is too large"', () => {
    assert.equal(config.clip.maxCacheMb, 2048)
})

test('an APP_EVENTS_FILE that is not valid JSON, or does not exist, names the setting and the file', () => {
    assert.throws(() => appEvents(), (e: Error) => /^APP_EVENTS_FILE: .*app-events\.json is not valid JSON \(/.test(e.message))
    const old = config.appEventsFile
    config.appEventsFile = 'config/no-such-app-events.json'
    try {
        assert.throws(() => appEvents(), (e: Error) => e.message === "APP_EVENTS_FILE: cannot read config/no-such-app-events.json (the file does not exist); set APP_EVENTS_FILE to the app's event dictionary, e.g. config/app-events.reval.json")
    } finally { config.appEventsFile = old }
})

test('wrong briefing settings show on the System page instead of the job waiting forever', async () => {
    resetJobs()
    const logs: string[] = []
    registerJob('briefing_delivery', 'Briefing delivery', 7 * 86_400_000)
    const tick = createBriefingScheduler({ webhook: 'https://chat.invalid/hook', kind: 'teams', day: 'monday', hour: Number('8am') }, { log: (m: string) => { logs.push(m) } })
    const quiet = console.log; console.log = () => {}
    try { await tick(new Date('2026-11-23T08:00:00Z')) } finally { console.log = quiet }
    const state = jobStates().find(j => j.key === 'briefing_delivery')!
    assert.equal(state.level, 'warn')
    assert.equal(state.reason, 'briefing settings are not valid: LENS_BRIEFING_DAY (sun to sat), LENS_BRIEFING_HOUR (0 to 23); retrying')
    assert.deepEqual(logs, ['Briefing delivery configuration is invalid'])
    resetJobs()
})
