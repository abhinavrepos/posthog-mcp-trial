// Complete, bounded reads. LIMIT is a page size, never a population cap.
import { columns, required, type RawEvent, toRaw, toSteps } from './appevents.ts'
import { hogql } from './posthog.ts'
import { P } from './props.ts'
export type EventWindow = { from: Date; to: Date; clientId?: string }
export const EVENT_PAGE_SIZE = 10000
// Live reads are for what history has not processed yet (today, yesterday). Each page re-reads the rest of the
// window, so a long live window costs billions of rows and gigabytes of memory: past this many events Lens
// refuses with a clear way forward instead of failing slowly or answering from part of the data.
const MAX_LIVE_EVENTS = (() => { const n = Number(process.env.LENS_LIVE_MAX_EVENTS || 1_000_000); return Number.isFinite(n) && n > 0 ? n : 1_000_000 })()
export class LiveWindowTooLarge extends Error {}
export async function liveEvents(q: EventWindow, sids?: string[]): Promise<RawEvent[]> {
    const reg = required(), result: RawEvent[] = []
    const filters = `event IN {events}
              AND ({client} = '' OR toString(${P.client}) = {client})
              AND notEmpty(toString(properties.$session_id))
              ${sids ? 'AND toString(properties.$session_id) IN {sids}' : ''}`
    const base = { from: q.from.toISOString(), to: q.to.toISOString(), client: q.clientId || '', events: [reg.events.screen, reg.events.interaction], ...(sids ? { sids } : {}) }
    // A read of given sessions is bounded by them (callers send batches of 50); a window read is counted first.
    const [{ n } = { n: 0 }] = sids ? [] : await hogql(`SELECT count() AS n FROM events WHERE timestamp >= {from} AND timestamp < {to} AND ${filters}`, base)
    if (Number(n) > MAX_LIVE_EVENTS) {
        const { dataThrough } = await import('./tasks.ts')
        const through = dataThrough()
        throw new LiveWindowTooLarge(`This window has ${Number(n).toLocaleString('en-US')} events that Lens's processed history does not cover yet${through ? ` (history is complete through ${through})` : ''}, more than a live read handles (${MAX_LIVE_EVENTS.toLocaleString('en-US')}). Ask for a window ending on or before ${through || 'the last processed day'} (relative windows such as "last 28 days" already do), or a shorter recent window.`)
    }
    let sid = '', ts = q.from.toISOString(), uuid = ''
    while (true) {
        const rows = await hogql(`SELECT ${columns(reg)}, toString(uuid) AS event_uuid FROM events
            WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events}
              AND ({client} = '' OR toString(${P.client}) = {client})
              AND notEmpty(toString(properties.$session_id))
              ${sids ? 'AND toString(properties.$session_id) IN {sids}' : ''}
              AND (toString(properties.$session_id), timestamp, toString(uuid)) > ({cursor_sid}, {cursor_ts}, {cursor_uuid})
            ORDER BY toString(properties.$session_id), timestamp, toString(uuid) LIMIT ${EVENT_PAGE_SIZE}`,
        { from: q.from.toISOString(), to: q.to.toISOString(), client: q.clientId || '', events: [reg.events.screen, reg.events.interaction],
            ...(sids ? { sids } : {}), cursor_sid: sid, cursor_ts: ts, cursor_uuid: uuid })
        for (const r of rows) result.push(toRaw(r))
        if (rows.length < EVENT_PAGE_SIZE) break
        const end = rows.at(-1)!, next = [String(end.sid), String(end.ts), String(end.event_uuid)]
        if (next[0] === sid && next[1] === ts && next[2] === uuid) throw new Error('Live event pagination did not advance; no partial answer returned.')
        ;[sid, ts, uuid] = next
    }
    return result
}
export function eventSessions(events: RawEvent[]) {
    const by = new Map<string, RawEvent[]>()
    for (const e of events) { if (!by.has(e.sid)) by.set(e.sid, []); by.get(e.sid)!.push(e) }
    return [...by.values()].map((ev) => toSteps(ev, required()))
}
