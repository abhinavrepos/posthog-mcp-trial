import { ToolInputError } from './toolinputerror.ts'
export const PERIODS = ['today','yesterday','last_7_days','last_14_days','last_28_days','last_30_days','last_90_days','last_6_months','last_12_months','last_2_years','last_3_years','last_4_years','this_week','this_month','this_quarter','this_year','last_week','last_month','last_quarter','last_year','all_time'] as const
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
// Building an Intl.DateTimeFormat is slow; one per time zone is reused.
const formats = new Map<string, Intl.DateTimeFormat>()
function formatFor(tz: string): Intl.DateTimeFormat {
    let f = formats.get(tz)
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        if (formats.size > 500) formats.clear()
        formats.set(tz, f)
    }
    return f
}
function tzOffset(at: Date, tz: string): number {
    const parts = Object.fromEntries(
        formatFor(tz)
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
        formatFor(tz)
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

/** Validated UTC windows over live PostHog data. */
export function analyticalWindow(text: string, now = new Date()): TimeWindow | undefined {
    const value = text.trim().toLowerCase().replaceAll('_', ' ')
    const make = (from: Date, to: Date): TimeWindow => {
        const days = (+to - +from) / DAY
        if (!Number.isFinite(days) || days <= 0 || days > 1500) throw new ToolInputError('Choose an ordered window of at most 1500 days.')
        return { from, to, label: text, precision: 'range' }
    }
    const date = (s: string) => {
        const d = new Date(s)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(+d) || d.toISOString().slice(0,10) !== s) throw new ToolInputError('Dates must be valid YYYY-MM-DD UTC dates')
        return d
    }
    const today = new Date(Math.floor(+now / DAY) * DAY)
    if (value === 'today' || value === 'yesterday') {
        const from = new Date(+today - (value === 'yesterday' ? DAY : 0))
        return make(from, new Date(+from + DAY))
    }
    // Singular last units mean the previous full calendar unit, anchored to the literal UTC date.
    const calendar = /^last (week|month|quarter|year)$/.exec(value)
    if (calendar) {
        const unit = calendar[1], y = today.getUTCFullYear(), m = today.getUTCMonth()
        const to = unit === 'week' ? new Date(+today - ((today.getUTCDay()+6)%7)*DAY)
            : new Date(Date.UTC(y, unit === 'year' ? 0 : unit === 'quarter' ? Math.floor(m/3)*3 : m, 1))
        const from = new Date(to)
        if(unit === 'week') from.setUTCDate(from.getUTCDate()-7)
        else from.setUTCMonth(from.getUTCMonth() - (unit === 'year' ? 12 : unit === 'quarter' ? 3 : 1))
        return make(from,to)
    }
    let m = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/.exec(value)
    if (m) return make(date(m[1]), new Date(+date(m[2]) + DAY))
    if (/^\d{4}$/.test(value)) return make(new Date(Date.UTC(+value,0,1)), new Date(Date.UTC(+value+1,0,1)))
    m = /^q([1-4])\s+(\d{4})$/.exec(value)
    if (m) return make(new Date(Date.UTC(+m[2],(+m[1]-1)*3,1)),new Date(Date.UTC(+m[2],+m[1]*3,1)))
    m = /^([a-z]+)\s+(\d{4})$/.exec(value)
    if (m) {
        const month = ['january','february','march','april','may','june','july','august','september','october','november','december'].findIndex(v => v === m![1] || v.slice(0,3) === m![1])
        if (month >= 0) return make(new Date(Date.UTC(+m[2],month,1)),new Date(Date.UTC(+m[2],month+1,1)))
    }
    m = /^(?:last|past)\s+(?:(\d+|a|one)\s+)?(days?|weeks?|months?|years?|quarter)$/.exec(value)
    if (m) {
        const n = !m[1] || ['a','one'].includes(m[1]) ? 1 : +m[1]
        if (!Number.isSafeInteger(n) || n < 1 || n > 1500) throw new ToolInputError('Invalid relative window')
        const end = new Date(now)
        const start = new Date(end)
        if (/year/.test(m[2])) start.setUTCFullYear(start.getUTCFullYear()-n)
        else if (/month|quarter/.test(m[2])) {
            const originalDay = start.getUTCDate()
            start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth()-n*(m[2] === 'quarter' ? 3 : 1))
            const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth()+1, 0)).getUTCDate()
            start.setUTCDate(Math.min(originalDay,last))
        } else start.setUTCDate(start.getUTCDate()-n*(/week/.test(m[2]) ? 7 : 1))
        return make(start,end)
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return make(date(value),new Date(+date(value)+DAY))
    // Calendar-to-date and open-ended phrases PMs use ("this month", "year to date", "since March 2024",
    // "all time"). They end at the current time.
    const end = new Date(now)
    const startOf = (unit: 'week'|'month'|'quarter'|'year') => {
        const d = today
        if (unit === 'week') return new Date(+d - ((d.getUTCDay() + 6) % 7) * DAY)
        if (unit === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
        if (unit === 'quarter') return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth()/3)*3, 1))
        return new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
    }
    m = /^(?:this|current)\s+(week|month|quarter|year)$/.exec(value) || /^(week|month|quarter|year)\s+to\s+date$/.exec(value)
    if (m) return make(startOf(m[1] as 'week'), new Date(Math.max(+startOf(m[1] as 'week') + DAY, +end)))
    if (value === 'ytd') return make(startOf('year'), new Date(Math.max(+startOf('year')+DAY,+end)))
    if (value === 'mtd') return make(startOf('month'), new Date(Math.max(+startOf('month')+DAY,+end)))
    if (value === 'qtd') return make(startOf('quarter'), new Date(Math.max(+startOf('quarter')+DAY,+end)))
    if (/^(?:all(?:\s+(?:time|data|history))?|ever|since\s+(?:the\s+)?(?:beginning|start)(?:\s+of\s+(?:our\s+|the\s+)?data)?|everything)$/.test(value)) return make(new Date(+end - 1500 * DAY), end)
    m = /^since\s+(.+)$/.exec(value)
    if (m) {
        const from = analyticalWindow(m[1], now)?.from
        if (from) return make(from, end)
    }
    return undefined
}

