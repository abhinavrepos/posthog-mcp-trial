// Second application (Reval-style, configured by APP_EVENTS_FILE): screens from the app's screen event, message boxes as
// visible errors, the app's vocabulary as safe labels, Ext <label for> association and its ':' separator.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rv-app-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
process.env.APP_EVENTS_FILE = join(import.meta.dirname, '../config/app-events.reval.json')
const { parseAppEvents } = await import('../src/core/appevents.ts')
const { resolveAppEvent, appVocabulary } = await import('../src/core/replay-vision.ts')
const { readTimeline, appScreenKey } = await import('../src/core/replay-timeline.ts')
const { detectCandidates } = await import('../src/core/replay-vision-detectors.ts')
const { humanScreen, formatInsight } = await import('../src/core/replay-vision-aggregate.ts')
const reval = parseAppEvents(JSON.parse(readFileSync(process.env.APP_EVENTS_FILE, 'utf8')))
const base = Date.parse('2026-11-27T09:00:00Z'), iso = (ms: number) => new Date(base + ms).toISOString()

test('Reval events resolve to screen opens/closes (visible dialog name), message boxes to errors, notices to completions', () => {
    assert.equal(appScreenKey('LinkListReqv', 'Hedge Designation'), 'hedge designation:screen')
    assert.equal(appScreenKey('DlgDetailIRSwap', 'UNKNOWN'), 'dlgdetailirswap:screen')
    const r = (event: string, dialog: string, dialog_name: string, action: string) => resolveAppEvent({ timestamp: iso(0), event, path: '/', dialog, dialog_name, action }, reval)
    assert.deepEqual([r('PageView', 'DlgDetailIRSwap', 'IR Swap', 'OPEN').screen, r('PageView', 'DlgDetailIRSwap', 'IR Swap', 'OPEN').nav], ['ir swap:screen', 'open'])
    assert.equal(r('PageView', 'DlgDetailIRSwap', 'IR Swap', 'OPEN').screen_name, 'IR Swap')
    assert.equal(humanScreen('ir swap:screen', 'IR Swap'), 'IR Swap (screen)')
    assert.match(formatInsight({ screen: 'ir swap:screen', screen_name: 'IR Swap', element: 'Save', behaviour: '1 user retried Save', users_affected: 1, users_reached: 1, sessions_affected: 1, citations: [], outcome: 'No abandonment observed', time_lost_ms: 0, cause: 'Likely cause: Save is slow.', fix: 'Fix: show progress on Save.', signals: ['D10'], confidence: 'low', limitations: [], severity: 'Low' }), /^\[Low\] IR Swap \(screen\)/)
    assert.equal(r('PageView', 'DlgDetailIRSwap', 'IR Swap', 'CLOSE').nav, 'close')
    assert.equal(r('PageView', 'DlgDetailIRSwap', 'IR Swap', 'CLOSE').success, true)
    assert.equal(r('PageView', 'undefined', 'undefined', 'OPEN').screen, undefined, 'a tab change inside a dialog is not a screen')
    assert.equal(r('Event', 'messagebox', 'UNKNOWN', '').error, true)
    assert.equal(r('Event', 'toast', 'UNKNOWN', '').notice, true)
    assert.equal(resolveAppEvent({ timestamp: iso(0), event: 'Event', dialog: 'toast', button: '["Trade Added"]' }, reval).success, true)
    assert.equal(resolveAppEvent({ timestamp: iso(0), event: 'Event', dialog: 'toast', button: '["Loading"]' }, reval).success, false)
    assert.equal(r('Event', 'DlgDetailIRSwap', 'IR Swap', '').screen, undefined, 'interactions are not navigation')
    assert.equal(resolveAppEvent({ timestamp: iso(0), event: '$pageview', path: '/x' }, null).screen, undefined)
    const v = appVocabulary()
    for (const l of ['Save', 'Recalc Cashflow', 'Export', 'Trade Date', 'Cashflow', 'IR Swap']) assert.ok(v.includes(l), l)
    assert.ok(!v.includes('OPEN') && !v.includes('UNKNOWN'))
})

