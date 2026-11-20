// Live client/user roster; cached for no longer than ten minutes per time window.
import { hogql, isTruncated, markPartial, type Completeness } from './posthog.ts'
import { P } from './props.ts'
import { normalise, userExpr } from './identity.ts'
import { config } from './config.ts'
export interface KnownClient extends Completeness { id:string; name:string; events:number; last_seen:string; users:(string|null)[]; emails?:(string|null)[]; distinct_ids?:(string|null)[]; user_event_counts?:[string|null,string|null,string|null,string|number|null][] }
export interface ClientMatch extends KnownClient { confidence:number; via:string; matched_user?:string; user_events?:number }
const stringValue = (value:unknown) => String(value ?? '')
const TEN_MINUTES = 600000, HOUR = 3600000
const cache = new Map<string,{at:number; value:Promise<KnownClient[]>}>()
type Roster = Map<string,string> & Completeness
let emails: {at:number; value:Promise<Roster>} | undefined
let recentNames: {at:number; value:Promise<Roster>} | undefined
let names: {at:number; value:Roster} | undefined
let namesFlight: Promise<void> | undefined
let namesTimer: ReturnType<typeof setTimeout> | undefined
let generation = 0
export function clearClientCache() {
    cache.clear(); emails = undefined; recentNames = undefined; names = undefined; namesFlight = undefined
    clearTimeout(namesTimer); namesTimer = undefined; generation++
}
function namesQuery(days:number, timeoutMs:number): Promise<Roster> {
    return hogql(`SELECT toString(${P.client}) AS id, argMax(toString(${P.clientName}), timestamp) AS name
        FROM events WHERE timestamp >= {from} AND timestamp < {to} AND notEmpty(toString(${P.client}))
        GROUP BY id LIMIT 100000`, {from:new Date(Date.now()-days*86400000).toISOString(),to:new Date().toISOString()},
        {timeoutMs,retries:0}).then(rows=>markPartial(new Map(rows.map(r=>[stringValue(r.id),stringValue(r.name || r.id)])), isTruncated(rows)))
}
/** Startup warm-up is deliberately detached from callers; keep the last good roster during refresh. */
export function warmClientNames(): void {
    if (!config.properties.clientName || !config.posthog.projectId || !config.posthog.personalApiKey || namesFlight) return
    if (namesTimer) return
    const gen = generation
    namesFlight = namesQuery(400,60000).then(value=>{
        if (generation === gen) names = {at:Date.now(),value}
    }).catch(()=>{}).finally(()=>{
        if (generation !== gen) return
        namesFlight = undefined
        // Refresh five minutes ahead of expiry; a failed refresh (a heavy query) waits ten minutes before retrying.
        const delay = names && Date.now()-names.at < HOUR-300000 ? HOUR-300000 : TEN_MINUTES
        namesTimer = setTimeout(()=>{ namesTimer = undefined; warmClientNames() },delay)
        namesTimer.unref()
    })
}
const readyNames = () => names && Date.now()-names.at < HOUR ? names.value : undefined
async function clientNames(): Promise<Roster> {
    if (!config.properties.clientName) return new Map()
    const ready = readyNames()
    if (ready) return ready
    if (!recentNames || Date.now()-recentNames.at >= TEN_MINUTES) {
        recentNames = {at:Date.now(),value:namesQuery(30,8000).catch(()=>new Map())}
    }
    const recent = await recentNames.value
    return readyNames() ?? recent
}
function clientEmails(): Promise<Roster> {
    if (!emails || Date.now()-emails.at >= TEN_MINUTES) {
        emails = {at:Date.now(),value:hogql(`SELECT toString(pdi.distinct_id) AS did,
            toString(p.properties.${config.properties.personEmail}) AS email
            FROM person_distinct_ids pdi JOIN persons p ON p.id = pdi.person_id LIMIT 100000`, {},
            {timeoutMs:8000,retries:0}).then(rows=>markPartial(new Map(rows.map(r=>[stringValue(r.did),stringValue(r.email)])), isTruncated(rows))).catch(()=>new Map())}
    }
    return emails.value
}
export async function knownClients(from?: Date, to?: Date): Promise<KnownClient[]> {
    const key = [from?.toISOString().slice(0,10) || 'last_90_days',to?.toISOString().slice(0,10) || 'now'].join('|')
    from ??= new Date(Date.now()-90*86400000); to ??= new Date()
    let hit = cache.get(key)
    if (!hit || Date.now()-hit.at >= TEN_MINUTES) {
        const value = hogql(`SELECT toString(${P.client}) AS id, ${userExpr()} AS user,
            toString(distinct_id) AS did, count() AS n, max(timestamp) AS last_seen
            FROM events WHERE timestamp >= {from} AND timestamp < {to} AND notEmpty(toString(${P.client}))
            GROUP BY id, user, did LIMIT 100000`, {from:from.toISOString(),to:to.toISOString()}, +to - +from > 31 * 86400000 ? { timeoutMs: 300_000 } : {}).then(rows=>{
            const clients = new Map<string,KnownClient>()
            for (const r of rows) {
                const id=stringValue(r.id), user=stringValue(r.user), did=stringValue(r.did), n=Number(r.n || 0)
                const last_seen=new Date(String(r.last_seen)).toISOString()
                let c=clients.get(id)
                if (!c) { c={id,name:id,events:0,last_seen,users:[],distinct_ids:[],user_event_counts:[]}; clients.set(id,c) }
                c.events+=n
                if (last_seen>c.last_seen) c.last_seen=last_seen
                c.user_event_counts!.push([user,'',did,stringValue(r.n)])
            }
            for (const c of clients.values()) {
                c.users=[...new Set(c.user_event_counts!.map(r=>r[0]))]
                c.distinct_ids=[...new Set(c.user_event_counts!.map(r=>r[2]))]
            }
            return markPartial([...clients.values()].sort((a,b)=>b.events-a.events).slice(0,10000).map(c=>markPartial(c, isTruncated(rows) || clients.size > 10000)), isTruncated(rows) || clients.size > 10000)
        })
        hit={at:Date.now(),value}; cache.set(key,hit)
        value.catch(()=>{ if(cache.get(key)?.value===value) cache.delete(key) })
        if(cache.size>20) cache.delete(cache.keys().next().value!)
    }
    const [clients,emailRoster,nameRoster] = await Promise.all([hit.value,clientEmails(),clientNames()])
    return markPartial(clients.map(c=>{
        const counts=c.user_event_counts!.map(([u,_e,d,n])=>[u,emailRoster.get(d || '') || '',d,n] as NonNullable<KnownClient['user_event_counts']>[number])
        return markPartial({...c,name:nameRoster.get(c.id) || c.id,emails:[...new Set(counts.map(r=>r[1]))],user_event_counts:counts}, !!c.truncated || !!emailRoster.truncated || !!nameRoster.truncated)
    }), isTruncated(clients) || clients.some(c=>c.truncated) || !!emailRoster.truncated || !!nameRoster.truncated)
}
export function matchClients(query:string, clients:KnownClient[]): ClientMatch[] & Completeness {
    const norm = (value:unknown) => normalise(stringValue(value))
    const n = norm(query.trim()), parts = query.split(config.properties.distinctIdSeparator)
    const clientPart = config.properties.clientFromDistinctId || 3
    const extracted = parts.length >= clientPart ? norm(parts[clientPart-1]) : ''
    const local = norm(query.split('@')[0])
    const out:ClientMatch[]=[]
    for(const c of clients) {
        let confidence=0, via='', matched_user:string|undefined
        for(const [label,raw] of [['id',c.id],['name',c.name]] as const) {
            const v=norm(raw), score=n===v ? 1 : extracted && extracted===v ? .99 : local===v ? .98 : v.startsWith(n) ? .85 : v.includes(n) ? .7 : 0
            if(n && score>confidence) {confidence=score;via=label+(score===1 ? ':exact' : ':normalised/prefix/contains')}
        }
        for(const u of c.users) {
            const v=norm(u), score=n===v || local===v ? 1 : v.startsWith(n) ? .84 : v.includes(n) ? .69 : 0
            if(n && score>=confidence) {confidence=score;via='user';matched_user=u ?? undefined}
        }
        if(c.emails?.some(e=>norm(e)===n)) {confidence=1;via='email';matched_user=query}
        if(c.distinct_ids?.some(d=>norm(d)===n)) {confidence=1;via='distinct_id';matched_user=query.split(config.properties.distinctIdSeparator).at(-1)}
        if(confidence) {
            // Resolve emails/distinct ids to their user before summing that user's rows.
            const matchedRows=c.user_event_counts || []
            if(matched_user) matched_user=matchedRows.find(([u,e,d])=>[u,e,d].some(v=>norm(v)===norm(matched_user!)))?.[0] || matched_user
            const user_events=matched_user ? matchedRows.filter(([u])=>norm(u)===norm(matched_user!)).reduce((sum,row)=>sum+Number(row[3]),0) : undefined
            out.push({...c,confidence,via,matched_user,...(matched_user ? {user_events} : {})})
        }
    }
    return markPartial(out.sort((a,b)=>b.confidence-a.confidence || b.events-a.events).slice(0,10), isTruncated(clients) || clients.some(c=>c.truncated))
}
export async function resolveClient(input:{text:string; emails?:string[]; clientHint?:string; from?:Date; to?:Date}) {
    const text = input.clientHint || input.text
    const inWindow = matchClients(text, await knownClients(input.from,input.to))
    if (inWindow.length || inWindow.truncated || !input.from) return inWindow
    // A client with no events in the asked-for dates still exists: say so, instead of "no client matches".
    const outside = matchClients(text, await knownClients(new Date(Date.now()-400*86400000), new Date()))
    return markPartial(outside.map(m => ({...m, events:0, ...(m.matched_user ? {user_events:0} : {}), outside_window:true})), !!outside.truncated)
}
