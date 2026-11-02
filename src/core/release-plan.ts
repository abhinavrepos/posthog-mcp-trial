// The demo world's release history: Acme Portal ships monthly releases named YY.N.0. Each release
// has Jira tickets (project ACP), and most tickets leave a trace in PostHog: a new event people
// use, rage clicks, errors that a later fix removes.
//
// The history seeder (scripts/seed-history.ts)
// generates the matching PostHog usage, so the release dashboard has a consistent story:
//   26.5.0  a new chart engine breaks the revenue report; 26.6.0 fixes it
//   26.7.0  new client list filters cause rage clicks; 26.8.0 brings quick search back
//   26.8.0  bulk send is the most used feature of the year
//   26.10.0 PDF totals in base currency break multi-currency exports (the triage demo's bug)
// Nothing here is read by the release dashboard itself: it only sees Jira and PostHog.
import { CLIENTS, type DemoClient } from './catalog.ts'

export type TicketType = 'Story' | 'Bug' | 'Improvement' | 'Task'

export interface Signal {
    screen: string
    event?: string // a custom event the ticket added, captured on visits to `screen`
    use?: number // chance per visit to the screen once a client has the release
    who?: 'enterprise' | 'multi-currency' | 'admins'
    rage?: number // chance of a rage click per visit while a client is on an affected release
    element?: string // what the rage clicks hit
    error?: { rate: number; type: string; message: string; fn: string }
    until?: string // the release that ends the rage clicks or errors
    exportBug?: true // the 26.10.0 regression, which the seeder models separately
}

export interface DemoTicket {
    key: string
    type: TicketType
    summary: string
    description: string
    components: string[]
    labels?: string[]
    signal?: Signal
}

export interface DemoRelease {
    name: string
    date: string // release date (UTC)
    released: boolean
    description: string
    tickets: DemoTicket[]
}

const t = (key: string, type: TicketType, components: string[], summary: string, description: string, signal?: Signal, labels?: string[]): DemoTicket => ({
    key,
    type,
    summary,
    description,
    components,
    signal,
    labels,
})