test('timeline: Reval screens from app events, CLOSE returns to the previous open screen, message box = visible error; Ext labels', async () => {
    // Ext field: <label for=input-id><span>Trade Date:</span></label> ... <input id=input-id>; Ext button text in a span.
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [
        { id: 10, type: 2, tagName: 'div', attributes: { class: 'x-field' }, childNodes: [{ id: 11, type: 2, tagName: 'label', attributes: { for: 'textfield-1012-inputEl' }, childNodes: [{ id: 12, type: 2, tagName: 'span', childNodes: [{ id: 13, type: 3, textContent: 'Trade Date:' }] }] },
            { id: 14, type: 2, tagName: 'input', attributes: { id: 'textfield-1012-inputEl' } }] },
        { id: 20, type: 2, tagName: 'a', attributes: { class: 'x-btn' }, childNodes: [{ id: 21, type: 2, tagName: 'span', childNodes: [{ id: 22, type: 3, textContent: 'Recalc Cashflow' }] }] }] }
    const ev = (ms: number, type: number, data: unknown) => ['w', { timestamp: base + ms, type, data }]
    const rows = [ev(0, 4, { href: 'http://reval/', width: 1366, height: 820 }), ev(1, 2, { node: root, initialOffset: { top: 0, left: 0 } }),
        ev(1500, 3, { source: 2, type: 1, id: 14, x: 5, y: 5 }), ev(1510, 3, { source: 2, type: 2, id: 14, x: 5, y: 5 }), ev(3000, 3, { source: 2, type: 2, id: 22, x: 9, y: 9 })]
    const file = join(dir, 'r.jsonl'); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const app = [
        { timestamp: iso(1000), event: 'PageView', screen: 'ir swap:screen', nav: 'open' as const },
        { timestamp: iso(4000), event: 'PageView', screen: 'counterparty:screen', nav: 'open' as const },
        { timestamp: iso(6000), event: 'PageView', screen: 'counterparty:screen', nav: 'close' as const },
        { timestamp: iso(7000), event: 'Event', error: true },
    ]
    const t = await readTimeline(file, { start_time: iso(0), app_events: app, labels: appVocabulary() })
    assert.deepEqual(t.items.filter((e) => e.kind === 'navigation').map((e) => e.screen), ['ir swap:screen', 'counterparty:screen', 'ir swap:screen'])
    assert.deepEqual(t.items.filter((e) => e.kind === 'navigation').map((e) => e.navigation_reason), ['open', 'open', 'return'])
    assert.ok(t.items.some((e) => e.kind === 'error' && e.error_kind === 'visible' && e.source === 'app'))
    assert.deepEqual(t.items.filter((e) => e.kind === 'click' && e.interaction === 2).map((e) => e.label), ['Trade Date', 'Recalc Cashflow'])
    assert.ok(t.items.every((e, i, a) => i === 0 || a[i - 1]!.offset_ms <= e.offset_ms), 'items are in time order with app events merged')
    // Without the app vocabulary those labels stay private.
    const bare = await readTimeline(file, { start_time: iso(0), app_events: app, labels: [] })
    assert.ok(!bare.items.some((e) => e.label === 'Recalc Cashflow'))
})

test('a Save rejected twice by a Reval message box with edits between is a D4 validation loop on the Reval screen', async () => {
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [{ id: 30, type: 2, tagName: 'a', childNodes: [{ id: 31, type: 3, textContent: 'Save' }] }, { id: 33, type: 2, tagName: 'div', attributes: { class: 'x-field' }, childNodes: [{ id: 34, type: 2, tagName: 'label', attributes: { for: 'nf' }, childNodes: [{ id: 35, type: 3, textContent: 'Trade Date:' }] }, { id: 32, type: 2, tagName: 'input', attributes: { id: 'nf' } }] }] }
    const ev = (ms: number, type: number, data: unknown) => ['w', { timestamp: base + ms, type, data }]
    const click = (ms: number, id: number) => [ev(ms - 10, 3, { source: 2, type: 1, id, x: 5, y: 5 }), ev(ms, 3, { source: 2, type: 2, id, x: 5, y: 5 })]
    const rows = [ev(0, 4, { href: 'http://reval/', width: 1366, height: 820 }), ev(1, 2, { node: root, initialOffset: { top: 0, left: 0 } }),
        ...click(2000, 30), ...click(3500, 32), ev(3600, 3, { source: 5, id: 32, text: '*' }), ...click(5000, 30), ...click(6500, 32), ev(6600, 3, { source: 5, id: 32, text: '**' }), ...click(8000, 30)]
    const file = join(dir, 'v.jsonl'); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const app = [{ timestamp: iso(500), event: 'PageView', screen: 'cap / floor:screen', nav: 'open' as const },
        { timestamp: iso(2300), event: 'Event', error: true }, { timestamp: iso(5300), event: 'Event', error: true }, { timestamp: iso(8300), event: 'Event', error: true }]
    const t = await readTimeline(file, { start_time: iso(0), app_events: app, labels: appVocabulary() })
    const d4 = detectCandidates(t).find((c) => c.kind === 'D4')
    assert.ok(d4 && d4.screen === 'cap / floor:screen' && d4.element === 'Save' && Number(d4.facts.cycles) >= 2)
})

