// Who may do what with surveys: survey roles on the page and in chat, personal chat tokens, and
// PostHog's own survey commands refused. Uses its own database.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'survey-access-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
Object.assign(process.env, { POSTHOG_SURVEY_API_KEY: 'phx_test', POSTHOG_PROJECT_ID: '1', APP_EVENTS_FILE: 'config/app-events.reval.json', FEATURE_SURVEYS: 'on' })
after(() => rmSync(dir, { recursive: true, force: true }))
const access = await import('../src/service/access.ts')
const { surveyToolNames } = await import('../src/mcp/surveytools.ts')
const { replayRefusal } = await import('../src/mcp/posthog-proxy.ts')

test('survey roles: admins launch, people get what an admin set, others the default', () => {
    access.setPerson('admin@x.com', 'admin', 'test')
    assert.equal(access.surveyRoleOf('admin@x.com', 'admin'), 'launch')
    assert.equal(access.surveyRoleOf('pm@x.com', 'watch'), 'none', 'default is none')
    access.setSurveyRole('pm@x.com', 'edit', 'admin@x.com')
    assert.equal(access.surveyRoleOf('PM@x.com', 'watch'), 'edit')
    access.setSurveySettings({ default_role: 'view' }, 'admin@x.com')
    assert.equal(access.surveyRoleOf('other@x.com', 'none'), 'view')
    assert.throws(() => access.setSurveySettings({ default_role: 'launch' }, 'admin@x.com'), /cannot be launch/)
    access.resetSurveyRole('pm@x.com', 'admin@x.com')
    assert.equal(access.surveyRoleOf('pm@x.com', 'watch'), 'view')
    const log = access.readAudit({ action: 'access.survey' }).map((r) => r.action)
    assert.ok(log.includes('access.survey_role_set') && log.includes('access.survey_settings') && log.includes('access.survey_role_reset'))
})

test('chat: personal tokens say who asks; the shared token gets the role an admin chose; revoked tokens stop', () => {
    access.setSurveyRole('lead@x.com', 'launch', 'admin@x.com')
    const { token, id } = access.createMcpToken({ email: 'lead@x.com', posthog_admin: false }, 'Claude')
    assert.match(token, /^lens_/)
    const me = access.chatCaller(token, 'shared-secret-token')
    assert.deepEqual([me?.who, me?.shared, me?.surveyRole], ['lead@x.com', false, 'launch'])
    const shared = access.chatCaller('shared-secret-token', 'shared-secret-token')
    assert.deepEqual([shared?.shared, shared?.surveyRole], [true, 'view'], 'shared token: view by default')
    access.setSurveySettings({ shared_token_role: 'none' }, 'admin@x.com')
    assert.equal(access.chatCaller('shared-secret-token', 'shared-secret-token')?.surveyRole, 'none')
    assert.equal(access.chatCaller('lens_' + 'x'.repeat(32), 'shared-secret-token'), undefined, 'unknown token refused')
    assert.equal(access.chatCaller(undefined, 'shared-secret-token'), undefined)
    assert.equal(access.revokeMcpToken(id, 'someone@x.com', 'someone@x.com'), false, 'people revoke only their own')
    assert.equal(access.revokeMcpToken(id, 'admin@x.com'), true, 'admins revoke any')
    assert.equal(access.chatCaller(token, 'shared-secret-token'), undefined, 'revoked: refused at once')
    assert.ok(!JSON.stringify(access.listMcpTokens()).includes(token), 'only a hash is kept')
})

test('chat tools follow the survey role', () => {
    const all = surveyToolNames('launch')
    assert.deepEqual(surveyToolNames('none'), [])
    assert.deepEqual(surveyToolNames('view').sort(), ['list_surveys', 'survey_results'])
    assert.deepEqual(surveyToolNames('edit').sort(), ['design_survey', 'list_surveys', 'save_survey', 'survey_results'])
    assert.deepEqual(all.sort(), ['design_survey', 'launch_survey', 'list_surveys', 'save_survey', 'stop_survey', 'survey_results'])
})

test("PostHog's MCP refuses survey commands: surveys are Lens only", () => {
    const call = (command: string) => replayRefusal({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec', arguments: { command } } }, 'lens')
    assert.match(String(call('call surveys-get-all {}')?.error?.message), /managed only in Lens/)
    assert.match(String(call('call survey-create {"name":"x"}')?.error?.message), /managed only in Lens/)
    assert.equal(call('call insight-query {"query":"x"}'), undefined)
})

test('the admin and Connect chat pages render, and their scripts parse', async () => {
    const v = { email: 'a@b.c', name: 'A', role: 'admin', posthog_admin: true, in_replay_project: true, session: 's', surveys: 'launch' } as never
    const { handleConnect } = await import('../src/service/connect.ts')
    const { handleAdmin } = await import('../src/service/admin.ts')
    for (const [fn, path] of [[handleConnect, '/replays/connect'], [handleAdmin, '/replays/admin']] as const) {
        let html = ''
        const res = { writeHead() {}, setHeader() {}, end(b: string) { html = b } } as never
        await (fn as (...a: unknown[]) => Promise<boolean>)({ method: 'GET', headers: {} }, res, new URL('http://x' + path), v)
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
        assert.ok(scripts.length >= 2, path)
        for (const s of scripts) assert.doesNotThrow(() => new Function(s), path)
    }
})
