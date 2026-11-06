import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { moveFile } from '../src/core/files.ts'
import { fillDays } from '../src/core/impact.ts'
import { bestPerSession, elementLabel, type Incident } from '../src/core/incidents.ts'
import { verifyClipLink } from '../src/core/links.ts'
import { resolveScreen, scoreClientName } from '../src/core/resolve.ts'
import { isRising, suggestSeverity } from '../src/core/severity.ts'
import { struggleScore } from '../src/core/silent.ts'
import { stem, tokens } from '../src/core/text.ts'
import { parseTicket } from '../src/core/ticket.ts'
import { parseTimeWindow, widen } from '../src/core/timewindow.ts'

// Friday 31 Oct 2026, 15:00 UTC
const NOW = new Date('2026-10-31T15:00:00Z')
const iso = (d: Date) => d.toISOString()

describe('stemming and screens', () => {
    test('plural and singular stem the same', () => {
        for (const [a, b] of [['invoices', 'invoice'], ['reports', 'report'], ['companies', 'company'], ['batches', 'batch']]) {
            assert.equal(stem(a), stem(b), `${a} vs ${b}`)
        }
        assert.equal(stem('status'), 'status')
    })

    test('ticket words map to the right screen', () => {
        assert.equal(resolveScreen('They cannot export invoices to PDF')[0].path, '/invoices')
        assert.equal(resolveScreen('the invoice page hangs')[0].path, '/invoices')
        assert.equal(resolveScreen('revenue report shows zero for the quarter')[0].path, '/reports/revenue')
        assert.equal(resolveScreen('error on /settings when saving')[0].path, '/settings')
        assert.equal(resolveScreen('something is wrong').length, 0)
    })
})

describe('client names', () => {
    const bw = { id: 'brightwater', name: 'Brightwater Logistics' }
    test('full name, first word and id all match; unrelated text does not', () => {
        assert.equal(scoreClientName('Brightwater Logistics cannot export', bw), 1)
        assert.ok(scoreClientName('brightwater says export is stuck', bw) >= 0.7)
        assert.equal(scoreClientName('client id brightwater', bw), 0.95)
        assert.equal(scoreClientName('Nordlicht cannot export', bw), 0)
        // A generic word shared with a name is not enough on its own.
        assert.ok(scoreClientName('logistics team reports a problem', bw) < 0.7)
    })
    test('accents in names do not block a match', () => {
        assert.equal(scoreClientName('sofia marin from acme', { id: 'x', name: 'Sofía Marín' }), 1)
    })
})

describe('time windows', () => {
    test('this afternoon in the reporter timezone', () => {
        const w = parseTimeWindow('Ben saw it this afternoon', NOW, 'Europe/Berlin')
        // Berlin is UTC+1 on 31 Oct 2026 (after DST ends on 25 Oct).
        assert.equal(iso(w.from), '2026-10-31T11:00:00.000Z')
        assert.equal(iso(w.to), NOW.toISOString()) // capped at now
        assert.equal(w.precision, 'part-of-day')
    })
    test('a clock time is ±45 minutes', () => {
        const w = parseTimeWindow('on 2026-10-30 at 09:30', NOW, 'UTC')
        assert.equal(iso(w.from), '2026-10-30T08:45:00.000Z')
        assert.equal(iso(w.to), '2026-10-30T10:15:00.000Z')
    })
    test('3pm with no day, still ahead in the reporter timezone, means yesterday', () => {
        // 15:00 UTC is 11:00 in New York, so "3pm" there has not happened yet today.
        const w = parseTimeWindow('around 3pm', NOW, 'America/New_York')
        assert.equal(iso(w.from), '2026-10-30T18:15:00.000Z')
    })
    test('yesterday, weekdays, dates and relative times', () => {
        assert.equal(iso(parseTimeWindow('yesterday', NOW).from), '2026-10-30T00:00:00.000Z')
        assert.equal(iso(parseTimeWindow('on Monday', NOW).from), '2026-10-26T00:00:00.000Z')
        assert.equal(iso(parseTimeWindow('since 28 Oct', NOW).from), '2026-10-28T00:00:00.000Z')
        // A month/day after today belongs to last year.
        assert.equal(iso(parseTimeWindow('Dec 3', NOW).from), '2025-12-03T00:00:00.000Z')
        const ago = parseTimeWindow('about 2 hours ago', NOW)
        assert.ok(ago.from < new Date('2026-10-31T13:00:00Z') && ago.to > new Date('2026-10-31T13:00:00Z'))
    })
    test('ticket numbers are not clock times', () => {
        assert.equal(parseTimeWindow('see ticket 4312 for 12 invoices', NOW).precision, 'none')
    })
    test('no time falls back to a week, and widening ends with the week', () => {
        const w = parseTimeWindow('export broken', NOW)
        assert.equal(w.precision, 'none')
        const steps = widen(parseTimeWindow('this afternoon', NOW), NOW)
        assert.deepEqual(steps.map((s) => s.step.split(' (')[0]), ['the time in the ticket', 'the ticket time ± 12 hours', 'the last 7 days'])
    })
})

describe('ticket parsing', () => {
    test('structured fields win and the reporter email is not the client user', () => {
        const p = parseTicket(
            {
                key: 'SUP-1',
                kind: 'rci',
                summary: 'Export stuck',
                description: 'Raised by cs@acme.example for ben.okafor@brightwater.example. Invoices page.',
                reporter: { email: 'cs@acme.example', timeZone: 'Europe/London' },
                fields: { screen: 'revenue report' },
            },
            NOW
        )
        assert.deepEqual(p.emails, ['ben.okafor@brightwater.example'])
        assert.equal(p.screenPath, '/reports/revenue')
        assert.equal(p.sources.screen, 'field')
    })
})

