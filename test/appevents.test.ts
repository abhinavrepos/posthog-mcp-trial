// The app's own events (APP_EVENTS_FILE): reading Reval-like events into stories and friction.
// The events here are made up in the shape Reval sends; no real data.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'triage-appevents-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.CLIENT_FROM_DISTINCT_ID = '3'
process.env.PROP_CLIENT_NAME = 'none'
process.env.POSTHOG_PROJECT_ID = '123456'
const { db } = await import('../src/core/db.ts')
const ae = await import('../src/core/appevents.ts')
const { clientExpr, P } = await import('../src/core/props.ts')
const { registerTools, APP_EVENT_TOOLS, CORE_TOOLS } = await import('../src/mcp/tools.ts')
const { DASHBOARD_TOOLS, dashboardToolNames } = await import('../src/mcp/dashboardtools.ts')
const { SURVEY_TOOLS } = await import('../src/mcp/surveytools.ts')
const { serverInstructions, INSTRUCTIONS_LIMIT } = await import('../src/mcp/instructions.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const reg = ae.parseAppEvents(JSON.parse(readFileSync('config/app-events.reval.json', 'utf8')))
type E = Partial<import('../src/core/appevents.ts').RawEvent> & { s: number }
const T0 = Date.parse('2026-11-05T10:00:00Z')
const session = (sid: string, client: string, list: E[]) =>
    list.map(({ s, ...e }) => ({ sid, client, user: `C1DEV|01|${client}|USER1`, ts: new Date(T0 + s * 1000).toISOString(), event: 'Event', dialog: '', ...e }))
const open = (s: number, dialog: string, dialogName: string, tab = dialogName): E => ({ s, event: 'PageView', dialog, dialogName, tab, action: 'OPEN' })
const press = (s: number, dialog: string, button: string, dialogName = 'X'): E => ({ s, dialog, dialogName, tab: 'Main', button })
const message = (s: number, text: string): E => ({ s, dialog: 'messagebox', dialogName: 'UNKNOWN', tab: 'UNKNOWN', button: JSON.stringify([text]) })
const notice = (s: number, text: string): E => ({ s, dialog: 'toast', dialogName: 'UNKNOWN', tab: 'UNKNOWN', button: JSON.stringify([text]) })
const field = (s: number, dialog: string, action: string, control = 'TEXTFIELD'): E => ({ s, dialog, dialogName: 'X', tab: 'Parameters', action, control })

// A hedge designation that fails twice the same way, then works; an accrual report that fails and is given up.
const hedge = session('s1', 'RQA', [
    open(0, 'DlgDetailFasLinkAdvanced', 'Hedge Designation'),
    press(10, 'DlgDetailFasLinkAdvanced', 'Save', 'Hedge Designation'),
    message(11, 'Please designate a risk. Could not save FAS Link.'),
    field(15, 'DlgDetailFasLinkAdvanced', 'gridfloatedit-3404-inputEl'),
    press(21, 'DlgDetailFasLinkAdvanced', 'Save', 'Hedge Designation'),
    message(22, 'Please designate a risk. Could not save FAS Link.'),
    field(30, 'DlgDetailFasLinkAdvanced', 'Risk', 'DROPDOWN'),
    press(40, 'DlgDetailFasLinkAdvanced', 'Save', 'Hedge Designation'),
    notice(41, 'Link Id 3508 Added'),
])
const accrual = session('s2', 'C26', [
    { s: 0, dialog: 'menuCmb', dialogName: 'Menu', tab: 'Menu', action: 'Menu', control: 'SEARCHTYPE' },
    { s: 2, dialog: 'menuCmb', dialogName: 'Menu', tab: 'Menu', action: 'Accrual Report', control: 'SEARCH' },
    open(3, 'DlgRepAccrEnh', 'Accrual Report Parameters', 'Parameters'),
    field(5, 'DlgRepAccrEnh', 'From Trade Id'),
    press(9, 'DlgRepAccrEnh', 'Run', 'Accrual Report Parameters'),
    message(10, 'Please provide an Accrual Date range'),
    { s: 30, dialog: 'menuCmb', dialogName: 'Menu', tab: 'Trades', action: 'Trades', control: 'SEARCHTYPE' },
    { s: 31, dialog: 'menuCmb', dialogName: 'Menu', tab: 'Trades', action: 'COUNTERPARTY BANK', control: 'SEARCH' },
    message(32, 'No trades found for search text: COUNTERPARTY BANK'),
    { s: 400, event: 'PageView', dialog: 'DlgRepAccrEnh', dialogName: 'Accrual Report Parameters', action: 'CLOSE' },
])
const report = session('s3', 'C32', [
    open(0, 'DlgRepAccrEnh', 'Accrual Report Parameters', 'Parameters'),
    press(5, 'DlgRepAccrEnh', 'Run', 'Accrual Report Parameters'),
    notice(6, 'The async report has been scheduled'),
    press(60, 'DlgRepAccrEnh', 'Export', 'Accrual Report Parameters'),
])

describe('reading the vocabulary', () => {
    test('the Reval file loads', () => {
        assert.equal(reg.app, 'Reval')
        assert.equal(reg.properties.dialog?.name, 'dialog_id')
        assert.ok(reg.submitButtons.includes('Save'))
    })
    test('property names must be plain names, since they go into HogQL', () => {
        assert.throws(() => ae.parseAppEvents({ properties: { dialog: { name: "x') OR 1=1 --" } } }), /plain property name/)
        assert.throws(() => ae.parseAppEvents({ properties: {} }), /properties.dialog is required/)
        assert.throws(() => ae.parseAppEvents({ properties: { dialog: { name: 'd' }, colour: { name: 'c' } } }), /unknown property role/)
        assert.throws(() => ae.parseAppEvents({ properties: { dialog: { name: 'd' } }, redact: ['('] }), /not a regular expression/)
        assert.throws(() => ae.parseAppEvents({ properties: { dialog: { name: 'd' } }, messageOutcome: 'bad' }), /outcome/)
    })
})

describe('messages are generalised', () => {
    const g = (t: string) => ae.generalise(t, reg)
    test('ids, numbers and dates go; words and short numbers stay', () => {
        assert.equal(g('Trade Id 4348 Updated'), 'Trade Id # Updated')
        assert.equal(g('["New Hypothetical Trade created. Trade Id : 19028"]'), 'New Hypothetical Trade created. Trade Id : #')
        assert.equal(g('Index Setting Value cannot be blank. Please enter the value for date 2026/10/23 for IFRS 9'), 'Index Setting Value cannot be blank. Please enter the value for date <date> for IFRS 9')
        assert.equal(
            g('Last Traded Quote for rate feed code: AUD-CDS-RECOVERY-RATE-RP_100000920 at market date: 06-Nov-2026 15:35:44 not found.\\nUnable to price trade.'),
            'Last Traded Quote for rate feed code: … at market date: <date> not found. Unable to price trade.'
        )
    })
    test('user names and search text are redacted', () => {
        assert.equal(g('Mail sent to jane.doe@bank.example'), 'Mail sent to …')
        assert.equal(g('User Updated : JDOPS'), 'User Updated : …')
        assert.equal(g('No trades found for search text: COUNTERPARTY BANK'), 'No trades found for search text: …')
    })
    test('the same message for different trades groups together', () => assert.equal(g('Trade Id 50758 Added'), g('Trade Id 19027 Added')))
    test('outcomes: queued, nothing found, error, done', () => {
        assert.equal(ae.outcomeOf('The async report has been scheduled', true, reg), 'accepted')
        assert.equal(ae.outcomeOf('No trades found for search text: 1', false, reg), 'empty')
        assert.equal(ae.outcomeOf('Please provide an Accrual Date range', false, reg), 'error')
        assert.equal(ae.outcomeOf('Trade Id 1 Added', true, reg), 'completed')
    })
})

describe('steps', () => {
    test('each attempt gets the outcome of the message that follows it', () => {
        const steps = ae.toSteps(hedge, reg)
        const saves = steps.filter((s) => s.kind === 'submit')
        assert.deepEqual(saves.map((s) => s.outcome), ['error', 'error', 'completed'])
        const errors = steps.filter((s) => s.kind === 'message')
        assert.ok(errors.every((m) => m.dialog === 'DlgDetailFasLinkAdvanced' && m.name === 'Hedge Designation'))
    })
    test('an attempt with no message in time has outcome none', () => {
        const steps = ae.toSteps(report, reg)
        assert.deepEqual(steps.filter((s) => s.kind === 'submit').map((s) => s.outcome), ['accepted', 'none'])
    })
    test('a message after a search belongs to the menu bar', () => {
        const m = ae.toSteps(accrual, reg).find((s) => s.text?.startsWith('No trades'))!
        assert.equal(m.dialog, 'menuCmb')
        assert.equal(m.outcome, 'empty')
    })
    test('order of arrival does not matter', () => {
        const a = ae.toSteps(hedge, reg).map((s) => [s.kind, s.outcome])
        const b = ae.toSteps([...hedge].reverse(), reg).map((s) => [s.kind, s.outcome])
        assert.deepEqual(a, b)
    })
    test('a message at the same moment as the attempt still answers it', () => {
        const same = session('t1', 'X', [press(5, 'D', 'Save'), message(5, 'Please select Trade Type')])
        assert.equal(ae.toSteps([...same].reverse(), reg).find((x) => x.kind === 'submit')!.outcome, 'error')
    })
    test('a search after an attempt ends the wait: the search gets the message', () => {
        const moved = session('t2', 'X', [
            press(0, 'A', 'Save'),
            { s: 3, dialog: 'menuCmb', action: 'Trades', control: 'SEARCHTYPE' },
            { s: 4, dialog: 'menuCmb', action: '123', control: 'SEARCH' },
            message(5, 'No trades found for search text: 123'),
        ])
        const st = ae.toSteps(moved, reg)
        assert.equal(st.find((x) => x.kind === 'submit')!.outcome, 'none')
        assert.equal(st.find((x) => x.kind === 'message')!.dialog, 'menuCmb')
    })
    test('a success notice after an error is a recovery, not a stuck session', () => {
        const rec = session('t3', 'X', [press(0, 'D', 'Save'), message(1, 'Case Id: Input required'), field(5, 'D', 'Case Id'), notice(9, 'User Updated : X')])
        assert.equal(ae.frictionByDialog([ae.toSteps(rec, reg)], reg, new Map())[0].stuck_sessions, 0)
    })
    test('field labels are decoded', () => {
        const st = ae.toSteps(session('t4', 'X', [field(1, 'D', 'C&amp;P Mapping User ID')]), reg)
        assert.equal(st[0].label, 'C&P Mapping User ID')
    })
    test('generated ids are not shown as labels', () => {
        const f = ae.toSteps(hedge, reg).find((s) => s.kind === 'field')!
        assert.equal(f.label, 'an unlabelled textfield')
    })
})

describe('the session story', () => {
    test('reads like what happened', () => {
        const r = ae.renderStory(ae.toSteps(accrual, reg), reg)
        const t = r.lines.join('\n')
        assert.match(t, /searched "Accrual Report"/)
        assert.match(t, /Accrual Report Parameters( › \w+)?: pressed \[Run\] → FAILED/)
        assert.match(t, /✘ ERROR: "Please provide an Accrual Date range"/)
        assert.match(t, /min with nothing/)
        assert.match(t, /closed Accrual Report Parameters/)
        assert.equal(r.failed, 1)
        assert.equal(r.errors[0].at_s, 10)
    })
    test('search text outside the menu is not shown', () => {
        const t = ae.renderStory(ae.toSteps(accrual, reg), reg).lines.join('\n')
        assert.ok(!t.includes('COUNTERPARTY'), t)
        assert.match(t, /searched "…"/)
    })
    test('repeats are folded and the line limit holds', () => {
        const many = session('s9', 'X', Array.from({ length: 50 }, (_, i) => field(i, 'D', 'Name')))
        const r = ae.renderStory(ae.toSteps(many, reg), reg)
        assert.equal(r.lines.length, 1)
        assert.match(r.lines[0], /×50$/)
        const long = session('s8', 'X', Array.from({ length: 50 }, (_, i) => field(i, 'D', `F${i % 2 ? 'a' : 'b'}${i}`)))
        assert.equal(ae.renderStory(ae.toSteps(long, reg), reg, { maxLines: 20 }).lines.length, 20)
    })
})

describe('friction per dialog', () => {
    const f = ae.frictionByDialog([hedge, accrual, report].map((s) => ae.toSteps(s, reg)), reg, new Map([['DlgRepAccrEnh', { opens: 2 }]]))
    const by = Object.fromEntries(f.map((d) => [d.dialog, d]))
    test('attempts, outcomes and retries', () => {
        const h = by.DlgDetailFasLinkAdvanced
        assert.equal(h.attempts, 3)
        assert.deepEqual(h.outcomes, { completed: 1, accepted: 0, error: 2, empty: 0, none: 0 })
        assert.equal(h.retry_loops, 2)
        assert.equal(h.stuck_sessions, 0, 'it worked in the end')
        assert.equal(h.errors[0].count, 2)
        assert.equal(h.errors[0].sessions, 1)
        assert.deepEqual(h.errors[0].clients, ['RQA'])
    })
    test('a failure that is never fixed is a stuck session', () => {
        const a = by.DlgRepAccrEnh
        assert.equal(a.name, 'Accrual Report Parameters')
        assert.equal(a.opens, 2)
        assert.equal(a.attempts, 3)
        assert.equal(a.stuck_sessions, 1)
        assert.deepEqual(a.clients_with_errors, ['C26'])
        assert.equal(a.clients, 2)
    })
    test('messages and notices are not dialogs of their own', () => {
        assert.ok(!by.messagebox && !by.toast)
        assert.equal(by.menuCmb.name, 'Menu bar')
    })
    test('dialogs with errors for more clients come first', () => assert.deepEqual(f.slice(0, 2).map((d) => d.clients_with_errors.length), [1, 1]))
})

describe('trade ids stay, search text does not', () => {
    const a = session('k1', 'C1', [press(0, 'S', 'Save', 'IR Swap'), message(1, 'Last Traded Quote not found for trade 4348. Unable to price trade.'), press(20, 'S', 'Save', 'IR Swap'), notice(21, 'Trade Id 4348 Updated')])
    const b = session('k2', 'C2', [press(0, 'S', 'Save', 'IR Swap'), message(1, 'Last Traded Quote not found for trade 19027. Unable to price trade.')])
    test('the story shows the trade id', () => {
        const t = ae.renderStory(ae.toSteps(a, reg), reg).lines.join('\n')
        assert.match(t, /"Last Traded Quote not found for trade 4348\. Unable to price trade\."/)
        assert.match(t, /"Trade Id 4348 Updated"/)
    })
    test('the same error on two trades is one problem, listing both messages', () => {
        const f = ae.frictionByDialog([a, b].map((x) => ae.toSteps(x, reg)), reg, new Map()).find((d) => d.dialog === 'S')!
        assert.equal(f.errors.length, 1)
        assert.equal(f.errors[0].text, 'Last Traded Quote not found for trade #. Unable to price trade.')
        assert.equal(f.errors[0].count, 2)
        assert.deepEqual(f.errors[0].messages.sort(), ['Last Traded Quote not found for trade 19027. Unable to price trade.', 'Last Traded Quote not found for trade 4348. Unable to price trade.'])
    })
    test('find_trade reads from where the trade was opened (pure part: steps carry the cause)', () => {
        const st = ae.toSteps(a, reg)
        const notice = st.find((x) => x.kind === 'notice')!
        assert.equal(st[notice.cause!].kind, 'submit')
    })
    test('search text in a message stays hidden', () => assert.equal(ae.cleanMessage('No trades found for search text: ACME BANK', reg), 'No trades found for search text: …'))
})

describe('top pains', () => {
    const now = ae.frictionByDialog([hedge, accrual, report].map((x) => ae.toSteps(x, reg)), reg, new Map())
    const before = ae.frictionByDialog([report].map((x) => ae.toSteps(x, reg)), reg, new Map())
    const pains = ae.rankPains(now, before)
    test('only dialogs with failures, ranked, with a headline a PM can read', () => {
        assert.deepEqual(pains.map((p) => p.rank), [1, 2, 3].slice(0, pains.length))
        assert.ok(pains.every((p) => p.failed_attempts || p.clients_hit.length))
        const h = pains.find((p) => p.dialog === 'DlgDetailFasLinkAdvanced')!
        assert.match(h.headline, /^Hedge Designation: 1 client hit errors, 2 of 3 attempts failed, 2 retries after a failure\. Main error: "Please designate a risk\. Could not save FAS Link\."\.$/)
        assert.equal(h.trend, 'new')
        assert.equal(h.example?.session_id, 's1')
    })
    test('the trend compares with the period before', () => {
        const a = ae.rankPains(now, now).find((p) => p.dialog === 'DlgRepAccrEnh')!
        assert.equal(a.trend, 'same')
        const fixed = ae.rankPains(before.length ? before : now, now)
        assert.ok(fixed.every((p) => p.trend !== 'worse'))
    })
    test('at most max', () => assert.equal(ae.rankPains(now, [], 1).length, 1))
})

describe('client signals', () => {
    const period = (sessions: number, users: string[], days: number, dialogs: number, attempts: number, errors: number) => ({ sessions, users, days, dialogs, attempts, errors })
    const at = Date.parse('2026-11-10T00:00:00Z')
    const list = ae.clientSignals(
        [
            { client: 'STEADY', now: period(20, ['A|1|S|U1', 'A|1|S|U2'], 8, 10, 40, 4), before: period(21, ['A|1|S|U1', 'A|1|S|U2'], 8, 10, 40, 4), last_seen: '2026-11-09T12:00:00Z' },
            { client: 'FADING', now: period(6, ['A|1|F|OPS1'], 3, 4, 10, 1), before: period(24, ['A|1|F|OPS1', 'A|1|F|OPS2', 'A|1|F|RISK1'], 9, 9, 30, 3), last_seen: '2026-11-08T12:00:00Z' },
            { client: 'HURTING', now: period(15, ['A|1|H|FX'], 7, 6, 20, 9), before: period(14, ['A|1|H|FX'], 7, 6, 20, 2), last_seen: '2026-11-09T12:00:00Z' },
            { client: 'GONE', now: period(0, [], 0, 0, 0, 0), before: period(8, ['A|1|G|X'], 4, 5, 10, 1), last_seen: '2026-10-25T12:00:00Z' },
        ],
        at
    )
    const by = Object.fromEntries(list.map((c) => [c.client, c]))
    test('a steady client has no signals and comes last', () => {
        assert.deepEqual(by.STEADY.signals, [])
        assert.equal(list.at(-1)!.client, 'STEADY')
    })
    test('less use and people gone quiet, by name', () => {
        assert.ok(by.FADING.signals.some((s) => /sessions down 75% \(24 → 6\)/.test(s)), by.FADING.signals.join('; '))
        assert.ok(by.FADING.signals.some((s) => /2 of 3 users not seen this period: OPS2, RISK1/.test(s)))
        assert.deepEqual(by.FADING.quiet_users, ['OPS2', 'RISK1'])
    })
    test('more failures', () => assert.match(by.HURTING.signals[0], /45% of attempts failed \(was 10%/))
    test('a client that stopped', () => assert.ok(by.GONE.signals.some((s) => /not seen for 15 days/.test(s))))
})

describe('the client from the distinct id', () => {
    test('part 3 of ENV|SITE|CLIENT|USER', () => {
        assert.equal(P.client, "splitByChar('|', toString(distinct_id))[3]")
        assert.equal(P.clientName, `toString(${P.client})`)
    })
    test('or an event property', () => assert.equal(clientExpr({ client: 'client_id', clientName: '', version: '', personEmail: 'email', clientFromDistinctId: 0, distinctIdSeparator: '|' }), 'properties.client_id'))
})

describe('the MCP server with app events', async () => {
    const server = new McpServer({ name: 't', version: '0' }, { instructions: serverInstructions(true) })
    registerTools(server)
    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    test('offers app tools with reval_brief first and the PM prompts', async () => {
        const names = (await client.listTools()).tools.map((t) => t.name)
        for (const n of ['discover_workflows', 'workflow_completion', 'message_doctor', 'reval_brief', 'describe_app_events', 'session_story', 'dialog_friction', 'client_signals', 'attempt_timings', 'top_pains', 'find_trade']) assert.ok(names.includes(n), n)
        assert.ok(names.indexOf('reval_brief') < names.indexOf('describe_app_events'))
        const prompts = (await client.listPrompts()).prompts.map((p) => p.name)
        for (const n of ['where_clients_struggle', 'weekly_review', 'client_check', 'release_check']) assert.ok(prompts.includes(n), n)
    })
    test('PM prompts call reval_brief first with explicit arguments and no invented additions', async () => {
        const cases = [
            { name: 'where_clients_struggle', arguments: { client: 'ACME', when: 'last 3 days' }, expected: { client: 'ACME', when: 'last 3 days' } },
            { name: 'weekly_review', expected: { when: 'last 7 days' } },
            { name: 'client_check', arguments: { client: 'ACME' }, expected: { client: 'ACME' } },
            { name: 'release_check', arguments: { release: '26.10.0' }, expected: { when: 'last 14 days' } },
            { name: 'release_check', expected: { when: 'last 14 days' } },
        ]
        for (const item of cases) {
            const prompt = await client.getPrompt({ name: item.name, arguments: item.arguments as Record<string, string> | undefined })
            const content = prompt.messages[0].content
            assert.equal(content.type, 'text')
            const text = content.type === 'text' ? content.text : ''
            assert.match(text, /Call reval_brief first with /)
            assert.match(text, /[Aa]dd (nothing invented|no invented facts)/)
            const args = JSON.parse(text.match(/Call reval_brief first with (\{[^\n]+\})\./)![1])
            for (const [key, value] of Object.entries(item.expected)) assert.equal(args[key], value)
            if (item.name === 'release_check') assert.match(args.question, /release/)
        }
    })
    test('lists every app tool exactly once, with reval_brief first', async () => {
        const names = (await client.listTools()).tools.map((t) => t.name)
        // Dashboard tools (task map, flow time) and survey tools are listed on their own.
        const appNames = names.filter((name) => !CORE_TOOLS.includes(name) && !DASHBOARD_TOOLS.includes(name) && !SURVEY_TOOLS.includes(name))
        assert.deepEqual(names.filter((n) => DASHBOARD_TOOLS.includes(n)).sort(), dashboardToolNames().sort())
        assert.equal(APP_EVENT_TOOLS[0], 'reval_brief')
        assert.equal(appNames[0], 'reval_brief')
        assert.equal(new Set(APP_EVENT_TOOLS).size, APP_EVENT_TOOLS.length)
        assert.deepEqual([...appNames].sort(), [...APP_EVENT_TOOLS].sort())
    })
    test('workflow tools describe automatic discovery and accept ids, names or dialogs', async () => {
        const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]))
        for (const name of ['discover_workflows', 'workflow_completion']) {
            assert.ok(tools.get(name)?.description?.startsWith('Which tasks do people do in Reval, and do they finish them?'), name)
            assert.equal(tools.get(name)?.annotations?.readOnlyHint, true)
        }
        assert.match(tools.get('discover_workflows')?.description || '', /Lens supplies names/)
        assert.match(tools.get('workflow_completion')?.description || '', /discovered workflow id\/name/)
    })
    test('the instructions name them, say where the client is, and still fit', () => {
        const text = client.getInstructions() || ''
        for (const n of ['reval_brief', 'describe_app_events', 'session_story', 'dialog_friction', 'client_signals', 'attempt_timings', 'top_pains', 'find_trade', 'discover_workflows', 'workflow_completion', 'message_doctor']) assert.ok(text.includes(n), n)
        const appLine = text.split('\n').filter((line) => line.includes('reval_brief'))
        assert.equal(appLine.length, 1)
        assert.ok(appLine[0].startsWith('- reval_brief'))
        assert.match(text, /part 3 of the distinct id/)
        assert.ok(text.length + 100 < INSTRUCTIONS_LIMIT, `instructions are ${text.length} characters`)
    })
})