test('Ext menu show/hide and aria-expanded mutations prevent a D14 repeated-command finding', async () => {
    const ev = (ms: number, type: number, data: unknown) => ['w', { timestamp: base + ms, type, data }]
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [
        { id: 10, type: 2, tagName: 'a', attributes: { class: 'x-btn', role: 'button', 'aria-label': 'Trades', 'aria-expanded': 'false' } },
        { id: 20, type: 2, tagName: 'div', attributes: { class: 'x-menu', style: 'display:none' } },
    ] }
    const run = async (change: Record<string, unknown>) => {
        const rows = [ev(0, 4, { href: 'http://reval/', width: 1000, height: 800 }), ev(1, 2, { node: root }),
            ev(1000, 3, { source: 2, type: 2, id: 10 }), ev(2000, 3, { source: 0, adds: [], removes: [], texts: [], attributes: [change] }),
            ev(4000, 3, { source: 2, type: 2, id: 10 })]
        const file = join(dir, `menu-${Object.keys(change.attributes as object)[0]}.jsonl`)
        writeFileSync(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n')
        const t = await readTimeline(file, { start_time: iso(0), app_events: [{ timestamp: iso(100), event: 'PageView', screen: 'ir swap:screen', screen_name: 'IR Swap', nav: 'open' }], labels: appVocabulary() })
        assert.ok(t.items.some(e => e.state_change === 'menu'))
        assert.ok(!detectCandidates(t).some(c => c.kind === 'D14' && c.element === 'Trades'))
    }
    await run({ id: 10, attributes: { 'aria-expanded': 'true' } })
    await run({ id: 20, attributes: { style: 'display:block' } })
})

test('Ext masks (shapes from a Reval simulator recording): a load mask hidden and reused is one wait each time; modal backdrops and hidden progress bars are no waits', async () => {
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [] }
    const ev = (ms: number, type: number, data: unknown) => ['w', { timestamp: base + ms, type, data }]
    const m = (ms: number, d: Record<string, unknown>) => ev(ms, 3, { source: 0, adds: [], removes: [], texts: [], attributes: [], ...d })
    const rows = [ev(0, 4, { href: 'http://reval/', width: 1366, height: 820 }), ev(1, 2, { node: root, initialOffset: { top: 0, left: 0 } }),
        m(1000, { adds: [{ parentId: 1, node: { id: 381, type: 2, tagName: 'div', attributes: { class: 'x-component x-border-box x-mask x-component-default' } } }, { parentId: 1, node: { id: 382, type: 2, tagName: 'div', attributes: { class: 'x-mask-msg' } } }] }),
        m(1300, { attributes: [{ id: 381, attributes: { 'aria-hidden': 'true', style: 'display: none;' } }] }),
        m(2000, { adds: [{ parentId: 1, node: { id: 502, type: 2, tagName: 'div', attributes: { class: 'x-mask x-border-box', style: 'z-index: 18996' } } }, { parentId: 1, node: { id: 510, type: 2, tagName: 'div', attributes: { role: 'progressbar', class: 'x-progress x-hidden-offsets' } } }] }),
        m(4000, { attributes: [{ id: 381, attributes: { 'aria-hidden': 'false', style: '' } }] }),
        m(4300, { attributes: [{ id: 381, attributes: { 'aria-hidden': 'true', style: 'display: none;' } }] }),
        m(9000, { removes: [{ parentId: 1, id: 381 }] })]
    const file = join(dir, 'm.jsonl'); writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const t = await readTimeline(file, { start_time: iso(0) })
    assert.deepEqual(t.items.filter((e) => e.kind === 'coverage').map((e) => `${e.offset_ms}:${e.label}`), ['1000:wait_start', '1300:wait_end', '4000:wait_start', '4300:wait_end'])
})

