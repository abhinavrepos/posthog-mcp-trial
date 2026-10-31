import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'triage-rel-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { db } = await import('../src/core/db.ts')
const { autoLink, sameWord, quarterOf, classify, releaseSettings, resolveScope } = await import('../src/core/releases.ts')
const { RELEASES, versionAt } = await import('../src/core/release-plan.ts')
const { CLIENTS } = await import('../src/core/catalog.ts')
after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
})

const areas = {
    screens: [],
    events: [
        { name: 'invoice_bulk_sent', first_seen: '2026-08-10T10:00:00Z', path: '/invoices', count: 488 },
        { name: 'invoice_bulk_edited', first_seen: '2026-04-13T10:00:00Z', path: '/invoices', count: 514 },
        { name: 'invoice_export_started', first_seen: '2025-09-01T08:00:00Z', path: '/invoices', count: 3849 },
        { name: 'client_contact_edited', first_seen: '2026-04-14T09:00:00Z', path: '/clients', count: 207 },
        { name: 'client_contact_invited', first_seen: '2026-01-12T12:00:00Z', path: '/clients', count: 207 },
        { name: 'theme_changed', first_seen: '2026-02-10T12:00:00Z', path: '/settings', count: 64 },
    ],
}

describe('linking tickets to PostHog', () => {
    test('a new feature links to the event that appeared with its release', () => {
        const l = autoLink({ summary: 'Bulk send invoices', description: 'Select invoices and email them.', components: ['Invoices'] }, '2026-08-10', areas)
        assert.equal(l.event, 'invoice_bulk_sent')
        assert.equal(l.screen, '/invoices')
        assert.equal(l.source, 'event')
        assert.match(l.reason, /on release day/)
    })

    test('an older event with the same words is not taken for a new feature', () => {
        const l = autoLink({ summary: 'Edit client contacts inline', components: ['Clients'] }, '2026-04-13', areas)
        assert.equal(l.event, 'client_contact_edited')
    })

    test('a bug fix with no new event links to the screen from its component', () => {
        const l = autoLink({ summary: 'Export stuck for very large batches', components: ['Invoices'] }, '2026-09-14', areas)
        assert.equal(l.event, undefined)
        assert.equal(l.screen, '/invoices')
        assert.equal(l.source, 'component')
    })

    test('the component map wins over screen names', () => {
        const l = autoLink({ summary: 'Something', components: ['Billing'] }, '2026-09-14', areas, { Billing: '/invoices' })
        assert.equal(l.screen, '/invoices')
    })

    test('without a component, words in the ticket name the screen', () => {
        const l = autoLink({ summary: 'Revenue report chart is blank', components: [] }, '2026-09-14', areas)
        assert.equal(l.screen, '/reports/revenue')
        assert.equal(l.source, 'text')
    })

    test('a bug is not linked to a feature event that only shares the screen name', () => {
        const ev = { ...areas, events: [...areas.events, { name: 'revenue_summary_viewed', first_seen: '2025-12-08T10:00:00Z', path: '/reports/revenue', count: 900 }] }
        const bug = autoLink({ summary: 'Revenue chart is blank for clients with one invoice', components: ['Reports'], type: 'Bug' }, '2025-12-08', ev)
        assert.equal(bug.event, undefined)
        const story = autoLink({ summary: 'Year-end revenue summary', components: ['Reports'], type: 'Story' }, '2025-12-08', ev)
        assert.equal(story.event, 'revenue_summary_viewed')
    })

    test("sharing only the screen word is not enough to take another feature's event", () => {
        const ev = { ...areas, events: [...areas.events, { name: 'revenue_forecast_viewed', first_seen: '2026-05-11T10:00:00Z', path: '/reports/revenue', count: 300 }] }
        const l = autoLink({ summary: 'New chart engine for the revenue report', components: ['Reports'], type: 'Story' }, '2026-05-11', ev)
        assert.equal(l.event, undefined)
        assert.equal(l.screen, '/reports/revenue')
    })

    test('a word the screen is searched by (forecast) still counts as a feature word', () => {
        const ev = { ...areas, events: [...areas.events, { name: 'revenue_forecast_viewed', first_seen: '2026-05-11T10:00:00Z', path: '/reports/revenue', count: 300 }] }
        const l = autoLink({ summary: 'Forecast next quarter', components: ['Reports'], type: 'Story' }, '2026-05-11', ev)
        assert.equal(l.event, 'revenue_forecast_viewed')
    })

    test('a platform task links to nothing', () => {
        const l = autoLink({ summary: 'Move CI to new runners', components: ['Platform'] }, '2026-09-14', areas)
        assert.equal(l.source, 'none')
    })

    test('a feature whose event uses other words is left to the screen, for a person to fix', () => {
        const l = autoLink({ summary: 'Dark mode', components: ['Settings'] }, '2026-02-09', areas)
        assert.equal(l.event, undefined)
        assert.equal(l.screen, '/settings')
    })
})

describe('word matching', () => {
    test('endings differ, words match; different words do not', () => {
        for (const [a, b] of [['export', 'exported'], ['approval', 'approved'], ['customise', 'customized'], ['invite', 'invited'], ['invoice', 'invoicing']]) assert.ok(sameWord(a, b), `${a} ~ ${b}`)
        for (const [a, b] of [['send', 'sent'], ['contact', 'content'], ['broken', 'breakdown'], ['report', 'repeat']]) assert.ok(!sameWord(a, b), `${a} !~ ${b}`)
    })
})

