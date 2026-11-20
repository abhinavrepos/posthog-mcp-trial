// Live client/user roster; cached for no longer than ten minutes per time window.
import { hogql } from './posthog.ts'
import { P } from './props.ts'
import { normalise, userExpr } from './identity.ts'
import { config } from './config.ts'
export interface KnownClient { id:string; name:string; events:number; last_seen:string; users:(string|null)[]; emails?:(string|null)[]; distinct_ids?:(string|null)[]; user_event_counts?:[string|null,string|null,string|null,string|number|null][] }
export interface ClientMatch extends KnownClient { confidence:number; via:string; matched_user?:string; user_events?:number }
const stringValue = (value:unknown) => String(value ?? '')
const cache = new Map<string,{at:number; value:Promise<KnownClient[]>}>()
export function clearClientCache() { cache.clear() }
export async function knownClients(from?: Date, to?: Date): Promise<KnownClient[]> {
    const key = [from?.toISOString().slice(0,10) || 'last_90_days',to?.toISOString().slice(0,10) || 'now'].join('|')
    from ??= new Date(Date.now()-90*86400000); to ??= new Date()
    const hit = cache.get(key)
    if(hit && Date.now()-hit.at < 600000) return hit.value
    const value = hogql(`SELECT id, any(name) AS name, sum(n) AS events, max(last_seen) AS last_seen,
        groupUniqArray(5000)(user) AS users, groupUniqArray(5000)(email) AS emails, groupUniqArray(5000)(did) AS distinct_ids,
        groupArray(tuple(user,email,did,n)) AS user_event_counts
        FROM (SELECT toString(${P.client}) AS id, any(toString(${P.clientName})) AS name,
            ${userExpr()} AS user, toString(${P.email}) AS email, toString(distinct_id) AS did,
            count() AS n, max(timestamp) AS last_seen
            FROM events WHERE timestamp >= {from} AND timestamp < {to} AND notEmpty(toString(${P.client}))
            GROUP BY id, user, email, did)
        GROUP BY id ORDER BY events DESC LIMIT 10000`, {from:from.toISOString(),to:to.toISOString()}).then(rows=>rows.map(r=>({
            id:String(r.id),name:String(r.name || r.id),events:Number(r.events),last_seen:new Date(String(r.last_seen)).toISOString(),users:(r.users as string[] || []).map(stringValue),emails:(r.emails as string[] || []).map(stringValue),distinct_ids:(r.distinct_ids as string[] || []).map(stringValue),user_event_counts:((r.user_event_counts || []) as unknown[][]).map(([u,e,d,n])=>[stringValue(u),stringValue(e),stringValue(d),stringValue(n)] as [string,string,string,string])})))
    cache.set(key,{at:Date.now(),value}); value.catch(()=>cache.delete(key))
    if(cache.size>20) cache.delete(cache.keys().next().value!)
    return value
}
export function matchClients(query:string, clients:KnownClient[]): ClientMatch[] {
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
    return out.sort((a,b)=>b.confidence-a.confidence || b.events-a.events).slice(0,10)
}
export async function resolveClient(input:{text:string; emails?:string[]; clientHint?:string; from?:Date; to?:Date}) {
    const text = input.clientHint || input.text
    const inWindow = matchClients(text, await knownClients(input.from,input.to))
    if (inWindow.length || !input.from) return inWindow
    // A client with no events in the asked-for dates still exists: say so, instead of "no client matches".
    return matchClients(text, await knownClients(new Date(Date.now()-400*86400000), new Date())).map(m => ({...m, events:0, ...(m.matched_user ? {user_events:0} : {}), outside_window:true}))
}
