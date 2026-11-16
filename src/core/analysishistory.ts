import { comparisonWindow, type ComparisonOptions } from './comparison.ts'
import { historyCoverage } from './historycoverage.ts'
import { analyticalWindow } from './timewindow.ts'
// Daily sufficient statistics for friction/discovery; compact episodes support arbitrary ad hoc funnels.
// These tables share task_ingest's transaction, finalization and session ownership.
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib'
import { tasksDb, coverage, dataThrough } from './tasks.ts'
import { frictionCandidates, finishFriction, clientSignals, required, type ClientPeriod, type AppEvents, type Step, type FrictionCandidate } from './appevents.ts'
import { discoveryCandidates, finishDiscovery, completionAttempts, finishCompletion, workflowEpisodes, type WorkflowCandidate, type Workflow } from './workflows.ts'
import type { EventWindow } from './liveevents.ts'
const DAY = 86400000
const day = (d: Date | number) => new Date(+d).toISOString().slice(0, 10)
// A support count plus only the identities that can overlap daily partitions.
// Ordinary sessions are owned by one ingestion day and need no stored identity.
class Support extends Set<string> {
    constructor(public count: number, public boundary = new Set<string>()) { super() }
    override get size() { return this.count }
}
const encode = (x: unknown, quality = 6, window = 22) => brotliCompressSync(Buffer.from(JSON.stringify(x, (_k, v) => v instanceof Support ? { $count: v.count, b: [...v.boundary] } : v instanceof Set ? { $set: [...v] } : v instanceof Map ? { $map: [...v] } : v)), { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_LGWIN]: window } })
const decodePlain = <T>(s: unknown): T => JSON.parse(brotliDecompressSync(s as Uint8Array).toString())
type StoredSet = { $count?: number; b?: string[]; $set?: string[] }
function storedSet(s: StoredSet): Set<string> { return s.$count === undefined ? new Set(s.$set) : new Support(s.$count, new Set(s.b)) }
function decodeFriction(value: unknown): [string, FrictionCandidate[]][] {
    type ErrorValue = FrictionCandidate['_err'] extends Map<string, infer E> ? E : never
    type StoredError = Omit<ErrorValue, 's' | 'c' | 'm'> & { s: StoredSet; c: StoredSet; m: StoredSet }
    type Stored = Omit<FrictionCandidate, '_s' | '_c' | '_es' | '_ec' | '_err'> & { _s: StoredSet; _c: StoredSet; _es: StoredSet; _ec: StoredSet; _err: { $map: [string, StoredError][] } }
    return decodePlain<[string, Stored[]][]>(value).map(([client, fs]) => [client, fs.map((f) => ({ ...f,
        _s: storedSet(f._s), _c: storedSet(f._c), _es: storedSet(f._es), _ec: storedSet(f._ec),
        _err: new Map(f._err.$map.map(([k,e]) => [k, { ...e, s: storedSet(e.s), c: storedSet(e.c), m: storedSet(e.m) }])) }))])
}
function union<T>(a: Set<T>, b: Set<T>) {
    if (a instanceof Support && b instanceof Support) {
        a.count += b.count
        for (const id of b.boundary) { if (a.boundary.has(id)) a.count--; else a.boundary.add(id) }
    } else for (const x of b) a.add(x)
}
const support = (s: Set<string>, boundary = new Set<string>()) => new Support(s.size, new Set([...s].filter((id) => boundary.has(id))))
function dictionary() {
    const ids = new Map<string, number>()
    const insert = tasksDb.prepare('INSERT OR IGNORE INTO analysis_dictionary(value) VALUES (?)')
    const find = tasksDb.prepare('SELECT id FROM analysis_dictionary WHERE value = ?')
    return (value: string) => {
        let id = ids.get(value)
        if (id === undefined) { insert.run(value); id = Number(find.get(value)!.id); ids.set(value, id) }
        return id
    }
}
const kinds = ['open', 'submit', 'message', 'notice'] as const
const outcomes = [undefined, 'completed', 'accepted', 'error', 'empty', 'none'] as const
type StepRow = [number, number, string, number, string, number, number, number, number, number?]
type ExpandedEpisode = [number, ...StepRow[]]
type EncodedEpisode = ExpandedEpisode | [number, string, string]
function episodeEncode(steps: Step[], intern: (s: string) => number, client: string): EncodedEpisode {
    const base = Date.parse(steps[0].ts)
    const opens = [...new Set(steps.filter((s) => s.kind === 'open').map((s) => intern(s.dialog)))]
    const rows = steps.map((s) => [s.i, (Date.parse(s.ts) - base) / 1000, 'osmn'[kinds.indexOf(s.kind as typeof kinds[number])], intern(s.dialog),
        '-caexn'[outcomes.indexOf(s.outcome)], s.cause ?? -1, s.kind === 'submit' ? intern(s.label) : 0,
        s.outcome === 'error' ? intern(s.template || '') : 0, s.outcome === 'error' ? intern(s.text || '') : 0,
        (s.raw.client || '') === client ? 0 : intern(s.raw.client || '')].join(','))
    return [base, `|${opens.join('|')}|`, rows.join(';')]
}
function selectEpisode(value: EncodedEpisode, codes: Set<number>, startCode?: number): ExpandedEpisode | undefined {
    const selected: ExpandedEpisode = [value[0]]
    if (typeof value[1] === 'string') {
        if (startCode === undefined || !value[1].includes(`|${startCode}|`)) return undefined
        for (const row of (value[2] as string).split(';')) {
            let at = -1
            for (let i=0;i<3;i++) at = row.indexOf(',',at+1)
            const end = row.indexOf(',',at+1)
            if (!codes.has(Number(row.slice(at+1,end)))) continue
            const fields = row.split(',')
            selected.push(fields.map((v,i) => i === 2 || i === 4 ? v : Number(v)) as StepRow)
        }
        return selected
    }
    let starts = false
    for (const row of value.slice(1) as StepRow[]) {
        if (row[2] === 'o' && row[3] === startCode) starts = true
        if (codes.has(row[3])) selected.push(row)
    }
    return starts ? selected : undefined
}
function episodeDecode(value: ExpandedEpisode, sid: string, client: string, dict: Map<number, string>): Step[] {
    const [base, ...encoded] = value
    const rows = encoded as [number, number, string, number, string, number, number, number, number, number][]
    const str = (n: number) => dict.get(n) || ''
    return rows.map(([i, delta, kind, dialog, outcome, cause, label, template, text, stepClient]) => {
        const ts = new Date(base + delta * 1000).toISOString()
        return { i, ts, kind: kinds['osmn'.indexOf(kind)], dialog: str(dialog), outcome: outcomes['-caexn'.indexOf(outcome)], cause: cause < 0 ? undefined : cause,
            label: str(label), template: str(template), text: str(text), tab: '', raw: { sid, client: stepClient ? str(stepClient) : client, ts, event: '', dialog: '' } } as Step
    })
}
function mergeFriction(a: FrictionCandidate, b: FrictionCandidate) {
    for (const k of ['opens', 'attempts', 'retry_loops', 'stuck_sessions'] as const) a[k] += b[k]
    for (const k of Object.keys(a.outcomes) as (keyof typeof a.outcomes)[]) a.outcomes[k] += b.outcomes[k]
    for (const k of ['_s', '_c', '_es', '_ec'] as const) union(a[k], b[k])
    for (const [k, e] of b._err) {
        const old = a._err.get(k)
        if (!old) { a._err.set(k, e); continue }
        old.count += e.count; union(old.s, e.s); union(old.c, e.c)
        for (const m of e.m) if (old.m.size < 10) old.m.add(m)
    }
}
export function storeAnalysisDay(owner: string, sessions: Step[][], reg: AppEvents) {
    const groups = new Map<string, Step[][]>()
    for (const s of sessions) if (s.length) {
        const c = s[0].raw.client || ''
        if (!groups.has(c)) groups.set(c, [])
        groups.get(c)!.push(s)
    }
    const fIns = tasksDb.prepare('INSERT INTO friction_daily VALUES (?,?,?)')
    const wIns = tasksDb.prepare('INSERT INTO workflow_daily VALUES (?,?,?,?)')
    const intern = dictionary()
    const nIns = tasksDb.prepare('INSERT INTO analysis_names_daily VALUES (?,?,?,?,?,?)')
    const packedFriction: [string, FrictionCandidate[]][] = []
    const packedWorkflows = new Map<string, [string, unknown[]][]>()
    const packedEpisodes: [string, [string, number, EncodedEpisode][]][] = []
    for (const [client, ss] of [...groups].sort((a,b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) {
        const opens = new Map<string, { opens: number; name?: string }>()
        const names = new Map<string, number>()
        for (const s of ss.flat()) if (s.kind === 'open') {
            if (s.name && s.name.toUpperCase() !== 'UNKNOWN') {
                const k = JSON.stringify([s.ts.slice(0, 10), s.dialog, s.name]); names.set(k, (names.get(k) || 0) + 1)
            }
            const o = opens.get(s.dialog) || { opens: 0, name: s.name }; o.opens++; opens.set(s.dialog, o)
        }
        for (const [key, n] of names) { const [startDay, dialog, name] = JSON.parse(key) as string[]; nIns.run(owner, startDay, client, intern(dialog), intern(name), n) }
        const friction = frictionCandidates(ss, reg, opens).sort((a,b) => a.dialog.localeCompare(b.dialog))
        for (const f of friction) {
            f._s = support(f._s); f._es = support(f._es)
            for (const e of f._err.values()) e.s = support(e.s)

        }
        packedFriction.push([client, friction])
        const boundary = new Set(ss.filter((s) => new Set(s.filter((x) => x.kind === 'open').map((x) => x.ts.slice(0, 10))).size > 1).map((s) => s[0].raw.sid))
        // No daily minimum support or containment pruning: both must run after combining the window.
        for (const startDay of new Set(ss.flat().filter((s) => s.kind === 'open').map((s) => s.ts.slice(0, 10)))) {
            const packed = []
            const namedToday = new Set(ss.flat().filter((s) => s.kind === 'open' && s.ts.startsWith(startDay) && s.name && s.name.toUpperCase() !== 'UNKNOWN').map((s) => s.dialog))
            for (const c of discoveryCandidates(ss, reg, { window: { from: new Date(startDay), to: new Date(Date.parse(startDay) + DAY) } })) {
                const errors = new Map<string, Step & { count?: number }>()
                for (const s of c.errors) if ((s.kind === 'message' || s.kind === 'notice') && s.outcome === 'error') {
                    const key = s.template || s.text || '(no text)', old = errors.get(key)
                    if (old) old.count = (old.count ?? 1) + 1
                    else errors.set(key, { kind: s.kind, outcome: s.outcome, text: s.text, template: s.template, count: 1 } as Step & { count: number })
                }
                c.errors = [...errors.values()]
                const fallback = c.seen.map((name,i) => name && !namedToday.has(c.dialogs[i]) ? intern(name) : 0)
                packed.push([c.dialogs.map(intern), [c.sessions.size, [...c.sessions].filter((id) => boundary.has(id))], [...c.users].map(intern), c.occurrences, c.completed, c.accepted, [...c.times], c.errors.map((e) => [intern(e.template || ''), intern(e.text || ''), e.count]), fallback.some(Boolean) ? fallback : [], [...c.finishes].map(([f,n]) => [intern(f), n]), c.clients.size === 1 && c.clients.has(client) ? 0 : [...c.clients].map(intern)])
            }
            if (!packedWorkflows.has(startDay)) packedWorkflows.set(startDay, [])
            packedWorkflows.get(startDay)!.push([client, packed])
        }
        let n = 0
        const episodes: [string, number, EncodedEpisode][] = []
        for (const ep of workflowEpisodes(ss, reg)) {
            // Attribution, indices, reply times, dialog opens and episode boundaries are already resolved.
            // Raw fields/grid activity is discarded, while original timestamps preserve idle boundaries.
            const steps = ep.steps.filter((s) => ['open', 'submit', 'message', 'notice'].includes(s.kind))
            if (steps.length) episodes.push([steps[0].raw.sid, n++, episodeEncode(steps, intern, client)])
        }
        episodes.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
        packedEpisodes.push([client, episodes])
    }
    fIns.run(owner, '', encode(packedFriction))
    storeGlobalFriction(owner, packedFriction)
    for (const [start, rows] of packedWorkflows) wIns.run(owner, start, '', encode(rows))
    storeIndexedEpisodes(owner, packedEpisodes)
    rebuildWorkflowGlobalDay(owner)
    storeClientMetrics(owner, sessions, reg, intern)
    tasksDb.prepare('INSERT INTO analysis_days VALUES (?)').run(owner)
}

export function analysisCoverage(q: EventWindow, margin = false) {
    const from = day(+q.from - (margin ? DAY : 0)), to = day(+q.to - 1)
    const c = coverage({ from, to })
    const processed = new Set((tasksDb.prepare('SELECT day FROM analysis_days WHERE day BETWEEN ? AND ?').all(from, to) as { day: string }[]).map((r) => r.day))
    const missing = new Set(c.unprocessed)
    for (let t = Date.parse(from); t < +q.to; t += DAY) if (!processed.has(day(t))) missing.add(day(t))
    const aligned = +q.from % DAY === 0 && +q.to % DAY === 0
    const days = (c.days || []).map(d => d.status === 'complete' && !processed.has(d.day) ? { ...d, status: 'pending' as const, detail: 'Analysis rollups not processed yet' } : d)
    return { ...historyCoverage(from,to,days,dataThrough(),'analysis_history'), complete: c.complete && !missing.size && aligned, unprocessed: [...missing].sort(), aligned }
}
export function analysisMeta(q: EventWindow, margin = false) {
    const coverage = analysisCoverage(q)
    const support = margin ? analysisCoverage(q, true) : coverage
    return { source: support.aligned && (support.covered_days>0 || +q.to-+q.from>7*DAY) ? 'history' as const : 'live' as const, coverage, data_through: dataThrough(), sample_rate: 1 }
}
function storeGlobalFriction(owner: string, groups: [string,FrictionCandidate[]][]) {
    const by=new Map<string,FrictionCandidate>()
    for(const [,fs] of groups)for(const f of fs){const old=by.get(f.dialog);if(old)mergeFriction(old,f);else by.set(f.dialog,f)}
    tasksDb.prepare('INSERT OR REPLACE INTO friction_daily VALUES (?,?,?)').run(owner,'*',encode([['*',[...by.values()]]]))
}
export function backfillGlobalFriction(owner: string) {
    if(tasksDb.prepare("SELECT 1 FROM friction_daily WHERE day=? AND client='*'").get(owner))return
    const row=tasksDb.prepare("SELECT value FROM friction_daily WHERE day=? AND client=''").get(owner)
    if(row)storeGlobalFriction(owner,decodeFriction(row.value))
}
export function historyFriction(q: EventWindow) {
    const cover = analysisCoverage(q)
    if (!cover.aligned || (!cover.covered_days && +q.to-+q.from<=7*DAY)) return undefined
    const by = new Map<string, FrictionCandidate>()
    const rows = tasksDb.prepare(`SELECT value FROM friction_daily WHERE ((? != '' AND client = '') OR (? = '' AND (client = '*' OR (client = '' AND day NOT IN (SELECT day FROM friction_daily WHERE client='*'))))) AND day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= 'analysis_unavailable:' AND key < 'analysis_unavailable;') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND day >= ? AND day < ? ORDER BY day, client`)
        .iterate(q.clientId || '', q.clientId || '', day(q.from), day(q.to))
    for (const row of rows) {
        for (const [client, fs] of decodeFriction(row.value)) {
            if (q.clientId && client !== q.clientId) continue
            for (const f of fs) {
            const old = by.get(f.dialog)
            if (old) mergeFriction(old, f); else by.set(f.dialog, f)
        }
    }
    }
    return finishFriction([...by.values()])
}
/** Complete observed name counts, usable for name resolution without another PostHog scan. */
export function historyDialogNames(q: EventWindow) {
    const cover = analysisCoverage(q, true)
    if (!cover.aligned || (!cover.covered_days && +q.to-+q.from<=7*DAY)) return undefined
    const names = new Map<string, { name?: string }>()
    for (const row of tasksDb.prepare(`SELECT coalesce(d.value,a.dialog) AS dialog,coalesce(n.value,a.name) AS name,sum(a.n) AS total FROM analysis_names_daily a
        LEFT JOIN analysis_dictionary d ON d.id = a.dialog LEFT JOIN analysis_dictionary n ON n.id = a.name
        WHERE start_day >= ? AND start_day < ? AND (? = '' OR client = ?)
        GROUP BY a.dialog,a.name ORDER BY total DESC,name`).iterate(day(q.from), day(q.to), q.clientId || '', q.clientId || '')) {
        if (!names.has(String(row.dialog))) names.set(String(row.dialog), { name: String(row.name) })
    }
    return names
}
export function historyDiscovery(q: EventWindow, limit?: number) {
    const cover = analysisCoverage(q, true)
    if (!cover.aligned || (!cover.covered_days && +q.to-+q.from<=7*DAY)) return undefined
    const dict = analysisDictionary()
    const lo = day(q.from), hi = day(q.to)
    // Four 12-bit dictionary codes plus a length tag fit exactly in a JS number.
    // Large dictionaries use the general string representation without collisions.
    const numeric = [...dict.keys()].every((id) => id < 4096)
    const keyOf = (a: number[]): string | number => numeric ? a.length * 281474976710656 + a[0] + a[1] * 4096 + (a[2] || 0) * 16777216 + (a[3] || 0) * 68719476736 : a.join(',')
    const supports = new Map<string | number, { dialogs: number[]; n: number; client: number; others?: Set<number>; boundary?: Set<string> }>()
    const count = Number(tasksDb.prepare('SELECT count(*) n FROM workflow_support_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? AND length = 2').get(lo, hi)!.n)
    const original = Number(tasksDb.prepare('SELECT count(*) n FROM workflow_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ?').get(lo, hi)!.n)
    const global = !q.clientId && count === original
    let wanted: Set<string | number> | undefined, lengths: Set<number> | undefined
    if (global) {
        const supportRows = (length: number) => tasksDb.prepare('SELECT value FROM workflow_support_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? AND length = ?').iterate(lo,hi,length)
        // only: accumulate just these chains (the exact second pass of the long-window pruning below).
        const load = (length: number, only?: Set<string | number>) => {
        for (const row of supportRows(length)) {
            const reader = supportReader(row.value)
            while (!reader.done()) {
                const length = reader.next(), dialogs = []
                for (let i=0;i<length;i++) dialogs.push(reader.next())
                const n = reader.next(), key = keyOf(dialogs)
                if (only && !only.has(key)) { const b = reader.next(); for (let i=0;i<b;i++) reader.next(); const k = reader.next(); for (let i=0;i<k;i++) reader.next(); continue }
                let c = supports.get(key)
                if (!c) supports.set(key, c = { dialogs, n: 0, client: 0 })
                c.n += n
                const boundaries = reader.next()
                if (boundaries) {
                    if (!c.boundary) c.boundary = new Set()
                    for (let i=0;i<boundaries;i++) {
                        const id = dict.get(reader.next())!
                        if (c.boundary.has(id)) c.n--; else c.boundary.add(id)
                    }
                }
                const clients = reader.next()
                for (let i=0;i<clients;i++) {
                    const id = reader.next()
                    if (!c.client) c.client = id
                    else if (id !== c.client) { if (!c.others) c.others = new Set(); c.others.add(id) }
                }
            }
        }

        }
        load(2)
        const breadth = (c: { client: number; others?: Set<number> }) => Number(!!c.client) + (c.others?.size || 0)
        const size = Math.max(0, limit ?? 15)
        const two = [...supports.values()].filter((c) => c.n >= 2).sort((a,b) => b.n*breadth(b)-a.n*breadth(a))
        const threshold = two[Math.min(two.length,size)-1]
        const score = threshold ? threshold.n * breadth(threshold) : 0
        const minSupport = two.reduce((n,c) => c.n*breadth(c) >= score ? Math.min(n,c.n) : n, Infinity)
        const bounds = tasksDb.prepare('SELECT length,sum(max_sessions) sessions,sum(max_clients) clients FROM workflow_support_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? AND length > 2 GROUP BY length').all(lo,hi)
        // If every longer chain is below the current score threshold AND cannot contain
        // any candidate above it, none can affect the result. Otherwise inspect all lengths.
        const skipLong = Number.isFinite(size) && size > 0 && two.length >= size && bounds.every((r) => Number(r.sessions)*Number(r.clients) < score && Number(r.sessions) < .8*minSupport)
        const clients = (c: {client: number; others?: Set<number>}) => Number(!!c.client) + (c.others?.size || 0)
        const rank = (a: typeof supports extends Map<string | number,infer V> ? V : never,b: typeof a) => b.n*clients(b)-a.n*clients(a) || b.n-a.n || b.dialogs.length-a.dialogs.length
        const finish = () => {
            const contained = new Set<string | number>()
            for (const c of supports.values()) if (c.n >= 2) for (let n=2;n<c.dialogs.length;n++) for (let i=0;i+n<=c.dialogs.length;i++) {
                const key = keyOf(c.dialogs.slice(i,i+n)), short = supports.get(key)
                if (short && c.n >= .8 * short.n) contained.add(key)
            }
            const ranked = [...supports.entries()].filter(([k,c]) => c.n >= 2 && !contained.has(k)).sort((a,b) => rank(a[1],b[1]))
            const rankThreshold = ranked[Math.min(ranked.length,size)-1]?.[1]
            const chosen = ranked.filter(([,c],i) => i < size || (!!rankThreshold && rank(c,rankThreshold) === 0))
            return { chosen, score: rankThreshold ? rankThreshold.n * clients(rankThreshold) : 0, minN: chosen.reduce((m,[,c]) => Math.min(m,c.n), Infinity), full: ranked.length < size }
        }
        // Long windows: summing every distinct 3- and 4-dialog chain does not scale (millions of chains over
        // months; 224 days took 29 s and 800 MB). Exact pruning instead: a longer chain can change the answer only
        // by ranking (n x clients >= the last chosen score) or by removing a chosen chain (n >= 80% of its n). With
        // B = every client in the window (a chain's clients are a subset of its final pair's), any chain that
        // matters has a window total n >= T = min(score / B, 0.8 x smallest chosen n), so on at least one of the
        // D days it had n_day >= T / D. Pass 1 keeps only such chains; pass 2 counts them exactly. If the
        // resulting answer lowers the bar, T is lowered and the passes repeat (at worst: everything, as before).
        let result = finish()
        if (!skipLong) {
            const everyClient = new Set<number>()
            for (const c of supports.values()) { if (c.client) everyClient.add(c.client); for (const o of c.others || []) everyClient.add(o) }
            const B = Math.max(1, everyClient.size)
            const D = Math.max(1, Number(tasksDb.prepare('SELECT count(DISTINCT start_day) n FROM workflow_support_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? AND length > 2').get(lo, hi)!.n))
            let T = result.full ? 0 : Math.min(result.score / B, .8 * result.minN)
            for (;;) {
                for (const [k, c] of supports) if (c.dialogs.length > 2) supports.delete(k)
                const perDay = T / D
                let only: Set<string | number> | undefined
                if (perDay > 1) {
                    only = new Set()
                    for (const length of [3, 4]) for (const row of supportRows(length)) {
                        const reader = supportReader(row.value)
                        while (!reader.done()) {
                            const len = reader.next(), dialogs = []
                            for (let i=0;i<len;i++) dialogs.push(reader.next())
                            const n = reader.next(), b = reader.next()
                            for (let i=0;i<b;i++) reader.next()
                            const k = reader.next(); for (let i=0;i<k;i++) reader.next()
                            if (n >= perDay) only.add(keyOf(dialogs))
                        }
                    }
                }
                load(3, only); load(4, only)
                result = finish()
                const need = result.full ? 0 : Math.min(result.score / B, .8 * result.minN)
                if (!only || T <= need) break
                T = need
            }
        }
        wanted = new Set(result.chosen.map(([key]) => key))
        lengths = new Set([...wanted].map((k) => supports.get(k)!.dialogs.length))
    }
    function* rows(): Generator<[string, Packed[]]> {
        if (global) {
            for (const length of lengths!) for (const row of tasksDb.prepare('SELECT value FROM workflow_global_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? AND length = ? ORDER BY day').iterate(lo,hi,length)) {
                for (const [client,cs] of decodePlain<[string,Packed[]][]>(row.value)) yield [client,cs.filter((c) => wanted!.has(keyOf(c[0])))]
            }
        } else {
            for (const row of tasksDb.prepare('SELECT value FROM workflow_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? ORDER BY day').iterate(lo, hi)) {
                for (const group of decodePlain<[string, Packed[]][]>(row.value)) if (!q.clientId || group[0] === q.clientId) yield group
            }
            for (const row of tasksDb.prepare('SELECT value FROM workflow_global_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= \'analysis_unavailable:\' AND key < \'analysis_unavailable;\') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND start_day >= ? AND start_day < ? ORDER BY day').iterate(lo,hi)) {
                for (const [,cs] of decodePlain<[string,Packed[]][]>(row.value)) yield [q.clientId || '', cs.filter((c) => c[11] && (!q.clientId || dict.get(c[11]) === q.clientId))]
            }
        }
    }
    const by = combineWorkflows(rows(), dict)
    const candidates: WorkflowCandidate[] = []
    for (const c of by.values()) candidates.push({ dialogs: c.dialogs.map((id) => dict.get(id)!), sessions: c.sessions,
        users: new Support(c.users.size), clients: new Support(global ? (() => { const s = supports.get(keyOf(c.dialogs))!; return Number(!!s.client) + (s.others?.size || 0) })() : c.clients.size), occurrences: c.occurrences, completed: c.completed, accepted: c.accepted,
        times: c.times, errors: [...c.errors.values()].map(([template,text,count]) => ({ kind: 'message', outcome: 'error', template: dict.get(template), text: dict.get(text), count } as Step & { count: number })),
        seen: c.seen.map((id) => dict.get(id)!), finishes: new Map([...c.finishes].map(([f,n]) => [dict.get(f)!, n])) })
    const names = historyDialogNames(q)
    return finishDiscovery(candidates, required(), { limit, names: { get: (d) => names?.get(d)?.name } })
}

type EpisodeGroups = [string, [string, number, EncodedEpisode][]][]
/** Vertical episode index: one header per episode, each step stored once under its dialog.
 * Completion reads only the requested dialogs; no per-episode SQL rows or duplicated step payloads. */
function storeIndexedEpisodes(owner: string, groups: EpisodeGroups) {
    const headers: [string,string,number,number][] = []
    const byDialog = new Map<number, [number,string][]>()
    for (const [client, episodes] of groups) for (const [sid,n,value] of episodes) {
        const id = headers.length
        headers.push([client,sid,n,value[0]])
        const rows = typeof value[1] === 'string' ? (value[2] as string).split(';') : (value.slice(1) as StepRow[]).map(r=>r.join(','))
        const parts = new Map<number,string[]>()
        for (const row of rows) {
            const fields = row.split(','); const dialog = Number(fields[3])
            if(!parts.has(dialog))parts.set(dialog,[])
            parts.get(dialog)!.push(row)
        }
        for(const [dialog,rows] of parts) {
            if(!byDialog.has(dialog))byDialog.set(dialog,[])
            byDialog.get(dialog)!.push([id,rows.join(';')])
        }
    }
    // Reuse the existing payload table: its legacy client key now identifies an indexed section.
    tasksDb.prepare('INSERT INTO workflow_episodes_daily VALUES (?,?,?)').run(owner,'@header',encode(headers,5,20))
    const insert=tasksDb.prepare('INSERT INTO workflow_episodes_daily VALUES (?,?,?)')
    for(const [dialog,rows] of byDialog)insert.run(owner,'@dialog:'+dialog,encode(rows,5,20))
    tasksDb.prepare('INSERT INTO workflow_episode_index_days VALUES (?)').run(owner)
}
/** Maintenance backfill uses existing exact episodes, with one atomic day at a time. */
export function indexWorkflowDay(owner: string): void {
    if (tasksDb.prepare('SELECT 1 FROM workflow_episode_index_days WHERE day=?').get(owner)) return
    const groups: EpisodeGroups = []
    for (const r of tasksDb.prepare('SELECT value FROM workflow_episodes_daily WHERE day=?').all(owner)) groups.push(...decodePlain<EpisodeGroups>(r.value))
    tasksDb.exec('BEGIN IMMEDIATE')
    try {
        tasksDb.prepare('DELETE FROM workflow_episodes_daily WHERE day=?').run(owner)
        storeIndexedEpisodes(owner, groups)
        tasksDb.exec('COMMIT')
    } catch(e) { tasksDb.exec('ROLLBACK'); throw e }
}

export function historyCompletion(q: EventWindow, definition: Workflow) {
    const cover = analysisCoverage(q, true)
    if (!cover.aligned || (!cover.covered_days && +q.to-+q.from<=7*DAY)) return undefined
    const attempts: ReturnType<typeof completionAttempts> = []
    const dict = analysisDictionary(), reg = required()
    const excluded = new Set([...reg.dialogs.menu, ...reg.dialogs.messages, ...reg.dialogs.notices])
    const codes = new Set([...dict].filter(([,value]) => definition.dialogs.includes(value)).map(([id]) => id))
    const startCode = [...dict].find(([,value]) => value === definition.dialogs[0])?.[0]
    let owner = ''
    let candidates: { client: string; sid: string; n: number; value: ExpandedEpisode }[] = []
    const flush = () => {
        const batch = candidates.sort((a,b)=>a.client.localeCompare(b.client)||a.sid.localeCompare(b.sid)||a.n-b.n).map(({client,sid,value})=>{
            const steps = episodeDecode(value, sid, client, dict)
            return { steps, opens: steps.filter(s=>s.kind==='open' && !!s.dialog && !excluded.has(s.dialog)) }
        })
        attempts.push(...completionAttempts([], definition, reg, q, batch))
        candidates = []
    }
    const lo=day(+q.from-DAY), hi=day(q.to)
    const eligible = `day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0)
        AND day NOT IN (SELECT substr(key,22) FROM task_state WHERE key >= 'analysis_unavailable:' AND key < 'analysis_unavailable;')`
    for(const row of tasksDb.prepare(`SELECT day FROM analysis_days WHERE day >= ? AND day < ? AND ${eligible} ORDER BY day`).iterate(lo,hi)) {
        if(owner)flush()
        owner=String(row.day)
        const header=tasksDb.prepare("SELECT value FROM workflow_episodes_daily WHERE day=? AND client='@header'").get(owner)
        if(header) {
            if(startCode===undefined)continue
            const headers=decodePlain<[string,string,number,number][]>(header.value)
            const start=tasksDb.prepare('SELECT value FROM workflow_episodes_daily WHERE day=? AND client=?').get(owner,'@dialog:'+startCode)
            if(!start)continue
            const parts=new Map<number,string[]>()
            for(const [id,rows] of decodePlain<[number,string][]>(start.value)) {
                if(q.clientId && headers[id][0]!==q.clientId)continue
                const strings=rows.split(';')
                if(strings.some(r=>r.split(',')[2]==='o'))parts.set(id,strings)
            }
            for(const code of codes)if(code!==startCode) {
                const part=tasksDb.prepare('SELECT value FROM workflow_episodes_daily WHERE day=? AND client=?').get(owner,'@dialog:'+code)
                if(part)for(const [id,rows] of decodePlain<[number,string][]>(part.value))if(parts.has(id))parts.get(id)!.push(...rows.split(';'))
            }
            for(const [id,rows] of parts) {
                const [client,sid,n,base]=headers[id]
                const steps=rows.map(row=>row.split(',').map((v,i)=>i===2||i===4?v:Number(v)) as StepRow).sort((a,b)=>a[0]-b[0])
                candidates.push({client,sid,n,value:[base,...steps]})
            }
        } else {
            // Old retained days remain readable until the incremental index backfill reaches them.
            for(const legacy of tasksDb.prepare('SELECT value FROM workflow_episodes_daily WHERE day=? ORDER BY client').iterate(owner)) {
                for(const [client,episodes] of decodePlain<EpisodeGroups>(legacy.value)) {
                    if(q.clientId && client!==q.clientId)continue
                    for(const [sid,n,value] of episodes){const selected=selectEpisode(value,codes,startCode);if(selected)candidates.push({client,sid,n,value:selected})}
                }
            }
        }
    }
    flush()
    const names = historyDialogNames(q)
    return finishCompletion(attempts, definition, reg, { get: (d) => names?.get(d)?.name })
}

/** Only relative last/past N day/week/month windows are shifted; explicit dates and today stay literal. */
export function completeDayWindow<T extends { from: Date; to: Date }>(q: T, input?: string, now = new Date()): T {
    const value = input?.trim() || 'last 7 days'
    if (!/^(last|past)\b/i.test(value)) return q
    const parsed = analyticalWindow(value, now, dataThrough())
    if (!parsed) throw new Error(`Unrecognised time window: ${value}`)
    return { ...q, ...parsed }
}

// Raw-event client signals have a different definition from attributed submit outcomes.
// Keep their own tiny sufficient statistics so top_pains never scans raw history.
type ClientMetrics = [string, string, number, string[], number[], number[], number, number, string]
function storeClientMetrics(owner: string, sessions: Step[][], reg: AppEvents, intern: (s: string) => number) {
    const groups = new Map<string, { sessions: Set<string>; boundary: Set<string>; users: Set<number>; dialogs: Set<number>; attempts: number; errors: number; last: string; day: string; client: string }>()
    const empty = reg.outcomes.filter((o) => o.outcome === 'empty').map((o) => new RegExp(o.match, 'i'))
    for (const session of sessions) {
        const boundary = new Set(session.map((s) => s.ts.slice(0, 10))).size > 1
        for (const s of session) {
            const e = s.raw, d = e.ts.slice(0, 10), client = e.client || ''
            if (!client || ![reg.events.screen, reg.events.interaction].includes(e.event)) continue
            const key = JSON.stringify([d, client])
            let g = groups.get(key)
            if (!g) groups.set(key, g = { sessions: new Set(), boundary: new Set(), users: new Set(), dialogs: new Set(), attempts: 0, errors: 0, last: e.ts, day: d, client })
            g.sessions.add(e.sid); if (boundary) g.boundary.add(e.sid)
            g.users.add(intern(e.user || ''))
            if (e.event === reg.events.screen) g.dialogs.add(intern(e.dialog))
            g.attempts += Number(reg.submitButtons.includes(e.button || ''))
            g.errors += Number(reg.dialogs.messages.includes(e.dialog) && !empty.some((r) => r.test(e.button || '')))
            if (e.ts > g.last) g.last = e.ts
        }
    }
    const rows: ClientMetrics[] = [...groups.values()].map((g) => [g.day, g.client, g.sessions.size, [...g.boundary], [...g.users], [...g.dialogs], g.attempts, g.errors, g.last])
    tasksDb.prepare('INSERT INTO analysis_client_daily VALUES (?,?)').run(owner, encode(rows))
}
export function historyClientSignals(q: EventWindow & ComparisonOptions) {
    const cover = analysisCoverage(q, true)
    if (!cover.aligned || (!cover.covered_days && +q.to-+q.from<=7*DAY)) return undefined
    const baseline = comparisonWindow(q)
    const baselineComplete = !!baseline && analysisCoverage(baseline).complete
    const currentComplete = analysisCoverage(q).complete
    const groups = new Map<string, { now: Acc; before: Acc; last: string }>()
    type Acc = { sessions: Support; users: Set<number>; dialogs: Set<number>; days: Set<string>; attempts: number; errors: number }
    const acc = (): Acc => ({ sessions: new Support(0), users: new Set(), dialogs: new Set(), days: new Set(), attempts: 0, errors: 0 })
    for (const [window,which] of [[q,'now'],...(baselineComplete ? [[baseline!,'before']] : [])] as [{from:Date;to:Date},'now'|'before'][]) {
        for (const row of tasksDb.prepare(`SELECT value FROM analysis_client_daily WHERE day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= 'analysis_unavailable:' AND key < 'analysis_unavailable;') AND day NOT IN (SELECT day FROM task_ingest WHERE day NOT IN (SELECT day FROM analysis_days)) AND day >= ? AND day < ? ORDER BY day`).iterate(day(+window.from-DAY),day(window.to))) {
            for (const [date, client, sessions, boundary, users, dialogs, attempts, errors, last] of decodePlain<ClientMetrics[]>(row.value)) {
                if (date < day(window.from) || date >= day(window.to) || (q.clientId && client !== q.clientId)) continue
                let g=groups.get(client)
                if(!g) groups.set(client,g={now:acc(),before:acc(),last})
                const a=g[which]
                union(a.sessions,new Support(sessions,new Set(boundary)));union(a.users,new Set(users));union(a.dialogs,new Set(dialogs))
                a.days.add(date);a.attempts+=attempts;a.errors+=errors
                if(last>g.last)g.last=last
            }
        }
    }
    const dict = new Map((tasksDb.prepare('SELECT id,value FROM analysis_dictionary').all() as {id: number; value: string}[]).map((r) => [r.id, r.value]))
    const period = (a: Acc): ClientPeriod => ({ sessions: a.sessions.size, users: [], user_count: a.users.size, dialogs: a.dialogs.size, days: a.days.size, attempts: a.attempts, errors: a.errors })
    const result = clientSignals([...groups].map(([client, g]) => {
        const quiet = [...g.before.users].filter((u) => !g.now.users.has(u))
        return { client, now: period(g.now), before: period(g.before), last_seen: g.last, quiet_user_count: quiet.length, quiet_users: quiet.slice(0, 6).map((u) => dict.get(u)!) }
    }), +q.to)
    if (!baselineComplete || !currentComplete) for (const c of result) { c.signals = []; c.weight = 0 }
    return result
}

type Packed = [number[], [number, string[]], number[], number, number, number, [number, number][], [number, number, number][], number[], [number, number][], (number[] | 0)?, number?]
type Combined = { dialogs: number[]; sessions: Support; users: Set<number>; clients: Set<string>; occurrences: number; completed: number; accepted: number;
        times: Map<number, number>; errors: Map<number, [number, number, number]>; seen: number[]; finishes: Map<number, number> }
function analysisDictionary() {
    return new Map((tasksDb.prepare('SELECT id,value FROM analysis_dictionary').all() as { id: number; value: string }[]).map((r) => [r.id, r.value]))
}
function combineWorkflows(rows: Iterable<[string, Packed[]]>, dict: Map<number, string>) {
    const by = new Map<string, Combined>()
    for (const [client, cs] of rows) {
            for (const [dialogs, sessions, users, occurrences, completed, accepted, times, errors, seen, finishes, clients, owner] of cs) {
                const key = dialogs.join(',')
                let c = by.get(key)
                if (!c) by.set(key, c = { dialogs, sessions: new Support(0), users: new Set(), clients: new Set(), occurrences: 0, completed: 0, accepted: 0,
                    times: new Map(), errors: new Map(), seen, finishes: new Map() })
                c.sessions.count += sessions[0]
                for (const id of sessions[1]) { if (c.sessions.boundary.has(id)) c.sessions.count--; else c.sessions.boundary.add(id) }
                for (const id of users) c.users.add(id)
                if (Array.isArray(clients)) { for (const id of clients) c.clients.add(dict.get(id)!) } else if (owner) c.clients.add(dict.get(owner)!)
                else if (client) c.clients.add(client)
                c.occurrences += occurrences; c.completed += completed; c.accepted += accepted
                for (const [t,n] of times) c.times.set(t, (c.times.get(t) || 0) + n)
                for (const [template,text,n] of errors) {
                    const key = template && dict.get(template) ? template : text, old = c.errors.get(key)
                    if (old) old[2] += n; else c.errors.set(key, [template,text,n])
                }
                for (const [f,n] of finishes) c.finishes.set(f, (c.finishes.get(f) || 0) + n)
            }
        }

    return by
}
/** Rebuildable all-client summary: avoid decoding each client contribution on global reads. */
export function rebuildWorkflowGlobalDay(owner: string) {
    const dict = analysisDictionary(), intern = dictionary()
    for (const row of tasksDb.prepare('SELECT start_day,value FROM workflow_daily WHERE day = ?').all(owner)) {
        if (tasksDb.prepare('SELECT 1 FROM workflow_support_daily WHERE day = ? AND start_day = ?').get(owner, String(row.start_day))) continue
        const groups = decodePlain<[string, Packed[]][]>(row.value)
        const by = combineWorkflows(groups, dict)
        const contributors = new Map<string, Set<string>>()
        for (const [client, cs] of groups) for (const c of cs) {
            const key = c[0].join(',')
            if (!contributors.has(key)) contributors.set(key, new Set())
            contributors.get(key)!.add(client)
        }
        const packed: Packed[] = [...by.values()].map((c) => {
            const owners = contributors.get(c.dialogs.join(','))!
            return [c.dialogs, [c.sessions.size, [...c.sessions.boundary]], [...c.users], c.occurrences, c.completed, c.accepted,
                [...c.times], [...c.errors.values()], c.seen, [...c.finishes], [...c.clients].map(intern), owners.size === 1 ? intern([...owners][0]) : 0]
        })
        storeSupports(owner, String(row.start_day), packed, intern)
        // Breadth lives in the skinny support index. Only unusual single-owner attribution
        // needs an explicit client override in details; ordinary owners are implicit.
        const details: Packed[] = packed.map((c) => {
            const clients = c[10] as number[], owner = c[11] || 0
            return [...c.slice(0,8), c[8], c[9], !owner || (clients.length === 1 && clients[0] === owner) ? 0 : clients, owner] as unknown as Packed
        })
        for (const length of [2,3,4]) tasksDb.prepare('INSERT OR REPLACE INTO workflow_global_daily VALUES (?,?,?,?)')
            .run(owner, String(row.start_day), length, encode([['', details.filter((c) => c[0].length === length)]], 10, 18))
        // Single-client chains already have every statistic in the global record. Store breakdowns only for shared chains.
        const shared = groups.map(([client, cs]) => [client, cs.filter((c) => contributors.get(c[0].join(','))!.size > 1)])
        tasksDb.prepare('UPDATE workflow_daily SET value = ? WHERE day = ? AND start_day = ?').run(encode(shared), owner, String(row.start_day))
    }
}

// The hot discovery index is a varint stream, not millions of nested JSON arrays.
// Fields: dialog count/codes, session count, boundary-session dictionary ids, client count/ids.
function encodeSupports(packed: Packed[], intern: (s: string) => number) {
    const bytes: number[] = []
    const put = (n: number) => { while (n >= 128) { bytes.push(n % 128 + 128); n = Math.floor(n / 128) }; bytes.push(n) }
    for (const c of packed) {
        put(c[0].length); for (const id of c[0]) put(id)
        put(c[1][0]); put(c[1][1].length); for (const sid of c[1][1]) put(intern(sid))
        put((c[10] as number[]).length); for (const id of c[10] as number[]) put(id)
    }
    return brotliCompressSync(Buffer.from(bytes), { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } })
}
function supportReader(value: unknown) {
    const bytes = brotliDecompressSync(value as Uint8Array)
    let position = 0
    return { done: () => position === bytes.length, next: () => {
        let n = 0, scale = 1, byte: number
        do { byte = bytes[position++]; n += (byte % 128) * scale; scale *= 128 } while (byte >= 128)
        return n
    } }
}
export function rebuildWorkflowSupportDay(owner: string) {
    const by = new Map<string, Packed[]>(), intern = dictionary(), dict = analysisDictionary()
    const shared = new Map<string, ReturnType<typeof combineWorkflows>>()
    for (const row of tasksDb.prepare('SELECT start_day,value FROM workflow_daily WHERE day = ?').iterate(owner))
        shared.set(String(row.start_day), combineWorkflows(decodePlain<[string,Packed[]][]>(row.value),dict))
    for (const row of tasksDb.prepare('SELECT start_day,value FROM workflow_global_daily WHERE day = ?').iterate(owner)) {
        const start = String(row.start_day)
        if (!by.has(start)) by.set(start, [])
        for (const [,cs] of decodePlain<[string,Packed[]][]>(row.value)) for (const c of cs) {
            if (!Array.isArray(c[10])) c[10] = c[11] ? [c[11]] : [...(shared.get(start)?.get(c[0].join(','))?.clients || [])].map(intern)
            by.get(start)!.push(c)
        }
    }
    for (const [start,cs] of by) storeSupports(owner,start,cs,intern)
}

function storeSupports(owner: string, start: string, packed: Packed[], intern: (s: string) => number) {
    for (const length of [2,3,4]) {
        const rows = packed.filter((c) => c[0].length === length)
        let sessions = 0, clients = 0
        for (const c of rows) { sessions = Math.max(sessions,c[1][0]); clients = Math.max(clients,(c[10] as number[]).length) }
        tasksDb.prepare('INSERT OR REPLACE INTO workflow_support_daily VALUES (?,?,?,?,?,?)').run(owner,start,length,sessions,clients,encodeSupports(rows,intern))
    }
}
