// End-to-end check of a deployed Lens: every page as admin and viewer (errors, labels, layout at 1280/1024/390 px),
// Copilot address and personal chat keys (MCP, PostHog through Lens), Live, Surveys (results, launch safeguard),
// the PostHog survey lock, Dashboards (task map, flow time, pins and sharing), pagination and System.
// See scripts/e2e/README.md.
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
const report: string[] = []
const ok = (l: string, c: boolean, x = '') => { report.push((c ? 'PASS ' : 'FAIL ') + l + (x ? ' — ' + x : '')); return c }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })

async function session(email: string) {
    const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); await page.setViewport({ width: 1280, height: 900 })
    await page.evaluateOnNewDocument('globalThis.__name = (f) => f')
    const errors: string[] = []
    page.on('console', (m: any) => { if (['error', 'warn'].includes(m.type()) && !/favicon/.test(m.text())) errors.push(page.url().replace(LENS, '') + ': ' + m.text().slice(0, 160)) })
    page.on('pageerror', (e: any) => errors.push(page.url().replace(LENS, '') + ': ' + String(e).slice(0, 160)))
    page.on('response', (r: any) => { if (r.status() >= 400 && r.url().startsWith(LENS)) errors.push('HTTP ' + r.status() + ' ' + r.url().replace(LENS, '')) })
    await page.goto(LENS + '/replays', { waitUntil: 'networkidle0' })
    await page.type('input[type=email]', email); await page.type('input[type=password]', pw)
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('form button')])
    const api = (path: string, method = 'GET', body?: unknown) => page.evaluate(async (path, method, body) => {
        const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-clip-page': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const t = await r.text(); let j: any; try { j = JSON.parse(t) } catch { j = t }
        return { status: r.status, body: j }
    }, path, method, body)
    return { page, errors, api }
}
async function mcp(path: string, token: string, method: string, params: unknown = {}, sid?: string) {
    const r = await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }) })
    const text = await r.text()
    const data = r.headers.get('content-type')?.includes('event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).pop() : (text ? JSON.parse(text) : undefined)
    return { status: r.status, sid: r.headers.get('mcp-session-id') || sid, data }
}
async function mcpSession(path: string, token: string) {
    const init = await mcp(path, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })
    if (init.status === 200 && init.sid) await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': init.sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    return init
}

const admin = await session(ADMIN)
const viewer = await session(VIEWER)

