// Run R: seeded personas over the Reval simulator (tools/reval-sim: real Ext JS classic 6.2, Reval's real event names
// PageView/Event with dialog_id), recording into the REAL local PostHog (session replay + app events), exactly like the
// ERPNext harness. The simulator page itself is unmodified; friction is injected by a page script (evaluateOnNewDocument)
// and a mark is written only when it actually took effect. Personas use the UI as a user does: toolbar menus, menu items,
// Ext fields (key by key), tabs, toolbar buttons, the message box OK button, the tab close tool, wheel scrolling.
import puppeteer, { type Browser, type Page } from 'puppeteer'
import { appScreenKey } from '../../src/core/replay-timeline.ts'
import type { LabConfig } from './setup.ts'
import type { Persona, Severity, Truth } from './personas.ts'

export type RevalWorkflow = 'deal' | 'hedge' | 'amortisation'
export type RevalFriction = 'validation_loop' | 'dead_button' | 'scroll_hunt' | 'revisit' | 'slow_wait' | 'hesitation'
export interface RevalPlan { seed: number; phase: 'calibration' | 'heldout'; user: string; persona: Persona; workflow: RevalWorkflow; injection?: RevalFriction; dose?: number; planned_severity?: Severity; cohort?: string; cohort_users?: number }
export interface RevalCaptured { plan: RevalPlan; session_id: string | null; distinct_id: string; started_at: string; ended_at: string; truth: Truth[]; steps: { name: string; ok: boolean; at: number; detail?: string }[]; errors: string[]; app_log: number }

export const REVAL_CLIENT = 'SEM'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function rng(seed: number) { let x = seed || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 } }
const pace = (p: Persona) => ({ Expert: .65, Novice: 1.6, Hurried: .5, Careful: 1.2, Explorer: 1.4, Returning: .85 }[p])
const expected: Record<RevalFriction, string[]> = { validation_loop: ['D4', 'D7'], dead_button: ['D1', 'D2'], scroll_hunt: ['S1', 'S2', 'S3'], revisit: ['R1', 'R2'], slow_wait: ['D10'], hesitation: ['D6', 'D8', 'D12'] }
/** The relabel used by I1: the Notional field of IR Swap shows this instead (a TRM-plausible but unclear label). */
export const HESITATION_LABEL = 'Principal Amount'

/** Friction switches inside the page. Runs before the simulator's own scripts; marks only when the change took effect. */
function injectionScript(kind: string, dose: number): string {
    return `(() => {
  const kind=${JSON.stringify(kind)},dose=${Number(dose) || 0};window.RV_TRUTH=[];
  const mark=(element,phase)=>window.RV_TRUTH.push({at:Date.now(),kind,element,phase});
  // I3: one screen's /Dialog request takes dose ms (Reval's slow open). Patch the table before reval.js reads it.
  if(kind==='slow_wait'){let cfg;Object.defineProperty(window,'REVAL_CFG',{configurable:true,get:()=>cfg,set:(v)=>{for(const s of v.screens)if(s.menu==='DlgHedgeRel'){s.loadMs=dose;mark('Hedge Relationship','patched')}cfg=v}})}
  const apply=()=>{
    if(!window.Ext||!Ext.ComponentQuery)return;
    // I5: an inert decorative Apply button in the IR Swap toolbar.
    if(kind==='dead_button'){const tab=Ext.ComponentQuery.query('[revalMenu]').find(x=>x.revalMenu==='DlgDetailIRSwap'&&x.xtype!=='menuitem');const tb=tab&&tab.down('toolbar');if(tb&&!tb.down('#rvDeadApply')){tb.add({xtype:'button',text:'Apply',itemId:'rvDeadApply',revalLabel:'Apply'});mark('Apply','start')}}
    // I1: IR Swap's Notional field is relabelled.
    if(kind==='hesitation'){const tab=Ext.ComponentQuery.query('[revalMenu]').find(x=>x.revalMenu==='DlgDetailIRSwap'&&x.xtype!=='menuitem');const f=tab&&tab.query('field').find(x=>x.revalLabel==='Notional');if(f&&f.getFieldLabel()!==${JSON.stringify(HESITATION_LABEL)}){f.setFieldLabel(${JSON.stringify(HESITATION_LABEL)});mark(${JSON.stringify(HESITATION_LABEL)},'start')}}
  };
  setInterval(apply,150);
})()`
}

