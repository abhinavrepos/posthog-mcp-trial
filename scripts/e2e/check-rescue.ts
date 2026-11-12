// End-to-end check of the rescue queue on a deployed Lens: results, page (admin/viewer, desktop/phone), owner/status
// through the form, snooze, permissions, the period choice, chat tools with real personal keys, timing.
// With E2E_EXPECT_PLANTED=1 it also expects the demo data's planted problems (C01/Treasury 1, C02/Treasury 2).
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

const admin = await session('lens-check-admin@example.invalid')
const viewer = await session('lens-check-viewer@example.invalid')

// 1. real results and timing
let t = Date.now(); const q = await admin.api(`/replays/dashboards/api/rescue?${W}`); const cold = Date.now() - t
t = Date.now(); await admin.api(`/replays/dashboards/api/rescue?${W}`); const warm = Date.now() - t
ok('API answers', q.status === 200, `HTTP ${q.status}, first ${cold} ms, repeat ${warm} ms`)
const clients: any[] = q.body.clients || []
console.log(`window ${q.body.window?.from}..${q.body.window?.to} vs ${q.body.baseline?.from}..${q.body.baseline?.to}; coverage complete=${q.body.coverage?.complete}; ${clients.length} clients flagged; data through ${q.body.data_through}`)
if (!q.body.coverage?.complete) console.log('  unprocessed:', (q.body.coverage?.unprocessed || []).length, 'days;', q.body.coverage?.text)
for (const c of clients.slice(0, 8)) console.log(`  ${c.level.padEnd(6)} ${c.trend.padEnd(6)} ${String(Math.round(c.score)).padStart(4)}  ${c.client_name}: ${c.reasons.slice(0, 3).map((r: any) => r.text).join(' | ')}  → ${c.next_step}`)
ok('repeat read is fast (cached)', warm < 300, `${warm} ms`)

// 2. page: admin and viewer, desktop and phone
for (const [who, s] of [['admin', admin], ['viewer', viewer]] as const) {
    const before = s.errors.length
    const r = await s.page.goto(LENS + '/replays/dashboards', { waitUntil: 'networkidle0', timeout: 90000 }); await wait(1500)
    const info = await s.page.evaluate(() => ({ title: document.querySelector('h1,h2')?.textContent, firstTab: document.querySelector('nav.tabs a')?.textContent, current: document.querySelector('nav.tabs a[aria-current=page]')?.textContent, tabs: [...document.querySelectorAll('nav.tabs a')].map((a) => a.textContent || ''), forms: document.querySelectorAll('form[data-rescue], form.rescue-form, [data-rescue-form]').length, selects: document.querySelectorAll('select').length,
        unlabeled: [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((e: any) => e.offsetParent !== null && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby') && !(e.id && document.querySelector('label[for="' + e.id + '"]')) && !e.closest('label')).map((e: any) => e.id || e.name || e.tagName) }))
    ok(`${who}: Dashboards opens on the briefing, rescue queue is a tab`, r?.status() === 200 && /briefing/i.test(info.current || '') && info.tabs.some((t: string) => /rescue/i.test(t)), JSON.stringify({ title: info.title, current: info.current, tabs: info.tabs }))
    ok(`${who}: no browser errors, controls labelled`, s.errors.length === before && !info.unlabeled.length, [...s.errors.slice(before), ...info.unlabeled].join(' | '))
    await s.page.screenshot({ path: `${S}/rescue-${who}.png`, fullPage: true })
    await s.page.setViewport({ width: 390, height: 800 }); await wait(400)
    ok(`${who}: phone width, no sideways scroll`, !(await s.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)))
    await s.page.screenshot({ path: `${S}/rescue-${who}-phone.png`, fullPage: true })
    await s.page.setViewport({ width: 1280, height: 900 })
}
const viewerEdit = await viewer.page.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /save/i.test(b.textContent || '') && (b as any).offsetParent !== null).length)
ok('viewer sees no Save (cannot assign)', viewerEdit === 0, `${viewerEdit} save buttons`)

// 3. owner/status through the real form (admin), then API, audit
// Write test owners, notes and statuses to a synthetic client, never to the demo clients (S001–S005) people look at.
const target = clients.find((c: any) => !/^S00\d$/.test(c.client)) ?? clients[0]
if (target) {
    const p = admin.page; await p.goto(LENS + `/replays/dashboards?view=rescue&${W}`, { waitUntil: 'networkidle0' }); await wait(1000)
    const filled = await p.evaluate((client) => {
        const forms = [...document.querySelectorAll('form')].filter((f) => f.querySelector('select[name=status]'))
        const f = forms.find((f) => (f as HTMLFormElement).dataset.client === client || f.closest('[data-client]')?.getAttribute('data-client') === client) || forms[0]
        if (!f) return 'no form'
        const set = (n: string, v: string) => { const e = f.querySelector(`[name=${n}]`) as HTMLInputElement | null; if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) } return !!e }
        const r = [set('owner', 'lens-check-admin@example.invalid'), set('status', 'contacted'), set('note', 'Called the treasury lead (check)')]
        ;(f.querySelector('button[type=submit], button') as HTMLButtonElement).click()
        return r.join(',') + ' ' + ((f as HTMLFormElement).dataset.client || f.closest('[data-client]')?.getAttribute('data-client') || '?')
    }, target.client)
    await wait(2000)
    const status = await p.evaluate(() => [...document.querySelectorAll('[role=status]')].map((e) => e.textContent).join(' | '))
    const after = await admin.api(`/replays/dashboards/api/rescue?${W}`)
    const row = (after.body.clients || []).find((c: any) => c.action?.status === 'contacted')
    ok('form saves owner/status/note', !!row && row.action.owner === 'lens-check-admin@example.invalid' && /Called/.test(row.action.note || ''), `form: ${filled}; status: ${status.slice(0, 80)}; row: ${row ? row.client_name + ' ' + row.action.status : 'none'}`)
    const audit = await admin.api('/replays/admin/api/audit?q=rescue')
    ok('change is in the activity log', (audit.body.audit || []).some((a: any) => a.action === 'rescue.updated'))

    // 4. snooze: hidden, include_snoozed shows it, back to open
    const snooze = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)
    // Snooze from the period being viewed, as the page does: the score kept for "worse since snoozed" is for that period.
    const sn = await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client) + '?' + W, 'POST', { status: 'expected', snooze_until: snooze, note: 'Seasonal, expected (check)' })
    const hidden = await admin.api(`/replays/dashboards/api/rescue?${W}`)
    const shown = await admin.api(`/replays/dashboards/api/rescue?${W}&include_snoozed=true`)
    ok('snoozed client hidden, counted, and shown on request', sn.status === 200 && !(hidden.body.clients || []).some((c: any) => c.client === target.client) && hidden.body.hidden_snoozed >= 1 && (shown.body.clients || []).some((c: any) => c.client === target.client), `POST ${sn.status}, hidden ${hidden.body.hidden_snoozed}`)
    ok('expected without a snooze date is refused', (await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { status: 'expected', snooze_until: null })).status === 400)
    ok('bad owner is refused', (await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { owner: 'not an email' })).status === 400)
    ok('write without the page header is refused', (await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { status: 'open' }, false)).status === 403)
    const back = await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { status: 'open', owner: '', note: '', snooze_until: null, due: null })
    ok('back to open, visible again', back.status === 200 && ((await admin.api(`/replays/dashboards/api/rescue?${W}`)).body.clients || []).some((c: any) => c.client === target.client))

    // 5. viewer cannot write
    ok('viewer cannot set a status', (await viewer.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { status: 'contacted' })).status === 403)
}
ok('viewer can read the queue', (await viewer.api(`/replays/dashboards/api/rescue?${W}`)).status === 200)