export function parseTimeWindow(text: string, now: Date = new Date(), tzIn?: string): TimeWindow {
    const analytical = tzIn && /^(today|yesterday)$/i.test(text.trim()) ? undefined : analyticalWindow(text, now)
    if (analytical) return analytical
    const tz = validTz(tzIn)
    const t = ` ${text.toLowerCase()} `
    const today = localDate(now, tz)
    const tzLabel = tz === 'UTC' ? 'UTC' : tz
    const dayStart = (y: number, m: number, d: number) => zoned(y, m, d, 0, 0, tz)
    // Move calendar dates before converting to UTC: a local day can be 23 or 25 hours.
    const daysBack = (n: number) => {
        const d = new Date(Date.UTC(today.y, today.m, today.d - n))
        return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() }
    }
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
        day = daysBack(1)
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
            day = daysBack(back)
            dayLabel = back === 0 ? 'today' : m[1][0].toUpperCase() + m[1].slice(1)
        }
    }

    const clock = parseClock(t.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' '))
    if (clock) {
        const base = day || today
        let at = zoned(base.y, base.m, base.d, clock.h, clock.min, tz)
        // "at 3pm" with no day and 3pm still ahead of us means yesterday.
        if (!day && at > now) {
            const previous = daysBack(1)
            at = zoned(previous.y, previous.m, previous.d, clock.h, clock.min, tz)
        }
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
            const to = zoned(day.y, day.m, day.d, h1, 0, tz)
            return window(from, to, `${dayLabel} ${part} (${tzLabel})`, 'part-of-day')
        }
        const from = dayStart(day.y, day.m, day.d)
        return window(from, dayStart(day.y, day.m, day.d + 1), `${dayLabel} (${tzLabel})`, 'day')
    }

    if (text.trim()) throw new ToolInputError(`Invalid time window. Use period: ${PERIODS.join(', ')}; or from/to YYYY-MM-DD, e.g. 2024-11-01 to 2025-11-30.`)
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
