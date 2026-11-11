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

test('launch safeguard: four rules, a Jira ticket, the acknowledgement word for word; recorded', async () => {
    const { launchRules, checkTicket, recordLaunch, launchesOf, ACKNOWLEDGEMENT } = await import('../src/core/launches.ts')
    const rules = launchRules({ clients: ['ACME'], sample_percent: 33, steps: ['Opens DlgA', 'Presses Save'], show: 'once', pacing: { per_user: 2, gap_hours: 24, quiet_days_after_close: 7 } }, { level: 'queued', alert: '⚠ Queued for ACME: their users are already in 2. More text.' })
    assert.equal(rules.length, 4)
    assert.match(rules[0], /Reval users at once: 33% of the users of ACME see it in Reval, bottom right.*Opens DlgA → Presses Save/)
    assert.match(rules[1], /never more than 2 running surveys.*24 hours.*Right now: Queued for ACME/)
    assert.match(rules[2], /×.*7 days/)
    assert.match(rules[3], /stopping keeps the answers/)
    assert.deepEqual(await checkTicket(' reval-1234 '), { ok: true, key: 'REVAL-1234' })
    for (const bad of ['', '1234', 'REVAL 12', 'REVAL-', 'http://x/REVAL-1']) assert.equal((await checkTicket(bad)).ok, false, bad)
    recordLaunch({ survey_id: 's1', survey_name: 'n', ticket: 'REVAL-1', ticket_summary: null, launched_by: 'pm@x.com', via: 'Surveys page', rules })
    assert.deepEqual(launchesOf('s1').map((l) => [l.ticket, l.launched_by, l.rules.length]), [['REVAL-1', 'pm@x.com', 4]])
    assert.match(ACKNOWLEDGEMENT, /^I acknowledge that this launches a survey that Reval users will see/)
    // The page refuses a launch without the acknowledgement or with a bad ticket, before calling PostHog.
    const { handleSurveys } = await import('../src/service/surveyspage.ts')
    const post = async (body: object) => {
        const sent: { status?: number; body?: string } = {}
        const req = Object.assign((async function* () { yield JSON.stringify(body) })(), { method: 'POST', headers: {} })
        const res = { writeHead: (s: number) => (sent.status = s), end: (b: string) => (sent.body = b) } as never
        await handleSurveys(req as never, res, new URL('http://x/replays/surveys/api/survey/01a1c6d6-8086-0000-b54b-4feed4e4f2b0/launch'), { email: 'a@b.c', role: 'admin', surveys: 'launch' } as never)
        return sent
    }
    assert.match(String((await post({ ticket: 'REVAL-1' })).body), /acknowledgement/)
    assert.match(String((await post({ ticket: 'nope', acknowledgement: ACKNOWLEDGEMENT })).body), /Jira ticket ID/)
})

test('Copilot address: admins set it, the Chat page hands it out, bad values refused', async () => {
    const { config } = await import('../src/core/config.ts')
    assert.equal(access.chatUrl(), config.service.publicUrl, 'default is PUBLIC_URL')
    assert.equal(access.setChatUrl(' https://lens.ion.example/ ', 'admin@x.com'), 'https://lens.ion.example')
    for (const bad of ['lens', 'ftp://x', 'https://x/?a=1', 'javascript:alert(1)']) assert.throws(() => access.setChatUrl(bad, 'admin@x.com'), /full address/, bad)
    const { handleConnect } = await import('../src/service/connect.ts')
    let body = ''
    const res = { writeHead() {}, end(b: string) { body = b } } as never
    const req = Object.assign((async function* () { yield '{}' })(), { method: 'POST', headers: {} })
    const v = { email: 'lead@x.com', role: 'watch', surveys: 'launch' } as never
    await handleConnect(req as never, res, new URL('http://x/replays/connect/api/tokens'), v)
    assert.equal(JSON.parse(body).url, 'https://lens.ion.example/mcp')
    access.setChatUrl('', 'admin@x.com')
    assert.equal(access.chatUrl(), config.service.publicUrl, 'empty goes back to the default')
    assert.ok(access.readAudit({ action: 'access.chat_url' }).length >= 2)
})