// ---------------------------------------------------------------- 1. every page, both people
const pages = [['clips', '/replays'], ['live', '/replays/live'], ['dashboards', '/replays/dashboards'], ['surveys', '/replays/surveys'], ['chat', '/replays/connect'], ['system', '/replays/system'], ['admin', '/replays/admin']]
for (const [who, s] of [['admin', admin], ['viewer', viewer]] as const) {
    for (const [name, path] of pages) {
        const before = s.errors.length
        const r = await s.page.goto(LENS + path, { waitUntil: 'networkidle0', timeout: 90000 }).catch(() => null)
        await wait(2500)
        const status = r?.status()
        if (who === 'viewer' && (name === 'system' || name === 'admin')) { ok(`viewer refused ${name}`, status === 403, 'HTTP ' + status); continue }
        ok(`${who} ${name} loads`, status === 200, 'HTTP ' + status)
        ok(`${who} ${name} no browser errors`, s.errors.length === before, s.errors.slice(before).join(' | '))
        const a = await s.page.evaluate(() => {
            const vis = (e: any) => e.offsetParent !== null
            const unlabeled = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((e: any) => vis(e) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !(e.id && document.querySelector('label[for="' + e.id + '"]')) && !e.closest('label')).map((e: any) => e.id || e.name || e.tagName)
            const noName = [...document.querySelectorAll('button')].filter((b: any) => vis(b) && !(b.textContent || '').trim() && !b.getAttribute('aria-label')).length
            return { unlabeled, noName, h: !!document.querySelector('h1,h2') }
        })
        ok(`${who} ${name} controls labelled`, !a.unlabeled.length && !a.noName && a.h, JSON.stringify(a))
        await s.page.screenshot({ path: `${S}/final-${who}-${name}.png`, fullPage: true })
        for (const w of [1280, 1024, 390]) {
            await s.page.setViewport({ width: w, height: 900 }); await wait(250)
            const lay = await s.page.evaluate(() => {
                const tabs = [...document.querySelectorAll('nav a')].map((a) => a.getBoundingClientRect()), hdr = document.querySelector('.hdr')!.getBoundingClientRect()
                const overlap = tabs.some((t) => t.right > hdr.left && t.left < hdr.right && t.bottom > hdr.top && t.top < hdr.bottom)
                // a one-word button whose text wraps onto two lines (e.g. "Rese / t")
                const broken = [...document.querySelectorAll('button')].filter((b: any) => b.offsetParent !== null && !/\s/.test((b.textContent || '').trim()) && (b.textContent || '').trim().length > 2 && b.getClientRects().length && (() => { const r = document.createRange(); r.selectNodeContents(b); return r.getClientRects().length > 1 })()).map((b: any) => b.textContent.trim())
                // a table heading with a word split over two lines (e.g. "Fla / gs")
                const splitHeads: string[] = []
                for (const th of document.querySelectorAll('th')) {
                    if ((th as any).offsetParent === null) continue
                    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT)
                    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                        const text = n.textContent || ''; const re = /[^\s/]+/g; let m
                        while ((m = re.exec(text))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); if (r.getClientRects().length > 1) splitHeads.push(m[0]) }
                    }
                }
                return { overlap, broken, splitHeads }
            })
            ok(`${who} ${name} layout at ${w}px: header clear, no words split in buttons or table headings`, !lay.overlap && !lay.broken.length && !lay.splitHeads.length, JSON.stringify(lay))
        }
        await s.page.setViewport({ width: 1280, height: 900 })
        await s.page.setViewport({ width: 390, height: 800 }); await wait(400)
        ok(`${who} ${name} phone width: no sideways scroll`, !(await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)))
        if (name === 'dashboards' || name === 'surveys') await s.page.screenshot({ path: `${S}/final-${who}-${name}-phone.png`, fullPage: true })
        await s.page.setViewport({ width: 1280, height: 900 })
    }
}

// ---------------------------------------------------------------- 2. skip link
{
    const p = admin.page; await p.goto(LENS + '/replays/connect', { waitUntil: 'networkidle0' })
    const hidden = await p.evaluate(() => document.querySelector('.skip')!.getBoundingClientRect().left < 0)
    await p.keyboard.press('Tab')
    const r = await p.evaluate(() => { const s = document.querySelector('.skip')!.getBoundingClientRect(), b = document.querySelector('.brand')!.getBoundingClientRect(); return { focused: document.activeElement?.className, overlap: s.bottom > b.top && s.top < b.bottom } })
    ok('skip link hidden until Tab, then a bar above the header (not over the name)', hidden && r.focused === 'skip' && !r.overlap, JSON.stringify(r))
    await p.screenshot({ path: `${S}/final-skip.png`, clip: { x: 0, y: 0, width: 1280, height: 160 } })
    await p.keyboard.press('Enter'); await wait(200)
    ok('skip link jumps to the content', await p.evaluate(() => location.hash === '#main'))
}

