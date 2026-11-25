// The simulated Reval's screens, as a table. Each row becomes one screen of the Ext JS page (page/reval.js):
// an MDI tab, a floating window, a report (a parameter window whose events carry the report menu id), a
// tabbed dialog, a grid, or an iframe. The facts behind the shapes are in /root/briefs/reval-sim.md.
export type Kind = 'tab' | 'window' | 'modal' | 'report' | 'iframe'
export interface Screen {
    menu: string // the menu id the user picks (reports: "report:<id>")
    id: string // the Ext dialog (class) name
    event: string // the dialog_id Reval sends: the dialog id, or for reports the menu id without "report:"
    name: string // the title, sent as dialog_name
    kind: Kind
    group: string // the menu it sits in
    buttons: string[]
    fields?: string[]
    tabs?: string[] // inner tabs (a tabbed dialog): changes send PageView OPEN with no dialog id
    grid?: boolean // a grid loaded explicitly (Run / Refresh) under its own Ext.LoadMask
    param?: string // reports: the parameter window's Ext dialog
    result?: string // reports: the result tab's Ext dialog (opened by Run)
    loadMs: number // how long /Dialog takes
    settleMs: number // after the tab is shown and OPEN is sent, until the viewport mask goes
    stuck?: boolean // the viewport mask never goes away (a hung load)
    message?: string // Save shows this toast (or, starting with "!", this message box)
}

const T = (menu: string, name: string, group: string, extra: Partial<Screen> = {}): Screen => ({
    menu, id: menu, event: menu, name, kind: 'tab', group, buttons: ['Save', 'Close'], fields: ['Trade Date', 'Counterparty', 'Notional'], loadMs: 250, settleMs: 400, ...extra,
})
const R = (reportId: string, name: string, param: string, result: string, extra: Partial<Screen> = {}): Screen => ({
    menu: `report:${reportId}`, id: result, event: reportId, name, kind: 'report', group: 'Reports', param, result,
    buttons: ['Run', 'Export', 'XLS Export', 'XLSX Export', 'CSV Export', 'Close'], fields: ['As Of Date', 'Entity', 'Portfolio'], loadMs: 300, settleMs: 300, ...extra,
})

const hand: Screen[] = [
    T('DlgDetailIRSwap', 'IR Swap', 'Trades', { tabs: ['Terms', 'Cashflow', 'Schedule', 'Audit'], buttons: ['Save', 'Recalc Cashflow', 'Copy', 'Close'], message: 'Trade Id 4348 Updated' }),
    T('DlgDetailFXForward', 'FX Forward', 'Trades', { tabs: ['Terms', 'Settlement'], message: 'Trade Id 5120 Updated' }),
    T('DlgDetailCCS', 'Cross Currency Swap', 'Trades', { tabs: ['Terms', 'Cashflow', 'Resets'], message: 'Trade Id 7781 Updated' }),
    T('DlgDetailFRA', 'FRA', 'Trades', { message: 'Trade Id 1002 Updated' }),
    T('DlgDetailCap', 'Cap / Floor', 'Trades', { tabs: ['Terms', 'Cashflow'], message: '!Strike must be greater than zero' }),
    T('DlgDetailLoan', 'Loan', 'Trades', { tabs: ['Terms', 'Amortisation', 'Fees'], message: 'Trade Id 9001 Updated' }),
    T('DlgTradeList', 'Trade List', 'Trades', { grid: true, buttons: ['Run', 'Export', 'XLSX Export', 'CSV Export', 'Delete'], fields: ['Entity', 'Status'], loadMs: 400, settleMs: 700 }),
    T('DlgHedgeRel', 'Hedge Relationship', 'Hedging', { tabs: ['Designation', 'Effectiveness', 'Documentation'], buttons: ['Save', 'Approve', 'Close'], message: 'Link Id 3508 Added' }),
    T('DlgHedgeList', 'Hedge List', 'Hedging', { grid: true, buttons: ['Run', 'Export', 'XLSX Export'], loadMs: 350, settleMs: 600 }),
    { menu: 'DlgTradeSearch', id: 'DlgTradeSearch', event: 'DlgTradeSearch', name: 'Trade Search', kind: 'modal', group: 'Trades', buttons: ['Search', 'OK', 'Cancel'], fields: ['Trade Id'], loadMs: 200, settleMs: 200 },
    { menu: 'DlgCalculator', id: 'DlgCalculator', event: 'DlgCalculator', name: 'Calculator', kind: 'window', group: 'Tools', buttons: ['Calculate', 'Close'], fields: ['Rate', 'Tenor'], loadMs: 150, settleMs: 150 },
    { menu: 'DlgMarketDataWin', id: 'DlgMarketDataWin', event: 'DlgMarketDataWin', name: 'Market Data Snapshot', kind: 'window', group: 'Market Data', buttons: ['Refresh', 'Close'], grid: true, loadMs: 300, settleMs: 300 },
    { menu: 'DlgDashboardFrame', id: 'DlgDashboardFrame', event: 'DlgDashboardFrame', name: 'Dashboards', kind: 'iframe', group: 'Tools', buttons: ['Export', 'Refresh'], loadMs: 200, settleMs: 300 },
    { menu: 'DlgArchiveLoad', id: 'DlgArchiveLoad', event: 'DlgArchiveLoad', name: 'Archive Loader', kind: 'tab', group: 'Admin', buttons: ['Run'], loadMs: 200, settleMs: 300, stuck: true },
    T('DlgImport', 'Trade Import', 'Admin', { buttons: ['Import', 'Close'], message: 'Import has been scheduled' }),
    R('LinkListReqv', 'Hedge Designation', 'DlgHedgeDesigListParam', 'DlgHedgeDesigListReport'),
    R('HedgeEffReqv', 'Hedge Effectiveness', 'DlgHedgeEffParam', 'DlgHedgeEffReport'),
    R('CashflowReqv', 'Cashflow Report', 'DlgCashflowParam', 'DlgCashflowReport'),
    R('JournalReqv', 'Journal Entries', 'DlgJournalParam', 'DlgJournalReport'),
    R('ValuationReqv', 'Valuation Report', 'DlgValuationParam', 'DlgValuationReport'),
]

