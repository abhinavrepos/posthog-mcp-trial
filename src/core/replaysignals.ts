import { gunzipSync } from 'node:zlib'

import { parseNetwork, pathTemplate } from './replaynet.ts'

export interface SessionSignals {
    version: 1
    duration_ms: number; active_ms: number; idle_ms: number
    clicks: number
    rage_clicks: { target: string; count: number; at_ms: number }[]
    dead_clicks: { target: string; at_ms: number }[]
    errors_shown: { target?: string; at_ms: number }[]
    error_loops: { field?: string; count: number }[]
    fields: { field: string; edits: number; focus_count: number; ms: number }[]
    hesitations: { before: string; ms: number; at_ms: number }[]
    cursor: { px_per_min: number; direction_changes_per_min: number; circling_bursts: number }
    scroll: { px: number; reversals: number; hunting_bursts: number }
    network_errors: number; slow_calls: number; console_errors: number
}

/** Keep short structural identifiers; free-form multiword labels are conservatively dropped. */
export function safeName(s: unknown): string | undefined {
    if (typeof s !== 'string' || !s.trim() || s.length > 40 || /\s/.test(s.trim()) || /\d{3}|\p{Sc}|USD|EUR|GBP|CAD|CHF|JPY|@|\d[.,]\d/iu.test(s)) return undefined
    return s.trim()
}
const keys = ['data-field', 'data-action', 'name', 'id', 'aria-label', 'role', 'type', 'data-testid', 'data-dialog'] as const
interface NodeInfo { tag: string; attrs: Record<string, string>; parent?: number; error: boolean; hidden: boolean; errorClass: boolean }