// ---------------------------------------------------------------- 3. Copilot: admin address + Chat page + MCP with a personal key
let token = ''
{
    const set = await admin.api('/replays/admin/api/settings', 'POST', { chat_url: 'https://lens.check.example/' })
    ok('admin sets the Copilot address', set.status === 200 && set.body.chat_url === 'https://lens.check.example', JSON.stringify(set.body))
    ok('bad Copilot address refused', (await admin.api('/replays/admin/api/settings', 'POST', { chat_url: 'javascript:alert(1)' })).status === 400)
    const p = admin.page; await p.goto(LENS + '/replays/connect', { waitUntil: 'networkidle0' })
    await p.click('#make'); await p.waitForFunction(() => document.querySelectorAll('#add code').length >= 5, { timeout: 15000 })
    const fields = await p.$$eval('#add code', (cs) => cs.map((c) => c.textContent || ''))
    ok('Chat page: Lens and PostHog fields use the admin address', fields.includes('https://lens.check.example/mcp') && fields.includes('https://lens.check.example/posthog-mcp'), fields.filter((f) => f.startsWith('http')).join(', '))
    token = (fields.find((f) => f.startsWith('Bearer lens_')) || '').slice(7)
    ok('Chat page: header value holds a personal key', /^lens_/.test(token))
    await p.screenshot({ path: `${S}/final-chat-connected.png`, fullPage: true })
    const back = await admin.api('/replays/admin/api/settings', 'POST', { chat_url: '' })
    ok('Copilot address back to default', back.status === 200 && /10\.0\.2\.15:8080/.test(back.body.chat_url), back.body.chat_url)

    // chat with that key, exactly as Copilot would (through the tunnel)
    const init = await mcpSession('/mcp', token)
    ok('MCP /mcp: key accepted (initialize)', init.status === 200 && !!init.data?.result, 'HTTP ' + init.status)
    const tools = await mcp('/mcp', token, 'tools/list', {}, init.sid)
    const names: string[] = tools.data?.result?.tools?.map((t: any) => t.name) || []
    ok('MCP /mcp: admin gets dashboard and survey tools', ['find_task', 'task_map', 'flow_time', 'pin_dashboard', 'list_surveys', 'survey_results', 'stop_survey'].every((n) => names.includes(n)), names.length + ' tools')
    ok('MCP /mcp: no survey launch from chat, even for an admin', !names.includes('launch_survey'), names.filter((n) => /survey/.test(n)).join(', '))
    const tm = await mcp('/mcp', token, 'tools/call', { name: 'task_map', arguments: {} }, init.sid)
    const tmText = JSON.stringify(tm.data?.result?.content || tm.data?.error || '').slice(0, 300)
    ok('MCP task_map answers', tm.status === 200 && !!tm.data?.result && !tm.data.result.isError, tmText)
    const ph = await mcpSession('/posthog-mcp', token)
    const phTools = await mcp('/posthog-mcp', token, 'tools/list', {}, ph.sid)
    ok('MCP /posthog-mcp: same key works (PostHog tools via Lens)', ph.status === 200 && (phTools.data?.result?.tools || []).some((t: any) => t.name === 'exec'), 'HTTP ' + ph.status)
    const refused = await mcp('/posthog-mcp', token, 'tools/call', { name: 'exec', arguments: { command: 'call surveys-get-all {}' } }, ph.sid)
    ok('MCP /posthog-mcp: PostHog survey commands refused (surveys only in Lens)', /managed only in Lens/.test(JSON.stringify(refused.data)), JSON.stringify(refused.data).slice(0, 160))
    ok('MCP without a key refused', (await mcp('/mcp', 'lens_nope', 'initialize', {})).status === 401)
}
// viewer key: limited tools
{
    const vt = await viewer.api('/replays/connect/api/tokens', 'POST', { label: 'check' })
    const vinit = await mcpSession('/mcp', vt.body.token)
    const vnames: string[] = (await mcp('/mcp', vt.body.token, 'tools/list', {}, vinit.sid)).data?.result?.tools?.map((t: any) => t.name) || []
    ok('MCP viewer key: can read surveys and dashboards but not launch or pin', vnames.includes('list_surveys') && vnames.includes('task_map') && !vnames.includes('launch_survey') && !vnames.includes('pin_dashboard'), vnames.filter((n) => /survey|dashboard|task|flow/.test(n)).join(','))
    const list = await viewer.api('/replays/connect/api/tokens')
    for (const t of list.body.tokens) await viewer.api('/replays/connect/api/tokens/' + t.id, 'DELETE')
}
// revoke the admin key on the Chat page: chat stops at once
{
    const list = await admin.api('/replays/connect/api/tokens')
    for (const t of list.body.tokens.filter((t: any) => !t.revoked_at)) await admin.api('/replays/connect/api/tokens/' + t.id, 'DELETE')
    ok('revoked key stops chat at once', (await mcp('/mcp', token, 'initialize', {})).status === 401)
}

