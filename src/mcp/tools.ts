import { randomUUID, createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { config, posthogMcpActive } from '../core/config.ts'
import { resolveClient } from '../core/resolve.ts'
import { dataGuide, dataCoverage } from '../core/dataguide.ts'
import { findSessions } from '../core/appevents.ts'
import { replayUrl, markPartial } from '../core/posthog.ts'
import { renderClip, clipName, pendingRenders } from '../core/clip.ts'
import { pinGraph, listPinned, unpinGraph, graphSchema, pinnedUrl } from '../core/pinned.ts'
import { ToolInputError } from '../core/toolinputerror.ts'
import { toolContext, auditClient } from '../core/toolcontext.ts'
import { recordClip, setSaved } from '../service/replays.ts'
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
import { resolveTime, timeShape, inclusiveWindow, windowContext } from './timeinput.ts'
import { runRecipe } from './recipes.ts'
import { EXAMPLES, D } from './descriptions.ts'
import { withContext } from './result.ts'
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
        let release:(()=>void)|undefined,result:any,error_kind:string|undefined,job_hash:string|undefined,result_kind:string|undefined,origin={name,args:args as Record<string,unknown>}
        const context={clients,correlationId:correlation,window:undefined as ReturnType<typeof resolveTime>|undefined}
        try {
            release=toolLimiter.acquire(caller?.email || caller?.who || 'stdio',caller?.tokenId || 'stdio',name,name==='posthog_exec' && isPosthogQuery(args.command) ? 5 : undefined)
            result=await toolContext.run(context,async()=>{
                const execute=AsyncLocalStorage.bind(async(query?:{signal:AbortSignal;timeoutMs:number})=>query ? posthogQueryContext.run(query,()=>call(args,extra)) : call(args,extra))
                let answer=jobBacked(name,!!cfg.annotations?.readOnlyHint,args) ? await dispatch.execute(name,args,undefined,extra,execute) : await execute()
                if(answer instanceof JobAnswer) {
                    job_hash=createHash('sha256').update(answer.id).digest('hex');result_kind=answer.started?'job_started':'job_result'
                    context.window=answer.context.window
                    origin={name:answer.context.name,args:answer.context.args}
                    for(const id of answer.context.clients || [])clients.add(id)
                    answer=answer.result
                }
                return answer
            })
            if(result && !result.isError)result=withContext(result,origin.name,origin.args,context.window ? windowContext(context.window) : undefined)
        } catch(e) {const mapped=toolError(e,origin.name,correlation,EXAMPLES[origin.name]);result=mapped.result;error_kind=mapped.kind}
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
        description:D.posthog_exec,inputSchema:{command:z.string({error:'command is required, e.g. {"command":"recipe top_screens {\\"client\\":\\"C08\\",\\"window\\":{\\"last\\":\\"30d\\"}}"}'}).min(1).max(100000)}
    },async({command})=>/^\s*recipe\b/i.test(command) ? jsonResult('Recipe',await runRecipe(command)) : posthogExec(command,{url:config.posthog.mcpUrl,apiKey:config.posthog.mcpApiKey,name:config.mcp.name}))
    server.registerTool('data_guide',{description:D.data_guide,inputSchema:{},annotations:{readOnlyHint:true}},async()=>jsonResult('Data guide',await dataGuide()))
    server.registerTool('resolve_client',{description:D.resolve_client,inputSchema:{query:z.string({error:'query is the client code or name, user, email or distinct id, e.g. {"query":"C08","window":{"last":"7d"}}'}).min(1).max(320),...timeShape},annotations:{readOnlyHint:true}},async args=>{
        const window=resolveTime(args,90)
        const context=toolContext.getStore();if(context)context.window=window
        const matches=await resolveClient({text:args.query,from:window.from,to:window.to})
        for(const m of matches)auditClient(m.id)
        return jsonResult('Client matches',{...markPartial({}, !!matches.truncated), matches:matches.map(({users,emails,distinct_ids,user_event_counts,events,last_seen,...m})=>({...m,last_seen_in_window:last_seen,client_events:events})),coverage:await dataCoverage().catch(()=>null)})
    })
    server.registerTool('find_sessions',{description:D.find_sessions,inputSchema:{client:z.string({error:'client is required (a client code or name, or a user code/email), e.g. {"client":"C08","screen":"LinkListReqv","window":{"last":"7d"}}'}).min(1).max(320),recorded_only:z.boolean().optional().describe('Only sessions with a recording (set when asked for a replay to watch).'),detail:z.boolean().optional().describe('Include detailed actions, outcomes, context, and session bounds.'),screen:z.string().max(200).optional().describe('Dialog/tab name or code, e.g. LinkListReqv.'),what:z.string().max(500).optional().describe('Case-insensitive text in an action, button, field or message, e.g. "CSV Export" or "Error saving trade".'),user:z.string().max(320).optional().describe('User code, email or distinct id; narrows to that user.'),...timeShape,limit:z.number().int().min(1).max(20).default(10).describe('Sessions per page, 1-20.'),cursor:z.string().max(250).optional().describe('next_cursor from the previous page.')},annotations:{readOnlyHint:true}},async args=>{
        const w=resolveTime(args,30)
        const context=toolContext.getStore();if(context)context.window=w
        if(+w.to-+w.from>366*86400000)throw new ToolInputError('find_sessions searches at most one year (366 days) at a time; use a window of at most {"last":"365d"} and page older years separately.')
        const matches=await resolveClient({text:args.client,from:w.from,to:w.to}), best=matches[0]
        if(!best && matches.truncated)return jsonResult('Sessions',{sessions:[],...markPartial({},true)})
        if(!best)throw new ToolInputError(`No client matches "${String(args.client).slice(0,80)}" in the window. Call resolve_client to find the client code, or widen the window.`)
        auditClient(best.id)
        if ((best as {outside_window?:boolean}).outside_window) return jsonResult('Sessions',{sessions:[],client:best.id,matched_user:best.matched_user,note:`${best.name || best.id} exists but has no events between ${w.from.toISOString().slice(0,10)} and ${new Date(+w.to-1).toISOString().slice(0,10)}. It was last seen ${String(best.last_seen).slice(0,10)}.`})
        return jsonResult('Sessions',await findSessions({clientId:best.id,from:w.from,to:w.to,screen:args.screen,what:args.what,user:args.user || best.matched_user,limit:args.limit,cursor:args.cursor,recordedOnly:args.recorded_only === true,detail:args.detail === true}))
    })
    server.registerTool('get_replay_link',{description:D.get_replay_link,inputSchema:{session_id:z.string({error:'session_id is required (from find_sessions), e.g. {"session_id":"b0b07a50-a614-43d1-cb4d-d52df885cb71","start_s":0}'}).min(1),start_s:z.number({error:'start_s is required: seconds into the session, 0 for the start'}).min(0),duration_s:z.number().min(3).max(120).default(30),save:z.boolean().default(false)}},async({session_id:raw,start_s,duration_s,save})=>{
        const session_id=sessionIdOf(raw), request={sessionId:session_id,startOffsetS:start_s,durationS:duration_s}
        const replay_url=replayUrl(session_id,start_s), refusal=mcpClipRefusal()
        if(refusal)return jsonResult('Clip unavailable',{replay_url,clip_url:`${config.service.publicUrl}/replays?url=${encodeURIComponent(replay_url)}`,reason:refusal})
        try {
        const clip=await waitForReplayClip(request,caller?.email || caller?.who,{render:replayDeps.render,record:async clip=>{const owner=caller?.email || caller?.who || 'stdio';await replayDeps.record(clip,owner);if(save && setSaved(clip.name,owner,true))audit(owner,'clip.saved',{clip:clip.name})},backgroundError:e=>{toolError(e,'get_replay_link')}})
        return jsonResult(clip?'Clip ready':'Clip rendering; it will finish in the background',{replay_url,clip_url:`${config.service.publicUrl}/replays?clip=${encodeURIComponent(clip?.name || clipName(request))}`})
        } catch(e) {
            const error=toolError(e,'get_replay_link')
            return jsonResult('Clip unavailable',{replay_url,clip_url:`${config.service.publicUrl}/replays?url=${encodeURIComponent(replay_url)}`,error:error.result.content[0].text})
        }
    })
    server.registerTool('pin_graph',{description:D.pin_graph,inputSchema:graphSchema},async args=>{
        const graph=pinGraph(args,caller?.email || caller?.who || 'stdio')
        audit(graph.saved_by,'graph.pinned',{id:graph.id,title:graph.title})
        return jsonResult('Graph saved',{id:graph.id,url:pinnedUrl(graph.id)})
    })
    server.registerTool('list_pinned',{description:D.list_pinned,inputSchema:{limit:z.number().int().min(1).max(100).default(50),offset:z.number().int().min(0).default(0)},annotations:{readOnlyHint:true}},async({limit,offset})=>jsonResult('Pinned',listPinned(limit,offset).map(({chart,...g})=>({...g,type:chart.type,url:pinnedUrl(g.id)}))))
    server.registerTool('unpin_graph',{description:D.unpin_graph,inputSchema:{id:z.string({error:'id is the snapshot id from pin_graph or list_pinned, e.g. {"id":"6f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f"}'}).uuid({error:'id must be a snapshot UUID from pin_graph or list_pinned'})}},async({id})=>jsonResult('Graph deleted',{deleted:unpinGraph(id,caller?.email || caller?.who || 'stdio',caller?.admin)}))
    registerSurveyTools(server,caller)
}
