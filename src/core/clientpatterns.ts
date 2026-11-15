// Account timelines use retained sufficient statistics only: no event/replay reads.
import { tasksDb, coverage, dataThrough, validWindow } from './tasks.ts'
import { clientOutcomes } from './outcomes.ts'
import { historyLimits } from './historycoverage.ts'
import { analyticalWindow } from './timewindow.ts'
import type { Window } from './taskstypes.ts'
const DAY=86400000
const shift=(s:string,n:number)=>new Date(Date.parse(s)+n*DAY).toISOString().slice(0,10)
const query=<T>(sql:string,...args:(string|number)[])=>tasksDb.prepare(sql).all(...args) as T[]
// Used on every source to exclude partially ingested days; never sum them as complete.
const eligible = `day NOT IN (SELECT day FROM task_ingest WHERE finalized = 0 OR truncated != 0) AND day NOT IN (SELECT substr(key, 22) FROM task_state WHERE key >= 'analysis_unavailable:' AND key < 'analysis_unavailable;') AND day < date('now') AND day NOT IN (SELECT substr(key, 17) FROM task_state WHERE key >= 'signals_missing:' AND key < 'signals_missing;')`
export interface TimelineOptions { client:string; from?:string; to?:string; weeks?:number; bucket?:'month'|'week'; anchor?:string }
export interface TimelineBucket {
    from:string; to:string; covered_days:number; missing_days:number; sessions:number|null; active_users:number|null;
    attempts:number|null; done:number|null; completion_rate:number|null; error_rate:number|null; median_s:number|null;
    exports:number|null; tasks:{task:string;attempts:number;done:number}[]; tasks_rest:{tasks:number;attempts:number;done:number}; warnings:string[]
}
export function timelineWindow(p:TimelineOptions): Window {
    let to=p.to || dataThrough() || shift(new Date().toISOString().slice(0,10),-1)
    if (p.anchor === 'outcome date' || p.anchor === 'outcome') {
        const outcome=clientOutcomes().filter(o=>o.client===p.client).sort((a,b)=>b.decided_on.localeCompare(a.decided_on))[0]
        if (!outcome) throw new Error('No dated outcome is recorded for this client; supply an anchor date.')
        to=outcome.decided_on
    } else if (p.anchor === 'last activity') {
        const last=query<{day:string|null}>(`SELECT max(day) day FROM client_daily WHERE client=? AND sessions>0 AND ${eligible}`,p.client)[0]?.day
        if (!last) throw new Error('No activity in retained complete history; last activity is unknown.')
        to=last
    } else if (p.anchor) to=p.anchor
    // Explicit from/to are inclusive. A dated anchor determines the series end.
    const from=p.from || (p.weeks ? shift(to,1-p.weeks*7) : analyticalWindow('last 4 years',new Date(+new Date(to)+DAY))!.from.toISOString().slice(0,10))
    const w={from,to};validWindow(w);return w
}
interface TimelineRow {client:string;period:string;n:number;attempts:number;done:number;failed:number;hist:string;task_id:string}
interface PreparedTimeline {window:Window; tables:Map<string,Map<string,TimelineRow[]>>}
export function clientTimeline(p:TimelineOptions,prepared?:PreparedTimeline) {
    const w=timelineWindow(p), cover=coverage(w), bucket=p.bucket || 'month'
    const group=bucket==='month' ? "substr(day,1,7)||'-01'" : "date(day, '-' || ((cast(strftime('%w',day) as integer)+6)%7) || ' days')"
    const read=(table:string,fields:string,extra='')=>{
        if(!prepared)return query<TimelineRow>(`SELECT ${group} period,${fields} FROM ${table} WHERE client=? AND day BETWEEN ? AND ? AND ${eligible} GROUP BY period${extra}`,p.client,w.from,w.to)
        const key=table+fields+extra
        let clients=prepared.tables.get(key)
        if(!clients) {
            clients=new Map()
            for(const r of query<TimelineRow>(`SELECT client,${group} period,${fields} FROM ${table} WHERE day BETWEEN ? AND ? AND ${eligible} GROUP BY client,period${extra}`,prepared.window.from,prepared.window.to)) {
                if(!clients.has(r.client))clients.set(r.client,[]);clients.get(r.client)!.push(r)
            }
            prepared.tables.set(key,clients)
        }
        return (clients.get(p.client)||[]).filter(r=>r.period>=w.from.slice(0,7)+'-01' && r.period<=w.to)
    }
    const sessions=new Map(read('client_daily','sum(sessions) n').map(r=>[r.period,r.n]))
    const users=new Map(read('user_daily',"count(DISTINCT nullif(user,'')) n").map(r=>[r.period,r.n]))
    const taskUsers=new Map(read('task_users_daily',"count(DISTINCT nullif(user,'')) n").map(r=>[r.period,r.n]))
    const exports=new Map(read('ops_daily',"sum(CASE WHEN family='export' THEN submits ELSE 0 END) n").map(r=>[r.period,r.n]))
    const tasks=read('task_daily','task_id,sum(attempts) attempts,sum(done) done,sum(failed) failed,hist_merge(dur_hist) hist',',task_id')
    const periods=new Map<string,{from:string;to:string}>()
    for(let d=w.from;d<=w.to;d=shift(d,1)) {
        const period=bucket==='month' ? d.slice(0,7)+'-01' : shift(d,-((new Date(d).getUTCDay()+6)%7))
        const old=periods.get(period);if(old) old.to=d;else periods.set(period,{from:d,to:d})
    }
    const warnings=query<{week_end:string;kind:string}>(`SELECT DISTINCT week_end,kind FROM week_obs WHERE client=? AND week_end BETWEEN ? AND ? ORDER BY week_end,kind`,p.client,w.from,w.to)
    const buckets:TimelineBucket[]=[]
    for(const [period,window] of periods) {
        const days=(cover.days || []).filter(d=>d.day>=window.from && d.day<=window.to), covered=days.filter(d=>d.status==='complete').length
        const rows=tasks.filter(t=>t.period===period).sort((a,b)=>b.attempts-a.attempts || a.task_id.localeCompare(b.task_id))
        const sum=(key:'attempts'|'done'|'failed')=>rows.reduce((n,r)=>n+r[key],0)
        const attempts=sum('attempts'), done=sum('done'), failed=sum('failed'), rest=rows.slice(5)
        // Use the same interpolated duration histogram as flow_time.
        const hist:number[]=[];for(const r of rows) for(const [i,n] of (JSON.parse(r.hist) as number[]).entries()) hist[i]=(hist[i]||0)+n
        const total=hist.reduce((a,b)=>a+b,0);let median:number|null=null, cumulative=0
        const bounds=[0,5,10,15,20,30,45,60,90,120,180,240,300,420,600,900,1200,1800,2700,3600,7200,14400]
        for(let i=0; i<hist.length && total; i++) { if(cumulative+hist[i]>=total*.5) {median=bounds[i]+(bounds[i+1]-bounds[i])*(total*.5-cumulative)/hist[i];break} cumulative+=hist[i] }
        buckets.push({...window,covered_days:covered,missing_days:days.length-covered,sessions:covered ? sessions.get(period)||0 : null,
            active_users:covered ? users.get(period) ?? taskUsers.get(period) ?? 0 : null,attempts:covered?attempts:null,done:covered?done:null,
            completion_rate:attempts?done/attempts:null,error_rate:attempts?failed/attempts:null,median_s:median,exports:covered?exports.get(period)||0:null,
            tasks:rows.slice(0,5).map(r=>({task:r.task_id,attempts:r.attempts,done:r.done})),tasks_rest:{tasks:rest.length,attempts:rest.reduce((n,r)=>n+r.attempts,0),done:rest.reduce((n,r)=>n+r.done,0)},
            warnings:[...new Set([...days.filter(d=>d.status!=='complete').map(d=>d.status),...warnings.filter(r=>r.week_end>=window.from&&r.week_end<=window.to).map(r=>r.kind)])]})
    }
    return {client:p.client,window:w,anchor:p.anchor || w.to,bucket,buckets,coverage:cover,limits:historyLimits(buckets.length),
        note:'Counts cover only finalized days. Active users are distinct within each bucket. Missing days are unknown, not zero. Durations use interpolated task histograms; warning reasons describe coverage, not causes of departure.'}
}
export interface ActivityOptions { from?:string;to?:string;silence_days?:number;established_days?:number;limit?:number;all?:boolean }
export function clientActivityChanges(p:ActivityOptions={}) {
    const silence=p.silence_days ?? 60, established=p.established_days ?? 3, limit=p.limit ?? 100
    if(!Number.isInteger(silence)||silence<1||silence>1500||!Number.isInteger(established)||established<1||established>1500||!Number.isInteger(limit)||limit<1||limit>150) throw new Error('Invalid silence, established-use or result limit')
    const w=timelineWindow({client:'',from:p.from,to:p.to}), cover=coverage(w)
    const names=new Map(query<{client:string;name:string}>('SELECT client,name FROM client_names').map(r=>[r.client,r.name]))
    const clients=new Map<string,string[]>()
    for(const r of query<{client:string;day:string}>(`SELECT client,day FROM client_daily WHERE day BETWEEN ? AND ? AND sessions>0 AND ${eligible} ORDER BY client,day`,w.from,w.to)) {
        if(!clients.has(r.client)) clients.set(r.client,[]);clients.get(r.client)!.push(r.day)
    }
    const rows=[...clients].map(([client,days])=>{
        const episodes:{onset:string;confirmed_on:string;reactivated_on:string|null}[]=[]
        for(let i=established-1;i<days.length;i++) {
            const next=days[i+1] || shift(w.to,1), silentDays=(Date.parse(next)-Date.parse(days[i]))/DAY-1
            if(silentDays<silence) continue
            const onset=shift(days[i],1), confirmed=shift(days[i],silence)
            // Every intervening day must be observed, including the follow-up proving silence.
            if((cover.days || []).some(d=>d.day>=onset && d.day<next && d.status!=='complete')) continue
            episodes.push({onset,confirmed_on:confirmed,reactivated_on:days[i+1]||null})
        }
        return {client,client_name:names.get(client)||client,last_activity:days.at(-1)!,established_active_days:days.length,first_sustained_silence:episodes[0]?.onset || null,episodes}
    })
    // Clients that went quiet, the most recent first; the rest are counted (150 rows of "no silence" told an
    // agent nothing and cost thousands of tokens). Internal callers take every row.
    const quiet=rows.filter(r=>r.episodes.length).sort((a,b)=>(b.episodes.at(-1)!.onset).localeCompare(a.episodes.at(-1)!.onset)||a.client.localeCompare(b.client))
    if(p.all) return {window:w,clients:rows,coverage:cover}
    return {window:w,label:'usage-based inactivity, not confirmed churn',silence_days:silence,established_days:established,clients_with_inactivity:quiet.length,clients_active_without_inactivity:rows.length-quiet.length,clients:quiet.slice(0,limit),coverage:cover,limits:historyLimits(Math.min(quiet.length,limit),Math.max(0,quiet.length-limit)),
        note:'Established use means at least the specified number of observed active days. Silence requires complete observation until reactivation or the window end. Earlier activity outside the requested window is unknown. Clients without retained activity cannot be classified.'}
}
export interface CompareOptions { client?:string; group?:'left_or_contracted'|'inactive';from?:string;to?:string;months?:number;followup_days?:number;silence_days?:number }
export function compareClientPatterns(p:CompareOptions={}) {
    const months=p.months ?? 12, followup=p.followup_days ?? 60
    if(!Number.isInteger(months)||months<1||months>48||!Number.isInteger(followup)||followup<1||followup>1500) throw new Error('Choose 1–48 months and 1–1500 follow-up days')
    const w=timelineWindow({client:'',from:p.from,to:p.to}), cover=coverage(w), outcomes=clientOutcomes()
    const index=new Map<string,string>(), peers=new Map<string,string>()
    if(p.client) {
        const end=timelineWindow({client:p.client,from:w.from,to:w.to,anchor:outcomes.some(o=>o.client===p.client)?'outcome date':'last activity'}).to
        index.set(p.client,end)
    } else if(p.group==='inactive') {
        for(const c of clientActivityChanges({...w,silence_days:p.silence_days,all:true}).clients) if(c.first_sustained_silence) index.set(c.client,c.first_sustained_silence)
    } else for(const o of outcomes) if(['left','contracted'].includes(o.outcome)&&o.decided_on>=w.from&&o.decided_on<=w.to) index.set(o.client,o.decided_on)
    const confirmed=outcomes.filter(o=>['stayed','renewed'].includes(o.outcome) && !index.has(o.client) && o.decided_on>=w.from && o.decided_on<=w.to)
    for(const o of confirmed) if(shift(o.decided_on,-followup)>=w.from && coverage({from:shift(o.decided_on,-followup),to:o.decided_on}).complete) peers.set(o.client,shift(o.decided_on,-followup))
    if(!peers.size && index.size) {
        // Same index date and follow-up for all observed-active controls.
        const at=[...index.values()].sort().at(-1)!, end=shift(at,followup)
        if(end<=w.to && coverage({from:at,to:end}).complete) for(const r of query<{client:string}>(`SELECT DISTINCT client FROM client_daily WHERE day BETWEEN ? AND ? AND sessions>0 AND ${eligible}`,end,end)) if(!index.has(r.client)) peers.set(r.client,at)
    }
    const prepared:PreparedTimeline={window:w,tables:new Map()}
    const aligned=(group:Map<string,string>)=>{
        const rows=new Map<number,TimelineBucket[]>(), contributing=new Set<string>(), excluded:{client:string;reason:string}[]=[]
        for(const [client,at] of group) {
            const end=new Date(at);end.setUTCDate(1)
            const start=new Date(end);start.setUTCMonth(start.getUTCMonth()-months)
            // A lookback reaching past the window is clamped to it (those months are simply unavailable); it used
            // to drop the client silently, so a 12-month lookback in a window starting mid-month found no one.
            const from=start.toISOString().slice(0,10) < w.from ? w.from : start.toISOString().slice(0,10), to=shift(end.toISOString().slice(0,10),-1)
            if(to<from || to>w.to) { excluded.push({client,reason:to>w.to?'index date is after the window':'no complete month before the index date inside the window'}); continue }
            const timeline=clientTimeline({client,from,to,bucket:'month'},prepared)
            // Offsets count back from the index month, whatever the clamped start.
            const n=timeline.buckets.length
            timeline.buckets.forEach((b,i)=>{if(b.missing_days) return;contributing.add(client);const offset=i-n;if(!rows.has(offset))rows.set(offset,[]);rows.get(offset)!.push(b)})
            if(!contributing.has(client)) excluded.push({client,reason:'every month before the index date has missing days in Lens history'})
        }
        return {rows,contributing,excluded}
    }
    const a=aligned(index),b=aligned(peers)
    const median=(values:(number|null)[])=>{const ns=values.filter((v):v is number=>v!==null).sort((a,b)=>a-b);return ns.length?(ns[Math.floor((ns.length-1)/2)]+ns[Math.floor(ns.length/2)])/2:null}
    const stats=(rows:TimelineBucket[])=>({clients:rows.length,sessions:median(rows.map(r=>r.sessions)),active_users:median(rows.map(r=>r.active_users)),attempts:median(rows.map(r=>r.attempts)),completion_rate:median(rows.map(r=>r.completion_rate)),error_rate:median(rows.map(r=>r.error_rate)),median_s:median(rows.map(r=>r.median_s)),exports:median(rows.map(r=>r.exports))})
    const series=Array.from({length:months},(_,i)=>({months_before_index:i-months,target:stats(a.rows.get(i-months)||[]),comparison:stats(b.rows.get(i-months)||[])}))
    return {window:w,target_clients:a.contributing.size,comparison_clients:b.contributing.size,target_selected:index.size,comparison_selected:peers.size,target_excluded:a.excluded.slice(0,20),comparison_excluded:b.excluded.slice(0,20),series,coverage:cover,limits:historyLimits(series.length),
        note:'Descriptive association, no causation. Index is the dated outcome or first sustained usage silence; months are complete calendar months before its month. Stayed means confirmed renewed/stayed at follow-up or observed active through follow-up. Only completely observed months enter medians; each month gives its exact contributing group size. Selection, seasonality and survivor bias may explain differences.'}
}
