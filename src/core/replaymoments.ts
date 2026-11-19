// One replay as a step-by-step account of what the person did with the mouse and keyboard, for the
// Watchlist (core/watchlist.ts) and for Copilot (get_session_moments). replaysignals.ts counts friction
// per session; this keeps the order: each click is a step, with what led up to it (how long the pointer
// rested on the target, how often it left and came back, how direct the path was, pauses, fields
// visited, scrolling back and forth) and what followed (the page reacted or not, the server's answer,
// an error on screen).
//
// Structure only, like replaysignals.ts: element names come from the reviewed vocabulary, never from the
// page's own text; no coordinates, typed values, screen text or URLs leave this file. The pointer path
// is reduced to one rounded ratio per step, because exact paths can identify the person moving them.
import { gunzipSync } from 'node:zlib'

import { parseNetwork } from './replaynet.ts'
import { htmlTags, NAME_KEYS, nameToken, safeName, structuralNames } from './replaysignals.ts'

export const MOMENTS_VERSION = 2

/** What a step can show. Order is the order of importance. */
export const MARKS = ['error_loop', 'failed_submit', 'repeated_clicks', 'no_response', 'slow_response', 'field_back_and_forth', 'scroll_hunting', 'circling', 'hesitation', 'hover_no_click', 'long_pause'] as const
export type Mark = (typeof MARKS)[number]
/** How much each mark counts towards a session's place in the highlights. */
export const MARK_WEIGHT: Record<Mark, number> = { error_loop: 6, failed_submit: 5, repeated_clicks: 4, no_response: 3, slow_response: 3, field_back_and_forth: 2, scroll_hunting: 2, circling: 2, hesitation: 2, hover_no_click: 1, long_pause: 1 }
export const MARK_TEXT: Record<Mark, string> = {
    error_loop: 'Fixed, retried and failed again',
    failed_submit: 'Submit failed',
    repeated_clicks: 'Clicked again and again',
    no_response: 'Click did nothing',
    slow_response: 'Slow server answer',
    field_back_and_forth: 'Back and forth between fields',
    scroll_hunting: 'Scrolled up and down',
    circling: 'Pointer moved back and forth',
    hesitation: 'Took long to act',
    hover_no_click: 'Hovered but did not click',
    long_pause: 'Sat still before acting',
}

export interface Step {
    n: number
    at_ms: number // from the start of the recording
    from_ms: number // where the lead-up starts
    kind: 'click' | 'submit' | 'end'
    target: string // reviewed name ("button#save", "field:notional") or a generic one ("button", "field")
    clicks: number // >1 when the same target was clicked several times within a second
    lead: {
        ms: number // since the previous step
        dwell_ms: number | null // pointer resting on the target just before the click
        returns: number // the pointer came back to the target after leaving it
        path_efficiency: number | null // straight line / path travelled, 0.1 steps; null when the pointer barely moved
        pauses: number // stretches of 1.5 to 15 s with no input at all
        longest_pause_ms: number
        fields: string[] // fields visited, in order, repeats collapsed
        field_returns: number
        scroll_reversals: number
        pointer_turns: number // sharp changes of pointer direction
        hovered: { target: string; ms: number }[] // named targets the pointer rested on without clicking (>= 1.5 s)
    }
    after: {
        page: 'changed' | 'no change' | 'not checked' // within 1 s
        request_ms: number | null // slowest call the step started (within 2 s)
        status: '2xx' | '3xx' | '4xx' | '5xx' | 'failed' | null
        error_shown: boolean // an alert or error appeared before the next step (at most 5 s)
    }
    marks: Mark[]
}
export interface SessionMoments {
    version: typeof MOMENTS_VERSION
    duration_ms: number
    active_ms: number
    steps: Step[]
    pointer: { samples: number; coverage: 'good' | 'sparse' | 'none' }
}

