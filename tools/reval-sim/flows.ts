// The flows: what a PM sets up in Lens, what a Reval user then does, and what must happen.
import type { SurveySpec } from '../../src/core/surveys.ts'

export type Act =
    | ['open', string] // pick a screen from the menu (a report: "report:<id>")
    | ['press', string, string] // click a button (screen key: menu or dialog id; result tabs: "<menu>#result")
    | ['field', string, string, string]
    | ['tab', string, string] // inner tab of a tabbed dialog
    | ['mdi', string] // switch to another open MDI tab (no event)
    | ['close', string] // close an MDI tab (CLOSE)
    | ['wait', number]
    | ['advance', number] // move the page's clock forward (ms)
    | ['logout'] | ['login', string, string?] | ['changeClient', string, string?]
    | ['reload'] // the user comes back later: a fresh page load (open surveys are gone from the screen)
    | ['modal'] | ['closeModal'] | ['msgOk']
    | ['iframeClick', string, string] // click inside an iframe screen (no PostHog there)
    | ['dismiss'] | ['answer']
    | ['ready'] // wait until the survey renderer and the surveys are loaded
    | ['launch', string] // the PM launches this survey now (saved with launch: false), while the page stays open
    | ['openAll'] // open every screen in a row, measuring each
    | ['expect', Expect]

export interface Expect {
    shown?: string[] // these surveys (keys) and no other appear, and "survey shown" is captured for each
    none?: boolean // no survey appears (watched for `within` ms)
    within?: number // ms; default 8000 for shown, 4000 for none
    notWhileMask?: boolean // when the survey appears, no Ext mask is visible
    after?: number // and not before this many ms
    by?: string // "survey shown" carries this user's distinct id
    note?: string
}

export interface SurveyDef { spec: SurveySpec; clients?: string[]; launch?: boolean }
export interface Flow {
    name: string
    why: string
    surveys: Record<string, SurveyDef>
    client?: string
    user?: string | ((chains: Record<string, string>) => string) // chain ids by survey key
    init?: number // ms after the viewport until initPostHog (default 300)
    slow?: number // the stand-in PostHog answers posthog-js this many ms late
    clientFromDistinctId?: number // CLIENT_FROM_DISTINCT_ID while Lens saves the surveys (default 3)
    versioned?: 'lens' | 'original' // what PostHog serves at /static/<version>/surveys.js
    lensWarns?: Record<string, RegExp[]> // per survey: warnings Lens must give (design checks included)
    lensQuiet?: string[] // surveys for which Lens must give no step warnings
    acts: Act[]
    quick?: boolean // part of the fast subset (pnpm test)
    refreshMs?: number // window.__lensSurveyRefreshMs: how often the survey engine reloads flags and surveys (default 5 min)
}

const Q = (text: string) => [{ type: 'rating' as const, text, scale: 5 as const, low_label: 'Hard', high_label: 'Easy' }]
const S = (name: string, steps: SurveySpec['steps'], extra: Partial<SurveySpec> = {}): SurveySpec => ({ name, questions: Q(`How easy was ${name.toLowerCase()}?`), steps, ...extra })
const once = (spec: SurveySpec, clients = ['SEM']): SurveyDef => ({ spec, clients })
const HOUR = 3600_000, DAY = 24 * HOUR