test('generalise: identifiers mixing letters and digits, same as before, in linear time', async () => {
    const { generalise } = await import('../src/core/appevents.ts')
    const reg = { redact: [] as string[] }
    // The previous single regex, kept here only to prove the new code gives the same answers.
    const old = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…').replace(/[A-Za-z0-9_.-]*(?:[A-Za-z][A-Za-z0-9_.-]*\d|\d[A-Za-z0-9_.-]*[A-Za-z])[A-Za-z0-9_.-]*/g, (t) => (t.length >= 5 ? '…' : t)).replace(/\d{3,}/g, '#')
    for (const s of ['Trade Id 4348 Updated', 'Feed USD-LIBOR3M failed', 'User ab12 ok', 'IFRS 9 hedge', 'Run report_2024_Q3.v2 now', 'x1 y22 z333 abc1234', 'plain words only', 'A-1 B.2c d_3e4f', 'Mail jo.smith+x@acme-co.com about T123', 'a@b c@d.e user@host.co.uk', 'no-at-sign.example.com'])
        assert.equal(generalise(s, reg), old(s), s)
    // A long run of letters with no digit made the old regex backtrack for seconds or minutes.
    const t = performance.now()
    for (const long of ['Error ' + 'a'.repeat(30_000) + ' in step', 'x'.repeat(30_000), 'a1'.repeat(15_000), 'a.'.repeat(15_000)]) generalise(long, reg, 100_000)
    assert.ok(performance.now() - t < 200, `took ${Math.round(performance.now() - t)} ms`)
})