export const RELEASES: DemoRelease[] = [
    {
        name: '25.9.0',
        date: '2025-09-08',
        released: true,
        description: 'Invoice search and time zone fixes.',
        tickets: [
            t('ACP-101', 'Story', ['Invoices'], 'Search invoices by customer name', 'Finance users want to find invoices by typing the customer name in the invoice list search.', { screen: '/invoices', event: 'invoice_searched', use: 0.25 }),
            t('ACP-102', 'Bug', ['Dashboard'], 'Dashboard totals are off by one day in US time zones', 'Totals on the dashboard use UTC midnight, so US users see yesterday in today.', { screen: '/dashboard' }),
            t('ACP-103', 'Task', ['Platform'], 'Upgrade the PDF library', 'Move to the maintained fork.'),
        ],
    },
    {
        name: '25.10.0',
        date: '2025-10-13',
        released: true,
        description: 'Client list sorting and faster invoice loading.',
        tickets: [
            t('ACP-110', 'Story', ['Clients'], 'Sort the client list by outstanding balance', 'Account managers want the clients who owe the most at the top.', { screen: '/clients', event: 'client_list_sorted', use: 0.2 }),
            t('ACP-111', 'Improvement', ['Invoices'], 'Faster invoice list loading', 'Paginate on the server so large accounts load in under a second.', { screen: '/invoices' }),
            t('ACP-112', 'Task', ['Platform'], 'Move CI to the new runners', 'Infrastructure only.'),
        ],
    },
    {
        name: '25.11.0',
        date: '2025-11-10',
        released: true,
        description: 'Recurring invoices and the overdue widget.',
        tickets: [
            t('ACP-120', 'Story', ['Invoices'], 'Recurring invoices', 'Let finance users set an invoice to repeat monthly or quarterly.', { screen: '/invoices', event: 'recurring_invoice_created', use: 0.1 }),
            t('ACP-121', 'Story', ['Dashboard'], 'Overdue invoices widget on the dashboard', 'A widget that lists overdue invoices and links to them.', { screen: '/dashboard', event: 'overdue_widget_clicked', use: 0.22 }),
            t('ACP-122', 'Bug', ['Clients'], 'Client notes are lost when saving twice', 'Saving a client note twice in a row drops the first note.', { screen: '/clients' }),
            t('ACP-123', 'Improvement', ['Invoices'], 'Clearer message when a PDF fails', 'Replace "Something went wrong" with what failed and what to do.', { screen: '/invoices' }),
            t('ACP-124', 'Task', ['Platform'], 'Rotate signing keys', 'Yearly key rotation.'),
        ],
    },
    {
        name: '25.12.0',
        date: '2025-12-08',
        released: true,
        description: 'Year-end revenue summary and two-factor login.',
        tickets: [
            t('ACP-130', 'Story', ['Reports'], 'Year-end revenue summary', 'One page with the year in numbers for finance teams closing the year.', { screen: '/reports/revenue', event: 'revenue_summary_viewed', use: 0.3 }),
            t('ACP-131', 'Story', ['Settings'], 'Two-factor login for admins', 'Admins can require two-factor login for their team.', { screen: '/settings', event: 'two_factor_enabled', use: 0.08, who: 'admins' }),
            t('ACP-132', 'Bug', ['Reports'], 'Revenue chart is blank for clients with one invoice', 'The chart needs two points to draw an axis.', { screen: '/reports/revenue' }),
            t('ACP-133', 'Improvement', ['Invoices'], 'Keyboard shortcuts on the invoice list', 'J and K to move, E to export.', { screen: '/invoices', event: 'invoice_shortcut_used', use: 0.02 }),
        ],
    },
    {
        name: '26.1.0',
        date: '2026-01-12',
        released: true,
        description: 'Invoice reminders and client invitations.',
        tickets: [
            t('ACP-140', 'Story', ['Invoices'], 'Email reminders for unpaid invoices', 'Send a reminder to the customer from the invoice list, one click per invoice.', { screen: '/invoices', event: 'invoice_reminder_sent', use: 0.3 }),
            t('ACP-141', 'Story', ['Clients'], 'Invite client contacts to the portal', 'Account managers can invite a client contact by email.', { screen: '/clients', event: 'client_contact_invited', use: 0.07 }),
            t('ACP-142', 'Improvement', ['Reports'], 'New date picker on the revenue report', 'Replace the two dropdowns with a calendar date picker.', {
                screen: '/reports/revenue',
                rage: 0.2,
                element: 'Next month',
                until: '26.2.0',
            }),
            t('ACP-143', 'Task', ['Platform'], 'Database index for invoice search', 'Speeds up ACP-101 for large accounts.'),
        ],
    },
    {
        name: '26.2.0',
        date: '2026-02-09',
        released: true,
        description: 'Date picker fix, dark mode, client CSV export.',
        tickets: [
            t('ACP-150', 'Bug', ['Reports'], 'Date picker closes when clicking the month arrows', 'Clicking "next month" in the new date picker closes it, so users click again and again.', { screen: '/reports/revenue' }),
            t('ACP-151', 'Story', ['Settings'], 'Dark mode', 'A dark theme, switched in settings.', { screen: '/settings', event: 'theme_changed', use: 0.04 }),
            t('ACP-152', 'Story', ['Clients'], 'Export the client list to CSV', 'Download the filtered client list as CSV.', { screen: '/clients', event: 'client_list_exported', use: 0.14 }),
            t('ACP-153', 'Improvement', ['Invoices'], 'Remember the last invoice filter', 'Keep the status filter between visits.', { screen: '/invoices' }),
        ],
    },
    {
        name: '26.3.0',
        date: '2026-03-09',
        released: true,
        description: 'Multi-currency invoices and revenue by region.',
        tickets: [
            t('ACP-160', 'Story', ['Invoices'], 'Multi-currency invoices', 'Invoice customers in their own currency.', { screen: '/invoices', event: 'invoice_currency_changed', use: 0.2, who: 'multi-currency' }),
            t('ACP-161', 'Story', ['Reports'], 'Revenue breakdown by region', 'Split revenue by EU, UK, US and APAC.', { screen: '/reports/revenue', event: 'revenue_breakdown_viewed', use: 0.26 }),
            t('ACP-162', 'Bug', ['Settings'], 'Settings page is slow with 50+ team members', 'Load team members on demand.', { screen: '/settings' }),
            t('ACP-163', 'Task', ['Platform'], 'Accessibility audit fixes', 'Labels and contrast fixes across the app.'),
        ],
    },
    {
        name: '26.4.0',
        date: '2026-04-13',
        released: true,
        description: 'Custom dashboard and bulk due-date edits.',
        tickets: [
            t('ACP-170', 'Story', ['Dashboard'], 'Customise the dashboard layout', 'Drag widgets to arrange the dashboard.', { screen: '/dashboard', event: 'dashboard_customized', use: 0.09 }),
            t('ACP-171', 'Story', ['Invoices'], 'Bulk edit due dates', 'Select invoices and move their due dates together.', { screen: '/invoices', event: 'invoice_bulk_edited', use: 0.17 }),
            t('ACP-172', 'Improvement', ['Clients'], 'Edit client contacts inline', 'Edit a contact without opening the client page.', { screen: '/clients', event: 'client_contact_edited', use: 0.12 }),
            t('ACP-173', 'Bug', ['Invoices'], 'Duplicate reminder emails', 'Reminders were sent twice when the job retried.', { screen: '/invoices' }),
        ],
    },
    {
        name: '26.5.0',
        date: '2026-05-11',
        released: true,
        description: 'New chart engine and next-quarter forecast.',
        tickets: [
            t('ACP-180', 'Story', ['Reports'], 'New chart engine for the revenue report', 'Replace the old charting code with the new engine for faster rendering.', {
                screen: '/reports/revenue',
                error: { rate: 0.25, type: 'TypeError', message: "Cannot read properties of undefined (reading 'quarter')", fn: 'renderQuarterAxis' },
                until: '26.6.0',
            }),
            t('ACP-181', 'Story', ['Reports'], 'Forecast next quarter', 'Show a forecast line on the revenue report.', { screen: '/reports/revenue', event: 'revenue_forecast_viewed', use: 0.22 }),
            t('ACP-182', 'Improvement', ['Invoices'], 'Company branding on invoice PDFs', 'Logo and colours on exported PDFs.', { screen: '/invoices', event: 'invoice_branding_updated', use: 0.05 }),
            t('ACP-183', 'Task', ['Platform'], 'Upgrade to Node 24', 'Runtime upgrade.'),
        ],
    },
    {
        name: '26.6.0',
        date: '2026-06-08',
        released: true,
        description: 'Revenue chart fix, saved views and read-only roles.',
        tickets: [
            t('ACP-190', 'Bug', ['Reports'], 'Revenue chart crashes when a quarter has no invoices', 'renderQuarterAxis assumes every quarter has data.', { screen: '/reports/revenue' }),
            t('ACP-191', 'Story', ['Reports'], 'Saved report views', 'Save a report with its filters and open it later.', { screen: '/reports/revenue', event: 'report_view_saved', use: 0.09 }),
            t('ACP-192', 'Story', ['Settings'], 'Read-only finance role', 'A team role that can see but not change invoices.', { screen: '/settings', event: 'team_role_assigned', use: 0.07, who: 'admins' }),
            t('ACP-193', 'Improvement', ['Dashboard'], 'Faster dashboard load', 'Cache the totals for five minutes.', { screen: '/dashboard' }),
        ],
    },
    {
        name: '26.7.0',
        date: '2026-07-13',
        released: true,
        description: 'Client list filters and invoice approvals.',
        tickets: [
            t('ACP-200', 'Story', ['Clients'], 'Redesigned client list filters', 'Replace the quick search box with a filter panel.', {
                screen: '/clients',
                event: 'client_filter_applied',
                use: 0.28,
                rage: 0.2,
                element: 'Filters',
                until: '26.8.0',
            }),
            t('ACP-201', 'Story', ['Invoices'], 'Invoice approval workflow', 'Invoices over a limit need a second person to approve.', { screen: '/invoices', event: 'invoice_approved', use: 0.2, who: 'enterprise' }),
            t('ACP-202', 'Bug', ['Invoices'], 'Wrong VAT rounding on credit notes', 'Round per line, not on the total.', { screen: '/invoices' }),
            t('ACP-203', 'Task', ['Platform'], 'SOC 2 audit logging', 'Log admin actions for the audit.'),
        ],
    },
    {
        name: '26.8.0',
        date: '2026-08-10',
        released: true,
        description: 'Bulk send and quick search is back.',
        tickets: [
            t('ACP-210', 'Story', ['Invoices'], 'Bulk send invoices', 'Select invoices and email them all in one go.', { screen: '/invoices', event: 'invoice_bulk_sent', use: 0.45 }),
            t('ACP-211', 'Bug', ['Clients'], 'Bring back quick search on the client list', 'People could not find the search box after the filter redesign and clicked around the filter panel.', { screen: '/clients' }),
            t('ACP-212', 'Story', ['Settings'], 'Slack notifications for paid invoices', 'Post to a Slack channel when an invoice is paid.', { screen: '/settings', event: 'slack_connected', use: 0.06, who: 'admins' }),
            t('ACP-213', 'Improvement', ['Reports'], 'Compare revenue with last year', 'A toggle that overlays last year.', { screen: '/reports/revenue', event: 'revenue_compare_toggled', use: 0.24 }),
        ],
    },
    {
        name: '26.9.0',
        date: '2026-09-14',
        released: true,
        description: 'Payment links and client health.',
        tickets: [
            t('ACP-220', 'Story', ['Invoices'], 'Payment links on invoices', 'Copy a link the customer can pay from.', { screen: '/invoices', event: 'payment_link_copied', use: 0.3 }),
            t('ACP-221', 'Story', ['Clients'], 'Client health score', 'A score from payment history, shown on the client list.', { screen: '/clients', event: 'client_health_viewed', use: 0.2 }),
            t('ACP-222', 'Improvement', ['Dashboard'], 'Cash-flow chart on the dashboard', 'Money in and out for the next 90 days.', { screen: '/dashboard', event: 'cashflow_chart_viewed', use: 0.15 }),
            t('ACP-223', 'Bug', ['Invoices'], 'Export stuck for very large batches', 'Batches over 500 invoices never finish.', { screen: '/invoices' }),
        ],
    },
    {
        name: '26.10.0',
        date: '2026-10-26',
        released: true,
        description: 'Base-currency PDF totals, invoice templates, quarter-end checklist.',
        tickets: [
            t('ACP-230', 'Story', ['Invoices'], 'Show PDF export totals in the base currency', 'Convert every line to the base currency before building the PDF totals, instead of one subtotal per currency.', { screen: '/invoices', exportBug: true }),
            t('ACP-231', 'Story', ['Invoices'], 'Invoice templates', 'Start an invoice from a saved template.', { screen: '/invoices', event: 'invoice_template_used', use: 0.25 }),
            t('ACP-232', 'Story', ['Dashboard'], 'Quarter-end close checklist', 'A checklist on the dashboard for closing the quarter.', { screen: '/dashboard', event: 'close_checklist_opened', use: 0.3 }),
            t('ACP-233', 'Bug', ['Clients'], 'Client search ignores accents', 'Searching "Marin" does not find "Marín".', { screen: '/clients' }),
            t('ACP-234', 'Task', ['Platform'], 'Upgrade the charting library', 'Security patch.'),
        ],
    },
    {
        name: '26.11.0',
        date: '2026-11-23',
        released: false,
        description: 'Planned: credit notes and approval limits.',
        tickets: [
            t('ACP-240', 'Story', ['Invoices'], 'Credit notes', 'Issue a credit note against an invoice.'),
            t('ACP-241', 'Improvement', ['Invoices'], 'Approval limits per team', 'Different approval limits per team.'),
        ],
    },
]

