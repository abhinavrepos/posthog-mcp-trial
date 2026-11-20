// Live client/user roster; cached for no longer than ten minutes per time window.
import { hogql } from './posthog.ts'
import { P } from './props.ts'
import { normalise, userExpr } from './identity.ts'
import { config } from './config.ts'
export interface KnownClient { id:string; name:string; events:number; last_seen:string; users:string[]; emails?:string[]; distinct_ids?:string[] }
export interface ClientMatch extends KnownClient { confidence:number; via:string; matched_user?:string }
const cache = new Map<string,{at:number; value:Promise<KnownClient[]>}>()
export function clearClientCache() { cache.clear() }
export async function knownClients(from = new Date(Date.now()-90*86400000), to = new Date()): Promise<KnownClient[]> {
    const key = [from.toISOString().slice(0,10),to.toISOString().slice(0,10)].join('|')
    const hit = cache.get(key)
    if(hit && Date.now()-hit.at < 600000) return hit.value
    const value = hogql(`SELECT toString(${P.client}) AS id, any(toString(${P.clientName})) AS name,
        count() AS events, max(timestamp) AS last_seen, groupUniqArray(5000)(${userExpr()}) AS users, groupUniqArray(5000)(toString(${P.email})) AS emails, groupUniqArray(5000)(toString(distinct_id)) AS distinct_ids
        FROM events WHERE timestamp >= {from} AND timestamp < {to} AND notEmpty(toString(${P.client}))
        GROUP BY id ORDER BY events DESC LIMIT 10000`, {from:from.toISOString(),to:to.toISOString()}).then(rows=>rows.map(r=>({
            id:String(r.id),name:String(r.name || r.id),events:Number(r.events),last_seen:new Date(String(r.last_seen)).toISOString(),users:(r.users as string[] || []).map(String),emails:(r.emails as string[] || []).map(String),distinct_ids:(r.distinct_ids as string[] || []).map(String)})))
    cache.set(key,{at:Date.now(),value}); value.catch(()=>cache.delete(key))
    if(cache.size>20) cache.delete(cache.keys().next().value!)
    return value
}
export function matchClients(query:string, clients:KnownClient[]): ClientMatch[] {
    const n = normalise(query.trim()), parts = query.split(config.properties.distinctIdSeparator)
    const clientPart = config.properties.clientFromDistinctId || 3
    const extracted = parts.length >= clientPart ? normalise(parts[clientPart-1]) : ''
    const local = normalise(query.split('@')[0])
    const out:ClientMatch[]=[]
    for(const c of clients) {
        let confidence=0, via='', matched_user:string|undefined
        for(const [label,raw] of [['id',c.id],['name',c.name]] as const) {
            const v=normalise(raw), score=n===v ? 1 : extracted && extracted===v ? .99 : local===v ? .98 : v.startsWith(n) ? .85 : v.includes(n) ? .7 : 0
            if(n && score>confidence) {confidence=score;via=label+(score===1 ? ':exact' : ':normalised/prefix/contains')}
        }
        for(const u of c.users) {
            const v=normalise(u), score=n===v || local===v ? 1 : v.startsWith(n) ? .84 : v.includes(n) ? .69 : 0
            if(n && score>=confidence) {confidence=score;via='user';matched_user=u}
        }
        if(c.emails?.some(e=>normalise(e)===n)) {confidence=1;via='email';matched_user=query}
        if(c.distinct_ids?.some(d=>normalise(d)===n)) {confidence=1;via='distinct_id';matched_user=query.split(config.properties.distinctIdSeparator).at(-1)}
        if(confidence) out.push({...c,confidence,via,matched_user})
    }
    return out.sort((a,b)=>b.confidence-a.confidence || b.events-a.events).slice(0,10)
}
export async function resolveClient(input:{text:string; emails?:string[]; clientHint?:string; from?:Date; to?:Date}) {
    const text = input.clientHint || input.text
    const inWindow = matchClients(text, await knownClients(input.from,input.to))
    if (inWindow.length || !input.from) return inWindow
    // A client with no events in the asked-for dates still exists: say so, instead of "no client matches".
    return matchClients(text, await knownClients(new Date(Date.now()-400*86400000), new Date())).map(m => ({...m, outside_window:true}))
}