// ---------------------------------------------------------------- 4. Live (the memory fix)
{
    // The most recent day with activity in the last week: test data may stop a day or two before today.
    let D = Y, day: any
    for (let n = 1; n <= 7; n++) { D = dayAgo(n); day = await admin.api(`/replays/live/api/time?from=${D}&to=${D}&tz=UTC&gap=60`); if (day.body?.totals?.actions > 0) break }
    const t0 = Date.now(); day = await admin.api(`/replays/live/api/time?from=${D}&to=${D}&tz=UTC&gap=60`)
    ok('Live: one day report', day.status === 200 && day.body.totals?.actions > 0, `${D}: ${Date.now() - t0} ms, ${day.body.totals?.actions} actions, ${day.body.clients?.length} clients`)
    const t1 = Date.now(); const month = await admin.api(`/replays/live/api/time?from=${dayAgo(30)}&to=${Y}&tz=UTC&gap=60`)
    ok('Live: 30-day report (failed before the fix)', month.status === 200, `${Date.now() - t1} ms, ${month.body.totals?.actions} actions`)
    const client = (day.body.clients || []).find((c: any) => c.client_id)?.client_id
    const sess = await admin.api(`/replays/live/api/sessions?from=${D}&to=${D}&tz=UTC&gap=60&client=${encodeURIComponent(client)}`)
    ok('Live: session list for a client', sess.status === 200 && sess.body.sessions?.length > 0, `${client}: ${sess.body.sessions?.length} sessions`)
    const user = sess.body.sessions?.[0]?.user
    const person = await admin.api(`/replays/live/api/person?from=${D}&tz=UTC&gap=60&client=${encodeURIComponent(client)}&user=${encodeURIComponent(user)}`)
    ok('Live: one person\'s timeline', person.status === 200 && person.body.actions?.length > 0, `${person.body.actions?.length} actions`)
}

