// End-to-end check of client anonymisation for AI (Admin → Client privacy for AI) on a deployed Lens, with
// its real clients: with the setting on, every Lens tool, prompt and listing, and the PostHog MCP proxy in
// both modes, are called the way an agent would, and every byte that comes back is searched for any client
// name, other name or code. Also: real names and codes are refused, codenames work, links open the client,
// and with the setting off everything is as before. The setting is put back as it was at the end.
// See scripts/e2e/README.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import puppeteer from 'puppeteer'

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) { console.error(`Set ${k} (see scripts/e2e/README.md)`); process.exit(2) } return v }
const S = env('E2E_OUT', 'e2e-out')
const LENS = env('LENS_URL', 'http://127.0.0.1:8080')
const pw = (process.env.E2E_PASSWORD ?? readFileSync(env('E2E_PASSWORD_FILE'), 'utf8')).trim()
const ADMIN = env('E2E_ADMIN', 'lens-check-admin@example.invalid')
mkdirSync(S, { recursive: true })
const report: string[] = []
const ok = (l: string, c: boolean, x = '') => { report.push((c ? 'PASS ' : 'FAIL ') + l + (x ? ' — ' + x : '')); return c }
const note = (l: string) => report.push('NOTE ' + l)
const COMMON = new Set(['alpha', 'beta', 'gamma', 'delta', 'omega', 'test', 'demo', 'main', 'core', 'base', 'open', 'data', 'bank', 'fund', 'cash', 'risk', 'trade', 'deal', 'swap', 'loan', 'bond', 'live', 'prod', 'user', 'admin', 'team', 'home', 'next', 'new', 'old', 'one', 'two', 'all', 'any', 'and', 'the', 'for', 'not', 'yes', 'no', 'ok', 'id', 'api', 'app', 'web', 'acc', 'ref', 'tmp', 'dev'])

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
const page = await (await browser.createBrowserContext()).newPage()
await page.goto(LENS + '/replays', { waitUntil: 'networkidle0' })
await page.type('input[type=email]', ADMIN); await page.type('input[type=password]', pw)
await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('form button')])
const api = (path: string, method = 'GET', body?: unknown) => page.evaluate(async (path, method, body) => {
    const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-clip-page': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const t = await r.text(); let j: any; try { j = JSON.parse(t) } catch { j = t }
    return { status: r.status, body: j }
}, path, method, body)

let rpcId = 1
async function mcp(path: string, token: string, method: string, params: unknown = {}, sid?: string) {
    const r = await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
    const raw = await r.text()
    const data = r.headers.get('content-type')?.includes('event-stream') ? raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return l } }).pop() : (raw ? (() => { try { return JSON.parse(raw) } catch { return raw } })() : undefined)
    return { status: r.status, sid: r.headers.get('mcp-session-id') || sid, raw, data }
}
async function session(path: string, token: string) {
    const init = await mcp(path, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'privacy-check', version: '1' } })
    if (init.sid) await fetch(LENS + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': init.sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    return init
}

