import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'triage-rel-'))
process.env.TRIAGE_DB = join(dir, 'test.db')
const { db } = await import('../src/core/db.ts')
const { autoLink, sameWord, quarterOf, scoreTicket, saveReleaseSettings, releaseSettings, DEFAULT_SETTINGS } = await import('../src/core/releases.ts')
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
        assert.deepEqual(quarterOf('2026-10-26', 1), { id: 'q:2026-4', label: 'Q4 2026' })
        assert.deepEqual(quarterOf('2026-01-12', 1), { id: 'q:2026-1', label: 'Q1 2026' })
    })
    test('a fiscal year starting in April is named after the year it ends', () => {
        assert.deepEqual(quarterOf('2026-04-13', 4), { id: 'q:FY2027-1', label: 'FY27 Q1' })
        assert.deepEqual(quarterOf('2026-03-09', 4), { id: 'q:FY2026-4', label: 'FY26 Q4' })
    })
})

describe('scores', () => {
    const snap = {
        release: '26.10.0',
        totals: { clients_after: 20 },
        screens: {
            '/invoices': { sessions_after: 400, sessions_before: 400, errors_after: 40, errors_before: 0, rage_after: 10, rage_before: 0, support: [{ key: 'SUP-1' }, { key: 'SUP-2' }] },
            '/clients': { sessions_after: 200, sessions_before: 200, errors_after: 0, errors_before: 0, rage_after: 2, rage_before: 30, support: [] },
        },
        new_errors: [{ path: '/invoices', clients: 4 }],
    } as never
    const w = DEFAULT_SETTINGS.weights

    test('a widely used new feature scores high on value and none on risk', () => {
        const s = scoreTicket({ link: { screen: '/invoices', event: 'invoice_template_used' }, risk_owner: false, usage: { after: 160, clients_after: 18 } } as never, snap, w, 0.5)
        assert.equal(s.direction, 'value')
        assert.ok(s.reach >= 0.89)
        assert.equal(s.risk, 0)
        assert.ok(s.impact >= 80)
    })
    test('the ticket that changed a screen carries its new errors and support tickets', () => {
        const s = scoreTicket({ link: { screen: '/invoices' }, risk_owner: true, usage: { after: 900, clients_after: 20 } } as never, snap, w, 0.5)
        assert.equal(s.direction, 'risk')
        assert.equal(s.errors, 1)
        assert.equal(s.support, 0.5)
        assert.ok(s.impact >= 70)
    })
    test('a new feature on the same screen is not credited with a fix', () => {
        const s = scoreTicket({ type: 'Story', link: { screen: '/clients', event: 'client_health_viewed' }, risk_owner: true, usage: { after: 50, clients_after: 10 } } as never, snap, w, 0.5)
        assert.equal(s.fixes, null)
    })
    test('a fix is credited when rage clicks drop', () => {
        const s = scoreTicket({ link: { screen: '/clients' }, risk_owner: true, usage: { after: 300, clients_after: 15 } } as never, snap, w, 0.5)
        assert.ok(s.fixes! >= 0.9)
        assert.equal(s.direction, 'value')
    })
    test('weights change the ranking without new data', () => {
        const t = { link: { screen: '/invoices' }, risk_owner: true, usage: { after: 900, clients_after: 20 } } as never
        const a = scoreTicket(t, snap, w, 0.5)
        const b = scoreTicket(t, snap, { ...w, errors: 0, support: 0, friction: 1 }, 0.5)
        assert.ok(b.risk < a.risk)
    })
})

describe('settings', () => {
    test('defaults, saving and refusing bad values', () => {
        assert.equal(releaseSettings().keep, 12)
        saveReleaseSettings({ keep: 8, fiscal_start_month: 4, weights: { ...DEFAULT_SETTINGS.weights, reach: 5 } })
        assert.equal(releaseSettings().keep, 8)
        assert.equal(releaseSettings().weights.reach, 5)
        assert.throws(() => saveReleaseSettings({ client_property: "client_id) OR 1=1 --" }), /plain property name/)
        assert.throws(() => saveReleaseSettings({ keep: 0 }), /between 1 and 52/)
        assert.throws(() => saveReleaseSettings({ support_jql: 'project = SUP; delete' }), /only filter/)
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