describe('incidents', () => {
    test('element labels prefer text, then data-attr, then id', () => {
        assert.equal(elementLabel('button.btn:text="Export PDF"nth-child="2"attr__data-attr="x"'), '"Export PDF"')
        assert.equal(elementLabel('button.btn:attr__data-attr="invoice-export-pdf"attr__id="export-pdf"'), '[data-attr=invoice-export-pdf]')
        assert.equal(elementLabel('button:attr__id="export-pdf";div.toolbar'), '#export-pdf')
        assert.equal(elementLabel(''), undefined)
    })
    test('one incident per session, exception first, recorded sessions first', () => {
        const base = { client_id: 'c', client_name: 'C', user: 'u', pathname: '/invoices', app_version: '26.10.0' }
        const rec = { start: '', end: '', offset_s: 1, url: '' }
        const list: Incident[] = [
            { ...base, kind: 'rageclick', timestamp: '2026-10-31T10:00:05Z', session_id: 'a', recording: rec },
            { ...base, kind: 'exception', timestamp: '2026-10-31T10:00:01Z', session_id: 'a', recording: rec },
            { ...base, kind: 'exception', timestamp: '2026-10-31T12:00:00Z', session_id: 'b' },
        ]
        const best = bestPerSession(list)
        assert.deepEqual(best.map((i) => [i.session_id, i.kind]), [['a', 'exception'], ['b', 'exception']])
    })
})

describe('severity', () => {
    const quiet = { hasError: false, clientsAffected: 0, usersAffected: 0, occurrences: 0, clientsUsingScreen: 20, blocksTask: false, rising: false, enterpriseAffected: false, silent: false }
    test('a blocking regression across several enterprise clients is P1', () => {
        const s = suggestSeverity({ ...quiet, hasError: true, blocksTask: true, clientsAffected: 4, usersAffected: 8, occurrences: 73, versionSpecific: '26.10.0', rising: true, enterpriseAffected: true })
        assert.equal(s.priority, 'P1')
        assert.ok(s.reasons.some((r) => r.includes('26.10.0')))
    })
    test('one user, one error, nothing else is P4 or P3, never P1', () => {
        const s = suggestSeverity({ ...quiet, hasError: true, clientsAffected: 1, usersAffected: 1, occurrences: 1 })
        assert.ok(['P3', 'P4'].includes(s.priority))
    })
    test('a silent issue says so', () => {
        assert.ok(suggestSeverity({ ...quiet, silent: true, clientsAffected: 1 }).reasons[0].startsWith('No error'))
    })
    test('rising compares the last 3 days with the 3 before', () => {
        const d = (n: number[]) => n.map((occurrences, i) => ({ day: String(i), occurrences }))
        assert.equal(isRising(d([0, 0, 1, 1, 2, 5, 9])), true)
        assert.equal(isRising(d([5, 5, 5, 1, 1, 1])), false)
    })
    test('struggle score lists its signals', () => {
        const s = struggleScore({ rageclicks: 1, dead_clicks: 0, repeated_action: { event: 'revenue_report_loaded', count: 5 }, duration_s: 30 })
        assert.ok(s.score > 0)
        assert.deepEqual(s.signals, ['1 rage click', 'repeated "revenue_report_loaded" 5×'])
    })
})

describe('misc', () => {
    test('fillDays fills quiet days with zero', () => {
        const out = fillDays([{ day: '2026-10-30', occurrences: 4 }], 3, NOW)
        assert.deepEqual(out, [
            { day: '2026-10-29', occurrences: 0 },
            { day: '2026-10-30', occurrences: 4 },
            { day: '2026-10-31', occurrences: 0 },
        ])
    })
    test('clip links need a valid, unexpired signature', async () => {
        const { createHmac } = await import('node:crypto')
        const exp = String(Math.floor(NOW.getTime() / 1000) + 60)
        const sig = createHmac('sha256', 's3cret').update(`a.mp4.${exp}`).digest('base64url')
        assert.equal(verifyClipLink('a.mp4', exp, sig, 's3cret', NOW.getTime()), true)
        assert.equal(verifyClipLink('b.mp4', exp, sig, 's3cret', NOW.getTime()), false)
        assert.equal(verifyClipLink('a.mp4', exp, sig, 's3cret', NOW.getTime() + 120_000), false)
        assert.equal(verifyClipLink('a.mp4', exp, sig, '', NOW.getTime()), false)
        assert.equal(verifyClipLink('a.mp4', exp, 'x', 's3cret', NOW.getTime()), false)
    })
    test('tokens drop company suffixes', () => {
        assert.deepEqual(tokens('Verdant Foods BV'), ['verdant', 'food'])
    })
})

describe('moving finished files', () => {
    test('the file ends up at the target, the source is gone, no temporary file is left', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lens-move-'))
        const [from, to] = [join(dir, 'from.mp4'), join(dir, 'to.mp4')]
        writeFileSync(from, 'video')
        moveFile(from, to)
        assert.equal(readFileSync(to, 'utf8'), 'video')
        assert.deepEqual(readdirSync(dir), ['to.mp4'])
        rmSync(dir, { recursive: true })
    })
    test('a failed copy leaves the source in place', () => {
        const dir = mkdtempSync(join(tmpdir(), 'lens-move-'))
        const from = join(dir, 'from.mp4')
        writeFileSync(from, 'video')
        assert.throws(() => moveFile(from, join(dir, 'missing', 'to.mp4')))
        assert.equal(readFileSync(from, 'utf8'), 'video')
        rmSync(dir, { recursive: true })
    })
})