describe('quarters', () => {
    test('calendar quarters', () => {
        assert.equal(quarterOf('2026-10-26', 1), 'Q4 2026')
        assert.equal(quarterOf('2026-01-12', 1), 'Q1 2026')
    })
    test('a fiscal year starting in April is named after the year it ends', () => {
        assert.equal(quarterOf('2026-04-13', 4), 'FY27 Q1')
        assert.equal(quarterOf('2026-03-09', 4), 'FY26 Q4')
    })
})

describe('outcome groups', () => {
    const sc = (o: Record<string, unknown> = {}) => ({
        sessions_after: 400,
        sessions_before: 400,
        errors_after: 0,
        errors_before: 0,
        rage_after: 0,
        rage_before: 0,
        support: [],
        survey: { answers_before: 0, answers_after: 0, rating_before: null, rating_after: null, comments_after: [] },
        ...o,
    })
    const snap = (screens: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        ({ release: '26.10.0', date: '2026-10-26', window: { days: 30, open: false }, totals: { clients_after: 100 }, screens, new_errors: [], tickets: [], ...extra }) as never
    const t = (o: Record<string, unknown>) => ({ key: 'ACP-1', type: 'Story', summary: 's', link_reason: 'r', risk_owner: false, shares_screen_with: [], usage: null, ...o }) as never
    const groups = (tk: never, sn: never) => classify(tk, sn).groups

    test('a new feature used by most clients is adopted; one used by few has low uptake', () => {
        const s = snap({ '/invoices': sc() })
        assert.deepEqual(groups(t({ link: { screen: '/invoices', event: 'e' }, usage: { after: 900, before: 0, users_after: 400, clients_after: 86 } }), s), ['adopted'])
        assert.deepEqual(groups(t({ link: { screen: '/invoices', event: 'e' }, usage: { after: 9, before: 0, users_after: 4, clients_after: 3 } }), s), ['low_uptake'])
    })
    test('the ticket that changed a screen gets its new errors, rage clicks and complaints', () => {
        const s = snap(
            { '/invoices': sc({ errors_after: 60, rage_after: 30, support: [{ key: 'SUP-1' }] }) },
            { new_errors: [{ path: '/invoices', clients: 10, type: 'TypeError', message: 'x', occurrences: 60 }] }
        )
        const g = groups(t({ link: { screen: '/invoices' }, risk_owner: true, usage: { after: 5000, before: 5000, clients_after: 99 } }), s)
        assert.deepEqual(g.sort(), ['complaints', 'errors', 'rage'])
        assert.deepEqual(groups(t({ link: { screen: '/invoices', event: 'e' }, risk_owner: false, usage: { after: 50, clients_after: 40 } }), s), ['adopted'], 'a feature next to it is not blamed')
    })
    test('a drop in survey rating counts as a complaint', () => {
        const s = snap({ '/clients': sc({ survey: { answers_before: 40, answers_after: 38, rating_before: 4.2, rating_after: 3.1, comments_after: [] } }) })
        assert.deepEqual(groups(t({ link: { screen: '/clients' }, risk_owner: true, usage: { after: 1, clients_after: 1 } }), s), ['complaints'])
    })
    test('a bug fix is credited when errors halve; a new feature on that screen is not', () => {
        const s = snap({ '/reports/revenue': sc({ errors_before: 100, errors_after: 20 }) })
        assert.deepEqual(groups(t({ type: 'Bug', link: { screen: '/reports/revenue' }, risk_owner: true, usage: { after: 1, clients_after: 1 } }), s), ['fixed'])
        assert.ok(!groups(t({ type: 'Story', link: { screen: '/reports/revenue', event: 'e' }, risk_owner: true, usage: { after: 1, clients_after: 1 } }), s).includes('fixed'))
    })
    test('unlinked tickets cannot be measured; quiet new releases are too new to tell', () => {
        assert.deepEqual(groups(t({ link: null }), snap({})), ['unmeasured'])
        const fresh = snap({ '/dashboard': sc() }, { window: { days: 5, open: true } })
        assert.deepEqual(groups(t({ link: { screen: '/dashboard' }, risk_owner: true, usage: { after: 10, clients_after: 9 } }), fresh), ['too_new'])
    })
})

describe('settings and scopes', () => {
    test('settings come from the environment, and unsafe property names are refused', () => {
        assert.equal(releaseSettings().keep, 12)
        process.env.RELEASES_KEEP = '8'
        process.env.RELEASES_CLIENT_PROPERTY = 'client_id) OR 1=1 --'
        assert.equal(releaseSettings().keep, 8)
        assert.equal(releaseSettings().client_property, 'client_id')
        delete process.env.RELEASES_KEEP
        delete process.env.RELEASES_CLIENT_PROPERTY
    })
    test('an unknown scope is undefined when nothing is stored', () => {
        assert.equal(resolveScope('Q9 1999'), undefined)
    })
})

describe('demo release plan', () => {
    test('12 releases plus older and planned ones, with dates in order', () => {
        const released = RELEASES.filter((r) => r.released)
        assert.ok(released.length >= 13)
        for (let i = 1; i < RELEASES.length; i++) assert.ok(RELEASES[i].date > RELEASES[i - 1].date)
        assert.ok(new Set(RELEASES.flatMap((r) => r.tickets.map((t) => t.key))).size === RELEASES.flatMap((r) => r.tickets).length, 'ticket keys are unique')
    })
    test('half the clients took 26.10.0 on release day; the rest stay on 26.9.0', () => {
        const t = Date.parse('2026-10-27T12:00:00Z')
        const on = CLIENTS.filter((c) => versionAt(c, t) === '26.10.0').length
        assert.equal(on, CLIENTS.filter((c) => c.version === '26.10.0').length)
        assert.ok(CLIENTS.every((c) => ['26.9.0', '26.10.0'].includes(versionAt(c, t))))
    })
})