class Driver {
    cursor = { x: 200, y: 200 }
    constructor(readonly page: Page, readonly random: () => number, readonly speed: number) {}
    async move(x: number, y: number) {
        const from = this.cursor, d = Math.hypot(x - from.x, y - from.y), n = Math.max(3, Math.min(30, Math.round(d / 24))), bend = (this.random() - .5) * Math.min(50, d * .2)
        for (let i = 1; i <= n; i++) { const t = i / n, c = 4 * t * (1 - t) * bend; await this.page.mouse.move(from.x + (x - from.x) * t + c, from.y + (y - from.y) * t - c); await sleep(Math.max(10, Math.min(75, (100 + 160 * Math.log2(1 + d / 80)) * this.speed / n))) }
        this.cursor = { x, y }
    }
    async clickId(id: string | null): Promise<boolean> {
        if (!id) return false
        const box = await (await this.page.$(`[id="${id.replace(/"/g, "")}"]`))?.boundingBox()
        if (!box || !box.width || !box.height) return false
        const x = box.x + box.width * (.3 + .4 * this.random()), y = box.y + box.height * (.3 + .4 * this.random())
        await this.move(x, y); await this.page.mouse.click(x, y); return true
    }
    async typeInto(id: string | null, value: string): Promise<boolean> {
        if (!(await this.clickId(id))) return false
        await this.page.keyboard.down('Control'); await this.page.keyboard.press('A'); await this.page.keyboard.up('Control')
        await this.page.keyboard.type(value, { delay: Math.round((30 + 70 * this.random()) * this.speed) }); await this.page.keyboard.press('Tab'); return true
    }
    async wheelId(id: string | null, delta: number) { const box = id ? await (await this.page.$(`[id="${id.replace(/"/g, "")}"]`))?.boundingBox() : null; if (!box) return false; await this.move(box.x + box.width * .55, box.y + Math.min(box.height * .5, 220)); await this.page.mouse.wheel({ deltaY: delta }); await sleep(180 + this.random() * 200); return true }
}