/** One pass over JSONL; only sanitized structure survives each line. */
export function signalsFromReplay(jsonl: string, recordingDurationMs?: number): SessionSignals {
    const out: SessionSignals = { version: 1, duration_ms: 0, active_ms: 0, idle_ms: 0, clicks: 0, rage_clicks: [], dead_clicks: [], errors_shown: [], error_loops: [], fields: [], hesitations: [], cursor: { px_per_min: 0, direction_changes_per_min: 0, circling_bursts: 0 }, scroll: { px: 0, reversals: 0, hunting_bursts: 0 }, network_errors: 0, slow_calls: 0, console_errors: 0 }
    // Window-local node ids must never resolve against another window's DOM.
    const textWindows = new Map<string, Map<number, number>>()
    let textParents = new Map<number, number>()
    const windows = new Map<string, Map<number, NodeInfo>>()
    const visibility = new WeakMap<NodeInfo, { hidden: boolean; aria: boolean; style: boolean }>()
    const fields = new Map<string, SessionSignals['fields'][number]>()
    let nodes = new Map<number, NodeInfo>()
    let start: number | undefined, end = 0, lastActivity: number | undefined, lastAction: number | undefined, moving = false
    let hasActivity = false
    let focus: { field: string; at: number } | undefined
    const pending: { target: string; time: number }[] = []
    const effects: number[] = []
    const rages = new Map<string, { times: number[]; result?: SessionSignals['rage_clicks'][number] }>()
    let submit = false, failed = false, edited: string | undefined
    const loops = new Map<string, number>()
    let point: { x: number; y: number } | undefined, vector: { x: number; y: number } | undefined, distance = 0, turns = 0, circle: number[] = []
    const scrolls = new Map<string, { x: number; y: number; sign: number }>()
    let reversals: number[] = []
    const networkSeen = new Set<string>()
    const relative = (t: number) => Math.max(0, t - (start ?? t))
    const name = (id: number, field = false): string => {
        const original = nodes.get(id)
        let n = original
        for (let depth = 0; n && depth <= 4; depth++, n = n.parent === undefined ? undefined : nodes.get(n.parent)) {
            for (const k of keys.slice(0, 6)) if (n.attrs[k]) return field ? `field:${n.attrs[k]}` : `${original?.tag || 'element'}#${n.attrs[k]}`
        }
        return field ? 'field' : original?.tag || 'element'
    }
    const fieldFor = (id: number) => {
        const field = name(id, true)
        let f = fields.get(field)
        if (!f) { f = { field, edits: 0, focus_count: 0, ms: 0 }; fields.set(field, f) }
        return f
    }
    const blur = (t: number) => { if (focus) { fields.get(focus.field)!.ms += Math.max(0, t - focus.at); focus = undefined } }
    const effect = (t: number) => { effects.push(t) }
    const appeared = (id: number, t: number) => {
        out.errors_shown.push({ target: name(id), at_ms: relative(t) })
        if (submit) { failed = true; submit = false }
    }
    const attrs = (raw: any): Record<string, string> => {
        const result: Record<string, string> = {}
        for (const k of keys) { const v = safeName(raw?.[k]); if (v) result[k] = v }
        return result
    }
    // Success toasts are effects, but their class alone is not evidence of an error.
    const errorClass = (raw: any) => typeof raw?.class === 'string' && /error|alert|invalid/i.test(raw.class)
    const hidden = (raw: any) => raw?.hidden != null || raw?.['aria-hidden'] === 'true' || (typeof raw?.style === 'string' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(raw.style))
    const isError = (role: unknown, cls: boolean) => role === 'alert' || role === 'alertdialog' || cls
    // Decode transport containers only; detectors never access text or non-allowlisted values.
    const unpack = (raw: any): any => {
        if (typeof raw !== 'string' || !raw.startsWith('\x1f\x8b')) return raw
        try { return JSON.parse(gunzipSync(Buffer.from(raw, 'latin1')).toString('utf8')) } catch { return undefined }
    }
    const add = (root: any, parent: number | undefined, t: number) => {
        const stack = [{ node: root, parent }]
        while (stack.length) {
            const item = stack.pop()!, n = item.node
            if (!n || typeof n.id !== 'number') continue
            // Retain text-node parent IDs only, never their content.
            if (n.type === 3 && item.parent !== undefined) textParents.set(n.id, item.parent)
            if (n.type === 2) {
                const info = { tag: safeName(n.tagName)?.toLowerCase() || 'element', attrs: attrs(n.attributes), parent: item.parent, error: isError(n.attributes?.role, errorClass(n.attributes)), hidden: hidden(n.attributes), errorClass: errorClass(n.attributes) }
                nodes.set(n.id, info)
                visibility.set(info, { hidden: n.attributes?.hidden != null, aria: n.attributes?.['aria-hidden'] === 'true', style: hidden({ style: n.attributes?.style }) })
                if (info.error && !info.hidden) appeared(n.id, t)
            }
            for (const child of n.childNodes || []) stack.push({ node: child, parent: n.type === 2 ? n.id : item.parent })
        }
    }
    const activity = (t: number) => { if (lastActivity !== undefined && t - lastActivity > 15000) out.idle_ms += t - lastActivity; lastActivity = Math.max(lastActivity ?? t, t); hasActivity = true }
    for (let offset = 0; offset < jsonl.length;) {
        let stop = jsonl.indexOf('\n', offset); if (stop < 0) stop = jsonl.length
        const line = jsonl.slice(offset, stop); offset = stop + 1
        let parsed: any
        try { parsed = JSON.parse(line) } catch { continue }
        const ev = Array.isArray(parsed) ? parsed[1] : parsed
        if (!ev || !Number.isFinite(ev.timestamp)) continue
        const t = ev.timestamp as number, d = ev.type === 2 ? unpack(ev.data) : ev.data
        if (ev.type === 3 && d?.source === 0) {
            for (const k of ['adds', 'attributes', 'removes', 'texts']) d[k] = unpack(d[k])
        }
        if (start === undefined) { start = t; lastActivity = t; lastAction = t }
        end = Math.max(end, t)
        // Explicit DOMContentLoaded/load events establish a page-load prefix.
        // Without that evidence, a long initial gap remains observable idle.
        if ((ev.type === 0 || ev.type === 1) && !hasActivity) lastActivity = undefined
        const window = String(Array.isArray(parsed) ? parsed[0] : '')
        if (!windows.has(window)) windows.set(window, new Map())
        nodes = windows.get(window)!
        if (!textWindows.has(window)) textWindows.set(window, new Map())
        textParents = textWindows.get(window)!
        if (ev.type === 2) { nodes.clear(); textParents.clear(); effect(t); add(d?.node, undefined, t) }
        if (ev.type === 4) { if (typeof d?.href === 'string') pathTemplate(d.href); effect(t) }
        if (ev.type === 6 && d?.plugin === 'rrweb/console@1' && d.payload?.level === 'error') out.console_errors++
        if (ev.type === 6 && d?.plugin === 'rrweb/network@1') {
            for (const r of parseNetwork(line)) {
                const k = `${r.method} ${r.path} ${Math.round(r.start / 50)}`
                if (networkSeen.has(k)) continue
                networkSeen.add(k)
                if ((r.status ?? 0) >= 400) out.network_errors++
                if (r.ms >= 5000) out.slow_calls++
                effect(r.start)
            }
        }
        if (ev.type !== 3 || !d) continue
        if (d.source === 0) {
            effect(t)
            for (const a of d.adds || []) add(a.node, a.parentId, t)
            for (const a of d.attributes || []) {
                const n = nodes.get(a.id); if (!n) continue
                for (const k of keys) if (Object.hasOwn(a.attributes || {}, k)) { delete n.attrs[k]; const v = safeName(a.attributes[k]); if (v) n.attrs[k] = v }
                const wasVisible = n.error && !n.hidden
                if (Object.hasOwn(a.attributes || {}, 'class')) n.errorClass = errorClass(a.attributes)
                n.error = isError(n.attrs.role, n.errorClass)
                for (const k of ['hidden', 'aria-hidden', 'style']) if (Object.hasOwn(a.attributes || {}, k)) {
                    // Store only visibility booleans, never raw styles.
                    const flags = visibility.get(n) || { hidden: n.hidden, aria: false, style: false }
                    if (k === 'hidden') flags.hidden = a.attributes[k] != null
                    if (k === 'aria-hidden') flags.aria = a.attributes[k] === 'true'
                    if (k === 'style') flags.style = hidden({ style: a.attributes[k] })
                    visibility.set(n, flags)
                    n.hidden = flags.hidden || flags.aria || flags.style
                }
                if (n.error && !n.hidden && (!wasVisible || submit)) appeared(a.id, t)
            }
            // Re-rendering an already visible alert after a submission also counts.
            // Read mutation IDs only, with at most one error per submission.
            if (submit) for (const change of d.texts || []) {
                let id = textParents.get(change.id)
                for (let depth = 0; id !== undefined && depth < 20; depth++) {
                    const n = nodes.get(id)
                    if (n?.error && !n.hidden) { appeared(id, t); break }
                    id = n?.parent
                }
                if (!submit) break
            }
            for (const r of d.removes || []) {
                const removed = new Set<number>([r.id])
                let changed = true
                while (changed) { changed = false; for (const [id, n] of nodes) if (n.parent !== undefined && removed.has(n.parent) && !removed.has(id)) { removed.add(id); changed = true } }
                for (const id of removed) nodes.delete(id)
            }
        }
        if ([2, 3, 5].includes(d.source)) activity(t)
        if (d.source === 1) for (const p of d.positions || []) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
            const pt = t + (Number(p.timeOffset) || 0)
            end = Math.max(end, pt)
            activity(pt)
            if (point) {
                const v = { x: p.x - point.x, y: p.y - point.y }
                distance += Math.hypot(v.x, v.y)
                if (vector && (Math.abs(v.x) >= 2 && Math.abs(vector.x) >= 2 && v.x * vector.x < 0 || Math.abs(v.y) >= 2 && Math.abs(vector.y) >= 2 && v.y * vector.y < 0)) {
                    turns++; circle = circle.filter(x => pt - x <= 3000); circle.push(pt)
                    if (circle.length >= 8) { out.cursor.circling_bursts++; circle = [] }
                }
                if (v.x || v.y) vector = v
            }
            point = { x: p.x, y: p.y }; moving = true
        }
        if (d.source === 3 && Number.isFinite(d.y)) {
            const k = `${window}:${d.id}`, prev = scrolls.get(k), delta = prev ? d.y - prev.y : 0, sign = Math.sign(delta)
            out.scroll.px += Math.abs(delta) + (prev && Number.isFinite(d.x) ? Math.abs(d.x - prev.x) : 0)
            if (prev && sign && prev.sign && sign !== prev.sign) {
                out.scroll.reversals++; reversals = reversals.filter(x => t - x <= 10000); reversals.push(t)
                if (reversals.length >= 4) { out.scroll.hunting_bursts++; reversals = [] }
            }
            scrolls.set(k, { x: Number.isFinite(d.x) ? d.x : 0, y: d.y, sign: sign || prev?.sign || 0 })
        }
        if (d.source === 5) { const f = fieldFor(d.id); f.edits++; if (failed) edited = f.field; lastAction = t; moving = false }
        if (d.source === 2) {
            if (d.type === 5) { blur(t); const f = fieldFor(d.id); f.focus_count++; focus = { field: f.field, at: t } }
            if (d.type === 6) blur(t)
            if (d.type !== 2) continue
            const target = name(d.id), n = nodes.get(d.id)
            out.clicks++
            if (moving && lastAction !== undefined && t - lastAction >= 8000) out.hesitations.push({ before: target, ms: t - lastAction, at_ms: relative(t) })
            lastAction = t; moving = false; circle = []; vector = undefined
            const rageKey = `${window}:${d.id}`
            let rage = rages.get(rageKey)
            if (!rage) { rage = { times: [] }; rages.set(rageKey, rage) }
            rage.times = rage.times.filter(time => t - time <= 1000)
            if (rage.times.length < 2) rage.result = undefined
            rage.times.push(t)
            if (rage.times.length >= 3) {
                if (!rage.result) { rage.result = { target, count: rage.times.length, at_ms: relative(rage.times[0]) }; out.rage_clicks.push(rage.result) }
                else rage.result.count = rage.times.length
            }
            if (!['input', 'label', 'textarea', 'select'].includes(n?.tag || '')) pending.push({ target, time: t })
            if (n?.attrs.type === 'submit' || /save|submit|run|confirm|apply/i.test(target)) {
                if (failed && edited) loops.set(edited, (loops.get(edited) || 0) + 1)
                submit = true; failed = false; edited = undefined
            }
        }
    }
    // A quiet recording may have no final rrweb event. Callers with session metadata
    // can supply its observed duration; never invent time beyond the recording.
    if (start !== undefined && Number.isFinite(recordingDurationMs) && recordingDurationMs! >= 0) end = Math.max(end, start + recordingDurationMs!)
    blur(end)
    if (lastActivity !== undefined && end - lastActivity > 15000) out.idle_ms += end - lastActivity
    out.duration_ms = Math.max(0, end - (start ?? end)); out.active_ms = Math.max(0, out.duration_ms - out.idle_ms)
    effects.sort((a, b) => a - b)
    for (const c of pending) {
        let lo = 0, hi = effects.length
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (effects[mid] < c.time) lo = mid + 1; else hi = mid }
        if (end - c.time >= 1000 && (effects[lo] === undefined || effects[lo] - c.time > 1000)) out.dead_clicks.push({ target: c.target, at_ms: relative(c.time) })
    }
    out.fields = [...fields.values()]
    out.error_loops = [...loops].filter(([, count]) => count >= 2).map(([field, count]) => ({ field, count }))
    const minutes = out.duration_ms / 60000
    out.cursor.px_per_min = minutes ? distance / minutes : 0
    out.cursor.direction_changes_per_min = minutes ? turns / minutes : 0
    return out
}