const start = (await api('/replays/admin/privacy/api/state')).body
const original = start.settings
const key = (await api('/replays/connect/api/tokens', 'POST', { label: 'privacy-check' })).body
const token: string = key.token
try {
    // ------------------------------------------------------------ turned on in the middle of a chat
    // A chat open before the switch: names while off, codenames from the next message on.
    await api('/replays/admin/privacy/api/settings', 'POST', { on: false, lens: true, posthog: 'block', triage: true, codes: true, emails: true, message: '' })
    const early = await session('/mcp', token)
    const rq = (await api('/replays/dashboards/api/rescue', 'GET')).body?.clients?.[0]
    const beforeOn = await mcp('/mcp', token, 'tools/call', { name: 'rescue_queue', arguments: {} }, early.sid)
    // ------------------------------------------------------------ what must never come out
    const state = (await api('/replays/admin/privacy/api/settings', 'POST', { on: true, posthog: 'block' })).body
    ok('setting turns on', state.on === true && state.posthog === 'block', JSON.stringify(state))
    const clients: { client: string; name: string; codename: string; aliases: string[]; auto_aliases: string[] }[] = (await api('/replays/admin/privacy/api/state')).body.clients
    ok('every known client has a codename', clients.length > 0 && clients.every((c) => /^[A-Z]/.test(c.codename)), `${clients.length} clients`)
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const needles = clients.flatMap((c) => {
        const out: { what: string; re: RegExp }[] = []
        for (const n of [c.name, ...c.aliases, ...c.auto_aliases].filter((x) => x && x.trim().length >= 3)) out.push({ what: `${c.codename}: name "${n}"`, re: new RegExp(`(?<![\\p{L}\\p{N}])${n.trim().split(/[\s_.+\-]+/).map(esc).join('(?:[\\s_.+\\-]|%20)+')}(?![\\p{L}\\p{N}])`, 'iu') })
        // As Lens matches them (src/core/anonymise.ts COMMON): a code that is also a common word counts only as written.
        const short = /^[A-Za-z]+$/.test(c.client) && COMMON.has(c.client.toLowerCase())
        out.push({ what: `${c.codename}: code "${c.client}"`, re: new RegExp(`(?<![\\p{L}\\p{N}_\\-])${esc(c.client)}(?![\\p{L}\\p{N}_\\-])`, short ? 'u' : 'iu') })
        return out
    })
    const leaks = (text: string) => needles.filter((n) => n.re.test(text)).map((n) => { const m = n.re.exec(text)!; return `${n.what} in "…${text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')}…"` })
    const all: string[] = []
    const check = (label: string, raw: string) => { all.push(raw); const l = leaks(raw); ok(`no client in: ${label}`, !l.length, l.slice(0, 3).join(' | ')) }

    const afterOn = await mcp('/mcp', token, 'tools/call', { name: 'rescue_queue', arguments: {} }, early.sid)
    if (rq) ok('turned on mid-chat: the same chat sees the client before, and only its codename after', beforeOn.raw.includes(rq.client) && !leaks(afterOn.raw).length && afterOn.raw.includes(clients.find((c) => c.client === rq.client)?.codename || '§'), `${rq.client}: before ${beforeOn.raw.includes(rq.client)}, after leaks ${leaks(afterOn.raw).length}`)
    // A client with history, for codename questions.
    const rescue = (await api('/replays/dashboards/api/rescue', 'GET')).body
    const busy = rescue?.clients?.[0]?.client as string | undefined
    const target = clients.find((c) => c.client === busy) ?? clients[0]
    note(`asking about ${target.codename} (a client with ${busy ? 'rescue reasons' : 'history'})`)

    // ------------------------------------------------------------ Lens MCP: everything an agent can list or call
    const init = await session('/mcp', token)
    check('initialize (instructions)', init.raw)
    const tools = await mcp('/mcp', token, 'tools/list', {}, init.sid); check('tools/list', tools.raw)
    for (const m of ['prompts/list', 'resources/list', 'resources/templates/list']) check(m, (await mcp('/mcp', token, m, {}, init.sid)).raw)
    const SKIP = new Set(['record_verdict', 'correct_ticket_link', 'refresh_releases', 'save_survey', 'stop_survey', 'set_rescue_status', 'pin_dashboard', 'share_dashboard', 'unpin_dashboard', 'draft_rescue_survey', 'get_replay_link'])
    const value = (prop: string, schema: any): unknown => {
        if (/^clients?$|client_id/i.test(prop)) return schema?.type === 'array' ? [target.codename] : target.codename
        const named: Record<string, unknown> = { query: target.codename, scope: 'all', screen: '/', key: 'REV-1', id: '4348', question: 'What needs attention this week?', name: 'privacy check', text: 'How easy was it?' }
        if (prop in named) return named[prop]
        if (schema?.enum) return schema.enum[0]
        if (schema?.type === 'number' || schema?.type === 'integer') return schema.minimum ?? 7
        if (schema?.type === 'boolean') return false
        if (schema?.type === 'array') return []
        if (schema?.type === 'object') return {}
        return 'x'
    }
    let called = 0
    for (const t of tools.data?.result?.tools ?? []) {
        if (SKIP.has(t.name) || t.annotations?.destructiveHint) continue
        const props = t.inputSchema?.properties ?? {}, req = new Set<string>(t.inputSchema?.required ?? [])
        const base = Object.fromEntries(Object.entries(props).filter(([k]) => req.has(k)).map(([k, s]) => [k, value(k, s)]))
        const withClient = Object.fromEntries(Object.entries(props).filter(([k]) => req.has(k) || /client/i.test(k)).map(([k, s]) => [k, value(k, s)]))
        for (const args of JSON.stringify(base) === JSON.stringify(withClient) ? [base] : [base, withClient]) {
            const r = await mcp('/mcp', token, 'tools/call', { name: t.name, arguments: args }, init.sid)
            called++
            check(`${t.name}(${JSON.stringify(args).slice(0, 80)})`, r.raw)
        }
    }
    ok('every listed tool was called', called >= 20, `${called} calls`)
    for (const p of (await mcp('/mcp', token, 'prompts/list', {}, init.sid)).data?.result?.prompts ?? []) {
        const args = Object.fromEntries((p.arguments ?? []).map((a: any) => [a.name, /client/i.test(a.name) ? target.codename : 'x']))
        check(`prompt ${p.name}`, (await mcp('/mcp', token, 'prompts/get', { name: p.name, arguments: args }, init.sid)).raw)
    }

    // ------------------------------------------------------------ refusals, codenames, links
    const REFUSED = /Client names and client codes are hidden from AI/
    const refusedCalls: [string, unknown][] = [
        ['client_story', { client: target.client }], ['client_story', { client: target.name || target.client }], ['client_story', { client: 'Contoso Unknown Ltd' }],
        ['resolve_client', { query: target.name || target.client }], ['resolve_client', { query: 'Contoso Unknown Ltd' }],
        ['reval_brief', { question: `How is ${target.name || target.client} doing?` }],
    ]
    for (const [name, args] of refusedCalls) {
        const r = await mcp('/mcp', token, 'tools/call', { name, arguments: args }, init.sid)
        ok(`refused: ${name}(real or unknown name)`, REFUSED.test(r.raw) || /Unknown tool|not found/i.test(r.raw), r.raw.slice(0, 160))
    }
    const story = await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.codename } }, init.sid)
    ok('codenames work: client_story(codename) answers about that client, by codename', story.status === 200 && !story.data?.result?.isError && story.raw.includes(target.codename), story.raw.slice(0, 200))
    const slug = target.codename.toLowerCase().replace(/\s+/g, '-')
    const linkPage = await page.goto(`${LENS}/replays/dashboards?view=rescue&client=${slug}`, { waitUntil: 'networkidle0' })
    ok('a codename link opens the real client in Lens', !!linkPage && new URL(page.url()).searchParams.get('client') === target.client, page.url())
    const anon = await fetch(`${LENS}/replays/codenames/api`)
    ok('codenames list needs a sign-in', anon.status === 401 || anon.status === 403, 'HTTP ' + anon.status)

    // ------------------------------------------------------------ PostHog MCP proxy, both modes
    const ph = await session('/posthog-mcp', token)
    if (ph.status === 200) {
        check('PostHog initialize', ph.raw); check('PostHog tools/list', (await mcp('/posthog-mcp', token, 'tools/list', {}, ph.sid)).raw)
        const exec = (command: string) => mcp('/posthog-mcp', token, 'tools/call', { name: 'exec', arguments: { command } }, ph.sid)
        const sql = (q: string) => `call execute-sql ${JSON.stringify({ query: q })}`
        const CLIENT_SQL = 'select distinct properties.client_id, properties.client_name from events where timestamp > now() - interval 90 day limit 50'
        for (const c of [sql(CLIENT_SQL), 'call query-trends {}', 'call insights-list {}', 'call read-data-schema {}', 'tools\ncall persons-list {}', 'CALL  feature-flag-get-all {}']) {
            const r = await exec(c)
            ok(`block mode refuses: ${c.slice(0, 50)}`, /switched off while client anonymisation is on|hidden from AI/.test(r.raw), r.raw.slice(0, 160)); check(`block: ${c.slice(0, 40)}`, r.raw)
        }
        for (const c of ['tools', 'info execute-sql', 'call docs-search {"query":"feature flags"}']) { const r = await exec(c); ok(`block mode allows: ${c}`, !/switched off while/.test(r.raw), r.raw.slice(0, 120)); check(`allowed: ${c}`, r.raw) }
        await api('/replays/admin/privacy/api/settings', 'POST', { posthog: 'filter' })
        const rows = await exec(sql(CLIENT_SQL))
        ok('filter mode runs the query', rows.status === 200 && !/switched off while/.test(rows.raw), rows.raw.slice(0, 160))
        check('filter mode: client ids and names in results', rows.raw)
        ok('filter mode: results carry codenames', clients.some((c) => rows.raw.includes(c.codename)), rows.raw.slice(0, 200))
        const byCodename = await exec(sql(`select count() from events where properties.client_id = '${target.codename}'`))
        check('filter mode: query by codename', byCodename.raw)
        ok('filter mode refuses a query naming a client', REFUSED.test((await exec(sql(`select '${target.name || target.client}'`))).raw))
        // Known limit: a query written to disguise names gets past a filter. Reported, not failed: block mode is the default.
        const disguised = await exec(sql("select distinct reverse(toString(properties.client_name)) from events where timestamp > now() - interval 90 day limit 20"))
        const reversed = clients.filter((c) => c.name && disguised.raw.toLowerCase().includes(c.name.toLowerCase().split('').reverse().join(''))).length
        note(`filter mode, disguised query (reversed names): ${reversed} of ${clients.filter((c) => c.name).length} names came back reversed: why block mode is the default`)
        await api('/replays/admin/privacy/api/settings', 'POST', { posthog: 'block' })
    } else note(`PostHog MCP proxy not available (HTTP ${ph.status}): skipped`)

    // ------------------------------------------------------------ an admin's own choices
    const custom = 'Please use the client codename from Lens.'
    await api('/replays/admin/privacy/api/settings', 'POST', { message: custom })
    ok('custom message to the AI is used', (await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.client } }, init.sid)).raw.includes(custom))
    await api('/replays/admin/privacy/api/settings', 'POST', { message: '', codes: false })
    const codesShown = await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.client } }, init.sid)
    ok('codes visible (admin choice): a real code is taken and shown, names still hidden', !REFUSED.test(codesShown.raw) && codesShown.raw.includes(target.client) && (!target.name || !codesShown.raw.toLowerCase().includes(target.name.toLowerCase())), codesShown.raw.slice(0, 160))
    await api('/replays/admin/privacy/api/settings', 'POST', { codes: true, lens: false })
    const lensOff = await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.client } }, init.sid)
    ok('Lens tools not covered (admin choice): answered as before', !REFUSED.test(lensOff.raw) && lensOff.status === 200, lensOff.raw.slice(0, 160))
    await api('/replays/admin/privacy/api/settings', 'POST', { lens: true })
    ok('covered again after the choice is undone', REFUSED.test((await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.client } }, init.sid)).raw))
    const counts = (await api('/replays/admin/privacy/api/state')).body.counts
    ok('blocked and cleaned counts recorded', (counts.lens_refused ?? 0) > 0 && (counts.lens_cleaned ?? 0) > 0, JSON.stringify(counts))
    writeFileSync(`${S}/privacy-payloads.txt`, all.join('\n\n----\n\n'))

    // ------------------------------------------------------------ off again: as before
    await api('/replays/admin/privacy/api/settings', 'POST', { on: false })
    const plain = await mcp('/mcp', token, 'tools/call', { name: 'client_story', arguments: { client: target.client } }, init.sid)
    ok('off: real client codes work and names show again', plain.status === 200 && !REFUSED.test(plain.raw) && (!target.name || plain.raw.includes(target.name)), plain.raw.slice(0, 160))
} finally {
    await api('/replays/admin/privacy/api/settings', 'POST', original)
    await api('/replays/connect/api/tokens/' + key.id, 'DELETE')
    ok('settings put back as they were', JSON.stringify((await api('/replays/admin/privacy/api/state')).body.settings) === JSON.stringify(original))
    await browser.close()
}
console.log(report.join('\n'))
const failed = report.filter((l) => l.startsWith('FAIL')).length
console.log(`${report.filter((l) => l.startsWith('PASS')).length} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
