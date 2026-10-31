// Turns "this afternoon", "yesterday around 3pm" or "30 Oct at 09:30" into a UTC window.
// Times are read in the reporter's timezone (Jira gives it on the reporter), falling back to UTC.

export interface TimeWindow {
    from: Date
    to: Date
    label: string // what was understood, for the report
    precision: 'exact' | 'part-of-day' | 'day' | 'range' | 'none'
}

const DAY = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const PARTS: Record<string, [number, number]> = {
    morning: [6, 12],
    afternoon: [12, 18],
    evening: [17, 23],
    night: [18, 24],
    lunchtime: [11, 14],
}

/** Offset of `tz` from UTC at `at`, in ms (positive east of UTC). */
function tzOffset(at: Date, tz: string): number {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        })
            .formatToParts(at)
            .map((p) => [p.type, p.value])
    )
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
    return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The UTC instant of a wall-clock time in `tz`. */
export function zoned(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
    const guess = new Date(Date.UTC(y, m, d, h, min))
    const first = new Date(guess.getTime() - tzOffset(guess, tz))
    // Second pass corrects for a DST change between the guess and the answer.
    return new Date(guess.getTime() - tzOffset(first, tz))
}

/** Calendar date (y, m, d) of `at` in `tz`. */
function localDate(at: Date, tz: string): { y: number; m: number; d: number; dow: number } {
    const local = new Date(at.getTime() + tzOffset(at, tz))
    return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), dow: local.getUTCDay() }
}

function validTz(tz?: string): string {
    if (!tz) return 'UTC'
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz })
        return tz
    } catch {
        return 'UTC'
    }
}

function parseClock(text: string): { h: number; min: number } | undefined {
    const m = /\b(?:at|around|about|approx\.?|~)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text)
    if (!m) return undefined
    const hasMarker = m[2] !== undefined || m[3] !== undefined
    if (!hasMarker) return undefined // a bare number is not a time
    let h = Number(m[1])
    const min = Number(m[2] || 0)
    const ampm = m[3]?.toLowerCase()
    if (ampm === 'pm' && h < 12) h += 12
    if (ampm === 'am' && h === 12) h = 0
    if (h > 23 || min > 59) return undefined
    return { h, min }
}

