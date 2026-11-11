// End-to-end check of the client signals on a deployed Lens: the four signal reasons in the rescue queue (page,
// API, chat), the Monday briefing (page and monday_brief), Ask them creating a real draft survey (then archived),
// permissions, and a privacy scan (no user identities). E2E_EXPECT_PLANTED=1 expects the demo clients from
// scripts/seed-reval-signals.ts (S001-S005).
import { mkdirSync, readFileSync } from 'node:fs'
import puppeteer from 'puppeteer'

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) { console.error(`Set ${k} (see scripts/e2e/README.md)`); process.exit(2) } return v }
const S = env('E2E_OUT', 'e2e-out')
const LENS = env('LENS_URL', 'http://127.0.0.1:8080'), PH = env('POSTHOG_URL', 'http://127.0.0.1')
const pw = (process.env.E2E_PASSWORD ?? readFileSync(env('E2E_PASSWORD_FILE'), 'utf8')).trim()
const ADMIN = env('E2E_ADMIN', 'lens-check-admin@example.invalid'), VIEWER = env('E2E_VIEWER', 'lens-check-viewer@example.invalid')
mkdirSync(S, { recursive: true })
// Dates relative to the last complete day (yesterday, UTC).
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const Y = dayAgo(1)
const W = `from=${dayAgo(14)}&to=${Y}&baseline_from=${dayAgo(28)}&baseline_to=${dayAgo(15)}`
const report: string[] = []; const ok = (l: string, c: boolean, x = '') => { report.push((c ? 'PASS ' : 'FAIL ') + l + (x ? ' — ' + x : '')); return c }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
async function session(email: string) {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.setViewport({ width: 1280, height: 900 })
    await page.evaluateOnNewDocument('globalThis.__name = (f) => f')
    const errors: string[] = []
    page.on('pageerror', (e: any) => errors.push(String(e).slice(0, 160)))
    page.on('console', (m: any) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text().slice(0, 160)) })
    page.on('response', (r: any) => { if (r.status() >= 500 && r.url().startsWith(LENS)) errors.push('HTTP ' + r.status() + ' ' + r.url().replace(LENS, '')) })
    await page.goto(LENS + '/replays', { waitUntil: 'networkidle0' })
    await page.type('input[type=email]', email); await page.type('input[type=password]', pw)
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('form button')])
    const api = (path: string, method = 'GET', body?: unknown, header = true) => page.evaluate(async (path, method, body, header) => {
        const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(header ? { 'x-clip-page': '1' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const t = await r.text(); let j: any; try { j = JSON.parse(t) } catch { j = t }
        return { status: r.status, body: j }
    }, path, method, body, header)
    return { page, errors, api }
}
async function mcp(token: string, method: string, params: unknown = {}, sid = '') {
    const r = await fetch(LENS + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const text = await r.text()
    const data = r.headers.get('content-type')?.includes('event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).pop() : text ? JSON.parse(text) : undefined
    return { status: r.status, sid: r.headers.get('mcp-session-id') || sid, data }
}
async function chat(token: string) {
    const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    if (init.sid) await fetch(LENS + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': init.sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    return { list: async () => ((await mcp(token, 'tools/list', {}, init.sid)).data?.result?.tools || []).map((t: any) => t.name) as string[], call: (name: string, args: unknown) => mcp(token, 'tools/call', { name, arguments: args }, init.sid) }
}


const admin = await session(ADMIN)
const viewer = await session(VIEWER)
// Client-user identities. Lens staff emails (owner, updated_by, activity) are expected in action metadata.
const PRIVATE = /USER[0-9]|C1PRD\|/
const expect = process.env.E2E_EXPECT_PLANTED === '1'

// 1. signal reasons in the rescue queue
const q = await admin.api('/replays/dashboards/api/rescue?days=28')
const byClient = new Map<string, any>((q.body.clients || []).map((c: any) => [c.client, c]))
const kinds = (id: string) => (byClient.get(id)?.reasons || []).map((r: any) => r.kind)
ok('rescue queue answers', q.status === 200 && q.body.coverage?.complete === true, `${q.body.clients?.length} clients; ${q.body.coverage?.text || 'complete'}`)
if (expect) {
    ok('Northwind: key person gap', kinds('S001').includes('key_person_gap'), kinds('S001').join(','))
    ok('Harbor: work moving out of Reval', kinds('S002').includes('work_moving_out'), kinds('S002').join(','))
    ok('Cedar: recurring close error', kinds('S003').includes('recurring_close_error'), kinds('S003').join(','))
    ok('Atlas: giving up after errors', kinds('S004').includes('giving_up'), kinds('S004').join(','))
    ok('Atlas: no false close error (its error is every day)', !kinds('S004').includes('recurring_close_error'))
    ok('Quiet Mills: not flagged', !byClient.has('S005'))
    for (const id of ['S001', 'S002', 'S003', 'S004']) { const c = byClient.get(id); if (c) console.log(`  ${c.client_name}: ${c.reasons[0].text}\n     → ${c.next_step}`) }
}
ok('rescue JSON has no user identities', !PRIVATE.test(JSON.stringify(q.body)))

// 2. briefing: page (default Dashboards view) and API
for (const [who, s] of [['admin', admin], ['viewer', viewer]] as const) {
    const before = s.errors.length
    const r = await s.page.goto(LENS + '/replays/dashboards', { waitUntil: 'networkidle0', timeout: 90000 }); await wait(1500)
    const info = await s.page.evaluate(() => ({ current: document.querySelector('nav.tabs a[aria-current=page]')?.textContent, text: document.body.innerText.slice(0, 4000),
        unlabeled: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((e: any) => e.offsetParent !== null && !e.getAttribute('aria-label') && !(e.id && document.querySelector('label[for="' + e.id + '"]')) && !e.closest('label')).length }))
    ok(`${who}: Dashboards opens on the briefing`, r?.status() === 200 && /briefing/i.test(info.current || ''), info.current || '')
    ok(`${who}: briefing page has no errors, labelled, no identities`, s.errors.length === before && !info.unlabeled && !PRIVATE.test(info.text), s.errors.slice(before).join(' | '))
    if (expect) ok(`${who}: briefing names the quiet account to check`, /Quiet Mills/.test(info.text))
    await s.page.screenshot({ path: `${S}/briefing-${who}.png`, fullPage: true })
}
const b = await admin.api('/replays/dashboards/api/briefing')
ok('briefing API answers without identities', b.status === 200 && !!b.body.headline && !PRIVATE.test(JSON.stringify(b.body)), b.body.headline)

// 3. Ask them: a real draft in PostHog, then archived
if (byClient.has('S002') || !expect) {
    const target = byClient.has('S002') ? 'S002' : (q.body.clients || [])[0]?.client
    if (target) {
        ok('viewer cannot draft a survey', (await viewer.api(`/replays/dashboards/api/rescue/${encodeURIComponent(target)}/ask`, 'POST', {})).status === 403)
        const a = await admin.api(`/replays/dashboards/api/rescue/${encodeURIComponent(target)}/ask`, 'POST', {})
        const id = a.body.survey_id || a.body.id || a.body.survey?.id
        ok('Ask them creates a draft survey', a.status === 201 && !!id, JSON.stringify(a.body).slice(0, 160))
        if (id) {
            const sv = await admin.api('/replays/surveys/api/survey/' + id)
            const txt = JSON.stringify(sv.body)
            ok('the draft targets that client, is not running, and asks the right questions', sv.status === 200 && txt.includes(target) && !/"status":"running"/.test(txt) && (target !== 'S002' || /export/i.test(txt)), txt.slice(0, 200))
            const arch = await admin.api('/replays/surveys/api/survey/' + id + '/archive', 'POST', {})
            ok('test draft archived', arch.status === 200)
        }
    }
}

// 3b. client story, handover pack, outcomes and the signal scorecard
{
    const story = await admin.api('/replays/dashboards/api/story?client=S001')
    const st = JSON.stringify(story.body)
    ok('client story answers with a timeline, no identities', story.status === 200 && Array.isArray(story.body.events) && story.body.weeks?.length > 0 && !PRIVATE.test(st), `${story.body.events?.length} events, ${story.body.weeks?.length} weeks`)
    if (expect) ok('the story shows the key-person signal', /One person did/.test(st))
    const pack = await admin.api('/replays/dashboards/api/handover-pack?client=S002')
    ok('handover pack is markdown without identities', pack.status === 200 && /^#/m.test(pack.body.markdown || '') && !PRIVATE.test(pack.body.markdown || ''), (pack.body.markdown || '').split('\n')[0])
    const p = admin.page, before = admin.errors.length
    const r = await p.goto(LENS + '/replays/dashboards?view=story&client=S002', { waitUntil: 'networkidle0', timeout: 90000 }); await wait(1000)
    ok('story page loads without errors', r?.status() === 200 && admin.errors.length === before, admin.errors.slice(before).join(' | '))
    await p.screenshot({ path: `${S}/story-admin.png`, fullPage: true })
    // outcomes: Harbor left today (its exports climbed weeks earlier), Quiet Mills renewed
    const today = new Date().toISOString().slice(0, 10)
    ok('viewer cannot record an outcome', (await viewer.api('/replays/admin/api/outcomes', 'POST', { client: 'S002', outcome: 'left', decided_on: today })).status >= 400)
    const o1 = await admin.api('/replays/admin/api/outcomes', 'POST', { client: 'S002', outcome: 'left', decided_on: today, note: 'e2e check' })
    const o2 = await admin.api('/replays/admin/api/outcomes', 'POST', { client: 'S005', outcome: 'renewed', decided_on: today, note: 'e2e check' })
    ok('admin records outcomes', o1.status === 200 && o2.status === 200)
    const t0 = Date.now(); const sc = await viewer.api('/replays/dashboards/api/scorecard?weeks=26'); const ms = Date.now() - t0
    const rows: any[] = sc.body.rows || []
    const wmo = rows.find((x) => x.kind === 'work_moving_out'), overall = rows.find((x) => x.kind === 'overall')
    ok('scorecard answers (viewer) without identities or probabilities', sc.status === 200 && !PRIVATE.test(JSON.stringify(sc.body)) && !/probab/i.test(JSON.stringify(sc.body.rows)), `${ms} ms; ${sc.body.explanation}`)
    if (expect) ok('scorecard: work moving out warned before Harbor left', wmo?.hits === 1 && wmo?.median_lead_days > 0, JSON.stringify(wmo))
    console.log('  overall:', JSON.stringify(overall))
    await admin.api('/replays/admin/api/outcomes', 'DELETE', { client: 'S002' })
    await admin.api('/replays/admin/api/outcomes', 'DELETE', { client: 'S005' })
    ok('test outcomes removed', ((await admin.api('/replays/admin/api/outcomes')).body || []).filter((x: any) => ['S002', 'S005'].includes(x.client)).length === 0)
}

// 4. chat
const at = await admin.api('/replays/connect/api/tokens', 'POST', { label: 'signals check' })
const vt = await viewer.api('/replays/connect/api/tokens', 'POST', { label: 'signals check' })
const ac = await chat(at.body.token), vc = await chat(vt.body.token)
const an = await ac.list(), vn = await vc.list()
ok('chat: admin has monday_brief and draft_rescue_survey', an.includes('monday_brief') && an.includes('draft_rescue_survey'))
ok('chat: viewer has monday_brief, not draft_rescue_survey', vn.includes('monday_brief') && !vn.includes('draft_rescue_survey'))
ok('chat: viewer has client_story, handover_pack and signal_scorecard', ['client_story', 'handover_pack', 'signal_scorecard'].every((t) => vn.includes(t)))
const mb = await vc.call('monday_brief', {})
const mbText = JSON.stringify(mb.data?.result?.content || mb.data?.error || '')
ok('chat: monday_brief answers without identities', mb.status === 200 && !mb.data?.result?.isError && !PRIVATE.test(mbText), mbText.slice(0, 160))
const rq = await vc.call('rescue_queue', { when: 'last 28 days' })
const rqText = JSON.stringify(rq.data?.result?.content || '')
if (expect) ok('chat: rescue_queue includes the signal reasons', /Exports went from/.test(rqText) && /One person did/.test(rqText) && !PRIVATE.test(rqText))
for (const [s] of [[admin], [viewer]] as const) { const l = await s.api('/replays/connect/api/tokens'); for (const k of l.body.tokens) if (!k.revoked_at) await s.api('/replays/connect/api/tokens/' + k.id, 'DELETE') }

console.log('\n' + report.join('\n'))
console.log(`\n${report.filter((r) => r.startsWith('PASS')).length} passed, ${report.filter((r) => r.startsWith('FAIL')).length} failed`)
await browser.close()