interface NodeInfo { tag: string; attrs: Record<string, string>; parent?: number; alert: boolean; hidden: boolean; cls: boolean; vis: { h: boolean; a: boolean; s: boolean } }
const FIELD_TAGS = new Set(['input', 'select', 'textarea'])
const FIELD_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider', 'searchbox'])
const SUBMIT = /save|submit|run|confirm|apply|book|send|ok/i
const round = (ms: number, to = 100) => Math.round(ms / to) * to

/** Parses a recording (the JSONL PostHog stores: [windowId, event] lines) into steps. */
export function momentsFromReplay(jsonl: string, recordingDurationMs?: number, opts?: { names?: Iterable<string> }): SessionMoments {
    const known = new Map<string, string>([...structuralNames].map((n) => [n, n]))
    for (const value of opts?.names || []) { const token = nameToken(value); const clean = safeName(String(value).replace(/\s+/g, '-')); if (token && clean && token.length <= 40 && !known.has(token)) known.set(token, clean) }
    const windows = new Map<string, Map<number, NodeInfo>>()
    let nodes = new Map<number, NodeInfo>(), win = ''

    const unpack = (raw: any): any => {
        if (typeof raw !== 'string' || !raw.startsWith('\x1f\x8b')) return raw
        try { return JSON.parse(gunzipSync(Buffer.from(raw, 'latin1'), { maxOutputLength: Math.max(1, Number(process.env.REPLAY_MAX_MB) || 200) * 1024 * 1024 }).toString('utf8')) } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Recording too large by decompression policy')
            return undefined
        }
    }
    const attrsOf = (raw: any): Record<string, string> => { const r: Record<string, string> = {}; for (const k of NAME_KEYS) { const v = safeName(raw?.[k]); if (v) r[k] = v } return r }
    // An alert counts only while it can be seen: hidden, aria-hidden or display:none alerts are templates, not errors.
    const styleHidden = (style: unknown) => typeof style === 'string' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)
    const visOf = (raw: any) => ({ h: raw?.hidden != null, a: raw?.['aria-hidden'] === 'true', s: styleHidden(raw?.style) })
    const alertOf = (raw: any, attrs: Record<string, string>) => attrs.role === 'alert' || attrs.role === 'alertdialog' || (typeof raw?.class === 'string' && /error|alert|invalid/i.test(raw.class))
    let alerted = false
    const add = (root: any, parent: number | undefined) => {
        const stack = [{ node: root, parent }]
        while (stack.length) {
            const { node: n, parent: p } = stack.pop()!
            if (!n || typeof n.id !== 'number') continue
            if (n.type === 2) {
                const tag = typeof n.tagName === 'string' ? n.tagName.toLowerCase() : ''
                const attrs = attrsOf(n.attributes)
                const vis = visOf(n.attributes)
                const info: NodeInfo = { tag: htmlTags.has(tag) ? tag : 'element', attrs, parent: p, alert: alertOf(n.attributes, attrs), hidden: vis.h || vis.a || vis.s, cls: alertOf({ class: n.attributes?.class }, {}), vis }
                nodes.set(n.id, info)
                if (info.alert && !info.hidden && !hiddenAbove(p)) alerted = true
            }
            for (const c of n.childNodes || []) stack.push({ node: c, parent: n.type === 2 ? n.id : p })
        }
    }
    const hiddenAbove = (id: number | undefined) => { for (let d = 0; id !== undefined && d < 30; d++) { const n = nodes.get(id); if (!n) return false; if (n.hidden) return true; id = n.parent } return false }
    /** The element a person would say they pointed at: the nearest button, link or field above the node. */
    const actionable = (id: number): number | undefined => {
        let cur: number | undefined = id
        for (let depth = 0; cur !== undefined && depth <= 6; depth++) {
            const n = nodes.get(cur)
            if (!n) return undefined
            if (n.tag === 'button' || n.tag === 'a' || FIELD_TAGS.has(n.tag) || n.attrs.role === 'button' || n.attrs.role === 'link' || n.attrs.role === 'tab' || FIELD_ROLES.has(n.attrs.role || '') || n.attrs['data-action'] || n.attrs['data-field']) return cur
            cur = n.parent
        }
        return undefined
    }
    const isField = (id: number) => { const n = nodes.get(id); return !!n && (FIELD_TAGS.has(n.tag) || FIELD_ROLES.has(n.attrs.role || '') || !!n.attrs['data-field']) }
    const name = (id: number | undefined, field = false): string => {
        if (id === undefined) return field ? 'field' : 'element'
        const original = nodes.get(id)
        let n = original
        for (let depth = 0; n && depth <= 4; depth++, n = n.parent === undefined ? undefined : nodes.get(n.parent)) {
            for (const k of NAME_KEYS.slice(0, 6)) { const hit = n.attrs[k] ? known.get(nameToken(n.attrs[k])) : undefined; if (hit) return field ? `field:${hit}` : `${original?.tag || 'element'}#${hit}` }
        }
        if (field || isField(id)) return 'field'
        if (original?.tag === 'button' || original?.attrs.role === 'button') return 'button'
        if (original?.tag === 'a' || original?.attrs.role === 'link') return 'link'
        return 'element'
    }
    const named = (t: string) => t.includes('#') || t.startsWith('field:')

    // ---------------------------------------------------------------- read events in browser time order
    const events: { parsed: any; line: string; t: number }[] = []
    for (const line of jsonl.split('\n')) {
        try { const parsed = JSON.parse(line), ev = Array.isArray(parsed) ? parsed[1] : parsed; if (Number.isFinite(ev?.timestamp)) events.push({ parsed, line, t: ev.timestamp }) } catch { /* not an event */ }
    }
    events.sort((a, b) => a.t - b.t)
    const start = events[0]?.t
    const rel = (t: number) => Math.max(0, t - (start ?? t))

    // A full snapshot replaces a window's nodes and reuses ids, so every key carries the snapshot generation.
    interface Sample { t: number; x: number; y: number; key: string } // key: window/generation:actionable id, or '' over nothing actionable
    interface Click { t: number; first: number; window: string; id: number; key: string; target: string; submit: boolean; field: boolean; x?: number; y?: number; count: number }
    const samples: Sample[] = []
    const keyInfo = new Map<string, { target: string; field: boolean }>() // as the element was when the pointer was on it
    const clicks: Click[] = []
    const inputs: { t: number; field: string }[] = []
    const scrolls: { t: number; sign: number }[] = []
    const changes = new Map<string, number[]>() // window -> times the page visibly changed
    const alerts = new Map<string, number[]>() // window -> times an error became visible
    const requests: { start: number; ms: number; status?: number; window: string }[] = []
    const activity: number[] = []
    const scrollPos = new Map<string, { y: number; sign: number }>()
    const generation = new Map<string, number>()
    const seen = new Set<string>()
    const push = (m: Map<string, number[]>, w: string, t: number) => { const l = m.get(w); if (l) l.push(t); else m.set(w, [t]) }
    let end = start ?? 0

    for (const { parsed, line, t } of events) {
        const ev = Array.isArray(parsed) ? parsed[1] : parsed
        win = String(Array.isArray(parsed) ? parsed[0] : '')
        if (!windows.has(win)) windows.set(win, new Map())
        nodes = windows.get(win)!
        end = Math.max(end, t)
        const gen = () => `${win}/${generation.get(win) || 0}`
        if (ev.type === 2) { generation.set(win, (generation.get(win) || 0) + 1); nodes.clear(); alerted = false; add(unpack(ev.data)?.node, undefined); push(changes, win, t); if (alerted) push(alerts, win, t); continue }
        if (ev.type === 4) { push(changes, win, t); continue }
        if (ev.type === 6 && ev.data?.plugin === 'rrweb/network@1') { for (const r of parseNetwork(line, seen)) requests.push({ start: r.start, ms: r.ms, status: r.status, window: win }); continue }
        if (ev.type !== 3 || !ev.data) continue
        const d = ev.data
        if (d.source === 0) {
            for (const k of ['adds', 'attributes', 'removes', 'texts']) d[k] = unpack(d[k])
            // Something appeared or changed. A removal alone (a toast expiring by itself) is not an answer to a click.
            if (d.adds?.length || d.attributes?.length || d.texts?.length) push(changes, win, t)
            alerted = false
            for (const a of d.adds || []) add(a.node, a.parentId)
            for (const a of d.attributes || []) {
                const n = nodes.get(a.id); if (!n) continue
                const at = a.attributes || {}
                for (const k of NAME_KEYS) if (Object.hasOwn(at, k)) { delete n.attrs[k]; const v = safeName(at[k]); if (v) n.attrs[k] = v }
                const wasVisible = n.alert && !n.hidden && !hiddenAbove(n.parent)
                if (Object.hasOwn(at, 'class')) n.cls = alertOf({ class: at.class }, {})
                // Each of the three ways to hide changes on its own (null removes the attribute).
                if (Object.hasOwn(at, 'hidden')) n.vis.h = at.hidden != null
                if (Object.hasOwn(at, 'aria-hidden')) n.vis.a = at['aria-hidden'] === 'true'
                if (Object.hasOwn(at, 'style')) n.vis.s = styleHidden(at.style)
                n.hidden = n.vis.h || n.vis.a || n.vis.s
                n.alert = n.cls || n.attrs.role === 'alert' || n.attrs.role === 'alertdialog'
                if (n.alert && !n.hidden && !hiddenAbove(n.parent) && !wasVisible) alerted = true
            }
            // New text inside an alert that is already showing: the error was shown again.
            for (const x of d.texts || []) { let id: number | undefined = x.id; for (let k = 0; id !== undefined && k < 20; k++) { const n = nodes.get(id); if (!n) break; if (n.alert && !n.hidden && !hiddenAbove(n.parent)) { alerted = true; break } id = n.parent } }
            for (const r of d.removes || []) nodes.delete(r.id)
            if (alerted) push(alerts, win, t)
            continue
        }
        if (d.source === 1) {
            for (const p of d.positions || []) {
                if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
                const pt = t + (Number(p.timeOffset) || 0), a = typeof p.id === 'number' ? actionable(p.id) : undefined
                const key = a === undefined ? '' : `${gen()}:${a}`
                if (key) keyInfo.set(key, { target: name(a), field: isField(a!) })
                samples.push({ t: pt, x: p.x, y: p.y, key })
                activity.push(pt); end = Math.max(end, pt)
            }
            continue
        }
        if (d.source === 3 && Number.isFinite(d.y)) {
            const k = `${win}:${d.id}`, prev = scrollPos.get(k), sign = prev ? Math.sign(d.y - prev.y) : 0
            if (prev && sign && prev.sign && sign !== prev.sign) scrolls.push({ t, sign })
            scrollPos.set(k, { y: d.y, sign: sign || prev?.sign || 0 })
            activity.push(t)
            continue
        }
        if (d.source === 5) { if (typeof d.id === 'number') inputs.push({ t, field: name(d.id, true) }); activity.push(t); continue }
        if (d.source === 2 && typeof d.id === 'number') {
            activity.push(t)
            if (d.type === 5 && isField(d.id)) inputs.push({ t, field: name(d.id, true) })
            if (d.type !== 2) continue
            const a = actionable(d.id) ?? d.id, key = `${gen()}:${a}`, field = isField(a) || nodes.get(a)?.tag === 'label', target = name(a, isField(a)), n = nodes.get(a)
            const last = clicks[clicks.length - 1]
            if (last && last.key === key && t - last.t <= 1000) { last.count++; last.t = t; continue }
            clicks.push({ t, first: t, window: win, id: a, key, target, field, submit: n?.attrs.type === 'submit' || SUBMIT.test(target.split('#')[1] || ''), x: Number.isFinite(d.x) ? d.x : undefined, y: Number.isFinite(d.y) ? d.y : undefined, count: 1 })
        }
    }
    if (start !== undefined && Number.isFinite(recordingDurationMs) && recordingDurationMs! >= 0) end = Math.max(end, start + recordingDurationMs!)

    // ---------------------------------------------------------------- build the steps
    // Everything is sorted once; each step reads its own slice by binary search, so long recordings stay linear-ish.
    const byT = (a: { t: number }, b: { t: number }) => a.t - b.t
    samples.sort(byT); inputs.sort(byT); scrolls.sort(byT); activity.sort((a, b) => a - b); requests.sort((a, b) => a.start - b.start)
    for (const l of [...changes.values(), ...alerts.values()]) l.sort((a, b) => a - b)
    /** First index whose value is > t (strictly after). */
    const after = <T>(list: T[], t: number, of: (x: T) => number) => { let lo = 0, hi = list.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (of(list[mid]) <= t) lo = mid + 1; else hi = mid } return lo }
    const slice = <T>(list: T[], a: number, b: number, of: (x: T) => number) => list.slice(after(list, a, of), after(list, b, of)) // (a, b]
    const tOf = (x: { t: number }) => x.t, num = (x: number) => x
    const anyIn = (list: number[] | undefined, a: number, b: number) => !!list && after(list, a, num) < after(list, b, num) // something in (a, b]

    let idle = 0
    for (let i = 1; i < activity.length; i++) if (activity[i] - activity[i - 1] > 15_000) idle += activity[i] - activity[i - 1]
    if (activity.length && end - activity[activity.length - 1] > 15_000) idle += end - activity[activity.length - 1]

    const steps: Step[] = []
    let prevT = start ?? 0
    const failedOn = new Map<string, boolean>() // target -> its last submit failed
    const ends = [...clicks.map((c) => ({ c, t: c.t })), ...(start !== undefined && end - (clicks[clicks.length - 1]?.t ?? start) >= 2000 ? [{ c: undefined, t: end }] : [])]
    for (const [i, { c, t }] of ends.entries()) {
        // The lead-up ends at the first click of a burst; the step itself is placed at the last one.
        const from = prevT, leadEnd = c ? c.first : t, lead = slice(samples, from, leadEnd, tOf)
        // Time on each actionable target: a sample owns the time until the next one (or the click), at most 15 s.
        const dwell = new Map<string, number>()
        let restOnTarget = 0, returns = 0, entered = false, prevOn = false
        for (let k = 0; k < lead.length; k++) {
            const s = lead[k], next = k + 1 < lead.length ? lead[k + 1].t : leadEnd, span = Math.min(15_000, Math.max(0, next - s.t))
            if (s.key) dwell.set(s.key, (dwell.get(s.key) || 0) + span)
            if (c) {
                const on = s.key === c.key
                if (on && !prevOn) { if (entered) returns++; entered = true } // each new arrival after the first
                prevOn = on
            }
        }
        if (c) for (let k = lead.length - 1; k >= 0 && lead[k].key === c.key; k--) restOnTarget += Math.min(15_000, Math.max(0, (k + 1 < lead.length ? lead[k + 1].t : leadEnd) - lead[k].t))
        let path = 0, turns = 0, circling = false, vector: { x: number; y: number } | undefined
        const burst: number[] = []
        for (let k = 1; k < lead.length; k++) {
            const v = { x: lead[k].x - lead[k - 1].x, y: lead[k].y - lead[k - 1].y }
            path += Math.hypot(v.x, v.y)
            // Same rule as replaysignals.ts: a reversal on either axis of at least 2 px; 8 within 3 s is circling.
            if (vector && ((Math.abs(v.x) >= 2 && Math.abs(vector.x) >= 2 && v.x * vector.x < 0) || (Math.abs(v.y) >= 2 && Math.abs(vector.y) >= 2 && v.y * vector.y < 0))) {
                turns++
                while (burst.length && lead[k].t - burst[0] > 3000) burst.shift()
                burst.push(lead[k].t)
                if (burst.length >= 8) circling = true
            }
            if (v.x || v.y) vector = v
        }
        const first = lead[0], endPt = c && c.x !== undefined && c.y !== undefined ? { x: c.x, y: c.y } : lead[lead.length - 1]
        if (first && endPt && c?.x !== undefined) path += Math.hypot(endPt.x - (lead[lead.length - 1]?.x ?? endPt.x), endPt.y - (lead[lead.length - 1]?.y ?? endPt.y))
        const efficiency = first && endPt && path >= 120 ? Math.round(Math.min(1, Math.hypot(endPt.x - first.x, endPt.y - first.y) / path) * 10) / 10 : null
        // Pauses: gaps between inputs, counting from the previous step itself (a still pointer sends nothing).
        const acts = [from, ...slice(activity, from, leadEnd, num)]
        let pauses = 0, longest = 0
        for (let k = 1; k < acts.length; k++) { const g = acts[k] - acts[k - 1]; if (g >= 1500 && g <= 15_000) { pauses++; longest = Math.max(longest, g) } }
        if (c) { const g = leadEnd - acts[acts.length - 1]; if (g >= 1500 && g <= 15_000) { pauses++; longest = Math.max(longest, g) } }
        const visited: string[] = []
        for (const x of slice(inputs, from, leadEnd, tOf)) if (visited[visited.length - 1] !== x.field) visited.push(x.field)
        const fieldReturns = visited.length - new Set(visited).size
        const reversals = slice(scrolls, from, leadEnd, tOf)
        let hunting = false
        for (let k = 3; k < reversals.length; k++) if (reversals[k].t - reversals[k - 3].t <= 10_000) hunting = true
        const previous = i > 0 ? ends[i - 1].c?.key : undefined
        const hovered = [...dwell].filter(([key, ms]) => ms >= 1500 && key !== c?.key && key !== previous && !keyInfo.get(key)?.field)
            .map(([key, ms]) => ({ target: keyInfo.get(key)?.target || 'element', ms: round(ms) }))
            .filter((h) => named(h.target)).sort((a, b) => b.ms - a.ms).slice(0, 3)

        // What followed: page changes, calls and errors in the same window only.
        const next = ends[i + 1]?.c?.first ?? ends[i + 1]?.t ?? end
        let page: Step['after']['page'] = 'not checked', requestMs: number | null = null, status: Step['after']['status'] = null, errorShown = false
        if (c) {
            if (!c.field && end - c.first >= 1000) page = anyIn(changes.get(c.window), c.first, c.first + 1000) ? 'changed' : 'no change'
            const lo = after(requests, c.first - 51, (r) => r.start), hi = after(requests, c.t + 2000, (r) => r.start)
            const calls = requests.slice(lo, hi).filter((r) => r.window === c.window)
            if (calls.length) {
                const slow = calls.reduce((a, b) => (b.ms > a.ms ? b : a))
                requestMs = round(slow.ms)
                const worst = Math.max(...calls.map((r) => r.status ?? 0))
                status = calls.some((r) => r.status === undefined && r.ms === 0) && !worst ? 'failed' : worst >= 500 ? '5xx' : worst >= 400 ? '4xx' : worst >= 300 ? '3xx' : worst >= 200 ? '2xx' : null
            }
            errorShown = anyIn(alerts.get(c.window), c.first, Math.min(next, c.first + 5000))
        }
        const marks: Mark[] = []
        const failed = !!c?.submit && (errorShown || status === '4xx' || status === '5xx' || status === 'failed')
        if (c && failed && failedOn.get(c.target) && visited.length) marks.push('error_loop')
        else if (failed) marks.push('failed_submit')
        if (c) failedOn.set(c.target, failed)
        if (c && c.count >= 3) marks.push('repeated_clicks')
        if (c && page === 'no change' && requestMs === null) marks.push('no_response')
        if (requestMs !== null && requestMs >= 5000) marks.push('slow_response')
        if (fieldReturns >= 2) marks.push('field_back_and_forth')
        if (hunting) marks.push('scroll_hunting')
        if (hovered.some((h) => h.ms >= 2000)) marks.push('hover_no_click')
        if (circling) marks.push('circling')
        // Same rule as replaysignals.ts: at least 8 s since the last action, with the pointer moving meanwhile.
        const moved = lead.length >= 2 && path >= 20
        if (c && leadEnd - from >= 8000 && moved) marks.push('hesitation')
        if (c && longest >= 8000) marks.push('long_pause')
        steps.push({
            n: i + 1, at_ms: round(rel(c ? c.first : t)), from_ms: round(rel(from)), kind: c ? (c.submit ? 'submit' : 'click') : 'end', target: c ? c.target : 'end of recording', clicks: c?.count ?? 0,
            lead: { ms: round(leadEnd - from), dwell_ms: c && restOnTarget > 0 ? round(restOnTarget) : null, returns, path_efficiency: efficiency, pauses, longest_pause_ms: round(longest), fields: visited.slice(0, 12), field_returns: fieldReturns, scroll_reversals: reversals.length, pointer_turns: turns, hovered },
            after: { page, request_ms: requestMs, status, error_shown: errorShown },
            marks: MARKS.filter((m) => marks.includes(m)),
        })
        prevT = t
    }
    const duration = Math.max(0, end - (start ?? end))
    return { version: MOMENTS_VERSION, duration_ms: duration, active_ms: Math.max(0, duration - idle), steps, pointer: { samples: samples.length, coverage: !samples.length ? 'none' : samples.length / Math.max(1, duration / 60_000) < 20 ? 'sparse' : 'good' } }
}

