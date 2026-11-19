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
    network_errors: number; slow_calls: number; console_errors: number // slow_calls excludes failures so their sum counts calls once.
}

/** Keep short structural identifiers; free-form multiword labels are conservatively dropped. */
export function safeName(s: unknown): string | undefined {
    if (typeof s !== 'string') return undefined
    const normalized = s.normalize('NFKC').replace(/\p{Cf}/gu, '')
    if (!normalized.trim() || normalized.length > 40 || /\s/.test(normalized.trim()) || /\p{Nd}{3}|\p{Sc}|USD|EUR|GBP|CAD|CHF|JPY|@|\p{Nd}[.,]\p{Nd}/iu.test(normalized)) return undefined
    return normalized.trim()
}
export const nameToken = (s: string) => s.normalize('NFKC').replace(/\p{Cf}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '')
export const structuralNames = new Set('save submit ok cancel close apply preview search run delete add edit next back refresh export banner alert error toast menu grid row dialog tab modal'.split(' '))
export const htmlTags = new Set('a button input select textarea label div span form table tr td th ul li ol section article header footer nav main aside p h1 h2 h3 h4 h5 h6 img svg dialog details summary option fieldset legend iframe canvas video audio body html head'.split(' '))
export const NAME_KEYS = ['data-field', 'data-action', 'name', 'id', 'aria-label', 'role', 'type', 'data-testid', 'data-dialog'] as const
interface NodeInfo { tag: string; attrs: Record<string, string>; parent?: number; error: boolean; hidden: boolean; errorClass: boolean }

