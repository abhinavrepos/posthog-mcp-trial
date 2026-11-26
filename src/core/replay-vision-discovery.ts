import {hogql,isTruncated} from './posthog.ts'
import {P} from './props.ts'
import {userExpr} from './identity.ts'

export interface Discovered {session_id:string;start:string;end:string;client_id:string|null;distinct_id:string|null}
/**
 * Bounded keyset read of recordings that started in [from, to) and whose last blob is before `to`
 * (the caller sets `to` = now − quiet period). Identity comes from a second bounded event query;
 * a missing or conflicting identity is deliberately left unmatched (null).
 */
export async function discoverFinishedRecordings(input:{from:Date;to:Date;cursor?:{end:string;session_id:string};limit?:number}):Promise<{rows:Discovered[];next?:{end:string;session_id:string};partial:boolean}> {
 const limit=Math.min(100,Math.max(1,Math.floor(input.limit??50)))
 if(!Number.isFinite(+input.from)||!Number.isFinite(+input.to)||+input.to<=+input.from||+input.to-+input.from>2*86400000)throw new Error('discovery_window')
 const query=`SELECT session_id, min(min_first_timestamp) AS start, max(max_last_timestamp) AS end
   FROM raw_session_replay_events WHERE min_first_timestamp >= {from} AND min_first_timestamp < {to}
   AND session_id != '' AND NOT is_deleted GROUP BY session_id
   HAVING end < {to} ${input.cursor?'AND (end < {cursorEnd} OR (end = {cursorEnd} AND session_id < {cursorId}))':''}
   ORDER BY end DESC, session_id DESC LIMIT ${limit+1}`
 const rows=await hogql(query,{from:input.from.toISOString(),to:input.to.toISOString(),cursorEnd:input.cursor?.end??'',cursorId:input.cursor?.session_id??''},{timeoutMs:15_000,retries:0})
 const more=rows.length>limit;const page=rows.slice(0,limit)
 const ids=page.map(r=>String(r.session_id)).filter(s=>/^[\w-]{8,120}$/.test(s))
 const identity=new Map<string,{client_id:string|null;distinct_id:string|null}>()
 if(ids.length){
  const people=await hogql(`SELECT toString(properties.$session_id) AS sid, uniqExact(toString(${P.client})) AS clients, any(toString(${P.client})) AS client,
    uniqExact(toString(distinct_id)) AS distincts, any(toString(distinct_id)) AS did, any(${userExpr()}) AS user
    FROM events WHERE timestamp >= {from} - INTERVAL 1 DAY AND timestamp < {to} + INTERVAL 1 DAY
    AND toString(properties.$session_id) IN {ids} GROUP BY sid LIMIT 100`,{from:input.from.toISOString(),to:input.to.toISOString(),ids},{timeoutMs:15_000,retries:0})
  for(const r of people){const cid=Number(r.clients)===1&&String(r.client||'')?String(r.client):null,did=Number(r.distincts)===1&&String(r.did||'')?String(r.did):null;identity.set(String(r.sid),{client_id:cid,distinct_id:did})}
 }
 const out=page.filter(r=>ids.includes(String(r.session_id))).map(r=>({session_id:String(r.session_id),start:new Date(String(r.start)).toISOString(),end:new Date(String(r.end)).toISOString(),client_id:identity.get(String(r.session_id))?.client_id??null,distinct_id:identity.get(String(r.session_id))?.distinct_id??null}))
 const last=out.at(-1)
 return {rows:out,next:more&&last?{end:last.end,session_id:last.session_id}:undefined,partial:isTruncated(rows)}
}