test('v10: report Run/Export resolve to a completion of that report screen (app success map); other dialogs and buttons do not', async () => {
    const r = (dialog: string, dialog_name: string, button: string, event = 'Event') => resolveAppEvent({ timestamp: iso(0), event, path: '/', dialog, dialog_name, action: '', button }, reval)
    for (const b of ['Run', 'Export', 'XLSX Export', 'xlsx export']) {
        const e = r('CashflowReqv', 'Cashflow Report', b)
        assert.deepEqual([e.completion, e.screen, e.nav], [true, 'cashflow report:screen', undefined], b)
    }
    assert.equal(r('CashflowReqv', 'Cashflow Report', 'Save').completion, undefined, 'not a completion button')
    assert.equal(r('DlgDetailIRSwap', 'IR Swap', 'Run').completion, undefined, 'not a report dialog')
    assert.equal(r('CashflowReqv', 'Cashflow Report', 'Run', 'PageView').completion, undefined, 'only interaction events')
    assert.equal(r('toast', 'UNKNOWN', 'Run').completion, undefined)
    // The map is validated and optional.
    const raw = JSON.parse(readFileSync(process.env.APP_EVENTS_FILE!, 'utf8'))
    assert.deepEqual(parseAppEvents({ ...raw, replaySuccess: { ...raw.replaySuccess, completion: undefined } }).replaySuccess.completion, [])
    assert.throws(() => parseAppEvents({ ...raw, replaySuccess: { ...raw.replaySuccess, completion: [{ dialogMatch: '(', buttons: ['Run'] }] } }))
    assert.throws(() => parseAppEvents({ ...raw, replaySuccess: { ...raw.replaySuccess, completion: [{ dialogMatch: 'Reqv$', buttons: 'Run' }] } }))
    assert.throws(() => parseAppEvents({ ...raw, replaySuccess: { ...raw.replaySuccess, completion: {} } }))

    // End to end (run R2 I6 shape): fill the report parameters, Run, Export, then open the Trade List -> no D5.
    const root = { id: 1, type: 2, tagName: 'div', childNodes: [{ id: 10, type: 2, tagName: 'div', attributes: { class: 'x-field' }, childNodes: [{ id: 11, type: 2, tagName: 'label', attributes: { for: 'pf' }, childNodes: [{ id: 12, type: 3, textContent: 'Portfolio:' }] }, { id: 14, type: 2, tagName: 'input', attributes: { id: 'pf' } }] }] }
    const ev = (ms: number, type: number, data: unknown) => ['w', { timestamp: base + ms, type, data }]
    const rows = [ev(0, 4, { href: 'http://reval/', width: 1366, height: 820 }), ev(1, 2, { node: root, initialOffset: { top: 0, left: 0 } }),
        ev(1500, 3, { source: 2, type: 5, id: 14 }), ev(1510, 3, { source: 2, type: 2, id: 14, x: 5, y: 5 }), ev(1600, 3, { source: 5, id: 14, text: '****' }), ev(9500, 3, { source: 1, positions: [{ x: 1, y: 1, id: 1, timeOffset: 0 }] })]
    const file = join(dir, 'rep.jsonl'); writeFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n')
    const open = (ms: number, dialog: string, name: string) => resolveAppEvent({ timestamp: iso(ms), event: 'PageView', dialog, dialog_name: name, action: 'OPEN' }, reval)
    const press = (ms: number, b: string) => resolveAppEvent({ timestamp: iso(ms), event: 'Event', dialog: 'CashflowReqv', dialog_name: 'Cashflow Report', action: '', button: b }, reval)
    const d5 = async (app: ReturnType<typeof open>[]) => detectCandidates(await readTimeline(file, { start_time: iso(0), app_events: app, labels: appVocabulary() })).filter((c) => c.kind === 'D5')
    const report = open(1000, 'CashflowReqv', 'Cashflow Report'), list = open(8000, 'DlgTradeList', 'Trade List')
    const t = await readTimeline(file, { start_time: iso(0), app_events: [report, press(3000, 'Run'), list], labels: appVocabulary() })
    assert.ok(t.items.some((e) => e.kind === 'app_action' && e.label === 'screen_complete' && e.screen === 'cashflow report:screen'))
    assert.deepEqual(await d5([report, press(3000, 'Run'), press(5000, 'Export'), list]), [])
    assert.equal((await d5([report, list])).length, 1, 'without Run/Export the filled parameters are still abandoned')
})