/** Process in browser time order; only sanitized structure survives extraction. */
export function signalsFromReplay(jsonl: string, recordingDurationMs?: number, opts?: { names?: Iterable<string> }): SessionSignals {
    // token -> the name as written in the reviewed list; output uses that, never the page's own spelling.
    const knownNames = new Map<string, string>([...structuralNames].map((n) => [n, n]))
    for (const value of opts?.names || []) { const token = nameToken(value); const clean = safeName(String(value).replace(/\s+/g, '-')); if (token && clean && token.length <= 40 && !knownNames.has(token)) knownNames.set(token, clean) }
    const out: SessionSignals = { version: 1, duration_ms: 0, active_ms: 0, idle_ms: 0, clicks: 0, rage_clicks: [], dead_clicks: [], errors_shown: [], error_loops: [], fields: [], hesitations: [], cursor: { px_per_min: 0, direction_changes_per_min: 0, circling_bursts: 0 }, scroll: { px: 0, reversals: 0, hunting_bursts: 0 }, network_errors: 0, slow_calls: 0, console_errors: 0 }
    // Window-local node ids must never resolve against another window's DOM.
    const textWindows = new Map<string, Map<number, number>>()
    let textParents = new Map<number, number>()
    const windows = new Map<string, Map<number, NodeInfo>>()
    const visibility = new WeakMap<NodeInfo, { hidden: boolean; aria: boolean; style: boolean }>()
    const fields = new Map<string, SessionSignals['fields'][number]>()
    let nodes = new Map<number, NodeInfo>()
    let start: number | undefined, end = 0, lastActivity: number | undefined, lastAction: number | undefined, moving = false
    let hasActivity = false, loaded = false
    let window = ''
    let focus: { field: string; at: number } | undefined
    const pending: { target: string; time: number; window: string; id: number; rage?: boolean }[] = []
    const effects = new Map<string, { time: number; removed?: Set<number> }[]>()
    const rages = new Map<string, { times: number[]; result?: SessionSignals['rage_clicks'][number] }>()
    const attempts = new Map<string, { submit: boolean; failed: boolean; edited?: string; retry?: string }>()
    let attempt = { submit: false, failed: false } as NonNullable<ReturnType<typeof attempts.get>>
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
            for (const k of NAME_KEYS.slice(0, 6)) { const known = n.attrs[k] ? knownNames.get(nameToken(n.attrs[k])) : undefined; if (known) return field ? `field:${known}` : `${original?.tag || 'element'}#${known}` }
        }
        if (field) return 'field'
        if (original?.tag === 'button' || original?.attrs.role === 'button') return 'button'
        if (['input', 'select', 'textarea'].includes(original?.tag || '') || ['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'slider', 'searchbox'].includes(original?.attrs.role || '')) return 'field'
        if (original?.tag === 'a' || original?.attrs.role === 'link') return 'link'
        return 'element'
    }
    const fieldFor = (id: number) => {
        const field = name(id, true)
        let f = fields.get(field)
        if (!f) { f = { field, edits: 0, focus_count: 0, ms: 0 }; fields.set(field, f) }
        return f
    }
    const blur = (t: number) => { if (focus) { fields.get(focus.field)!.ms += Math.max(0, t - focus.at); focus = undefined } }
    const effect = (t: number, removed?: Set<number>) => {
        if (!effects.has(window)) effects.set(window, [])
        effects.get(window)!.push({ time: t, removed })
    }
    const appeared = (id: number, t: number) => {
        out.errors_shown.push({ target: name(id), at_ms: relative(t) })
        if (attempt.submit) {
            if (attempt.retry) loops.set(attempt.retry, (loops.get(attempt.retry) || 0) + 1)
            attempt.failed = true; attempt.submit = false; attempt.retry = undefined
        }
    }
    const attrs = (raw: any): Record<string, string> => {
        const result: Record<string, string> = {}
        for (const k of NAME_KEYS) { const v = safeName(raw?.[k]); if (v) result[k] = v }
        return result
    }
    // Success toasts are effects, but their class alone is not evidence of an error.
    const errorClass = (raw: any) => typeof raw?.class === 'string' && /error|alert|invalid/i.test(raw.class)
    const hidden = (raw: any) => raw?.hidden != null || raw?.['aria-hidden'] === 'true' || (typeof raw?.style === 'string' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(raw.style))
    const isError = (role: unknown, cls: boolean) => role === 'alert' || role === 'alertdialog' || cls
    // Decode transport containers only; detectors never access text or non-allowlisted values.
    const unpack = (raw: any): any => {
        if (typeof raw !== 'string' || !raw.startsWith('\x1f\x8b')) return raw
        try { return JSON.parse(gunzipSync(Buffer.from(raw, 'latin1'), { maxOutputLength: Math.max(1, Number(process.env.REPLAY_MAX_MB) || 200) * 1024 * 1024 }).toString('utf8')) } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('Recording too large by decompression policy')
            return undefined
        }
    }
    const add = (root: any, parent: number | undefined) => {
        const stack = [{ node: root, parent }]
        while (stack.length) {
            const item = stack.pop()!, n = item.node
            if (!n || typeof n.id !== 'number') continue
            // Retain text-node parent IDs only, never their content.
            if (n.type === 3 && item.parent !== undefined) textParents.set(n.id, item.parent)
            if (n.type === 2) {
                const tag = typeof n.tagName === 'string' ? n.tagName.toLowerCase() : ''
                const info = { tag: htmlTags.has(tag) ? tag : 'element', attrs: attrs(n.attributes), parent: item.parent, error: isError(n.attributes?.role, errorClass(n.attributes)), hidden: hidden(n.attributes), errorClass: errorClass(n.attributes) }
                nodes.set(n.id, info)
                visibility.set(info, { hidden: n.attributes?.hidden != null, aria: n.attributes?.['aria-hidden'] === 'true', style: hidden({ style: n.attributes?.style }) })
            }
            for (const child of n.childNodes || []) stack.push({ node: child, parent: n.type === 2 ? n.id : item.parent })
        }
    }
    const visibleErrors = () => {
        const result = new Map<string, number>()
        for (const [id, n] of nodes) {
            if (!n.error) continue
            let current: NodeInfo | undefined = n, nested = false, hidden = false
            const path: string[] = []
            const seen = new Set<NodeInfo>()
            while (current && !seen.has(current)) {
                seen.add(current)
                hidden ||= current.hidden
                if (current !== n && current.error) nested = true
                // Structural paths survive checkpoint node-id changes without retaining text.
                const siblings = [...nodes.values()].filter(v => v.parent === current!.parent && v.tag === current!.tag)
                path.push(`${current.tag}:${siblings.indexOf(current)}`)
                current = current.parent === undefined ? undefined : nodes.get(current.parent)
            }
            if (!hidden && !nested) result.set(path.join('/'), id)
        }
        return result
    }
    const activity = (t: number) => { if (lastActivity !== undefined && t - lastActivity > 15000 && (hasActivity || !loaded)) out.idle_ms += t - lastActivity; lastActivity = Math.max(lastActivity ?? t, t); hasActivity = true }
    const events: { parsed: any; line: string; timestamp: number }[] = []
    for (const line of jsonl.split('\n')) {
        try { const parsed = JSON.parse(line), ev = Array.isArray(parsed) ? parsed[1] : parsed; if (Number.isFinite(ev?.timestamp)) events.push({ parsed, line, timestamp: ev.timestamp }) } catch {}
    }
    events.sort((a, b) => a.timestamp - b.timestamp)
    for (const { parsed, line } of events) {
        const ev = Array.isArray(parsed) ? parsed[1] : parsed
        const t = ev.timestamp as number, d = ev.type === 2 ? unpack(ev.data) : ev.data
        if (ev.type === 3 && d?.source === 0) {
            for (const k of ['adds', 'attributes', 'removes', 'texts']) d[k] = unpack(d[k])
        }
        if (start === undefined) { start = t; lastActivity = t; lastAction = t }
        end = Math.max(end, t)
        // Explicit DOMContentLoaded/load events establish a page-load prefix.
        // Without that evidence, a long initial gap remains observable idle.
        if ((ev.type === 0 || ev.type === 1) && !hasActivity) loaded = true
        window = String(Array.isArray(parsed) ? parsed[0] : '')
        if (!attempts.has(window)) attempts.set(window, { submit: false, failed: false })
        attempt = attempts.get(window)!
        if (!windows.has(window)) windows.set(window, new Map())
        nodes = windows.get(window)!
        if (!textWindows.has(window)) textWindows.set(window, new Map())
        textParents = textWindows.get(window)!
        if (ev.type === 2) {
            const before = visibleErrors()
            nodes.clear(); textParents.clear(); effect(t); add(d?.node, undefined)
            for (const [key, id] of visibleErrors()) if (!before.has(key)) appeared(id, t)
        }
        if (ev.type === 4) { if (typeof d?.href === 'string') pathTemplate(d.href); effect(t) }
        if (ev.type === 6 && d?.plugin === 'rrweb/console@1' && d.payload?.level === 'error') out.console_errors++
        if (ev.type === 6 && d?.plugin === 'rrweb/network@1') {
            for (const r of parseNetwork(line, networkSeen)) {
                if ((r.status ?? 0) >= 400) out.network_errors++
                else if (r.ms >= 5000) out.slow_calls++
                effect(r.start)
            }
        }
        if (ev.type !== 3 || !d) continue
        if (d.source === 0) {
            const before = visibleErrors()
            // Expiring an unrelated toast is not feedback on the latest click.
            if (d.adds?.length || d.attributes?.length || d.texts?.length) effect(t)
            for (const a of d.adds || []) add(a.node, a.parentId)
            for (const a of d.attributes || []) {
                const n = nodes.get(a.id); if (!n) continue
                for (const k of NAME_KEYS) if (Object.hasOwn(a.attributes || {}, k)) { delete n.attrs[k]; const v = safeName(a.attributes[k]); if (v) n.attrs[k] = v }
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
            }
            // Re-rendering an already visible alert after a submission also counts.
            // Read mutation IDs only, with at most one error per submission.
            const after = visibleErrors()
            for (const [key, id] of after) if (!before.has(key) || (attempt.submit && (d.attributes || []).some((a: any) => a.id === id))) appeared(id, t)
            if (attempt.submit) for (const change of d.texts || []) {
                let id = textParents.get(change.id)
                for (let depth = 0; id !== undefined && depth < 20; depth++) {
                    const n = nodes.get(id)
                    if (n?.error && [...after.values()].includes(id)) { appeared(id, t); break }
                    id = n?.parent
                }
                if (!attempt.submit) break
            }
            for (const r of d.removes || []) {
                const removed = new Set<number>([r.id])
                let changed = true
                while (changed) { changed = false; for (const [id, n] of nodes) if (n.parent !== undefined && removed.has(n.parent) && !removed.has(id)) { removed.add(id); changed = true } }
                effect(t, removed)
                for (const id of removed) { nodes.delete(id); textParents.delete(id) }
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
        if (d.source === 5) { const f = fieldFor(d.id); f.edits++; if (attempt.failed) attempt.edited = f.field; lastAction = t; moving = false }
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
            if (!['input', 'label', 'textarea', 'select'].includes(n?.tag || '')) pending.push({ target, time: t, window, id: d.id })
            if (rage.result) for (const c of pending) if (c.window === window && c.id === d.id && rage.times.includes(c.time)) c.rage = true
            if (n?.attrs.type === 'submit' || /save|submit|run|confirm|apply/i.test(target)) {
                attempt.retry = attempt.failed ? attempt.edited : undefined
                attempt.submit = true; attempt.failed = false; attempt.edited = undefined
            }
        }
    }
    // A quiet recording may have no final rrweb event. Callers with session metadata
    // can supply its observed duration; never invent time beyond the recording.
    if (start !== undefined && Number.isFinite(recordingDurationMs) && recordingDurationMs! >= 0) end = Math.max(end, start + recordingDurationMs!)
    blur(end)
    if (lastActivity !== undefined && end - lastActivity > 15000) out.idle_ms += end - lastActivity
    out.duration_ms = Math.max(0, end - (start ?? end)); out.active_ms = Math.max(0, out.duration_ms - out.idle_ms)
    for (const list of effects.values()) list.sort((a, b) => a.time - b.time)
    for (const c of pending) {
        if (c.rage) continue
        const list = effects.get(c.window) || []
        let lo = 0, hi = list.length, responded = false
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid].time < c.time) lo = mid + 1; else hi = mid }
        for (let i = lo; i < list.length && list[i].time - c.time <= 1000; i++) {
            if (!list[i].removed || list[i].removed!.has(c.id)) { responded = true; break }
        }
        if (end - c.time >= 1000 && !responded) out.dead_clicks.push({ target: c.target, at_ms: relative(c.time) })
    }
    out.fields = [...fields.values()]
    out.error_loops = [...loops].filter(([, count]) => count >= 1).map(([field, count]) => ({ field, count }))
    const minutes = out.duration_ms / 60000
    out.cursor.px_per_min = minutes ? distance / minutes : 0
    out.cursor.direction_changes_per_min = minutes ? turns / minutes : 0
    return out
}
