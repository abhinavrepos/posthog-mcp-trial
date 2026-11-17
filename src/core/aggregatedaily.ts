// Full joint dimension grain; sets, never sums of distinct counts. Independent event-day coverage
// includes events without session IDs, unlike the session-owned workflow ingestion reader.
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import { required, prop } from './appevents.ts'
import { P } from './props.ts'
export const ROLLUP_DIMENSIONS = ['event', 'client', 'app_version', 'dialog', 'dialog_name', 'tab', 'action', 'button'] as const
export type DailyRow = { n: number; users: string[]; sessions: string[] } & Record<typeof ROLLUP_DIMENSIONS[number], string>
type Packed = [string[], [number[], number, number[], number[]][]]
const DAY = 86400000
// <= 1.03 GB of payload at 1461 days; reserve space for indexes, user-days and jobs.
export const MAX_DAILY_BYTES = 700000
const positive = (name: string, fallback: number) => Number.isFinite(Number(process.env[name])) && Number(process.env[name]) > 0 ? Math.floor(Number(process.env[name])) : fallback
export class RollupBudgetError extends Error {}
export const dailyDecodeLimit = () => positive('LENS_AGG_MAX_DAILY_DECOMPRESSED_BYTES', 32 * 1024 * 1024)
export function initAggregateDaily(db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS aggregate_dimension_daily(day TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS aggregate_dimension_skipped(day TEXT PRIMARY KEY, reason TEXT NOT NULL) WITHOUT ROWID;`)
}
export function packDaily(rows: DailyRow[]): Buffer {
    const dictionary: string[] = [], ids = new Map<string, number>()
    const intern = (s: string) => { let id = ids.get(s); if (id === undefined) { id = dictionary.length; ids.set(s, id); dictionary.push(s) } return id }
    const packed = rows.map(r => [ROLLUP_DIMENSIONS.map(d => intern(r[d])), r.n, r.users.map(intern), r.sessions.map(intern)])
    return brotliCompressSync(Buffer.from(JSON.stringify([dictionary, packed])), { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })
}
export function unpackDaily(value: Uint8Array): DailyRow[] {
    const [dict, rows] = JSON.parse(brotliDecompressSync(value, { maxOutputLength: dailyDecodeLimit() }).toString()) as Packed
    return rows.map(([dims, n, users, sessions]) => ({ ...Object.fromEntries(ROLLUP_DIMENSIONS.map((d,i) => [d,dict[dims[i]]])), n, users: users.map(i=>dict[i]), sessions: sessions.map(i=>dict[i]) } as DailyRow))
}
export function storeAggregateDaily(db: DatabaseSync, day: string, rows: DailyRow[]): boolean {
    const blob = packDaily(rows)
    // High-cardinality projects fall back to an exact live job; never silently trim a set or grain.
    db.prepare('DELETE FROM aggregate_dimension_daily WHERE day=?').run(day)
    if (blob.length > MAX_DAILY_BYTES) { db.prepare('INSERT OR REPLACE INTO aggregate_dimension_skipped VALUES (?,?)').run(day,'Exact rollup exceeds daily storage allowance; use live jobs.'); return false }
    db.prepare('DELETE FROM aggregate_dimension_skipped WHERE day=?').run(day)
    db.prepare('INSERT INTO aggregate_dimension_daily VALUES (?,?)').run(day, blob)
    return true
}
export async function ingestAggregateDaily(db: DatabaseSync, day: string, query: (sql: string, values: Record<string, unknown>) => Promise<Record<string, unknown>[]>) {
    const reg = required()
    const expr = ['event', `toString(${P.client})`, `toString(${P.version})`, prop(reg,'dialog'), prop(reg,'dialogName'), prop(reg,'tab'), prop(reg,'action'), prop(reg,'button')]
    const rows = await query(`SELECT ${expr.map((e,i)=>`${e} AS ${ROLLUP_DIMENSIONS[i]}`).join(',')}, count() AS n,
        groupUniqArray(distinct_id) AS users, groupUniqArray(toString(properties.$session_id)) AS sessions
        FROM events WHERE timestamp >= {from} AND timestamp < {to} GROUP BY ${ROLLUP_DIMENSIONS.join(',')} LIMIT 200001`,
        { from: day, to: new Date(Date.parse(day)+DAY).toISOString().slice(0,10) })
    if (rows.length > 200000 || rows.some(r => !Array.isArray(r.users) || !Array.isArray(r.sessions))) {
        db.prepare('DELETE FROM aggregate_dimension_daily WHERE day=?').run(day); db.prepare('INSERT OR REPLACE INTO aggregate_dimension_skipped VALUES (?,?)').run(day,'Dimension query exceeds grain cap or lacks exact sets; use live jobs.'); return false
    }
    // A finalized task day is evidence of a lower bound, even after upstream retention.
    const hasIngest = db.prepare("SELECT 1 FROM sqlite_master WHERE name='task_ingest'").get()
    const prior = hasIngest ? db.prepare('SELECT sessions,events,finalized FROM task_ingest WHERE day=?').get(day) : undefined
    if (prior?.finalized && (Number(prior.sessions) > 0 || Number(prior.events) > 0)) {
        // Task evidence owns two days of events for sessions starting here, not one event day.
        const counts = await query(`SELECT count() AS events, uniqExact($session_id) AS sessions FROM events
            WHERE timestamp >= {from} AND timestamp < {scan_to} AND event IN {events} AND $session_id IN (
                SELECT $session_id FROM events WHERE timestamp >= {scan_from} AND timestamp < {to} AND event IN {events} AND $session_id != ''
                GROUP BY $session_id HAVING min(timestamp) >= {from} AND min(timestamp) < {to} ORDER BY $session_id LIMIT 100000)`,
            { from: day, to: new Date(Date.parse(day)+DAY).toISOString().slice(0,10), scan_from: new Date(Date.parse(day)-DAY).toISOString().slice(0,10), scan_to: new Date(Date.parse(day)+2*DAY).toISOString().slice(0,10), events: [reg.events.screen, reg.events.interaction] })
        if (Number(counts[0]?.sessions || 0) < Number(prior.sessions) || Number(counts[0]?.events || 0) < Number(prior.events)) {
            db.prepare('DELETE FROM aggregate_dimension_daily WHERE day=?').run(day)
            db.prepare('INSERT OR REPLACE INTO aggregate_dimension_skipped VALUES (?,?)').run(day,'source_expired')
            return false
        }
    }
    return storeAggregateDaily(db, day, rows.map(r => ({ ...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,r[d] == null ? null : String(r[d])])), n: Number(r.n), users: r.users as string[], sessions: r.sessions as string[] } as DailyRow)))
}
export interface DailyQuery { from: Date; to: Date; metrics?: string[]; group_by?: string[]; bucket?: string; filters?: { dimension: string; op: string; value: string | string[] }[]; events?: string[]; limit?: number }
function periodOf(day: string, bucket: string): string {
    const d = new Date(day)
    if (bucket === 'week') return new Date(+d - ((d.getUTCDay()+6)%7)*DAY).toISOString().slice(0,10)
    if (bucket === 'month') return day.slice(0,7)+'-01'
    if (bucket === 'quarter') return `${d.getUTCFullYear()}-${String(Math.floor(d.getUTCMonth()/3)*3+1).padStart(2,'0')}-01`
    if (bucket === 'year') return day.slice(0,4)+'-01-01'
    return day
}
function readSnapshot<T>(db: DatabaseSync, read: () => T): T {
    db.exec('BEGIN')
    try { const result = read(); db.exec('COMMIT'); return result }
    catch (e) { db.exec('ROLLBACK'); throw e }
}
export function dailyAggregate(db: DatabaseSync, q: DailyQuery) {
    return readSnapshot(db, () => aggregateSnapshot(db, q))
}
function aggregateSnapshot(db: DatabaseSync, q: DailyQuery) {
    if (+q.from % DAY || +q.to % DAY || +q.from >= +q.to) return undefined
    const lo=q.from.toISOString().slice(0,10), hi=q.to.toISOString().slice(0,10)
    const count=Number(db.prepare('SELECT count(*) n FROM aggregate_dimension_daily WHERE day>=? AND day<?').get(lo,hi)!.n)
    if (count !== (+q.to-+q.from)/DAY) return undefined
    const metrics = q.metrics?.length ? [...new Set(q.metrics)] : ['events'], groups=[...new Set(q.group_by || [])], bucket=q.bucket || 'none', filters=q.filters || []
    const events=new Set(q.events?.length ? q.events : [required().events.screen,required().events.interaction])
    type Acc = { dims: Record<string, unknown>; events: number; users: Set<string>; sessions: Set<string>; clients: Set<string> }
    const acc = (dims: Record<string, unknown>): Acc => ({ dims, events:0, users:new Set(), sessions:new Set(), clients:new Set() })
    const total=acc({}), by=new Map<string,Acc>()
    const maxGroups=positive('LENS_AGG_MAX_GROUPS',20000), maxDistinct=positive('LENS_AGG_MAX_DISTINCT',5000000)
    let retained=0
    const retain=(set:Set<string>,id:string)=>{
        if(!set.has(id)) {
            if(retained >= maxDistinct) throw new RollupBudgetError('Exact rollup exceeded LENS_AGG_MAX_DISTINCT; using exact live queries.')
            retained++; set.add(id)
        }
    }
    const add=(a:Acc,r:DailyRow)=>{a.events+=r.n; if(metrics.includes('users'))for(const u of r.users)retain(a.users,u); if(metrics.includes('sessions'))for(const s of r.sessions)retain(a.sessions,s); if(metrics.includes('clients')&&r.client!==null)retain(a.clients,r.client)}
    for (const row of db.prepare('SELECT day,value FROM aggregate_dimension_daily WHERE day>=? AND day<? ORDER BY day').iterate(lo,hi)) {
        let decoded: DailyRow[]
        try { decoded=unpackDaily(row.value as Uint8Array) }
        catch { throw new RollupBudgetError('Exact rollup daily blob exceeded the decompressed-size guard or could not be decoded; using exact live queries.') }
        for(const r of decoded) {
            if (!events.has(r.event)) continue
            if(filters.some(f=>{const v=r[f.dimension as keyof DailyRow];const values=Array.isArray(f.value)?f.value:[f.value];return v===null || (f.op==='neq'?v===values[0]:f.op==='in'?!values.includes(String(v)):v!==values[0])}))continue
            add(total,r)
            if(groups.length || bucket!=='none') {
                const dims={...(bucket!=='none'?{period:periodOf(String(row.day),bucket)}:{}),...Object.fromEntries(groups.map(g=>[g,r[g as keyof DailyRow]]))}, key=JSON.stringify(dims)
                let a=by.get(key);if(!a) {
                    if(by.size >= maxGroups) throw new RollupBudgetError('Exact rollup exceeded LENS_AGG_MAX_GROUPS; using exact live queries.')
                    by.set(key,a=acc(dims))
                };add(a,r)
            }
        }
    }
    const value=(a:Acc,m:string)=>m==='events'?a.events:a[m as 'users'|'sessions'|'clients'].size
    const totals=Object.fromEntries(metrics.map(m=>[m,value(total,m)]))
    let rows: Record<string, unknown>[] = [], omitted=0
    const periods = new Map<string, Acc[]>()
    for (const a of by.values()) {
        const key = String(a.dims.period || '')
        if (!periods.has(key)) periods.set(key, [])
        periods.get(key)!.push(a)
    }
    const allowance = q.limit ?? 200
    const n = Math.min(allowance, 20)
    for (const entries of periods.values()) {
        entries.sort((a,b)=>value(b,metrics[0])-value(a,metrics[0]) || JSON.stringify(a.dims).localeCompare(JSON.stringify(b.dims)))
        const kept = groups.length && entries.length > allowance ? entries.slice(0,n) : entries
        rows.push(...kept.map(a=>({...a.dims,...Object.fromEntries(metrics.map(m=>[m,value(a,m)]))})))
        const rest = entries.slice(kept.length)
        omitted += rest.length
        if (rest.length) {
            const other = acc({...rest[0].dims,...Object.fromEntries(groups.map(g=>[g,'other'])),is_other:true})
            for (const a of rest) {
                other.events += a.events
                for (const m of ['users','sessions','clients'] as const) for (const id of a[m]) retain(other[m],id)
            }
            rows.push({...other.dims,...Object.fromEntries(metrics.map(m=>[m,value(other,m)]))})
        }
    }
    const limits = omitted ? {truncated:`Top ${n} groups per bucket plus other. To get the rest, repeat with eq or in filters on ${groups.join(' or ')} (at most 50 values) until other disappears.`} : {}
    rows.sort((a,b)=>String(a.period??'').localeCompare(String(b.period??''))||Number(b[metrics[0]])-Number(a[metrics[0]]))
    return { window:{from:q.from.toISOString(),to:q.to.toISOString()},metrics,group_by:groups,bucket,filters,totals,rows,groups_omitted:omitted,queries:0,seconds:0,
        limits,source:'history',coverage:{status:'complete',detail:'Exact event-day dimension rollups cover the entire window.'},note:'Counts are exact. Distinct user, client and session sets are unioned across every matching grain and day. Distinct counts per period are not additive across periods.' }
}
/** Vocabulary uses the same exact grains. A full-coverage check prevents silent partial counts. */
export function dailyVocabulary(db: DatabaseSync, from: Date, to: Date) {
    return readSnapshot(db, () => vocabularySnapshot(db, from, to))
}
function vocabularySnapshot(db: DatabaseSync, from: Date, to: Date) {
    const lo=from.toISOString().slice(0,10),hi=to.toISOString().slice(0,10)
    if(Number(db.prepare('SELECT count(*) n FROM aggregate_dimension_daily WHERE day>=? AND day<?').get(lo,hi)!.n)!==(+to-+from)/DAY)return undefined
    const reg=required(), events=new Map<string,number>(), clients=new Map<string,number>(), values=new Map<string,Map<string,number>>()
    const names=new Map<string,{opens:number;names:Map<string,number>;sessions:Set<string>;clients:Set<string>}>(), msgs=new Map<string,{dialog:string;button:string;action:string;n:number}>()
    let total=0
    const roles: Record<string,string>={dialog:'dialog',dialogName:'dialog_name',tab:'tab',action:'action',button:'button',version:'app_version'}
    for(const row of db.prepare('SELECT value FROM aggregate_dimension_daily WHERE day>=? AND day<? ORDER BY day').iterate(lo,hi)) for(const r of unpackDaily(row.value as Uint8Array)) {
        events.set(r.event,(events.get(r.event)||0)+r.n)
        if(![reg.events.screen,reg.events.interaction].includes(r.event))continue
        total+=r.n;clients.set(r.client,(clients.get(r.client)||0)+r.n)
        for(const [role,dim] of Object.entries(roles)) {const v=String(r[dim as keyof DailyRow]??'');if(!values.has(role))values.set(role,new Map());const map=values.get(role)!;map.set(v,(map.get(v)||0)+r.n)}
        if(r.dialog) {
            let d=names.get(r.dialog);if(!d)names.set(r.dialog,d={opens:0,names:new Map(),sessions:new Set(),clients:new Set()})
            if(r.event===reg.events.screen&&reg.screenActions.open.includes(r.action))d.opens+=r.n
            if(r.dialog_name&&r.dialog_name.toUpperCase()!=='UNKNOWN')d.names.set(r.dialog_name,(d.names.get(r.dialog_name)||0)+r.n)
            for(const s of r.sessions)d.sessions.add(s);if(r.client!==null)d.clients.add(r.client)
        }
        if([...reg.dialogs.messages,...reg.dialogs.notices].includes(r.dialog)){const key=JSON.stringify([r.dialog,r.button,r.action]);const old=msgs.get(key);if(old)old.n+=r.n;else msgs.set(key,{dialog:r.dialog,button:r.button,action:r.action,n:r.n})}
    }
    return { events:[...events].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([event,n])=>({event,n})),total,values,
        names:new Map([...names].sort((a,b)=>b[1].opens-a[1].opens).map(([dialog,d])=>[dialog,{opens:d.opens,name:[...d.names].sort((a,b)=>b[1]-a[1])[0]?.[0],sessions:d.sessions.size,clients:d.clients.size}])),
        msgs:[...msgs.values()],clients:[...clients].sort((a,b)=>b[1]-a[1]).slice(0,25).map(([client,n])=>({client,n})) }
}