/** One line a person can read: "Save: rested 2.1 s, came back twice · server 6.2 s, 5xx · error shown". */
export function stepLine(s: Step, human: (t: string) => string = (t) => t): string {
    const parts: string[] = []
    const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
    if (s.lead.dwell_ms !== null && s.lead.dwell_ms >= 500) parts.push(`rested on it ${sec(s.lead.dwell_ms)}`)
    if (s.lead.returns) parts.push(`came back to it ${s.lead.returns === 1 ? 'once' : `${s.lead.returns} times`}`)
    if (s.lead.longest_pause_ms >= 8000) parts.push(`paused ${sec(s.lead.longest_pause_ms)}`)
    if (s.lead.field_returns >= 2) parts.push(`went back to fields ${s.lead.field_returns} times`)
    if (s.marks.includes('hesitation')) parts.push(`took ${sec(s.lead.ms)} to click`)
    if (s.marks.includes('circling')) parts.push('pointer moved back and forth')
    if (s.lead.scroll_reversals >= 4) parts.push(`scrolled back and forth ${s.lead.scroll_reversals} times`)
    for (const h of s.lead.hovered.slice(0, 1)) if (h.ms >= 2000) parts.push(`hovered ${human(h.target)} ${sec(h.ms)} without clicking`)
    if (s.clicks >= 3) parts.push(`clicked ${s.clicks} times`)
    if (s.after.request_ms !== null) parts.push(`server ${sec(s.after.request_ms)}${s.after.status && s.after.status !== '2xx' ? `, ${s.after.status}` : ''}`)
    else if (s.after.page === 'no change') parts.push('nothing happened')
    if (s.after.error_shown) parts.push('error shown')
    const line = `${s.kind === 'end' ? 'Before leaving' : human(s.target)}${parts.length ? ': ' + parts.join(' · ') : ''}`
    return line.charAt(0).toUpperCase() + line.slice(1)
}