export const FLOWS: Flow[] = [
    {
        name: 'Hedge Designation then Export', quick: true,
        why: 'The production case: opens LinkListReqv (the report id Reval sends), then presses Export in its parameter window.',
        surveys: { A: once(S('Hedge export', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        lensQuiet: ['A'],
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'], notWhileMask: true }]],
    },
    {
        name: 'Only after Hedge Designation AND Export, in that order', quick: true,
        why: 'The owner\'s rule: the survey pops only after the user opened Hedge Designation and then exported from it. Not for opening it alone, not for an export elsewhere, not for an export that came first.',
        surveys: { A: once(S('Hedge export strict', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        lensQuiet: ['A'],
        acts: [['ready'],
            ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Export'], ['expect', { none: true, note: 'export in another screen' }],
            ['open', 'report:LinkListReqv'], ['wait', 600], ['expect', { none: true, note: 'Hedge Designation opened, nothing exported yet' }],
            ['press', 'LinkListReqv', 'Run'], ['wait', 1200], ['expect', { none: true, note: 'ran the report, still no export' }],
            ['mdi', 'DlgTradeList'], ['press', 'DlgTradeList', 'XLSX Export'], ['expect', { none: true, note: 'another export elsewhere after opening Hedge Designation' }],
            ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'], notWhileMask: true, within: 15000 }]],
    },
    {
        name: 'Export first, Hedge Designation after: no survey', quick: true,
        why: 'Order matters: exporting before opening Hedge Designation does not complete the chain.',
        surveys: { A: once(S('Hedge export order', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'DlgHedgeList'], ['wait', 1300], ['press', 'DlgHedgeList', 'Export'], ['open', 'report:LinkListReqv'], ['wait', 600], ['expect', { none: true, within: 8000 }]],
    },
    {
        name: 'Hedge Designation then Export minutes later', quick: true,
        why: 'The user opens the report, works for minutes (other screens, tab switches), then exports from Hedge Designation: the survey shows then, not before.',
        surveys: { A: once(S('Hedge export later', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['advance', 4 * 60_000], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'],
            ['expect', { none: true, note: 'minutes later, still no export from Hedge Designation' }], ['advance', 3 * 60_000],
            ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'], within: 15000 }]],
    },
    {
        name: 'Hedge Designation then XLSX Export (survey asks for XLSX Export)',
        why: 'The XLSX Export button is its own label.',
        surveys: { A: once(S('Hedge xlsx', [{ opens: 'LinkListReqv' }, { button: 'XLSX Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'XLSX Export'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Survey asks for Export, user presses XLSX Export',
        why: 'Export matches only the button labelled Export; Lens must say that Reval has other export buttons.',
        surveys: { A: once(S('Hedge export only', [{ opens: 'LinkListReqv' }, { button: 'Export' }])) },
        lensWarns: { A: [/XLSX Export/] },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'XLSX Export'], ['expect', { none: true }]],
    },
    {
        name: 'Any export (contains "Export"), user presses CSV Export',
        why: 'What Lens suggests for "any export": an event step with action_name containing Export.',
        surveys: { A: once(S('Hedge any export', [{ opens: 'LinkListReqv' }, { event: 'Event', properties: { dialog_id: 'LinkListReqv', action_name: { operator: 'icontains', values: ['Export'] } } }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'CSV Export'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Wrong id: DlgHedgeDesigListReport (the Ext dialog) instead of LinkListReqv', quick: true,
        why: 'Reval sends the report id for reports, never the Ext dialog name: the survey cannot show, and Lens must warn and point to LinkListReqv.',
        surveys: { A: once(S('Hedge wrong id', [{ opens: 'DlgHedgeDesigListReport' }, { button: 'Export' }])) },
        lensWarns: { A: [/DlgHedgeDesigListReport/, /LinkListReqv/] },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Run'], ['wait', 1200], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'Dialog title instead of id ("Hedge Designation")',
        why: 'Reval sends the title as dialog_name, steps match dialog_id: Lens must warn and give the id.',
        surveys: { A: once(S('Hedge by title', [{ opens: 'Hedge Designation' }, { button: 'Export' }])) },
        lensWarns: { A: [/title/i, /LinkListReqv/] },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'Steps while posthog-js is still loading (before identify)',
        why: 'initPostHog runs after the viewport; on a slow network the user opens the report and presses Export before posthog-js has loaded and identified. The snippet queues both events.',
        surveys: { A: once(S('Hedge early', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        slow: 2500,
        acts: [['wait', 500], ['open', 'report:LinkListReqv'], ['wait', 900], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'], within: 15000, by: 'C1DEV|01|SEM|SEMOPS' }]],
    },
    {
        name: 'First step before the surveys load, second after',
        why: 'The report is opened while posthog-js is loading; Export is pressed once everything is in.',
        surveys: { A: once(S('Hedge split', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        slow: 2000,
        acts: [['wait', 500], ['open', 'report:LinkListReqv'], ['ready'], ['wait', 300], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Steps before initPostHog runs at all',
        why: 'Before initPostHog there is no posthog object: Reval drops the event, so PostHog never has it. Nothing can show the survey from it (documented).',
        surveys: { A: once(S('Hedge before init', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        init: 3000,
        acts: [['wait', 300], ['open', 'report:LinkListReqv'], ['ready'], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true, note: 'OPEN happened before initPostHog: not in PostHog either' }]],
    },
    {
        name: 'Screen reopened while its tab is still open (focus only)',
        why: 'Picking IR Swap again only focuses its tab: no new OPEN. The chain continues from the first OPEN.',
        surveys: { A: once(S('Swap save', [{ opens: 'DlgDetailIRSwap' }, { button: 'Save', dialog: 'DlgDetailIRSwap' }])) },
        acts: [['ready'], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['open', 'DlgTradeList'], ['wait', 1300], ['open', 'DlgDetailIRSwap'], ['wait', 300], ['press', 'DlgDetailIRSwap', 'Save'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Chain that needs a second OPEN of a screen still open',
        why: 'List, detail, back to the list: the list tab is still open, so Reval sends no second OPEN. Never shows; Lens must warn.',
        surveys: { A: once(S('List detail list', [{ opens: 'DlgTradeList' }, { opens: 'DlgDetailIRSwap' }, { opens: 'DlgTradeList' }])) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['open', 'DlgTradeList'], ['expect', { none: true }]],
    },
    {
        name: 'Tab switches in between',
        why: 'Inner tab changes send PageView OPEN with no dialog id; MDI tab switches send nothing. Neither breaks the chain.',
        surveys: { A: once(S('Swap recalc', [{ opens: 'DlgDetailIRSwap' }, { button: 'Recalc Cashflow', dialog: 'DlgDetailIRSwap' }])) },
        acts: [['ready'], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['tab', 'DlgDetailIRSwap', 'Cashflow'], ['tab', 'DlgDetailIRSwap', 'Schedule'], ['open', 'DlgHedgeList'], ['wait', 1200],
            ['mdi', 'DlgDetailIRSwap'], ['tab', 'DlgDetailIRSwap', 'Terms'], ['press', 'DlgDetailIRSwap', 'Recalc Cashflow'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Long chain (6 steps) with noise', quick: true,
        why: 'Six steps across screens, fields, tabs, other screens and toasts in between.',
        surveys: { A: once(S('Trade lifecycle', [{ opens: 'DlgTradeList' }, { button: 'Run', dialog: 'DlgTradeList' }, { opens: 'DlgDetailIRSwap' }, { field: 'Notional', dialog: 'DlgDetailIRSwap' },
            { button: 'Save', dialog: 'DlgDetailIRSwap' }, { message: 'Trade Id 4348 Updated' }])) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['field', 'DlgTradeList', 'Entity', 'ION UK'], ['press', 'DlgTradeList', 'Run'], ['wait', 600], ['open', 'DlgCalculator'], ['wait', 500],
            ['press', 'DlgCalculator', 'Calculate'], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['tab', 'DlgDetailIRSwap', 'Cashflow'], ['tab', 'DlgDetailIRSwap', 'Terms'], ['field', 'DlgDetailIRSwap', 'Counterparty', 'ACME Bank'],
            ['field', 'DlgDetailIRSwap', 'Notional', '1000000'], ['open', 'DlgDetailFRA'], ['wait', 900], ['mdi', 'DlgDetailIRSwap'], ['press', 'DlgDetailIRSwap', 'Save'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'within_minutes: chain too slow',
        why: 'within_minutes 1: the second step comes 2 minutes after the first.',
        surveys: { A: once(S('Timed list', [{ opens: 'DlgTradeList' }, { button: 'Run', dialog: 'DlgTradeList' }], { within_minutes: 1 })) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['advance', 2 * 60_000], ['press', 'DlgTradeList', 'Run'], ['expect', { none: true }]],
    },
    {
        name: 'within_minutes: in time',
        why: 'The same survey, second step 30 seconds later.',
        surveys: { A: once(S('Timed list ok', [{ opens: 'DlgTradeList' }, { button: 'Run', dialog: 'DlgTradeList' }], { within_minutes: 1 })) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['advance', 30_000], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'reset_on: closing the first screen starts over',
        why: 'IR Swap saved, closed (reset), then the hedge report: must not show. Then the whole chain again: shows.',
        surveys: { A: once(S('Swap then hedge', [{ opens: 'DlgDetailIRSwap' }, { button: 'Save', dialog: 'DlgDetailIRSwap' }, { opens: 'LinkListReqv' }], { reset_on: [{ closes: 'DlgDetailIRSwap' }] })) },
        acts: [['ready'], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['press', 'DlgDetailIRSwap', 'Save'], ['wait', 600], ['close', 'DlgDetailIRSwap'], ['open', 'report:LinkListReqv'], ['expect', { none: true }],
            ['press', 'LinkListReqv', 'Close'], ['open', 'DlgDetailIRSwap'], ['wait', 900], ['press', 'DlgDetailIRSwap', 'Save'], ['wait', 600], ['open', 'report:LinkListReqv'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Clients audience, CLIENT_FROM_DISTINCT_ID=3, SEM user', quick: true,
        why: 'The client is part 3 of ENV|SITE|CLIENT|USER.',
        surveys: { A: once(S('SEM only', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Clients audience, CLIENT_FROM_DISTINCT_ID=3, other client',
        why: 'An ACME user does the same: not in the audience.',
        client: 'ACME', user: 'ACMEOPS',
        surveys: { A: once(S('SEM only 2', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'Clients audience, CLIENT_FROM_DISTINCT_ID=0',
        why: 'With 0 the browser reads client_id from each event, and Reval events carry no client: nobody sees it. Lens must warn.',
        clientFromDistinctId: 0,
        surveys: { A: once(S('SEM by property', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        lensWarns: { A: [/CLIENT_FROM_DISTINCT_ID=3/] },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'sample_percent 50: a user inside the sample',
        why: 'The sample is fixed per user (a hash of the user id and the chain).',
        surveys: { A: once(S('Half of SEM', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], { sample_percent: 50 })) },
        user: (chains) => sampleUser(chains.A, true),
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'sample_percent 50: a user outside the sample',
        why: 'The other half never sees it.',
        surveys: { A: once(S('Half of SEM 2', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], { sample_percent: 50 })) },
        user: (chains) => sampleUser(chains.A, false),
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'Two surveys on the same steps',
        why: 'One survey at a time: the one launched first shows; the other waits for the gap (24 h, and its days_between_surveys of 1) and shows a day later.',
        surveys: {
            A: once(S('First launched', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], { days_between_surveys: 1 })),
            B: once(S('Second launched', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }], { days_between_surveys: 1 })),
        },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'] }], ['answer'], ['wait', 1500],
            ['press', 'LinkListReqv', 'Export'], ['expect', { none: true, note: 'B waits: another survey within 24 h' }],
            ['advance', 25 * HOUR], ['press', 'LinkListReqv', 'Close'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['B'] }]],
    },
    {
        name: 'Per-user limit (SURVEYS_PER_USER=2)',
        why: 'Ignored surveys stay unfinished: after two shown and ignored, a third survey waits.',
        surveys: {
            A: once(S('Limit one', [{ button: 'Run', dialog: 'DlgTradeList' }], { days_between_surveys: 1 })),
            B: once(S('Limit two', [{ button: 'Run', dialog: 'DlgHedgeList' }], { days_between_surveys: 1 })),
            C: once(S('Limit three', [{ button: 'Calculate', dialog: 'DlgCalculator' }], { days_between_surveys: 1 })),
        },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }],
            ['advance', 25 * HOUR], ['reload'], ['ready'], ['open', 'DlgHedgeList'], ['wait', 1300], ['press', 'DlgHedgeList', 'Run'], ['expect', { shown: ['B'], note: 'A shown but not answered' }],
            ['advance', 25 * HOUR], ['reload'], ['ready'], ['open', 'DlgCalculator'], ['wait', 600], ['press', 'DlgCalculator', 'Calculate'], ['expect', { none: true, note: 'A and B unfinished: C waits' }]],
    },
    {
        name: 'show once: not again after an answer',
        why: 'Answered, then the steps again two days later.',
        surveys: { A: once(S('Once', [{ button: 'Run', dialog: 'DlgTradeList' }], { days_between_surveys: 1 })) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }], ['answer'], ['wait', 1500],
            ['advance', 49 * HOUR], ['press', 'DlgTradeList', 'Run'], ['expect', { none: true }]],
    },
    {
        name: 'show every_time: again after an answer (past the gap)',
        why: 'Answered, then the steps again two days later: shows again.',
        surveys: { A: once(S('Every time', [{ button: 'Run', dialog: 'DlgTradeList' }], { days_between_surveys: 1, show: 'every_time' })) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }], ['answer'], ['wait', 1500],
            ['press', 'DlgTradeList', 'Run'], ['expect', { none: true, note: 'within the 24 h gap' }],
            ['advance', 49 * HOUR], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Dismissed with the cross: quiet days',
        why: 'After a close with the cross, no Lens survey for 7 days, and the closed one never again.',
        surveys: {
            A: once(S('Closed one', [{ button: 'Run', dialog: 'DlgTradeList' }], { days_between_surveys: 1, show: 'every_time' })),
            B: once(S('After quiet', [{ button: 'Run', dialog: 'DlgHedgeList' }], { days_between_surveys: 1 })),
        },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'] }], ['dismiss'], ['wait', 1000],
            ['advance', 2 * DAY], ['open', 'DlgHedgeList'], ['wait', 1300], ['press', 'DlgHedgeList', 'Run'], ['expect', { none: true, note: 'quiet for 7 days' }],
            ['mdi', 'DlgTradeList'], ['press', 'DlgTradeList', 'Run'], ['expect', { none: true, note: 'closed: never again' }],
            ['advance', 6 * DAY], ['mdi', 'DlgHedgeList'], ['press', 'DlgHedgeList', 'Run'], ['expect', { shown: ['B'] }]],
    },
    {
        name: 'Loading mask still visible: waits, then shows', quick: true,
        why: 'OPEN is captured before the viewport LoadMask (z-index 99999) goes: the survey must wait for it.',
        surveys: { A: once(S('List opened', [{ opens: 'DlgTradeList' }])) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['expect', { shown: ['A'], notWhileMask: true, after: 900 }]],
    },
    {
        name: 'Grid load mask (custom Ext.LoadMask on Run)',
        why: 'The grid loads under its own mask after Run: the survey waits for it.',
        surveys: { A: once(S('List run', [{ button: 'Run', dialog: 'DlgTradeList' }])) },
        acts: [['ready'], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Run'], ['expect', { shown: ['A'], notWhileMask: true, after: 350 }]],
    },
    {
        name: 'Modal window open: waits until it closes',
        why: 'Trade Search is modal (Ext modal mask): the survey waits and shows once the window is closed.',
        surveys: { A: once(S('Search opened', [{ opens: 'DlgTradeSearch' }])) },
        acts: [['ready'], ['open', 'DlgTradeSearch'], ['expect', { none: true, within: 3000, note: 'modal still open' }], ['press', 'DlgTradeSearch', 'Cancel'], ['expect', { shown: ['A'], notWhileMask: true }]],
    },
    {
        name: 'Mask never goes away: gives up after max_wait_seconds',
        why: 'Archive Loader hangs under its viewport mask; with max_wait_seconds 3 the survey is skipped, not shown later over the hung screen.',
        surveys: { A: once(S('Archive opened', [{ opens: 'DlgArchiveLoad' }], { max_wait_seconds: 3 })) },
        acts: [['ready'], ['open', 'DlgArchiveLoad'], ['expect', { none: true, within: 6000 }]],
    },
    {
        name: 'Hidden-but-kept form mask does not block',
        why: 'Save shows a submit mask that is hidden but kept in the DOM; the next step must still show the survey.',
        surveys: { A: once(S('FRA save then edit', [{ button: 'Save', dialog: 'DlgDetailFRA' }, { field: 'Notional', dialog: 'DlgDetailFRA' }])) },
        acts: [['ready'], ['open', 'DlgDetailFRA'], ['wait', 900], ['press', 'DlgDetailFRA', 'Save'], ['wait', 1200], ['field', 'DlgDetailFRA', 'Notional', '250000'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Logout, then another client\'s user logs in (no reload)',
        why: 'No posthog.reset(): identify switches the user. The ACME user is not in the SEM audience; then a SEM user logs in and does the steps.',
        surveys: { A: once(S('SEM hedge relogin', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['logout'], ['login', 'ACMEOPS', 'ACME'], ['wait', 500], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'],
            ['expect', { none: true, note: 'ACME is not in the audience' }], ['logout'], ['login', 'SEMRISK', 'SEM'], ['wait', 500], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'],
            ['expect', { shown: ['A'], by: 'C1DEV|01|SEM|SEMRISK' }]],
    },
    {
        name: 'Logout mid-chain: the next user does not inherit it',
        why: 'User 1 opens the report and logs out; user 2 (same client) only presses Export elsewhere: must not show.',
        surveys: { A: once(S('Hedge then any export', [{ opens: 'LinkListReqv' }, { button: 'Export' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['logout'], ['login', 'SEMRISK', 'SEM'], ['wait', 500], ['open', 'DlgTradeList'], ['wait', 1300], ['press', 'DlgTradeList', 'Export'], ['expect', { none: true }]],
    },
    {
        name: 'Client change (full page reload)',
        why: 'The client change is a form POST: the page reloads as the ACME user, who then does the steps.',
        surveys: { A: once(S('ACME hedge', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }]), ['ACME']) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true, note: 'SEM is not in the audience' }],
            ['changeClient', 'ACME', 'ACMEOPS'], ['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { shown: ['A'], by: 'C1DEV|01|ACME|ACMEOPS' }]],
    },
    {
        name: 'Message box step (message)',
        why: 'Save in Cap / Floor shows a message box (modal): the step matches its text, and the survey waits until OK.',
        surveys: { A: once(S('Cap strike error', [{ opens: 'DlgDetailCap' }, { message: 'strike must be greater' }])) },
        acts: [['ready'], ['open', 'DlgDetailCap'], ['wait', 900], ['press', 'DlgDetailCap', 'Save'], ['expect', { none: true, within: 2500, note: 'message box open' }], ['msgOk'], ['expect', { shown: ['A'], notWhileMask: true }]],
    },
    {
        name: 'Toast step (message_pattern)',
        why: 'Save in Hedge Relationship shows the toast "Link Id 3508 Added".',
        surveys: { A: once(S('Link added', [{ opens: 'DlgHedgeRel' }, { message_pattern: '^Link Id [0-9]+ Added$' }])) },
        acts: [['ready'], ['open', 'DlgHedgeRel'], ['wait', 900], ['press', 'DlgHedgeRel', 'Save'], ['expect', { shown: ['A'] }]],
    },
    {
        name: 'Iframe screen: clicks inside send nothing',
        why: 'Dashboards is an iframe without PostHog: its Export click is never captured.',
        surveys: { A: once(S('Dashboard export', [{ opens: 'DlgDashboardFrame' }, { button: 'Export', dialog: 'DlgDashboardFrame' }])) },
        acts: [['ready'], ['open', 'DlgDashboardFrame'], ['wait', 900], ['iframeClick', 'DlgDashboardFrame', '#export'], ['expect', { none: true }]],
    },
    {
        name: '100 screens in a row',
        why: 'Every screen opened one after another (tabs, windows, reports): no slowdown, no console errors; the survey on the last one shows.',
        surveys: { A: once(S('Last screen', [{ opens: 'ValuationReqv' }, { opens: 'CovenantsReqv' }])) },
        acts: [['ready'], ['openAll'], ['expect', { shown: ['A'], within: 10000 }]],
    },
    {
        name: 'Survey launched while the page is open shows after the refresh interval', quick: true,
        why: 'posthog-js reads flags once per page load, so a survey launched while Reval is open used to need a reload. The engine reloads flags and surveys every few minutes while visible (here every 3 s): the survey must then show on the next Hedge Designation export, with no reload, and not before it is launched.',
        surveys: { A: { ...once(S('Hedge export live launch', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])), launch: false } },
        refreshMs: 3000,
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'],
            ['expect', { none: true, within: 4000, note: 'not launched yet' }],
            ['launch', 'A'], ['expect', { none: true, within: 8000, note: 'launched and refreshed: the export before the launch does not count' }],
            ['close', 'LinkListReqv'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'],
            ['expect', { shown: ['A'], notWhileMask: true, within: 10000, note: 'launched after page load, no reload' }]],
    },
    {
        name: 'PostHog serves its own surveys.js at the versioned path',
        why: 'posthog-js asks for /static/<version>/surveys.js first. If that is PostHog\'s original, chains never run: apply.sh must cover it.',
        versioned: 'original',
        surveys: { A: once(S('Versioned original', [{ opens: 'LinkListReqv' }, { button: 'Export', dialog: 'LinkListReqv' }])) },
        acts: [['ready'], ['open', 'report:LinkListReqv'], ['wait', 600], ['press', 'LinkListReqv', 'Export'], ['expect', { none: true }]],
    },
]

// The engine's sample bucket (FNV-1a of "<distinct id>|<chain id>", 0-99): a SEM user inside or outside 50%.
export function sampleUser(chainId: string, inside: boolean): string {
    for (let i = 1; i < 500; i++) {
        const user = `SEMU${i}`
        const value = `C1DEV|01|SEM|${user}|${chainId}`
        let h = 0x811c9dc5
        for (let k = 0; k < value.length; k++) { h ^= value.charCodeAt(k); h = Math.imul(h, 0x01000193) >>> 0 }
        if ((h % 100 < 50) === inside) return user
    }
    throw new Error('no user found')
}