// 5b. the Period choice in the page itself (select Last 14 days, Apply) finds the planted problems
{
    const p = admin.page; await p.goto(LENS + '/replays/dashboards?view=rescue', { waitUntil: 'networkidle0' })
    await p.select('select[name=days]', '14')
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), p.evaluate(() => (document.querySelector('select[name=days]') as HTMLSelectElement).form!.requestSubmit())])
    const txt = await p.evaluate(() => document.body.innerText)
    ok('page: choosing Last 14 days shows Treasury 1 (urgent) and Treasury 2', /Treasury 1/.test(txt) && /urgent/.test(txt) && /Treasury 2/.test(txt) && !/Waiting for processed history/.test(txt), (/Data through[^\n]*/.exec(txt) || [''])[0])
}

// 6. chat with real personal keys
const at = await admin.api('/replays/connect/api/tokens', 'POST', { label: 'rescue check' })
const vt = await viewer.api('/replays/connect/api/tokens', 'POST', { label: 'rescue check' })
const ac = await chat(at.body.token), vc = await chat(vt.body.token)
const an = await ac.list(), vn = await vc.list()
ok('chat: admin has rescue_queue and set_rescue_status', an.includes('rescue_queue') && an.includes('set_rescue_status'))
ok('chat: viewer has rescue_queue only', vn.includes('rescue_queue') && !vn.includes('set_rescue_status'))
t = Date.now(); const rq = await vc.call('rescue_queue', { when: 'last 14 days' }); const rqms = Date.now() - t
const rqText = JSON.stringify(rq.data?.result?.content || rq.data?.error || '')
ok('chat: rescue_queue answers with reasons and a link', rq.status === 200 && !rq.data?.result?.isError && /replays\/dashboards/.test(rqText) && (!target || rqText.includes(target.client_name)), `${rqms} ms; ${rqText.slice(0, 220)}`)
if (target) {
    const set = await ac.call('set_rescue_status', { client: target.client_name, status: 'in_progress', note: 'Set from chat (check)' })
    const r2 = await admin.api(`/replays/dashboards/api/rescue?${W}`)
    ok('chat: set_rescue_status by client name updates the queue', set.status === 200 && !set.data?.result?.isError && (r2.body.clients || []).some((c: any) => c.client === target.client && c.action?.status === 'in_progress'), JSON.stringify(set.data?.result?.content || set.data?.error).slice(0, 160))
    await admin.api('/replays/dashboards/api/rescue/' + encodeURIComponent(target.client), 'POST', { status: 'open', owner: '', note: '' })
}
for (const [s, tok] of [[admin, at], [viewer, vt]] as const) { const l = await s.api('/replays/connect/api/tokens'); for (const k of l.body.tokens) if (!k.revoked_at) await s.api('/replays/connect/api/tokens/' + k.id, 'DELETE') }

console.log('\n' + report.join('\n'))
console.log(`\n${report.filter((r) => r.startsWith('PASS')).length} passed, ${report.filter((r) => r.startsWith('FAIL')).length} failed`)
await browser.close()