// ---------------------------------------------------------------- 5. Surveys: results, written answers paging, launch safeguard
{
    const list = await admin.api('/replays/surveys/api/list?days=90')
    const surveys: any[] = list.body.surveys || list.body || []
    ok('Surveys: list', list.status === 200 && surveys.length > 0, surveys.length + ' surveys')
    const chain = surveys.find((s: any) => /ACME chain/.test(s.name)) || surveys[0]
    const d = await admin.api('/replays/surveys/api/survey/' + chain.id + '?days=90')
    const qs: any[] = d.body.results?.questions || d.body.questions || []
    ok('Surveys: results load (all submissions)', d.status === 200 && qs.length > 0, qs.map((q: any) => q.type + ':' + q.answers).join(' '))
    const open = qs.find((q: any) => q.recent)
    if (open) {
        const p1 = await admin.api(`/replays/surveys/api/survey/${chain.id}/answers?question=${encodeURIComponent(open.id)}&limit=1&days=90`)
        const p2 = p1.body.next ? await admin.api(`/replays/surveys/api/survey/${chain.id}/answers?question=${encodeURIComponent(open.id)}&limit=1&days=90&after=${encodeURIComponent(p1.body.next)}`) : null
        ok('Surveys: written answers page with a cursor (no OFFSET)', p1.status === 200 && (!p1.body.next || (p2?.status === 200 && p2.body.answers?.[0]?.at !== p1.body.answers?.[0]?.at)), `total ${p1.body.total}, page 2 ${p2 ? 'distinct' : 'n/a'}`)
    }
    const check = await admin.api('/replays/surveys/api/survey/' + chain.id + '/launch-check')
    ok('Launch safeguard: four rules and the acknowledgement', check.status === 200 && check.body.rules?.length === 4 && !!check.body.acknowledgement, (check.body.rules || []).length + ' rules')
    const noTicket = await admin.api('/replays/surveys/api/survey/' + chain.id + '/launch', 'POST', { ticket: '', acknowledgement: check.body.acknowledgement })
    ok('Launch refused without a Jira ticket', noTicket.status >= 400, 'HTTP ' + noTicket.status + ' ' + JSON.stringify(noTicket.body).slice(0, 100))
    const noAck = await admin.api('/replays/surveys/api/survey/' + chain.id + '/launch', 'POST', { ticket: 'REVAL-1', acknowledgement: 'ok' })
    ok('Launch refused without the exact acknowledgement', noAck.status >= 400, 'HTTP ' + noAck.status)
    // the dialog in the page
    const p = admin.page; await p.goto(LENS + '/replays/surveys#' + chain.id, { waitUntil: 'networkidle0' }); await wait(2500)
    const launchBtn = await p.$('#a-launch')
    if (launchBtn) {
        await launchBtn.click(); await wait(2500)
        const dlg = await p.evaluate(() => { const d = document.getElementById('ldlg') as HTMLDialogElement; const go = [...d.querySelectorAll('button')].find((b) => /launch/i.test(b.textContent || '') && b.type !== 'button') || [...d.querySelectorAll('button')].pop(); return { open: d.open, role: d.getAttribute('aria-labelledby') || d.getAttribute('aria-label'), rules: d.querySelectorAll('li').length, focusInside: d.contains(document.activeElement) } })
        ok('Launch dialog: opens with the rules, focus inside', dlg.open && dlg.rules >= 4 && dlg.focusInside, JSON.stringify(dlg))
        await p.screenshot({ path: `${S}/final-launch-dialog.png` })
        await p.keyboard.press('Escape'); await wait(300)
        ok('Launch dialog: Escape closes it, nothing launched', !(await p.evaluate(() => (document.getElementById('ldlg') as HTMLDialogElement).open)))
    } else ok('Launch dialog reachable from the survey', false, 'no #a-launch button')
    viewer.errors.length = 0
    const vd = await viewer.api('/replays/surveys/api/survey/' + chain.id + '/launch', 'POST', { ticket: 'REVAL-1', acknowledgement: check.body.acknowledgement })
    ok('Viewer (view role) cannot launch', vd.status === 403, 'HTTP ' + vd.status)
}

// ---------------------------------------------------------------- 6. PostHog survey lock and the "Survey by ION" renderer
{
    const apiR = await fetch(PH + '/api/projects/1/surveys/', { redirect: 'manual' })
    ok('PostHog survey API locked (403 without Lens\'s gate)', apiR.status === 403, 'HTTP ' + apiR.status)
    const ui = await fetch(PH + '/project/1/surveys', { redirect: 'manual' })
    ok('PostHog survey screens send people to Lens (302)', ui.status === 302, 'HTTP ' + ui.status + ' → ' + ui.headers.get('location'))
    const js = await (await fetch(PH + '/static/surveys.js')).text()
    ok('Reval\'s surveys.js is the Lens renderer with "Survey by ION"', js.includes('Survey by ION') && js.includes('lensSurveyQuiet'), js.length + ' bytes')
}

