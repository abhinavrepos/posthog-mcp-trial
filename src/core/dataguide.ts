// Shared, ten-minute cached project coverage and configured SQL vocabulary.
import { hogql } from './posthog.ts'
import { required, prop } from './appevents.ts'
import { config } from './config.ts'
import { userExpr } from './identity.ts'
import { P } from './props.ts'
export async function dataCoverage() {
    const [row] = await hogql('SELECT min(timestamp) AS data_starts, max(timestamp) AS data_ends FROM events', {}, {cache:true,ttlMs:600000})
    const bounds={data_starts:row?.data_starts ?? null,data_ends:row?.data_ends ?? null}
    const unavailable={...bounds,latest_event:bounds.data_ends,gaps:null,gaps_total:null,sparse_days:null,continuous_from:null,continuous_to:null,note:'Daily coverage unavailable; first/last events do not establish continuous coverage.'}
    try {
        const rows=await hogql('SELECT toDate(timestamp) AS day, count() AS n FROM events WHERE timestamp >= now() - INTERVAL 400 DAY GROUP BY day ORDER BY day LIMIT 1000',{}, {cache:true,ttlMs:600000})
        const dayMs=86400000, day=(ms:number)=>new Date(ms).toISOString().slice(0,10)
        const first=Date.parse(String(bounds.data_starts)), last=Date.parse(String(bounds.data_ends))
        if(!Number.isFinite(first) || !Number.isFinite(last))return unavailable
        // The query only samples part of its oldest UTC day; don't infer an outage there.
        const horizon=Date.now()-400*dayMs
        const start=(first>=horizon ? Math.floor(first/dayMs) : Math.ceil(horizon/dayMs))*dayMs
        const end=Math.floor(last/dayMs)*dayMs
        const counts=new Map(rows.map(r=>[String(r.day).slice(0,10),Number(r.n)]))
        const recent=[...counts].filter(([d,n])=>d>=day(Date.now()-89*dayMs) && n>0).map(([,n])=>n).sort((a,b)=>a-b)
        const middle=Math.floor(recent.length/2)
        const median=recent.length ? (recent[middle]+recent[Math.floor((recent.length-1)/2)])/2 : 0
        const sparse=[...counts].filter(([d,n])=>d>=day(start) && d<=day(end) && n>0 && n<median*0.05).map(([day,events])=>({day,events}))
        const sparseSet=new Set(sparse.map(r=>r.day)), gaps:{from:string;to:string;days:number}[]=[]
        // Weekends and holidays are quiet in business software: only a run of BREAK_DAYS or more empty/sparse days
        // (an outage, or data that stops) breaks continuity, as do quiet days at the very end.
        const BREAK_DAYS=5, breaks:{from:string;to:string;days:number}[]=[], runs:[number,number][]=[]
        let gapStart:number|null=null, lowStart:number|null=null, runStart:number|null=null
        for(let t=start;t<=end+dayMs;t+=dayMs) {
            const inRange=t<=end, present=inRange && (counts.get(day(t)) ?? 0)>0, low=inRange && (!present || sparseSet.has(day(t)))
            if(inRange && !present && gapStart===null)gapStart=t
            if((present || !inRange) && gapStart!==null) {gaps.push({from:day(gapStart),to:day(t-dayMs),days:(t-gapStart)/dayMs});gapStart=null}
            if(low && lowStart===null)lowStart=t
            if(!low && lowStart!==null) {
                const days=(t-lowStart)/dayMs
                if(days>=BREAK_DAYS || !inRange) {
                    breaks.push({from:day(lowStart),to:day(t-dayMs),days})
                    if(runStart!==null && runStart<lowStart)runs.push([runStart,lowStart-dayMs])
                    runStart=null
                }
                lowStart=null
            }
            if(inRange && !low && runStart===null)runStart=t
            if(!inRange && runStart!==null) {runs.push([runStart,end]);runStart=null}
        }
        // Trim quiet edges of each run so the span starts and ends on a normal day.
        let best:[number,number]|null=null
        for(let [a,b] of runs) {
            const normal=(t:number)=>(counts.get(day(t)) ?? 0)>0 && !sparseSet.has(day(t))
            while(a<=b && !normal(a))a+=dayMs
            while(b>=a && !normal(b))b-=dayMs
            if(a<=b && (!best || b-a>best[1]-best[0]))best=[a,b]
        }
        gaps.sort((a,b)=>b.days-a.days)
        const continuous_from=!best ? null : best[0]===Math.floor(first/dayMs)*dayMs ? bounds.data_starts : new Date(best[0]).toISOString()
        const continuous_to=!best ? null : best[1]===Math.floor(last/dayMs)*dayMs ? bounds.data_ends : `${day(best[1])}T23:59:59.999999Z`
        const short=gaps.filter(g=>!breaks.some(b=>g.from>=b.from && g.to<=b.to)).length
        const issues=breaks.slice(0,10).map(b=>`No or sparse data on ${b.from}..${b.to} (${b.days} days)`)
        if(short)issues.push(`${short} shorter quiet gap(s), such as weekends, do not break continuity`)
        return {...bounds,latest_event:bounds.data_ends,data_ends:continuous_to,gaps:gaps.slice(0,10),gaps_total:gaps.length,sparse_days:sparse.slice(0,10),continuous_from,continuous_to,
            note:`${issues.join('; ') || 'No gaps or sparse days detected'}; daily coverage checked only for the last 400 days; for year or week analyses use continuous_from..continuous_to (inclusive UTC bounds) and state it.`}
    } catch {return unavailable}
}
export async function dataGuide() {
    const reg=required()
    const [coverage,rows]=await Promise.all([
        dataCoverage(),
        hogql('SELECT toString(distinct_id) AS distinct_id FROM events LIMIT 1',{}, {cache:true,ttlMs:600000}),
    ])
    const example=String(rows[0]?.distinct_id || ''), separator=config.properties.distinctIdSeparator
    const clientPart=config.properties.clientFromDistinctId, userPart=(reg.distinctIdParts?.indexOf('{user}') ?? -1)+1
    const literal=(s:string)=>`'${s.replaceAll("'","''")}'`
    const screen=prop(reg,'dialogName'), action=prop(reg,'action'), version=prop(reg,'version')
    return {
        app:reg.app,events:{...reg.events,messages:{event:reg.events.interaction,dialog_ids:reg.dialogs.messages},notices:{event:reg.events.interaction,dialog_ids:reg.dialogs.notices}},
        properties:reg.properties,
        identity:{CLIENT_FROM_DISTINCT_ID:clientPart,separator,parts:reg.distinctIdParts,example_distinct_id:example || null,
            client:{part:clientPart || null,property:clientPart ? null : config.properties.client,value:clientPart ? example.split(separator)[clientPart-1] ?? null : null,expression:`toString(${P.client})`},
            user:{part:userPart || null,value:userPart ? example.split(separator)[userPart-1] ?? null : example || null,expression:userExpr()}},
        coverage,
        run_sql:'posthog_exec command: call execute-sql {"query":"<HogQL>"}',
        sql_notes:['windowFunnel needs toDateTime(timestamp), not the DateTime64 timestamp','windowFunnel returns the max level reached, not per-stage counts; use countIf(level >= N) for cumulative stage counts'],
        posthog_tools:(()=>{
            const msgs=[...reg.dialogs.messages,...reg.dialogs.notices]
            const noMsg={key:reg.properties.dialog?.name || 'dialog_id',operator:'is_not',type:'event',value:msgs}
            const clientFilter={type:'hogql',key:`toString(${P.client}) = '<CLIENT>'`}
            const name=(k:string,d:string)=>(reg.properties as Record<string,{name?:string}|undefined>)[k]?.name || d
            const screenProp=name('dialogName','dialog_name'), buttonProp=name('button','action_name'), versionProp=name('version','')
            return {
                funnel:{tool:'query-funnel',note:'Count per session with funnelAggregateByHogQL properties.$session_id (default counts people). Steps are EventsNode with property filters; filter a client with the hogql property below.',
                    example:{kind:'FunnelsQuery',series:[{kind:'EventsNode',event:reg.events.screen,properties:[{key:screenProp,operator:'exact',type:'event',value:'<SCREEN>'}]},{kind:'EventsNode',event:reg.events.interaction,properties:[{key:screenProp,operator:'exact',type:'event',value:'<SCREEN>'},{key:buttonProp,operator:'exact',type:'event',value:reg.submitButtons[0] || 'Save'}]}],
                        properties:[clientFilter],dateRange:{date_from:'<FROM>',date_to:'<TO>'},funnelsFilter:{funnelAggregateByHogQL:'properties.$session_id',funnelWindowInterval:1,funnelWindowIntervalUnit:'hour'},breakdownFilter:{breakdown:versionProp || screenProp,breakdown_type:'event'}}},
                paths:{tool:'query-paths',note:`Screen-to-screen paths. "Users" counts path visits (a person's activity split at 30 minutes idle), NOT distinct people: say "visits". Leave out messages (${msgs.join(', ')}) with the property shown. A year across all clients can exceed PostHog's memory: filter to a client, or run one quarter at a time.`,
                    example:{kind:'PathsQuery',dateRange:{date_from:'<FROM>',date_to:'<TO>'},properties:[clientFilter,noMsg],pathsFilter:{includeEventTypes:['hogql'],pathsHogQLExpression:`properties.${screenProp}`,startPoint:'<SCREEN>',stepLimit:3,edgeLimit:20}}},
            }
        })(),
        complete_weeks:'Last N complete weeks: replace N (4 below); coverage.data_ends excludes sparse replay-fixture days. Use the Monday containing data_ends as the exclusive upper bound, and keep the lower bound within continuous_from. If coverage is unknown, do not infer complete weeks.',
        examples:[
            `SELECT ${screen} AS screen, uniq(properties.$session_id) AS sessions FROM events WHERE event = ${literal(reg.events.screen)} GROUP BY screen LIMIT 20`,
            `SELECT ${screen} AS screen, count() AS opens FROM events WHERE event = ${literal(reg.events.screen)} AND ${action} = ${literal(reg.screenActions.open[0] || 'OPEN')} GROUP BY screen LIMIT 20`,
            `SELECT ${version} AS version, uniq(distinct_id) AS users FROM events WHERE notEmpty(${version}) GROUP BY version LIMIT 20`,
            `SELECT countIf(level >= 1) AS stage_1, countIf(level >= 2) AS stage_2, countIf(level >= 3) AS stage_3 FROM (SELECT distinct_id, properties.$session_id AS session_id, windowFunnel(3600)(toDateTime(timestamp), event = ${literal(reg.events.screen)} AND ${action} = ${literal(reg.screenActions.open[0] || 'OPEN')}, ${action} = 'CHANGE', ${prop(reg,'button')} = ${literal(reg.submitButtons[0] || 'Save')}) AS level FROM events GROUP BY distinct_id, session_id)`,
            `WITH toStartOfWeek(toDateTime(${literal(coverage.data_ends ? String(coverage.data_ends).slice(0,10) : 'REPLACE_WITH_coverage.data_ends')}, 'UTC'), 1) AS end_week SELECT toStartOfWeek(timestamp, 1) AS week, uniq(distinct_id) AS users FROM events WHERE timestamp >= end_week - INTERVAL 4 WEEK AND timestamp < end_week GROUP BY week ORDER BY week`,
        ],
    }
}