export const RELEASED = RELEASES.filter((r) => r.released)
const DAY = 86_400_000
const at = (r: DemoRelease) => Date.parse(r.date + 'T09:00:00Z')

/** Days a client waits before taking a release (0 to 12, the same every run). */
function lag(client: DemoClient, release: DemoRelease): number {
    let h = 0
    for (const ch of client.id + release.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return h % 13
}

/** The release a client is on at time t. 26.10.0 went to half the clients on its release day
 * (catalog `version`); the other half are still on 26.9.0. */
export function versionAt(client: DemoClient, time: number): string {
    let current = RELEASED[0].name
    for (const r of RELEASED) {
        const last = r === RELEASED[RELEASED.length - 1]
        if (last) {
            if (client.version === r.name && time >= at(r)) current = r.name
        } else if (time >= at(r) + lag(client, r) * DAY) current = r.name
    }
    return current
}

export const releaseTime = (name: string) => at(RELEASES.find((r) => r.name === name)!)
export const releaseIndex = (name: string) => RELEASES.findIndex((r) => r.name === name)

/** The live signals a client on `version` has. */
export function activeSignals(version: string): (Signal & { key: string; since: string })[] {
    const v = releaseIndex(version)
    const out: (Signal & { key: string; since: string })[] = []
    for (const r of RELEASED) {
        if (releaseIndex(r.name) > v) break
        for (const tk of r.tickets) if (tk.signal) out.push({ ...tk.signal, key: tk.key, since: r.name })
    }
    return out
}

export function appliesTo(s: Signal, client: DemoClient, role: string): boolean {
    if (s.who === 'enterprise') return client.plan === 'enterprise'
    if (s.who === 'multi-currency') return client.currencies.length > 1
    if (s.who === 'admins') return role === 'admin'
    return true
}

// ------------------------------------------------------------------ past support tickets
export interface DemoSupportTicket {
    key: string
    type: 'RCI' | 'MMT Risk'
    created: string
    client: string
    summary: string
    description: string
}

const client = (id: string) => CLIENTS.find((c) => c.id === id)!.name

/** Resolved RCI and MMT Risk tickets from the past year, for the support side of the dashboard. */
export const PAST_SUPPORT: DemoSupportTicket[] = [
    ['SUP-11', 'RCI', '2025-11-20', 'meridian', 'Overdue widget shows paid invoices', 'The new overdue widget on the dashboard lists invoices that were paid yesterday.'],
    ['SUP-12', 'RCI', '2026-01-15', 'granite', 'Date picker on revenue report keeps closing', 'On the revenue report the new date picker closes every time I click the arrow to go to the next month.'],
    ['SUP-13', 'RCI', '2026-01-19', 'atlas', 'Cannot pick a date range on the revenue report', 'The calendar on the revenue report closes before I can choose the end date.'],
    ['SUP-14', 'RCI', '2026-01-26', 'coral', 'Revenue report date picker unusable', 'Date picker on the revenue report: clicking next month closes it.'],
    ['SUP-15', 'RCI', '2026-03-17', 'nordlicht', 'Invoice currency switch resets the lines', 'Changing the invoice currency on the invoices screen clears the lines I typed.'],
    ['SUP-16', 'RCI', '2026-05-13', 'cobalt', 'Revenue report crashes', 'The revenue report shows an error and no chart since this week.'],
    ['SUP-17', 'RCI', '2026-05-14', 'meridian', 'Revenue chart error', 'Revenue report: "Something went wrong" instead of the chart, for Q2.'],
    ['SUP-18', 'MMT Risk', '2026-05-18', 'brightwater', 'Risk review: revenue report errors after 26.5.0', 'Please assess the exposure of the revenue report errors after the 26.5.0 release.'],
    ['SUP-19', 'RCI', '2026-05-22', 'kestrel', 'Forecast chart blank', 'The revenue report is blank when the quarter just started.'],
    ['SUP-20', 'RCI', '2026-05-29', 'atlas', 'Revenue report error on new quarter', 'Error on the revenue report for the current quarter.'],
    ['SUP-21', 'RCI', '2026-07-15', 'brightwater', 'Where did client search go?', 'On the client list there is no search box any more. I keep clicking the filters.'],
    ['SUP-22', 'RCI', '2026-07-16', 'verdant', 'Client list filters confusing', 'Cannot find a client by name on the clients screen since the update.'],
    ['SUP-23', 'RCI', '2026-07-21', 'harbor', 'Client list search missing', 'The client list lost its search box.'],
    ['SUP-24', 'RCI', '2026-07-28', 'granite', 'Filters on clients screen', 'The filter panel on the client list does nothing when I click Apply twice.'],
    ['SUP-25', 'RCI', '2026-08-19', 'coral', 'Bulk send: one invoice missing', 'Bulk send on invoices skipped one invoice of twenty.'],
    ['SUP-26', 'RCI', '2026-09-22', 'beacon', 'Payment link expired', 'The payment link copied from the invoice says expired.'],
    ['SUP-27', 'RCI', '2026-10-02', 'atlas', 'Settings page logs me out', 'Saving team settings logs me out.'],
].map(([key, type, created, id, summary, description]) => ({
    key,
    type: type as DemoSupportTicket['type'],
    created,
    client: client(id),
    summary,
    description: `${description}\n\nClient: ${client(id)}`,
}))