// The rest: ordinary trade, static-data and report screens, enough for a realistic ~100.
const instruments = ['Bond', 'Repo', 'Deposit', 'Swaption', 'Inflation Swap', 'Basis Swap', 'Commodity Swap', 'Equity Option', 'FX Option', 'FX Swap',
    'CDS', 'Future', 'Money Market', 'Commercial Paper', 'Total Return Swap', 'NDF', 'Collar', 'Callable Swap', 'Amortising Swap', 'Zero Coupon Swap']
const statics = ['Counterparty', 'Entity', 'Portfolio', 'Book', 'Calendar', 'Currency', 'Index', 'Curve', 'User', 'Role', 'Account', 'GL Mapping',
    'Hedge Strategy', 'Rating', 'Country', 'Settlement Instruction', 'Fee Type', 'Day Count', 'Workflow', 'Approval Rule', 'Notification', 'Scheduler Job',
    'Price Source', 'Volatility Surface', 'Fixing', 'Holiday', 'Business Unit', 'Cost Centre', 'Tax Rule', 'Document Template']
const reports = ['Position', 'PnL Explain', 'Risk Ladder', 'Accruals', 'Fair Value', 'Disclosure', 'Exposure', 'Limits', 'Audit Trail', 'Maturity',
    'Sensitivity', 'Hedge Accounting', 'Collateral', 'Interest Income', 'FX Revaluation', 'Trial Balance', 'Counterparty Risk', 'VaR', 'Liquidity', 'Settlements',
    'Rate Resets', 'Fixings Due', 'Trade Blotter', 'Ageing', 'Cash Forecast', 'Regulatory', 'Covenants',
    'Margin Calls', 'Bank Balances', 'Accounting Entries', 'Credit Limits']
const code = (s: string) => s.replace(/[^A-Za-z0-9]/g, '')
const generated: Screen[] = [
    ...instruments.map((n, i) => T(`DlgDetail${code(n)}`, n, 'Trades', { ...(i % 3 === 0 ? { tabs: ['Terms', 'Cashflow'] } : {}), message: `Trade Id ${2000 + i} Updated` })),
    ...statics.map((n, i) => T(`DlgStatic${code(n)}`, n, 'Static Data', {
        ...(i % 4 === 0 ? { grid: true, buttons: ['Run', 'Save', 'Export'] } : {}), ...(i % 5 === 1 ? { kind: 'window' as const } : {}), message: `${n} Updated`,
    })),
    ...reports.map((n) => R(`${code(n)}Reqv`, `${n} Report`, `Dlg${code(n)}Param`, `Dlg${code(n)}Report`)),
]

export const SCREENS: Screen[] = [...hand, ...generated]
if (new Set(SCREENS.map((s) => s.menu)).size !== SCREENS.length) throw new Error('duplicate screen menu ids')