/** DOM ids of Ext components, looked up through Ext (the driver then clicks them like a user). */
const q = {
    menuButton: (page: Page, group: string) => page.evaluate((g) => { const b = Ext.ComponentQuery.query('toolbar button').find((x: any) => x.text === g && x.isVisible(true)); return b ? b.getId() : null }, group),
    menuItem: (page: Page, name: string) => page.evaluate((n) => { const m = Ext.ComponentQuery.query('menuitem').find((x: any) => x.text === n && x.isVisible(true)); return m ? m.getId() : null }, name),
    field: (page: Page, menu: string, label: string) => page.evaluate((m, l) => { const c = Ext.ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'); const f = c && c.query('field').find((x: any) => x.revalLabel === l); return f && f.inputEl ? f.inputEl.dom.id : null }, menu, label),
    button: (page: Page, menu: string, label: string) => page.evaluate((m, l) => (window as any).Reval.button(m, l), menu, label),
    tab: (page: Page, menu: string, title: string) => page.evaluate((m, t) => { const c = Ext.ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'); const inner = c && c.down('#inner'); const tab = inner && inner.tabBar.items.items.find((x: any) => x.text === t); return tab ? tab.getId() : null }, menu, title),
    closeTool: (page: Page, menu: string) => page.evaluate((m) => { const c = Ext.ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'); const el = c && c.tab && c.tab.el && c.tab.el.dom.querySelector('.x-tab-close-btn'); return el ? (el.id || (el.id = 'rvclose-' + m.replace(/[^A-Za-z0-9]/g, ''))) : null }, menu),
    msgOk: (page: Page) => page.evaluate(() => { const b = (Ext as any).Msg && (Ext as any).Msg.down && (Ext as any).Msg.down('button[itemId=ok]'); return b && b.isVisible() ? b.getId() : null }),
    gridView: (page: Page, menu: string) => page.evaluate((m) => { const c = Ext.ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'); const g = c && c.down('#grid'); return g ? g.getView().getId() : null }, menu),
    row: (page: Page, menu: string, index: number) => page.evaluate((m, i) => { const c = Ext.ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'); const g = c && c.down('#grid'); const n = g && g.getView().getNode(i); return n ? (n.id || (n.id = `rvrow-${i}`)) : null }, menu, index),
}
declare const Ext: any

export async function driveReval(c: LabConfig, revalUrl: string, plan: RevalPlan, browser?: Browser): Promise<RevalCaptured> {
    const random = rng(plan.seed), errors: string[] = [], truth: Truth[] = [], steps: RevalCaptured['steps'] = []
    const distinct_id = `C1DEV|01|${REVAL_CLIENT}|${plan.user}`
    let session_id: string | null = null, app_log = 0
    const started_at = new Date().toISOString()
    const own = !browser
    const b = browser ?? await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] })
    const ctx = await b.createBrowserContext()
    try {
        const page = await ctx.newPage(); await page.setViewport({ width: 1366, height: 820 })
        const major = /Chrome\/(\d+)/.exec(await b.userAgent())?.[1] || '148'
        await page.setUserAgent({ userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36` })
        page.on('pageerror', (e) => { if (errors.length < 5) errors.push(`page_${String((e as Error)?.message ?? e).slice(0, 100)}`) })
        await page.evaluateOnNewDocument(injectionScript(plan.injection ?? '', plan.dose ?? 0))
        const d = new Driver(page, random, pace(plan.persona))
        const qs = new URLSearchParams({ token: c.token, ph: c.host, client: REVAL_CLIENT, user: plan.user, init: '300', speed: '1' })
        await page.goto(`${revalUrl}/?${qs}`, { waitUntil: 'load', timeout: 30_000 })
        await page.waitForFunction('!!window.Reval && !!window.__viewportAt', { timeout: 30_000 })
        await page.waitForFunction(() => (window as any).posthog?.__loaded && (window as any).__identifiedAt, { timeout: 30_000 }).catch(() => errors.push('posthog_not_loaded'))
        session_id = await page.evaluate(() => (window as any).posthog?.get_session_id?.() || null)
        await sleep(800)
        const step = (name: string, ok: boolean, detail?: string) => { steps.push({ name, ok, at: Date.now(), detail }) }
        const screenOf = (dialog: string, name: string) => appScreenKey(dialog, name)
        const mark = (kind: RevalFriction, element: string, screen: string, start: number, end: number, observed = true) => {
            if (!session_id) return
            truth.push({ id: `${plan.seed}:${truth.length}`, session_id, kind: kind as Truth['kind'], screen, element, t_start: start, t_end: end, expected_detectors: kind === 'slow_wait' && (plan.dose ?? 0) < 3000 ? [] : expected[kind], expected_severity: plan.planned_severity ?? 'Low', dose: plan.dose ?? 1, seed: plan.seed, observed })
        }
        const settled = () => page.waitForFunction(() => (window as any).Reval.masks() === 0, { timeout: 25_000 }).then(() => true, () => false)
        const openVia = async (group: string, name: string, menu: string) => {
            const opened = await d.clickId(await q.menuButton(page, group)) && (await sleep(250 + 250 * random()), await d.clickId(await q.menuItem(page, name)))
            const shown = opened && await page.waitForFunction((m) => !!(Ext as any).ComponentQuery.query('[revalMenu]').find((x: any) => x.revalMenu === m && x.xtype !== 'menuitem'), { timeout: 25_000 }, menu).then(() => true, () => false)
            await settled(); await sleep(300 + 500 * random()); return !!shown
        }
        const fill = async (menu: string, label: string, value: string) => d.typeInto(await q.field(page, menu, label), value)
        const press = async (menu: string, label: string) => { const ok = await d.clickId(await q.button(page, menu, label)); await sleep(500 + 400 * random()); return ok }
        const tab = async (menu: string, title: string) => { const ok = await d.clickId(await q.tab(page, menu, title)); await sleep(400 + 600 * random()); return ok }
        const closeTab = async (menu: string) => { const ok = await d.clickId(await q.closeTool(page, menu)); await sleep(400 + 400 * random()); return ok }
        const ok = async () => { const id = await q.msgOk(page); if (id) { await sleep(500 + 900 * random() * d.speed); await d.clickId(id) } return !!id }

        if (plan.workflow === 'deal' || plan.injection === 'validation_loop' || plan.injection === 'dead_button' || plan.injection === 'hesitation' || plan.injection === 'revisit') {
            const menu = 'DlgDetailIRSwap', screen = screenOf('DlgDetailIRSwap', 'IR Swap')
            step('opened_deal', await openVia('Trades', 'IR Swap', menu))
            if (plan.injection === 'hesitation') {
                const id = await q.field(page, menu, 'Notional'), start = Date.now()
                const focused = await d.clickId(id); await sleep(3000 + Math.floor(random() * 6000))
                const typed = await d.typeInto(id, '25000000')
                const relabelled = await page.evaluate(() => (window as any).RV_TRUTH.some((x: any) => x.kind === 'hesitation' && x.phase === 'start'))
                mark('hesitation', HESITATION_LABEL, screen, start, Date.now(), focused && typed && relabelled)
            }
            step('trade_date', await fill(menu, 'Trade Date', '26/11/2026'))
            step('counterparty', await fill(menu, 'Counterparty', 'ACME BANK'))
            if (plan.injection === 'revisit') {
                // I7: the counterparty's details are only on the Counterparty static screen: look it up twice (close and reopen).
                const start = Date.now(), cpMenu = 'DlgStaticCounterparty'
                let rounds = 0
                for (let i = 0; i < (plan.dose ?? 2); i++) {
                    if (await openVia('Static Data', 'Counterparty', cpMenu)) rounds++
                    await sleep(1200 + 800 * random())
                    await closeTab(cpMenu)
                    await sleep(500)
                }
                mark('revisit', 'Counterparty', screen, start, Date.now(), rounds === (plan.dose ?? 2))
            }
            if (plan.injection !== 'hesitation') step('notional', await fill(menu, 'Notional', '25000000'))
            if (plan.injection === 'dead_button') {
                const start = Date.now(); let clicks = 0
                for (let i = 0; i < (plan.dose ?? 5); i++) { if (await d.clickId(await q.button(page, menu, 'Apply'))) clicks++; await sleep(80 + Math.floor(random() * 80)) }
                await sleep(2500); mark('dead_button', 'Apply', screen, start, Date.now(), clicks === (plan.dose ?? 5))
            }
            step('cashflow_tab', await tab(menu, 'Cashflow'))
            step('recalc', await press(menu, 'Recalc Cashflow'))
            step('terms_tab', await tab(menu, 'Terms'))
            step('saved', await press(menu, 'Save') && await page.waitForFunction(() => (window as any).Reval.log.some((x: any) => x.props?.dialog_id === 'toast'), { timeout: 8000 }).then(() => true, () => false))
            await sleep(1200); step('closed', await closeTab(menu))
            if (plan.injection === 'validation_loop') {
                // I2: Cap / Floor rejects Save with Reval's message box "Strike must be greater than zero"; the user edits and retries, then gives up.
                const cap = 'DlgDetailCap', capScreen = screenOf('DlgDetailCap', 'Cap / Floor')
                step('opened_cap', await openVia('Trades', 'Cap / Floor', cap))
                await fill(cap, 'Trade Date', '26/11/2026'); await fill(cap, 'Counterparty', 'ACME BANK')
                const start = Date.now(); let errorsSeen = 0
                for (let i = 0; i < (plan.dose ?? 2); i++) {
                    await press(cap, 'Save'); await sleep(500)
                    if (await ok()) errorsSeen++
                    await fill(cap, 'Notional', String(10_000_000 + i * 5_000_000))
                }
                await press(cap, 'Save'); await sleep(500); if (await ok()) errorsSeen++
                mark('validation_loop', 'Save', capScreen, start, Date.now(), errorsSeen >= 2)
                await sleep(800); step('cap_given_up', await closeTab(cap))
            }
        }
        if (plan.workflow === 'hedge' || plan.injection === 'slow_wait') {
            const menu = 'DlgHedgeRel', screen = screenOf('DlgHedgeRel', 'Hedge Relationship')
            const start = Date.now()
            const opened = await openVia('Hedging', 'Hedge Relationship', menu)
            if (plan.injection === 'slow_wait') { const patched = await page.evaluate(() => (window as any).RV_TRUTH.some((x: any) => x.kind === 'slow_wait')); mark('slow_wait', 'Hedge Relationship', screen, start, Date.now(), opened && patched) }
            step('opened_hedge', opened)
            if (plan.workflow === 'hedge') {
                step('hedge_fields', await fill(menu, 'Trade Date', '26/11/2026') && await fill(menu, 'Counterparty', 'ACME BANK'))
                step('effectiveness_tab', await tab(menu, 'Effectiveness'))
                step('documentation_tab', await tab(menu, 'Documentation'))
                step('designation_tab', await tab(menu, 'Designation'))
                step('saved', await press(menu, 'Save')); await sleep(900)
                step('approved', await press(menu, 'Approve')); await sleep(900)
                step('closed', await closeTab(menu))
                const rep = 'report:LinkListReqv'
                step('opened_report', await openVia('Reports', 'Hedge Designation', rep))
                step('report_params', await fill(rep, 'As Of Date', '30/11/2026') && await fill(rep, 'Entity', 'SEM TREASURY'))
                step('report_run', await press(rep, 'Run')); await settled(); await sleep(1500)
                step('report_export', await press(`${rep}#result`, 'Export'))
            } else { await sleep(1500); await closeTab(menu) }
        }
        if (plan.workflow === 'amortisation' || plan.injection === 'scroll_hunt') {
            if (plan.workflow === 'amortisation') {
                const loan = 'DlgDetailLoan'
                step('opened_loan', await openVia('Trades', 'Loan', loan))
                step('amortisation_tab', await tab(loan, 'Amortisation'))
                await sleep(1500 + 1000 * random())
                step('closed_loan', await closeTab(loan))
                const rep = 'report:CashflowReqv'
                step('opened_report', await openVia('Reports', 'Cashflow Report', rep))
                step('report_params', await fill(rep, 'As Of Date', '30/11/2026') && await fill(rep, 'Portfolio', 'HEDGE BOOK'))
                step('report_run', await press(rep, 'Run')); await settled(); await sleep(1200)
                const view = await q.gridView(page, `${rep}#result`)
                step('report_scrolled', await d.wheelId(view, 400) && await d.wheelId(view, -200))
                step('report_export', await press(`${rep}#result`, 'XLSX Export'))
            }
            if (plan.injection === 'scroll_hunt') {
                // I6: find trade 37 in the Trade List grid by scrolling (no search used).
                const list = 'DlgTradeList', screen = screenOf('DlgTradeList', 'Trade List')
                step('opened_trade_list', await openVia('Trades', 'Trade List', list))
                await press(list, 'Run'); await settled(); await sleep(800)
                const view = await q.gridView(page, list), start = Date.now(); let wheels = 0
                for (const delta of [700, 600, -450, 800, -600, 900, -500, 700]) if (await d.wheelId(view, delta)) wheels++
                const found = await d.clickId(await q.row(page, list, 36))
                mark('scroll_hunt', 'Trade List', screen, start, Date.now(), wheels === 8 && found)
            }
        }
        await page.evaluate(() => (window as any).posthog?.capture?.('rv_lab_complete', { rv_lab: true }))
        app_log = await page.evaluate(() => (window as any).Reval.log.length)
        await sleep(3500)
        await page.close()
    } catch (e) { errors.push(e instanceof Error ? e.message.slice(0, 180) : 'drive_error') }
    finally { await ctx.close().catch(() => {}); if (own) await b.close().catch(() => {}) }
    return { plan, session_id, distinct_id, started_at, ended_at: new Date().toISOString(), truth, steps, errors, app_log }
}
