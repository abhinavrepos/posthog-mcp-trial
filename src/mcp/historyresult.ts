import { analyticalWindow, parseTimeWindow } from '../core/timewindow.ts'
import { coverage, dataThrough, tasksDb } from '../core/tasks.ts'
import { historyLimits } from '../core/historycoverage.ts'
const analytical = new Set(['find_client_incidents','screen_usage','error_blast_radius','find_silent_issues','triage_ticket','list_releases','release_outcomes','ticket_evidence','client_feedback','reval_brief','describe_app_events','session_story','dialog_friction','message_doctor','attempt_timings','top_pains','find_trade','client_signals','discover_workflows','workflow_completion','client_experience','friction_hotspots','signal_scorecard','client_story','client_activity_changes','compare_client_patterns','handover_pack','monday_brief','rescue_queue','task_map','flow_time','list_surveys','survey_results'])
const retained = new Set(['dialog_friction','top_pains','client_signals','discover_workflows','workflow_completion','signal_scorecard','client_story','client_activity_changes','compare_client_patterns','handover_pack','monday_brief','rescue_queue','task_map','flow_time'])
const defaults:Record<string,number>={top_pains:7,describe_app_events:7,client_signals:14,find_trade:30,screen_usage:30,error_blast_radius:30,flow_time:90,survey_results:90,list_surveys:30,rescue_queue:28,task_map:28}
const day=(d:Date)=>d.toISOString().slice(0,10)
/** Attach disclosures before the privacy pass, including text-only analytical reports. */
export function analyticalResult(name:string,args:unknown,result:unknown): unknown {
    if(!analytical.has(name) || !result || typeof result!=='object')return result
    const r=result as {_lensJson?:{label:string;value:unknown};content?:{type:string;text?:string}[];isError?:boolean}
    if(r.isError)return result
    const input=(args || {}) as {when?:string;days?:number;weeks?:number;from?:string;to?:string}
    let value=r._lensJson?.value as Record<string,unknown>|undefined
    if(Array.isArray(value)) value={rows:value}
    const output=value?.window as {from?:string;to?:string}|undefined
    let parsed
    if(output?.from && output.to && Number.isFinite(Date.parse(output.from)) && Number.isFinite(Date.parse(output.to))) {
        parsed={from:new Date(output.from),to:new Date(output.to.length===10 ? Date.parse(output.to)+86400000 : output.to)}
    } else if(input.from && input.to) parsed=analyticalWindow(`${input.from} to ${input.to}`)
    else parsed=analyticalWindow(input.when || `last ${input.days || (input.weeks ? input.weeks*7 : defaults[name] || 7)} days`,new Date(),dataThrough()) || parseTimeWindow(input.when!)
    if(!parsed)return result
    const window={from:day(parsed.from),to:day(new Date(+parsed.to-1))}
    let block:Record<string,unknown>
    if(value?.coverage && typeof value.coverage==='object' && 'requested' in value.coverage) block=value.coverage as Record<string,unknown>
    else if(retained.has(name)) block=coverage(window) as unknown as Record<string,unknown>
    else block={requested:{from:parsed.from.toISOString(),to_exclusive:parsed.to.toISOString(),timezone:'UTC'},answered:[{from:parsed.from.toISOString(),to_exclusive:parsed.to.toISOString()}],status:'source_observed',datasets:[{name,source:'posthog_live_or_retained_objects',covered_ranges:[{from:parsed.from.toISOString(),to_exclusive:parsed.to.toISOString()}],missing_ranges:[],detail:'Successful source query covers the requested timestamps; source retention and historical object availability are not independently verified.'}],comparison:{status:'none'},freshness:{data_through:dataThrough(),computed_at:new Date().toISOString()}}
    const arrays=value ? Object.values(value).filter(Array.isArray) : []
    const rows=arrays.reduce((n,a)=>n+a.length,0)
    const limits=value?.limits || {...historyLimits(rows),population:retained.has(name)?'covered_days_only':'source_available_data',warnings:['Missing or expired upstream events and historical object revisions cannot be reconstructed. Ranked rows and replay/message examples are bounded; totals are not inferred from examples.']}
    const compact={...block};delete compact.days;delete compact.unprocessed
    const out={...(value || {}),coverage:compact,limits}
    // Prevent accidental unbounded payloads. Every removed row is counted, including nested examples.
    const omitted:Record<string,number>={}
    const candidates:(()=>boolean)[]=[]
    const walk=(v:unknown,path='')=>{
        if(!v || typeof v!=='object')return
        for(const [key,child] of Object.entries(v)) {
            if(['coverage','limits','days','unprocessed'].includes(key))continue
            if(Array.isArray(child)) {const p=path+key;candidates.push(()=>{if(!child.length)return false;child.pop();omitted[p]=(omitted[p]||0)+1;return true})}
            else walk(child,path+key+'.')
        }
    }
    walk(out)
    while(JSON.stringify(out).length>27500) {let changed=false;for(const trim of candidates) {if(trim()) {changed=true;break}}if(!changed)break}
    if(Object.keys(omitted).length) (out as Record<string,unknown>).omitted_rows_by_path=omitted
    // Per-day flags are internal; coalesced ranges carry the same evidence without 1500 rows.
    const clean=JSON.parse(JSON.stringify(out,(key,v)=>key==='days' && Array.isArray(v) && v[0]?.status ? undefined : key==='unprocessed' && Array.isArray(v) ? undefined : v))
    if(r._lensJson)return {...r,_lensJson:{...r._lensJson,value:clean}}
    const disclosure=JSON.stringify({coverage:compact,limits})
    return {...r,content:[...(r.content || []),{type:'text',text:`History and limits: ${disclosure}`} ]}
}
// Scoped retained replay counts are observations, never claims that all recordings still exist.
export function replayMonths(from:string,to:string,client?:string) {
    const rows=tasksDb.prepare(`SELECT substr(day,1,7) month,count(*) analyzed,count(DISTINCT client) clients FROM replay_signals WHERE day BETWEEN ? AND ? AND (?='' OR client=?) GROUP BY month`).all(from,to,client||'',client||'')
    const by=new Map(rows.map(r=>[String(r.month),r]))
    const months=[]
    const d=new Date(from.slice(0,7)+'-01')
    for(;day(d)<=to;d.setUTCMonth(d.getUTCMonth()+1)) {
        const month=day(d).slice(0,7);months.push({month,analyzed:by.get(month)?.analyzed || 0,eligible_recordings:null,available_recordings:null,reason:'Only retained analyzed recordings are counted; upstream expiry and unrecorded sessions cannot be reconstructed.'})
    }
    return months
}
