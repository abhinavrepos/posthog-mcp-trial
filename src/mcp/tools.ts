import { randomUUID, createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { config, posthogMcpActive } from '../core/config.ts'
import { resolveClient } from '../core/resolve.ts'
import { dataGuide, dataCoverage } from '../core/dataguide.ts'
import { findSessions } from '../core/appevents.ts'
import { replayUrl } from '../core/posthog.ts'
import { renderClip, clipName, pendingRenders } from '../core/clip.ts'
import { pinGraph, listPinned, unpinGraph, graphSchema, pinnedUrl } from '../core/pinned.ts'
import { ToolInputError } from '../core/toolinputerror.ts'
import { toolContext, auditClient } from '../core/toolcontext.ts'
import { recordClip } from '../service/replays.ts'
import { audit, type ChatCaller } from '../service/access.ts'
import { registerSurveyTools, surveyToolNames } from './surveytools.ts'
import { jsonResult } from './result.ts'
import { outputFilter } from './output-filter.ts'
import { posthogExec } from './posthog-proxy.ts'
import { posthogQueryContext, isPosthogQuery } from './posthog-query.ts'
import { toolError } from './toolerror.ts'
import { toolLimiter } from './ratelimit.ts'
import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { writeToolAudit } from './toolaudit.ts'
import { createJobDispatch, installJobTools, JobAnswer, jobBacked, type JobOptions } from './jobtools.ts'
import { resolveTime, timeShape, inclusiveWindow } from './timeinput.ts'
import { waitForReplayClip } from './replay-clip.ts'
export const DIRECT_CALL = 'Call directly with JSON arguments.'
export const CORE_TOOLS=['get_job_result','data_guide','resolve_client','find_sessions','get_replay_link','pin_graph','list_pinned','unpin_graph']
export const lensToolNames=()=>[...(posthogMcpActive() && config.posthog.mcpViaLens ? ['posthog_exec'] : []),...CORE_TOOLS,...surveyToolNames()]
type Caller=Pick<ChatCaller,'who'|'surveyRole'> & Partial<ChatCaller>
export function sessionIdOf(value:string) {return (/\/replay\/([\w-]+)/.exec(value)?.[1] || value).trim()}
const renders:number[]=[]
export function mcpClipRefusal() {
    if(pendingRenders()>=20)return 'the render queue is full'
    while(renders.length && Date.now()-renders[0]>=3600000)renders.shift()
    if(renders.length >= (Number(process.env.CLIPS_PER_HOUR)||20))return 'the hourly MCP clip limit has been reached'
    renders.push(Date.now())
}
// All registered results, including survey tools and job polling, cross this boundary once.
export function wrapTools(server:McpServer, _insights=false, caller?:Caller, options?:JobOptions) {
    const dispatch=createJobDispatch(caller,options), register=server.registerTool.bind(server)
    server.registerTool=((name:string,cfg:any,call:any)=> (register as any)(name,cfg,async(args:any,extra:any)=>{
        const started=Date.now(), correlation=randomUUID(), clients=new Set<string>()
        let release:(()=>void)|undefined,result:any,error_kind:string|undefined,job_hash:string|undefined,result_kind:string|undefined
        const context={clients,correlationId:correlation,window:undefined as ReturnType<typeof resolveTime>|undefined}
        try {
            release=toolLimiter.acquire(caller?.email || caller?.who || 'stdio',caller?.tokenId || 'stdio',name,name==='posthog_exec' && isPosthogQuery(args.command) ? 5 : undefined)
            result=await toolContext.run(context,async()=>{
                const execute=AsyncLocalStorage.bind(async(query?:{signal:AbortSignal;timeoutMs:number})=>query ? posthogQueryContext.run(query,()=>call(args,extra)) : call(args,extra))
                let answer=jobBacked(name,!!cfg.annotations?.readOnlyHint,args) ? await dispatch.execute(name,args,undefined,extra,execute) : await execute()
                if(answer instanceof JobAnswer) {
                    job_hash=createHash('sha256').update(answer.id).digest('hex');result_kind=answer.started?'job_started':'job_result'
                    context.window=answer.context.window
                    for(const id of answer.context.clients || [])clients.add(id)
                    answer=answer.result
                }
                return answer
            })
        } catch(e) {const mapped=toolError(e,name,correlation);result=mapped.result;error_kind=mapped.kind}
        finally {
            release?.()
            try { writeToolAudit({at:new Date(started).toISOString(),user_email:caller?.email || caller?.who || 'stdio',token_id:caller?.tokenId || 'stdio',tool:name,argument_keys:Object.keys(args),resolved_window:context.window ? inclusiveWindow(context.window) : undefined,client_ids:[...clients],duration_ms:Date.now()-started,result_chars:JSON.stringify(result || {}).length,is_error:!!result?.isError,error_kind,job_hash,result_kind,correlation_id:correlation}) } catch(e) { errorDiagnostic(e,name,'audit',correlation) }
        }
        return outputFilter(result)
    }) as never) as typeof server.registerTool
    return dispatch
}
export function registerTools(server:McpServer,_ai?:unknown,caller?:Caller,_raw=false,replayDeps={render:renderClip,record:recordClip}) {
    installJobTools(server,wrapTools(server,false,caller))
    if(config.posthog.mcpViaLens && posthogMcpActive())server.registerTool('posthog_exec',{
        description:'Run PostHog tools for analysis. Call data_guide before SQL; use resolve_client for client and user codes (client codes are not screens). Syntax: tools / info <tool> / call <tool> <json>. Long calls return a job_id within 20 seconds; poll get_job_result.',inputSchema:{command:z.string().max(100000)}
    },async({command})=>posthogExec(command,{url:config.posthog.mcpUrl,apiKey:config.posthog.mcpApiKey,name:config.mcp.name}))
    server.registerTool('data_guide',{description:'Call first before writing PostHog SQL. Returns configured event/property vocabulary, identity layout, project coverage and example HogQL. No time window.',inputSchema:{},annotations:{readOnlyHint:true}},async()=>jsonResult('Data guide',await dataGuide()))
    server.registerTool('resolve_client',{description:'Resolve a client name, code, email, user or distinct id from live PostHog events. Returns match reasons, matched user, last seen, client_events (whole client), user_events (matched user only) and project coverage.',inputSchema:{query:z.string().min(1).max(320),...timeShape},annotations:{readOnlyHint:true}},async args=>{
        const window=resolveTime(args,90)
        const context=toolContext.getStore();if(context)context.window=window
        const matches=await resolveClient({text:args.query,from:window.from,to:window.to})
        for(const m of matches)auditClient(m.id)
        return jsonResult('Client matches',{matches:matches.map(({users,emails,distinct_ids,user_event_counts,events,...m})=>({...m,client_events:events})),coverage:await dataCoverage().catch(()=>null)})
    })
    server.registerTool('find_sessions',{description:'Find client sessions newest first. Optional screen matches dialog/tab name or code; what matches action/message text; user accepts email or distinct-id user. Up to one year. Returns PostHog replay and Lens clip links; use next_cursor for older sessions. Screen and what are independent session filters; actions show their own screen, target counts and next message outcome. Event and recording bounds are separate. Pages cap actions at 10, screens at 15 and size near 20,000 characters. When the person wants a replay to watch, set recorded_only: true so only sessions with a playable recording come back.',inputSchema:{client:z.string().min(1).max(320),recorded_only:z.boolean().optional().describe('Only sessions with a recording (set when asked for a replay to watch).'),screen:z.string().max(200).optional(),what:z.string().max(500).optional(),user:z.string().max(320).optional(),...timeShape,limit:z.number().int().min(1).max(20).default(10),cursor:z.string().max(250).optional()},annotations:{readOnlyHint:true}},async args=>{
        const w=resolveTime(args,30)
        const context=toolContext.getStore();if(context)context.window=w
        if(+w.to-+w.from>366*86400000)throw new ToolInputError('Choose a time window of at most one year.')
        const matches=await resolveClient({text:args.client,from:w.from,to:w.to}), best=matches[0]
        if(!best)throw new ToolInputError('No client matches. Try a client code or user.')
        auditClient(best.id)
        if ((best as {outside_window?:boolean}).outside_window) return jsonResult('Sessions',{sessions:[],client:best.id,matched_user:best.matched_user,note:`${best.name || best.id} exists but has no events between ${w.from.toISOString().slice(0,10)} and ${new Date(+w.to-1).toISOString().slice(0,10)}. It was last seen ${String(best.last_seen).slice(0,10)}.`})
        return jsonResult('Sessions',await findSessions({clientId:best.id,from:w.from,to:w.to,screen:args.screen,what:args.what,user:args.user || best.matched_user,limit:args.limit,cursor:args.cursor,recordedOnly:args.recorded_only === true}))
    })
    server.registerTool('get_replay_link',{description:'Get PostHog replay and Lens MP4 clip links. Waits up to 25 seconds for rendering; unfinished clips complete in the background.',inputSchema:{session_id:z.string().min(1),start_s:z.number().min(0),duration_s:z.number().min(3).max(120).default(30)}},async({session_id:raw,start_s,duration_s})=>{
        const session_id=sessionIdOf(raw), request={sessionId:session_id,startOffsetS:start_s,durationS:duration_s}
        const replay_url=replayUrl(session_id,start_s), refusal=mcpClipRefusal()
        if(refusal)return jsonResult('Clip unavailable',{replay_url,reason:refusal})
        try {
        const clip=await waitForReplayClip(request,caller?.email || caller?.who,{render:replayDeps.render,record:clip=>replayDeps.record(clip,caller?.email || caller?.who || 'stdio'),backgroundError:e=>{toolError(e,'get_replay_link')}})
        return jsonResult(clip?'Clip ready':'Clip rendering; it will finish in the background',{replay_url,clip_url:`${config.service.publicUrl}/replays?clip=${encodeURIComponent(clip?.name || clipName(request))}`})
        } catch(e) {
            const error=toolError(e,'get_replay_link')
            return jsonResult('Clip unavailable',{replay_url,clip_url:`${config.service.publicUrl}/replays?url=${encodeURIComponent(replay_url)}`,error:error.result.content[0].text})
        }
    })
    server.registerTool('pin_graph',{description:'Save a graph snapshot to Pinned. It does not refresh. At most 20 series and 500 points; each series must match x length.',inputSchema:graphSchema},async args=>{
        const graph=pinGraph(args,caller?.email || caller?.who || 'stdio')
        audit(graph.saved_by,'graph.pinned',{id:graph.id,title:graph.title})
        return jsonResult('Graph saved',{id:graph.id,url:pinnedUrl(graph.id)})
    })
    server.registerTool('list_pinned',{description:'List saved graph snapshots.',inputSchema:{limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).default(0)},annotations:{readOnlyHint:true}},async({limit,offset})=>jsonResult('Pinned',listPinned(limit,offset).map(({chart,...g})=>({...g,type:chart.type,url:pinnedUrl(g.id)}))))
    server.registerTool('unpin_graph',{description:'Delete your graph snapshot. Admins may delete any snapshot.',inputSchema:{id:z.string().uuid()}},async({id})=>jsonResult('Graph deleted',{deleted:unpinGraph(id,caller?.email || caller?.who || 'stdio',caller?.admin)}))
    registerSurveyTools(server,caller)
}