export function parseTimeWindow(text: string, now: Date = new Date(), tzIn?: string): TimeWindow {
    const tz = validTz(tzIn)
    const t = ` ${text.toLowerCase()} `
    const today = localDate(now, tz)
    const tzLabel = tz === 'UTC' ? 'UTC' : tz
    const dayStart = (y: number, m: number, d: number) => zoned(y, m, d, 0, 0, tz)
    const window = (from: Date, to: Date, label: string, precision: TimeWindow['precision']): TimeWindow => ({
        from,
        to: to > now ? now : to,
        label,
        precision,
    })

    // "N minutes/hours ago"
    let m = /\b(\d{1,3}|an?|one|two|three)\s+(minute|min|hour|hr)s?\s+ago\b/.exec(t)
    if (m) {
        const n = { a: 1, an: 1, one: 1, two: 2, three: 3 }[m[1]] ?? Number(m[1])
        const ms = m[2].startsWith('h') ? n * 3_600_000 : n * 60_000
        const at = now.getTime() - ms
        const slack = Math.max(15 * 60_000, ms * 0.25)
        return window(new Date(at - slack), new Date(at + slack), `about ${m[0].trim()}`, 'exact')
    }
    m = /\blast\s+(\d{1,2})\s+days?\b/.exec(t)
    if (m) return window(new Date(now.getTime() - Number(m[1]) * DAY), now, `last ${m[1]} days`, 'range')
    if (/\b(last|past|this)\s+week\b/.test(t)) return window(new Date(now.getTime() - 7 * DAY), now, 'the last 7 days', 'range')

    // Which day?
    let day: { y: number; m: number; d: number } | undefined
    let dayLabel = ''
    if (/\byesterday\b|\blast night\b/.test(t)) {
        const y = localDate(new Date(now.getTime() - DAY), tz)
        day = y
        dayLabel = 'yesterday'
    } else if (/\b(today|this (morning|afternoon|evening)|tonight|earlier|just now|right now)\b/.test(t)) {
        day = today
        dayLabel = 'today'
    }
    if (!day) {
        m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t)
        if (m) {
            day = { y: +m[1], m: +m[2] - 1, d: +m[3] }
            dayLabel = m[0]
        }
    }
    if (!day) {
        m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*\\b|\\b(${MONTHS.join('|')})[a-z]*\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(t)
        if (m) {
            const d = Number(m[1] || m[4])
            const mon = MONTHS.indexOf((m[2] || m[3]).slice(0, 3))
            // A date later than today means last year.
            const y = mon > today.m || (mon === today.m && d > today.d) ? today.y - 1 : today.y
            day = { y, m: mon, d }
            dayLabel = `${d} ${MONTHS[mon][0].toUpperCase()}${MONTHS[mon].slice(1)}`
        }
    }
    if (!day) {
        m = new RegExp(`\\b(?:on |last )?(${WEEKDAYS.join('|')})\\b`).exec(t)
        if (m) {
            const target = WEEKDAYS.indexOf(m[1])
            let back = (today.dow - target + 7) % 7
            if (back === 0 && /\blast\b/.test(m[0])) back = 7
            const dd = localDate(new Date(now.getTime() - back * DAY), tz)
            day = dd
            dayLabel = back === 0 ? 'today' : m[1][0].toUpperCase() + m[1].slice(1)
        }
    }

    const clock = parseClock(t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' '))
    if (clock) {
        const base = day || today
        let at = zoned(base.y, base.m, base.d, clock.h, clock.min, tz)
        // "at 3pm" with no day and 3pm still ahead of us means yesterday.
        if (!day && at > now) at = new Date(at.getTime() - DAY)
        const hh = String(clock.h).padStart(2, '0')
        const mm = String(clock.min).padStart(2, '0')
        const label = `${day ? dayLabel + ' ' : ''}around ${hh}:${mm} ${tzLabel}`
        return window(new Date(at.getTime() - 45 * 60_000), new Date(at.getTime() + 45 * 60_000), label, 'exact')
    }

    if (day) {
        const part = /\b(tonight|last night)\b/.test(t) ? 'night' : Object.keys(PARTS).find((p) => new RegExp(`\\b${p}\\b`).test(t))
        if (part) {
            const [h0, h1] = PARTS[part]
            const from = zoned(day.y, day.m, day.d, h0, 0, tz)
            const to = new Date(zoned(day.y, day.m, day.d, 0, 0, tz).getTime() + h1 * 3_600_000)
            return window(from, to, `${dayLabel} ${part} (${tzLabel})`, 'part-of-day')
        }
        const from = dayStart(day.y, day.m, day.d)
        return window(from, new Date(from.getTime() + DAY), `${dayLabel} (${tzLabel})`, 'day')
    }

    return window(new Date(now.getTime() - 7 * DAY), now, 'no time given; using the last 7 days', 'none')
}

/** Wider windows to try when the first one finds nothing. */
export function widen(w: TimeWindow, now: Date = new Date()): { window: TimeWindow; step: string }[] {
    const steps: { window: TimeWindow; step: string }[] = [{ window: w, step: `the time in the ticket (${w.label})` }]
    if (w.precision !== 'none' && w.precision !== 'range') {
        const from = new Date(w.from.getTime() - 12 * 3_600_000)
        const to = new Date(Math.min(now.getTime(), w.to.getTime() + 12 * 3_600_000))
        steps.push({ window: { from, to, label: `${w.label} ± 12 hours`, precision: 'range' }, step: 'the ticket time ± 12 hours' })
    }
    const week = { from: new Date(now.getTime() - 7 * DAY), to: now, label: 'the last 7 days', precision: 'range' as const }
    if (w.precision !== 'none') steps.push({ window: week, step: 'the last 7 days' })
    return steps
}