// ---------------------------------------------------------------- 7. Dashboards: task map, flow time 100 slowest, pin + share
{
    const map = await admin.api(`/replays/dashboards/api/task-map?from=${dayAgo(7)}&to=${Y}&attention=0`)
    const clients: any[] = map.body.clients || []
    ok('Task map: clients told apart (no Unknown client)', map.status === 200 && clients.length > 5 && !clients.some((c) => !c.client), clients.slice(0, 4).map((c) => c.client_name).join(', ') + '…')
    const tasks = await admin.api('/replays/dashboards/api/tasks?q=')
    const task = (tasks.body as any[]).sort((a, b) => b.attempts_90d - a.attempts_90d)[0]
    const flow = await admin.api(`/replays/dashboards/api/flow-time?task=${task.task_id}&from=${dayAgo(20)}&to=${Y}&slowest_limit=100`)
    ok('Flow time: up to 100 slowest attempts', flow.status === 200 && flow.body.slowest?.length > 10, `${task.name}: ${flow.body.slowest?.length} slowest`)
    const p = admin.page; await p.goto(`${LENS}/replays/dashboards?view=flow_time&task=${task.task_id}&from=${dayAgo(20)}&to=${Y}`, { waitUntil: 'networkidle0' }); await wait(1500)
    const pager = await p.evaluate(() => document.getElementById('slowest-pager')?.innerText.replace(/\s+/g, ' ') || '')
    ok('Flow time page: slowest attempts paginated', /of (1[1-9]|[2-9][0-9]|100) attempts/.test(pager), pager)
    await p.screenshot({ path: `${S}/final-admin-flow.png`, fullPage: true })
    const pin = await admin.api('/replays/dashboards/api/pins', 'POST', { kind: 'task_map', title: 'Check pin', params: { window: { last_days: 28 } } })
    ok('Pin a dashboard', pin.status === 201, 'HTTP ' + pin.status + ' ' + JSON.stringify(pin.body).slice(0, 120))
    if (pin.status === 201) {
        const sh = await admin.api('/replays/dashboards/api/pins/' + pin.body.id + '/share', 'POST', { emails: [VIEWER] })
        const seen = await viewer.api('/replays/dashboards/api/pins')
        ok('Share it: the viewer sees it', sh.status === 200 && (seen.body as any[]).some((d) => d.id === pin.body.id))
        ok('Viewer cannot change it', (await viewer.api('/replays/dashboards/api/pins/' + pin.body.id, 'DELETE')).status === 403)
        ok('Owner deletes it', (await admin.api('/replays/dashboards/api/pins/' + pin.body.id, 'DELETE')).status === 200)
    }
    ok('Viewer cannot pin', (await viewer.api('/replays/dashboards/api/pins', 'POST', { kind: 'task_map', title: 'x', params: {} })).status === 403)
}

// ---------------------------------------------------------------- 8. pagination and System
{
    const p = admin.page; await p.goto(LENS + '/replays/admin#activity', { waitUntil: 'networkidle0' }); await wait(2000)
    const pagers = await p.evaluate(() => [...document.querySelectorAll('.pager:not([hidden])')].map((x: any) => x.innerText.replace(/\s+/g, ' ')))
    ok('Admin: activity paginated', pagers.some((t) => /activity/.test(t)), pagers.join(' | '))
    const next = await p.$('.pager:not([hidden]) button[aria-label="Next page"]')
    if (next) { await next.click(); await wait(300); ok('Pager: Next goes to page 2', await p.evaluate(() => [...document.querySelectorAll('.pager')].some((x: any) => /Page 2 of/.test(x.innerText)))) }
    await p.goto(LENS + '/replays/system', { waitUntil: 'networkidle0' }); await wait(3000)
    const sys = await p.evaluate(() => ({ banner: document.getElementById('b-head')?.textContent, rows: document.querySelectorAll('#rows tr').length, notAvailable: /Not available until/.test(document.body.innerText) }))
    ok('System: live status shown, containers listed', !sys.notAvailable && sys.rows > 5 && !/not answering/.test(sys.banner || ''), JSON.stringify(sys))
}

console.log(report.join('\n'))
console.log(`\n${report.filter((r) => r.startsWith('PASS')).length} passed, ${report.filter((r) => r.startsWith('FAIL')).length} failed`)
await browser.close()
