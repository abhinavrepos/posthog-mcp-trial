import { ToolInputError } from '../core/toolinputerror.ts'
import { ingestMessages } from '../core/ingestmessages.ts'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { isPosthogQuery, posthogQueryContext } from './posthog-query.ts'
import { isPublicToolError, publicToolError } from './publicerror.ts'
import { randomUUID, createHash } from 'node:crypto'
import { isMainThread } from 'node:worker_threads'
import { timeShape, checkTime, resolveTime, inclusiveWindow } from './timeinput.ts'
import { toolError, argumentExample } from './toolerror.ts'
import { toolLimiter } from './ratelimit.ts'
import { writeToolAudit } from './toolaudit.ts'
import { toolContext, auditClient, requestedToolWindow } from '../core/toolcontext.ts'
import { privacyMode } from '../core/anonymise.ts'
import { installJobTools, createJobDispatch, JobAnswer, JOB_TOOLS, jobBacked, type JobOptions } from './jobtools.ts'
import { privacyCurrent, PRIVACY_CHANGED, privacyKey, withPrivacy } from '../core/anonymise.ts'
import { analyticalResult } from './historyresult.ts'
import { DETAIL_TOOLS, detailInput, applyDetail, outputSchemaFor, structuredOf, ANALYSIS_OUTPUT, ROWS_OUTPUT } from './structured.ts'
// MCP tools over the same core as the Jira automation. Each one answers a question a PM or
// support lead asks that Jira alone cannot.
import { jsonResult, reportResult, safeResult } from './result.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { appEvents, clientSignalsReport, describeAppEvents, dialogFriction, findTrade, sessionStory, slowAttempts, topPains } from '../core/appevents.ts'
import { completionWorkflow, discoverWorkflows, workflowCompletionReport } from '../core/workflowqueries.ts'
import { WORKFLOW_NAME_LIMIT } from '../core/workflows.ts'
import { revalBrief } from '../core/brief.ts'
import { waitForReplayClip } from './replay-clip.ts'
import { clipName, pendingRenders, renderClip } from '../core/clip.ts'
import { errorImpact } from '../core/impact.ts'
import { bestPerSession, findIncidents } from '../core/incidents.ts'
import { messageDoctor } from '../core/messagedoctor.ts'
import { config, posthogMcpActive } from '../core/config.ts'
import { posthogExec, execRoutingLine } from './posthog-proxy.ts'
import { replayUrl } from '../core/posthog.ts'
import {
    evidenceMarkdown,
    feedbackMarkdown,
    outcomesMarkdown,
    recompute,
    recordVerdict,
    releasesMarkdown,
    resolveScope,
    setLink,
    syncReleases,
    ticketRelease,
    evidenceMarkdown as ticketText,
    keptNames,
    quarters,
} from '../core/releases.ts'
import { addComment } from '../jira/client.ts'
import { clientSource } from '../core/props.ts'
import { resolveClient, resolveScreen } from '../core/resolve.ts'
import { struggleSessions } from '../core/silent.ts'
import { emailsIn } from '../core/text.ts'
import { parseTimeWindow } from '../core/timewindow.ts'
import { triage, type TriageAi } from '../core/triage.ts'
import { screenUsage } from '../core/usage.ts'
import { recordClip } from '../service/replays.ts'
import { registerSurveyTools, surveyToolNames } from './surveytools.ts'
import { registerDashboardTools, dashboardToolNames } from './dashboardtools.ts'
import type { ChatCaller } from '../service/access.ts'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
const text = (t: string): { content: Content[] } => ({ content: [{ type: 'text', text: t }] })
const json = jsonResult

async function pickClient(client: string) {
    const matches = await resolveClient({ text: client, emails: emailsIn(client), clientHint: client })
    if (!matches.length) throw new ToolInputError('No client matches. Try the client name, its id, or a user email.')
    auditClient(matches[0].id)
    return { best: matches[0], others: matches.slice(1, 4) }
}

function screenPath(screen?: string): string | undefined {
    if (!screen) return undefined
    if (screen.startsWith('/')) return screen
    const m = resolveScreen(screen)[0]
    if (!m) throw new ToolInputError('No screen matches. Use a configured screen name or path.')
    return m.path
}

const when = z.string().optional().describe('When, in plain words: "yesterday afternoon", "30 Oct around 14:00", "last 3 days". Default: last 7 days.')
const tz = z.string().optional().describe('IANA timezone the "when" is in, e.g. Europe/Berlin. Default UTC.')

// PostHog's own MCP server has a single tool, exec, that takes a command string ("call <tool> {json}").
// With both servers connected, Claude sometimes calls this server's tools that way too, and then the
// arguments never arrive. Every description says how these tools are called, since a client may not
// pass the server instructions on to Claude.
export const DIRECT_CALL = 'Call this tool directly with the arguments below, never through PostHog\'s exec tool or as a command string.'

/** A PostHog replay link (…/replay/<id>?t=…) or a bare session id, as a session id. */
export function sessionIdOf(value: string): string {
    const m = /\/replay\/([0-9A-Za-z-]{8,})/.exec(value)
    return (m ? m[1] : value).trim()
}

// The tracked app's name in descriptions (from APP_EVENTS_FILE): "which Reval client".
const A = appEvents()?.app || 'your app'

// Every tool name, for PostHog's proxied exec description ("use the lens server's tools (...)").
export const CORE_TOOLS = ['get_job_result', 'resolve_client', 'find_client_incidents', 'get_replay_link', 'screen_usage', 'error_blast_radius', 'find_silent_issues', 'triage_ticket']
export const RELEASE_TOOLS = ['list_releases', 'release_outcomes', 'ticket_evidence', 'client_feedback', 'record_verdict', 'correct_ticket_link', 'refresh_releases']
export const APP_EVENT_TOOLS = ['reval_brief', 'describe_app_events', 'top_pains', 'dialog_friction', 'session_story', 'attempt_timings', 'find_trade', 'client_signals', 'discover_workflows', 'workflow_completion', 'message_doctor', 'aggregate_events']
export const lensToolNames = (): string[] => [...CORE_TOOLS, ...(config.features.jira ? RELEASE_TOOLS : []), ...(appEvents() ? APP_EVENT_TOOLS : []), ...surveyToolNames(), ...dashboardToolNames()]

// Answers of the read-only analysis tools, shared by every chat session: the same question within two
// minutes is answered from memory, and identical questions asked at once share one run. Only these
// tools: answers are separated by insights access where needed. Errors are never kept.
export const CACHED_TOOLS = new Set(['reval_brief', 'describe_app_events', 'top_pains', 'dialog_friction', 'session_story', 'attempt_timings', 'find_trade', 'client_signals', 'discover_workflows', 'workflow_completion', 'message_doctor', 'screen_usage', 'find_silent_issues', 'error_blast_radius', 'aggregate_events'])
// All of these read PostHog events only. Lens's own writes (record_verdict, correct_ticket_link,
// refresh_releases, triage_ticket) change releases, verdicts and ticket links, which only uncached tools
// read (release_outcomes, list_releases, ticket_evidence...), so a write never needs to drop these answers.
const TOOL_TTL_MS = Math.max(0, Number(process.env.LENS_TOOL_CACHE_SECONDS ?? 120)) * 1000
const TOOL_CACHE_BYTES = 16 * 1024 * 1024
const toolAnswers = new Map<string, { at: number; value: unknown; bytes: number; ttl: number }>()
const toolFlights = new Map<string, Promise<unknown>>()
let toolBytes = 0
let toolCacheEpoch = 0
ingestMessages.on('stored', () => clearToolAnswers())
// Arguments as text with object keys sorted at every level, so {a, b} and {b, a} are the same question.
const stable = (v: unknown): string => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',')}}`
    : JSON.stringify(v) ?? 'null'
export function clearToolAnswers(): void { toolCacheEpoch++; toolAnswers.clear(); toolFlights.clear(); toolBytes = 0 }
// Calls made by the background pre-warm (src/mcp/prewarm.ts) recompute their answer and keep it until the
// next round. Only those calls: the flag travels with the pre-warm's own async work, so chat questions
// asked during a round still get the kept answer at once.
const prewarming = new AsyncLocalStorage<number>()
export function withPrewarm<T>(ttlMs: number, work: () => Promise<T>): Promise<T> {
    return prewarming.run(ttlMs, work)
}
function remember(key: string, value: unknown, ttl: number): void {
    const bytes = JSON.stringify(value).length
    if (bytes > TOOL_CACHE_BYTES / 8) return // one huge answer must not push everything else out
    const old = toolAnswers.get(key); if (old) { toolBytes -= old.bytes; toolAnswers.delete(key) }
    toolAnswers.set(key, { at: Date.now(), value, bytes, ttl }); toolBytes += bytes
    for (const [k, v] of toolAnswers) { if (toolBytes <= TOOL_CACHE_BYTES && toolAnswers.size <= 256) break; toolAnswers.delete(k); toolBytes -= v.bytes }
}
export async function cachedToolCall(name: string, args: unknown, run: () => Promise<unknown>): Promise<unknown> {
    if (!TOOL_TTL_MS) return run()
    const key = privacyKey() + name + '\u0000' + stable(args ?? {})
    const prewarmTtl = prewarming.getStore() ?? 0
    const hit = toolAnswers.get(key), refreshing = prewarmTtl > 0
    if (hit && !refreshing && Date.now() - hit.at < hit.ttl) { toolAnswers.delete(key); toolAnswers.set(key, hit); return structuredClone(hit.value) }
    // A chat question while the pre-warm refreshes this answer gets the kept one rather than waiting.
    if (hit && !refreshing && toolFlights.has(key)) return structuredClone(hit.value)
    let flight = toolFlights.get(key)
    if (!flight) {
        const epoch = toolCacheEpoch
        const ttl = Math.max(TOOL_TTL_MS, prewarmTtl)
        flight = run().then((value) => {
            if (epoch === toolCacheEpoch && !(value as { isError?: boolean } | undefined)?.isError) remember(key, value, ttl)
            return value
        }).finally(() => { if (toolFlights.get(key) === flight) toolFlights.delete(key) })
        toolFlights.set(key, flight)
    }
    return structuredClone(await flight)
}

const mcpRenders: number[] = []
export function mcpClipRefusal(): string | undefined {
    if (pendingRenders() >= 20) return 'the render queue is full'
    const now = Date.now()
    while (mcpRenders.length && now - mcpRenders[0]! >= 3_600_000) mcpRenders.shift()
    if (mcpRenders.length >= (Number(process.env.CLIPS_PER_HOUR) || 20)) return 'the hourly MCP clip limit has been reached'
    mcpRenders.push(now)
}

// Every Lens tool result goes through the AI-safety pass (src/core/aisafety.ts) at this one boundary,
// whether or not client anonymisation is on. Execution errors are mapped to actionable public messages;
// their full diagnostics stay in server logs, joined to the metadata audit by correlation id.
export const WINDOW_DEFAULTS: Record<string,number|string> = {screen_usage:30,error_blast_radius:30,describe_app_events:7,client_signals:14,find_trade:30,aggregate_events:30,reval_brief:14,task_map:28,flow_time:90,rescue_queue:28,set_rescue_status:28,client_experience:28,friction_hotspots:28,client_story:182,pin_dashboard:28,signal_scorecard:364,design_survey:14,list_surveys:30,survey_results:90,client_activity_changes:'last_4_years',compare_client_patterns:'last_4_years'}
type ToolCaller = Pick<ChatCaller, 'who'> & Partial<Pick<ChatCaller,'email'|'tokenId'|'surveyRole'|'dashboardRole'|'admin'|'insights'>>
/** Account for authenticated invocations refused by the transport's privacy guard. */
export function auditToolRefusal(name:string,keys:string[],refusal:unknown,caller?:ToolCaller): unknown {
    const started=Date.now(),correlation_id=randomUUID()
    let release:(()=>void)|undefined,kind=name==='unknown' ? 'unknown_tool' : 'privacy_refused'
    let result: unknown = refusal && typeof refusal === 'object' && 'code' in refusal ? refusal : {...(refusal as object),isError:true,content:[...(Array.isArray((refusal as {content?:unknown[]})?.content) ? (refusal as {content:unknown[]}).content : []),{type:'text',text:`Correlation id: ${correlation_id}`}]}
    try {release=toolLimiter.acquire(caller?.email || caller?.who || 'stdio',caller?.tokenId || caller?.who || 'stdio',name)}
    catch(error) {const mapped=toolError(error,name,correlation_id);result=refusal && typeof refusal==='object' && 'code' in refusal ? {code:-32602,message:mapped.result.content[0].text} : mapped.result;kind=mapped.kind}
    finally {
        release?.()
        try {writeToolAudit({at:new Date(started).toISOString(),user_email:caller?.email || caller?.who || 'stdio',token_id:caller?.tokenId || 'stdio',tool:name,argument_keys:keys,client_ids:[],duration_ms:Date.now()-started,result_chars:JSON.stringify(result).length,is_error:true,error_kind:kind,privacy_mode:privacyMode(),correlation_id})}
        catch(error) {errorDiagnostic(error,name,'audit',correlation_id)}
    }
    return result
}
/** A job handle after the privacy pass, with structuredContent parsed from its own first text block. Applied to
 * every JobAnswer, so a handle can never reach an outputSchema tool's client without structuredContent. */
function runningHandle(safe: unknown, jobId: string): unknown {
    const r = safe as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] }
    if (!r || r.isError || r.structuredContent || typeof r.content?.[0]?.text !== 'string') return safe
    try { const value = structuredOf(JSON.parse(r.content[0].text)); return value?.status === 'running' && value.job_id === jobId ? { ...r, structuredContent: value } : safe }
    catch { return safe }
}
export function wrapTools(server: McpServer, insights = false, caller?: ToolCaller, jobOptions?: JobOptions) {
    const dispatch = createJobDispatch(caller, jobOptions)
    const register = server.registerTool.bind(server)
    const setRequestHandler = server.server.setRequestHandler.bind(server.server)
    server.server.setRequestHandler = ((requestSchema: unknown, handler: (request:any, extra:any)=>unknown) => {
        return setRequestHandler(requestSchema as never, (async (request:any,extra:any) => {
            if(request.method==='tools/call') {
                const registry=(server as unknown as {_registeredTools: Record<string,unknown>})._registeredTools
                if(!Object.hasOwn(registry,request.params.name)) {
                    const error={code:-32602,message:'Unknown tool.'}
                    const answer=auditToolRefusal('unknown',[],error,caller) as {code?:number;message?:string;content?:{text:string}[]}
                    throw new McpError(answer.code ?? -32602,answer.message ?? answer.content?.[0]?.text ?? 'Unknown tool.')
                }
            }
            return handler(request,extra)
        }) as never)
    }) as typeof server.server.setRequestHandler

    // The SDK otherwise validates before invoking handlers. Delegate that step to our boundary so
    // rejected input also gets rate accounting, audit, and a safe execution error. listTools still
    // advertises the full strict schema. This SDK integration is covered by in-memory MCP tests.
    const boundary = server as unknown as {validateToolInput:(tool:unknown,args:unknown,name:string)=>Promise<unknown>}
    const validate = boundary.validateToolInput.bind(server)
    const wrapped = new Set<string>()
    boundary.validateToolInput = (tool,args,name) => wrapped.has(name) ? Promise.resolve(args ?? {}) : validate(tool,args,name)
    server.registerTool = ((name: string, cfg: { description?: string; inputSchema?: z.ZodRawShape; annotations?: {readOnlyHint?: boolean} }, cb: unknown) => {
        const isJob = (args: {command?:unknown} = {}) => jobBacked(name,cfg.annotations?.readOnlyHint ?? JOB_TOOLS.has(name),args)
        const original = cfg.inputSchema || {}
        const windowed = ['when','days','weeks','from','to'].some(k=>k in original)
        const shared = {...timeShape}
        if(!['compare','compare_with','compared_with'].some(k=>k in original)) for(const key of ['compare','compare_from','compare_to','compare_with','compared_with']) delete (shared as Record<string,unknown>)[key]
        const detailed = DETAIL_TOOLS.has(name) && !('detail' in original)
        const shape: z.ZodRawShape = {...(windowed ? {...original,...shared} : original),...(detailed ? {detail:detailInput} : {})}
        // Legacy defaults are applied only after exclusive time selectors have been validated.
        const validationShape = {...shape}
        for(const key of ['days','weeks']) if(key in validationShape) validationShape[key] = validationShape[key] instanceof z.ZodDefault ? (validationShape[key].removeDefault() as z.ZodType).optional() : (validationShape[key] as z.ZodType).optional()
        const schema = z.object(validationShape).strict().superRefine((input,ctx)=>{if(windowed)checkTime(input,ctx)})
        const contract={keys:Object.keys(shape),example:argumentExample(z.toJSONSchema(schema,{io:'input'}) as Record<string,unknown>)}
        const call = cb as (a: unknown, e: unknown) => unknown
        const handler = async (input: unknown, extra: unknown) => withPrivacy(async () => {
            const started=Date.now(), correlation=randomUUID(), clients=new Set<string>()
            let resultKind:string|undefined, jobHash:string|undefined
            let release:(()=>void)|undefined, errorKind:string|undefined, result:unknown, window:ReturnType<typeof inclusiveWindow>|undefined
            const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : []
            try {
                release=toolLimiter.acquire(caller?.email || caller?.who || 'stdio',caller?.tokenId || caller?.who || 'stdio',name, name==='posthog_exec' && isPosthogQuery((input as {command?:unknown})?.command) ? 5 : undefined)
                const parsed=schema.parse(input) as Record<string,unknown>
                const args = z.object(shape).parse(parsed) as Record<string,unknown>
                if(name==='get_job_result') jobHash=createHash('sha256').update(String(args.job_id)).digest('hex')
                const resolved=windowed ? resolveTime(parsed,name==='reval_brief' && parsed.trade ? 30 : name==='pin_dashboard' && parsed.kind==='flow_time' ? 90 : WINDOW_DEFAULTS[name] || 7) : undefined
                if(resolved) {
                    window=inclusiveWindow(resolved)
                    if('when' in original) args.when=(!JOB_TOOLS.has(name) && parsed.when) || `${window.from} to ${window.to}`
                    if(('from' in original || 'to' in original) && (JOB_TOOLS.has(name) || parsed.period || parsed.from || parsed.when)) {args.from=window.from;args.to=window.to}
                    if('days' in original) args.days=Math.max(1,Math.ceil((+resolved.to-+resolved.from)/86400000))
                    if('weeks' in original) args.weeks=Math.max(1,Math.ceil((+resolved.to-+resolved.from)/604800000))
                    if(parsed.compare_from) args.compare_with={from:parsed.compare_from,to:parsed.compare_to}
                    if(parsed.compared_with) {const c=inclusiveWindow(resolveTime({when:parsed.compared_with}));args.compare_with=c}
                    if(args.compare_with && 'compared_with' in original) {const c=args.compare_with as {from:string;to:string};args.compared_with=`${c.from} to ${c.to}`}
                }
                for(const key of Object.keys(timeShape)) if(!(key in original)) delete args[key]
                // detail shapes only the final answer: callbacks, caches and job single-flight never see it.
                const detail=detailed ? args.detail as 'concise'|'full'|undefined : undefined
                if(detailed) delete args.detail
                result=await toolContext.run({window:resolved,clients,correlationId:correlation},async()=>{
                    const execute=async()=>{
                        const result=isJob(args)
                            ? await dispatch.execute(name,args,resolved,extra,AsyncLocalStorage.bind(async(query)=>query ? posthogQueryContext.run(query,async()=>call(args,extra)) : call(args,extra)))
                            : await call(args,extra)
                        return {result,clients:[...clients],isError:!!(result as {isError?:boolean})?.isError}
                    }
                    const answer=await (CACHED_TOOLS.has(name) && !isJob(args) ? cachedToolCall(name,{args,insights,window},execute) : execute()) as {result:unknown;clients:string[]}
                    for(const id of answer.clients) clients.add(id)
                    let output=answer.result, outputName=name, outputArgs=args, outputWindow=resolved, jobId:string|undefined
                    if(output instanceof JobAnswer) {
                        jobId=output.id
                        jobHash=createHash('sha256').update(output.id).digest('hex')
                        resultKind=output.started ? 'job_started' : 'job_result'
                        outputName=output.context.name;outputArgs=output.context.args;outputWindow=output.context.window
                        if(outputWindow) window=inclusiveWindow(outputWindow)
                        const started=output.started
                        for(const id of output.context.clients || []) clients.add(id)
                        if(output.context.publicError && output.result && typeof output.result === 'object') publicToolError(output.result)
                        output=output.result
                        if(started) return runningHandle(await safeResult(output),jobId)
                    }
                    const value=output as {isError?:boolean;content?:unknown;_lensJson?:{value?:{window?:{from:string;to:string};period?:{from:string;to:string}}}}
                    const effective=value?._lensJson?.value?.window || value?._lensJson?.value?.period
                    if(effective && typeof effective.from === 'string' && typeof effective.to === 'string') {
                        const from=new Date(effective.from),to=new Date(effective.to.length===10 ? Date.parse(effective.to)+86400000 : effective.to)
                        if(Number.isFinite(+from) && Number.isFinite(+to)) window=inclusiveWindow({from,to,label:'answered',precision:'range'})
                    }
                    if(value?.isError) {
                        const content=JSON.stringify(value.content)
                        if(!isPublicToolError(output)) throw new Error(content)
                        errorKind='tool_error'
                        return safeResult({...value,content:[...(Array.isArray(value.content)?value.content:[]),{type:'text',text:`Correlation id: ${correlation}`}]})
                    }
                    const final=await safeResult(applyDetail(outputName,analyticalResult(outputName,outputArgs,output,outputWindow),detail))
                    return jobId ? runningHandle(final,jobId) : final
                })
                if(!privacyCurrent()) {errorKind='privacy_changed';result={isError:true,content:[{type:'text',text:`${PRIVACY_CHANGED} Correlation id: ${correlation}` }]}}
            } catch(error) {const mapped=toolError(error,name,correlation,contract);errorKind=mapped.kind;result=mapped.result}
            finally {
                release?.()
                // Only schema-defined argument keys; unknown keys can themselves contain private values.
                try {writeToolAudit({at:new Date(started).toISOString(),user_email:caller?.email || caller?.who || 'stdio',token_id:caller?.tokenId || 'stdio',tool:name,argument_keys:keys.filter(k=>k in shape).sort(),resolved_window:window,client_ids:[...clients],duration_ms:Date.now()-started,result_chars:JSON.stringify(result ?? {}).length,is_error:!!(result as {isError?:boolean})?.isError,error_kind:errorKind,result_kind:resultKind,job_hash:jobHash,privacy_mode:privacyMode(),correlation_id:correlation})}
                catch(error) {errorDiagnostic(error,name,'audit',correlation)}
            }
            return result
        })
        wrapped.add(name)
        const description=cfg.description || ''
        const first=description.match(/^.*?[.!?](?:\s|$)/)?.[0] || description
        const rest=description.slice(first.length)
        const outputSchema=outputSchemaFor((cfg as {outputSchema?:unknown}).outputSchema,isJob())
        return register(name, {...cfg,inputSchema:schema,...(outputSchema ? {outputSchema} : {}),description:`${first.trim()}${windowed ? ` Time: period or from/to (YYYY-MM-DD). Default: ${typeof WINDOW_DEFAULTS[name] === 'string' ? String(WINDOW_DEFAULTS[name]).replaceAll('_',' ') : `last ${WINDOW_DEFAULTS[name] || 7} days`}.` : ''} ${rest} ${DIRECT_CALL}`.trim()} as never,handler as never)
    }) as typeof server.registerTool
    return dispatch
}

// Which clients hit errors: the count is exact, the ids are examples. A list of every client per dialog grew
// with the client base (1,100 characters a dialog at 150 clients) and told the agent nothing more.

const comparisonInputs = () => ({ compare:z.enum(['previous','none']).optional(), compare_with:z.object({from:z.string(),to:z.string()}).optional() })
const comparisonArgs = (p:{compare?:'previous'|'none';compare_with?:{from:string;to:string}}) => ({compare:p.compare,...(p.compare_with ? {compare_with:{from:parseTimeWindow(p.compare_with.from).from,to:parseTimeWindow(p.compare_with.to).to}} : {})})
const CLIENT_EXAMPLES = 10
const fewClients = <T extends { clients_with_errors: string[] }>(d: T) =>
    ({ ...d, clients_with_errors_count: d.clients_with_errors.length, clients_with_errors: d.clients_with_errors.slice(0, CLIENT_EXAMPLES) })

/** raw is reserved for the isolated analysis worker: it calls handlers directly, never tools/call. */
export function registerTools(server: McpServer, ai?: TriageAi, caller?: Pick<ChatCaller, 'who' | 'surveyRole'> & Partial<Pick<ChatCaller, 'email' | 'tokenId' | 'dashboardRole' | 'admin' | 'insights'>>, raw = false, replayDeps = { render: renderClip, record: recordClip }): void {
    if (raw && isMainThread) throw new Error('Raw registration is reserved for isolated analysis workers.')
    const insights = !!caller?.admin || caller?.insights === true
    if (!raw) installJobTools(server, wrapTools(server, insights, caller))
    if (config.posthog.mcpViaLens && posthogMcpActive()) server.registerTool('posthog_exec', {
        description: `Runs PostHog commands for generic analytics and objects: trends, funnels, retention, insights, dashboards, flags, experiments, annotations, error-tracking administration, docs and SQL. Long analytics calls return a result or a job handle within 20 seconds; poll handles with get_job_result. ${execRoutingLine(config.mcp.name)}`,
        inputSchema: { command: z.string() },
    }, async ({ command }) => posthogExec(command, { url: config.posthog.mcpUrl, apiKey: config.posthog.mcpApiKey, name: config.mcp.name }))
    server.registerTool(
        'resolve_client',
        {
            title: 'Identify a client',
            description: `Identifies which ${A} client a name, client code or user email belongs to. Use it when a ticket names a client loosely.`,
            inputSchema: { query: z.string().describe('Client name, id, or a user email') },
            outputSchema: ROWS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ query }) => json(`Matches for "${query}":`, await resolveClient({ text: query, emails: emailsIn(query), clientHint: query }))
    )

    server.registerTool(
        'find_client_incidents',
        {
            title: 'When did this client hit a problem?',
            description:
                `Finds the sessions where a ${A} client, or one of its users, hit errors, rage clicks or dead clicks, with screens, releases and replay links. Use the Lens tool session_story for the event timeline and get_replay_link for a replay link.`,
            inputSchema: {
                client: z.string().describe('Client name, id or a user email'),
                when,
                timezone: tz,
                screen: z.string().optional().describe('Screen name or path, e.g. "invoices" or /invoices'),
                email: z.string().optional().describe('Only this user'),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ client, when: w, timezone, screen, email }) => {
            const { best } = await pickClient(client)
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            const incidents = await findIncidents({ clientId: best.id, from: win.from, to: win.to, pathname: screenPath(screen), email, limit: 100 })
            const sessions = bestPerSession(incidents).slice(0, 10)
            return json(
                `${best.name}: ${incidents.length} trouble events in ${sessions.length} sessions (${win.label}). One row per session, most useful first. Use get_replay_link with session_id and recording.offset_s to see it.`,
                sessions
            )
        }
    )

    // Replays can show sensitive client data. This tool hands back links for people to open; it
    // never returns frames, video bytes or anything else from the recording itself.
    server.registerTool(
        'get_replay_link',
        {
            title: 'Link to a session replay',
            description:
                `Gives a person links to watch one ${A} session at the right moment, including a replay and, when available, an MP4 clip. You cannot see the replay yourself; pass the links to the user. This is the only allowed way to share a replay: never use PostHog's session recording or Replay Vision tools.`,
            inputSchema: {
                session_id: z
                    .string({ error: 'session_id is missing. Call get_replay_link directly with arguments like {"session_id": "01a19b90-8c82-7185-ba5a-8333dd59c200", "start_s": 4}, not through PostHog\'s exec tool.' })
                    .describe('The session id, e.g. 01a19b90-8c82-7185-ba5a-8333dd59c200. A PostHog replay link works too.'),
                start_s: z
                    .number({ error: 'start_s is missing: seconds from the start of the recording, a number, e.g. {"start_s": 4}.' })
                    .min(0)
                    .describe('Seconds from the start of the recording. Use offset_s minus about 10.'),
                duration_s: z.number().min(3).max(120).default(30),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id: raw, start_s, duration_s }) => {
            const session_id = sessionIdOf(raw)
            const lines = [`Replay in PostHog from ${Math.floor(start_s)}s (PostHog login needed): ${replayUrl(session_id, start_s)}`]
            try {
                const refusal = mcpClipRefusal()
                if (refusal) {
                    lines.push(`No MP4 clip: ${refusal}. Use the PostHog replay link above.`)
                    return text(lines.join('\n'))
                }
                const request = { sessionId: session_id, startOffsetS: start_s, durationS: duration_s }
                const clip = await waitForReplayClip(request, caller?.email || caller?.who, {
                    render: replayDeps.render,
                    record: clip => replayDeps.record(clip, 'claude (MCP)'),
                    backgroundError: error => { toolError(error, 'get_replay_link') },
                })
                const page = `${config.service.publicUrl}/replays?clip=${encodeURIComponent(clip?.name ?? clipName(request))}`
                if (!clip) lines.push(`The MP4 is still rendering and will appear on the clip page (sign-in and the "Watch clips" role needed): ${page}`)
                else lines.push(`MP4 clip, ${Math.round(clip.video_duration_s)} s, on the clip page (sign-in and the "Watch clips" role needed): ${page}`)
            } catch (e) {
                const mapped=toolError(e,'get_replay_link')
                lines.push(`No MP4 clip is available. Use the PostHog replay link above. Correlation id: ${mapped.id}.`)
            }
            lines.push('These links are for the user to open. The replay content is not available to you.')
            return text(lines.join('\n'))
        }
    )

    server.registerTool(
        'screen_usage',
        {
            title: 'How is a screen used?',
            description: `Shows how a ${A} screen is used, by which clients and users, on which days, and where one client ranks. Use PostHog's exec instead for generic trends, insights or product analytics.`,
            inputSchema: {
                screen: z.string().describe('Screen name or path'),
                client: z.string().optional(),
                days: z.number().int().min(1).max(1500).default(30),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ screen, client, days }) => {
            const path = screenPath(screen)!
            const c = client ? (await pickClient(client)).best : undefined
            return json(`Usage of ${path} over ${days} days${c ? ` (with ${c.name})` : ''}:`, await screenUsage(path, { clientId: c?.id, days }))
        }
    )

    server.registerTool(
        'error_blast_radius',
        {
            title: 'Is it just them?',
            description:
                `Shows which ${A} clients and users hit an error message, how often, since when and on which releases. With a screen, includes failure rates per release. Use the Lens tool find_client_incidents for related sessions; error investigation stays in Lens.`,
            inputSchema: {
                issue_id: z.string().optional().describe('PostHog error tracking issue id, from find_client_incidents'),
                error_type: z.string().optional(),
                error_message: z.string().optional(),
                screen: z.string().optional(),
                days: z.number().int().min(1).max(1500).default(30),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ issue_id, error_type, error_message, screen, days }) => {
            if (!issue_id && (!error_type || !error_message)) throw new ToolInputError('Give issue_id, or error_type and error_message.')
            return json('Blast radius:', await errorImpact({ issue_id, error_type, error_message }, { days, pathname: screenPath(screen) }))
        }
    )

    server.registerTool(
        'find_silent_issues',
        {
            title: 'Problems without errors',
            description: `Finds sessions where a ${A} client struggled without errors: rage clicks, dead clicks, repeated actions or long stays. Use it for wrong data or confusion reported in a ticket.`,
            inputSchema: { client: z.string(), screen: z.string().optional(), when, timezone: tz },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ client, screen, when: w, timezone }) => {
            const { best } = await pickClient(client)
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            return json(`${best.name}: sessions with struggle signals and no error (${win.label}):`, await struggleSessions({ clientId: best.id, pathname: screenPath(screen), from: win.from, to: win.to }))
        }
    )

    server.registerTool(
        'triage_ticket',
        {
            title: 'Triage a ticket',
            description:
                `Triages a ${A} Jira ticket by identifying its client, screen and time, finding the session, and adding replay links, impact, usage and a suggested priority. Returns the report as markdown.`,
            inputSchema: {
                summary: z.string(),
                description: z.string().default(''),
                kind: z.enum(['rci', 'risk']).default('rci').describe('rci: a client-reported bug. risk: an MMT risk review of a screen.'),
                reporter_timezone: tz,
                clip: z.boolean().default(true),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ summary, description, kind, reporter_timezone, clip }) => {
            const report = await triage({ key: 'MCP', kind, summary, description, reporter: { timeZone: reporter_timezone } }, { ai, clip })
            if (report.clip) {
                await recordClip(report.clip, caller?.who || 'claude (MCP)')
                // MCP links must pass the clip page's current access checks when opened.
                report.clip.url = `${config.service.publicUrl}/replays?clip=${encodeURIComponent(report.clip.name)}`
            }
            return reportResult(report)
        }
    )

    // ------------------------------------------------------------------ release outcomes
    // Facts about the tickets each Jira release shipped, from the numbers the service stored
    // (src/core/releases.ts). The model judges what is risky; people's verdicts are saved.
    if (config.features.jira) {
        const scopeArg = z.string().optional().describe('A release like "26.10.0", a quarter like "Q3 2026", "last 3", a range like "26.5.0..26.8.0", or "all" (default).')
        const noScope = (q?: string) =>
            text(`Nothing called "${q}". Releases: ${keptNames().join(', ')}. Quarters: ${quarters().map((x) => x.label).join(', ')}. Or "all", "last 3", "26.5.0..26.8.0".`)
        const empty = () => text('No releases stored yet. Call refresh_releases first.')

        server.registerTool(
            'list_releases',
            {
                title: 'List releases',
                description: `Lists ${A} Jira releases, dates, available quarters and headline outcomes. Includes clients, errors and rage clicks per 1,000 sessions before and after, support tickets and survey ratings.`,
                inputSchema: {},
                annotations: { readOnlyHint: true },
            },
            async () => text(releasesMarkdown())
        )

        server.registerTool(
            'release_outcomes',
            {
                title: 'Tickets by outcome',
                description:
                    `Shows what happened after ${A} tickets shipped in a release, quarter or range, grouped by outcome. Includes errors, rage clicks, complaints, adoption, improvements and saved verdicts. Facts only: deciding what is risky is up to you. Start here for release reviews.`,
                inputSchema: { scope: scopeArg },
                annotations: { readOnlyHint: true },
            },
            async ({ scope }) => {
                if (!keptNames().length) return empty()
                const sc = resolveScope(scope)
                return sc ? text(outcomesMarkdown(sc)) : noScope(scope)
            }
        )

        server.registerTool(
            'ticket_evidence',
            {
                title: 'One ticket in full',
                description: `Explains the evidence for one ${A} Jira ticket and its release outcome. Includes its screen/event link, use before and after, errors, rage clicks, support tickets, survey comments in clients' words and earlier verdicts.`,
                inputSchema: { key: z.string().describe('Jira key, e.g. ACP-230') },
                annotations: { readOnlyHint: true },
            },
            async ({ key }) => text(evidenceMarkdown(key.trim().toUpperCase(), true) || `${key} is not in the kept releases.`)
        )

        server.registerTool(
            'client_feedback',
            {
                title: 'What clients said',
                description: `Shows what ${A} clients complained about after a release, grouped by screen, from support tickets and survey answers with ratings before and after. Use PostHog's exec instead for generic trends or funnels. Surveys themselves are handled only by the Lens survey tools (never PostHog), and launched only on the Lens Surveys page.`,
                inputSchema: { scope: scopeArg, screen: z.string().optional().describe('A screen path like /invoices, to narrow it down') },
                annotations: { readOnlyHint: true },
            },
            async ({ scope, screen }) => {
                if (!keptNames().length) return empty()
                const sc = resolveScope(scope)
                return sc ? text(feedbackMarkdown(sc, screen, true)) : noScope(scope)
            }
        )

        server.registerTool(
            'record_verdict',
            {
                title: 'Save a verdict',
                description:
                    `Saves an agreed verdict on a ${A} Jira ticket: risky, watch or fine, with the reason. Future calls show it next to the ticket. Only call this after the person agreed. Personal keys save the caller email; decided_by names the reviewer for shared keys. Admins can optionally post a comment to Jira.`,
                inputSchema: {
                    key: z.string(),
                    verdict: z.enum(['risky', 'watch', 'fine']),
                    reason: z.string().min(5).describe('Why, citing the numbers or client words'),
                    decided_by: z.string().describe('Who agreed to it, e.g. "Priya (PM)", or "claude" if nobody reviewed it'),
                    post_to_jira: z.boolean().default(false),
                },
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
            },
            async ({ key, verdict, reason, decided_by, post_to_jira }) => {
                decided_by = caller?.email || decided_by
                if (post_to_jira && !caller?.admin) return text('Posting to Jira requires admin access.')
                const k = key.trim().toUpperCase()
                const row = recordVerdict(k, verdict, reason, decided_by)
                let jira = ''
                if (post_to_jira) {
                    try {
                        await addComment(k, `**Release review: ${verdict}** (${decided_by})\n\n${reason}\n\n_From PostHog Lens release outcomes._`)
                        jira = ' Posted to Jira.'
                    } catch (e) {
                        const mapped=toolError(e,'record_verdict')
                        jira = ` The verdict was saved, but the Jira comment could not be posted. Check Jira access. Correlation id: ${mapped.id}.`
                    }
                }
                return text(`Saved: ${k} (${row.release}) is ${verdict}, by ${decided_by}.${jira}`)
            }
        )

        server.registerTool(
            'correct_ticket_link',
            {
                title: 'Fix how a ticket is linked',
                description:
                    `Fixes a ${A} Jira ticket's link to a screen or event, then recounts its release evidence. screen_problems controls whether screen errors, rage clicks and complaints count (auto lets the rules decide). reset=true restores the automatic link.`,
                inputSchema: {
                    key: z.string(),
                    screen: z.string().optional().describe('Screen path, e.g. /settings'),
                    event: z.string().optional().describe('PostHog event name, e.g. theme_changed'),
                    screen_problems: z.enum(['auto', 'count', 'ignore']).default('auto'),
                    reset: z.boolean().default(false),
                    changed_by: z.string().describe('Who asked for the change'),
                },
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async ({ key, screen, event, screen_problems, reset, changed_by }) => {
                const k = key.trim().toUpperCase()
                const release = ticketRelease(k)
                if (!release) return text(`${k} is not in the kept releases.`)
                if (reset) setLink(k, null, changed_by)
                else {
                    if (!screen && !event) return text('Give a screen, an event, or both (or reset=true).')
                    if (screen && !screen.startsWith('/')) return text('A screen is a path that starts with /, e.g. /invoices.')
                    setLink(k, { screen, event, ...(screen_problems === 'auto' ? {} : { risk: screen_problems === 'count' }) }, changed_by)
                }
                await recompute(release)
                return text(`Updated and recounted.\n\n${ticketText(k, true)}`)
            }
        )

        server.registerTool(
            'refresh_releases',
            {
                title: 'Refresh from Jira and PostHog',
                description: `Refreshes ${A} releases and tickets from Jira and recounts their PostHog evidence (about 15 seconds). The service also does this every 6 hours.`,
                inputSchema: {},
                annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
            },
            async () => {
                const r = await syncReleases()
                return text(`Refreshed ${r.releases.length} releases (${r.releases[0]} to ${r.releases.at(-1)}), ${r.tickets} tickets, in ${r.seconds} s.${r.dropped.length ? ` No longer kept: ${r.dropped.join(', ')}.` : ''}`)
            }
        )
    }
    if (appEvents()) registerAppEventTools(server, insights)

    if (config.features.jira) server.registerPrompt(
        'review_release',
        {
            title: 'Review a release',
            description: 'Judge which tickets in a release (or quarter) are risky, from the outcomes and what clients said.',
            argsSchema: { scope: z.string().optional().describe('e.g. 26.10.0, Q3 2026, last 3') },
        },
        ({ scope }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Review the release outcomes for ${scope || 'the latest release'} with the PostHog Lens tools.

1. Call release_outcomes${scope ? ` with scope "${scope}"` : ' with scope "last 1"'}. Then client_feedback for the same scope.
2. For each ticket in "More errors", "More rage clicks", "Clients complained" or "Low uptake", call ticket_evidence.
3. Decide for each of those tickets: risky, watch or fine. Weigh:
   - how many clients are affected, and whether they are large ones;
   - whether it blocks work (errors, failed exports) or only annoys (rage clicks);
   - whether it is growing or fading week by week, and whether a later release fixed it;
   - what clients actually said, in support tickets and surveys;
   - earlier verdicts on the same ticket, and why they were made.
   A ticket that shares a screen with others may not be the cause: say so.
4. Reply with a short table (ticket, verdict, one-line reason with numbers), then the 2 or 3 things to act on first. Mention what went well (adopted, fixed) in one line.
5. Ask me which verdicts to save. Only then call record_verdict, with decided_by set to who agreed. Do not invent numbers: use only what the tools returned.`,
                    },
                },
            ],
        })
    )
    registerSurveyTools(server, caller)
    if (appEvents()) registerDashboardTools(server, caller && { who: caller.who, email: caller.email, dashboardRole: caller.dashboardRole ?? 'view', surveyRole: caller.surveyRole, admin: !!caller.admin, insights: !!caller.admin || caller.insights === true })
}

// The app's own events (APP_EVENTS_FILE): what they are, one session as a story, where people fail.
function registerAppEventTools(server: McpServer, insights: boolean): void {
    const app = appEvents()!.app
    server.registerTool(
        'reval_brief',
        {
            title: 'Brief me on Reval',
            description: 'Start here for any question a product manager asks about Reval: what to worry about, how a client is doing, a dialog, a trade, or a weekly brief. The server investigates and returns a concise brief with comparisons, evidence links, limits and next questions. Relay it as returned; add no invented facts. No setup or other tool calls needed.',
            inputSchema: {
                question: z.string().optional().describe('The PM’s question in their own words. Omit for a general brief.'),
                client: z.string().optional().describe('Client name, id or email, if already known.'),
                dialog: z.string().optional().describe('Dialog name or code, if already known.'),
                trade: z.string().regex(/^\d{1,15}$/).optional().describe('Trade/link id, if already known.'),
                when: z.string().optional().describe('Plain-language window; default last 14 days, or 30 for a trade.'),
                timezone: tz,
            },
            annotations: { readOnlyHint: true },
        },
        async (input) => text(await revalBrief(input))
    )
    server.registerTool(
        'discover_workflows',
        {
            title: 'Which tasks people do and finish',
            description: `Which tasks do people do in ${app}, and do they finish them? Discovers frequent ordered dialog chains ending in a submit, ranked by sessions × clients, with completed and queued counts, durations and top errors. Lens supplies names from dialog titles, the submit button and success message, plus stable ids; no setup needed.`,
            inputSchema: { when, client: z.string().optional(), limit: z.number().int().min(1).max(50).default(15) },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ when: w, client, limit }) => {
            const win = (await import('../core/analysishistory.ts')).completeDayWindow(requestedToolWindow() || parseTimeWindow(w || 'last 7 days'), w)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} workflows (${win.label}):`, await discoverWorkflows({ from: win.from, to: win.to, clientId: best?.id, limit }))
        }
    )
    server.registerTool(
        'aggregate_events',
        {
            title: 'Count anything in the events',
            description: `Counts ${app} events, sessions, users or clients over any window up to 4 years, by period and by up to two approved dimensions (app_version, dialog, tab, button, action, event, client), with filters. For questions the other tools do not cover; exact counts computed in PostHog, never raw events or people.`,
            inputSchema: {
                when,
                metrics: z.array(z.enum(['events', 'sessions', 'users', 'clients'])).min(1).max(4).optional(),
                group_by: z.array(z.enum(['event', 'client', 'app_version', 'dialog', 'dialog_name', 'tab', 'action', 'button'])).max(2).optional(),
                bucket: z.enum(['none', 'day', 'week', 'month', 'quarter', 'year']).optional(),
                filters: z.array(z.object({ dimension: z.enum(['event', 'client', 'app_version', 'dialog', 'dialog_name', 'tab', 'action', 'button']), op: z.enum(['eq', 'neq', 'in']), value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]) })).max(5).optional(),
                events: z.array(z.string().max(200)).max(20).optional().describe('Event names; default: the app\'s own screen and interaction events.'),
                client: z.string().optional(),
                limit: z.number().int().min(1).max(200).default(50),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ when: w, client, filters, ...rest }) => {
            const win = (await import('../core/analysishistory.ts')).completeDayWindow(requestedToolWindow() || parseTimeWindow(w || 'last 30 days'), w)
            const best = client ? (await pickClient(client)).best : undefined
            const { aggregateEvents } = await import('../core/aggregate.ts')
            return json(`${app} event counts (${win.label}):`, await aggregateEvents({ ...rest, from: win.from, to: win.to,
                filters: [...(filters || []), ...(best ? [{ dimension: 'client', op: 'eq' as const, value: best.id }] : [])] }))
        }
    )
    server.registerTool(
        'workflow_completion',
        {
            title: 'Do clients finish a workflow',
            description: `Which tasks do people do in ${app}, and do they finish them? Measures a discovered workflow id/name or ordered dialogs per client and overall: starts, funnel, done, failures, retries, abandonment, time, dropout errors and example replay links for the person. Compares the previous equal window. Give either workflow or dialogs. Discovered workflows count completed or queued as done and report them separately; dialog lists require completed.`,
            inputSchema: { ...comparisonInputs(), workflow: z.string().trim().min(1).max(WORKFLOW_NAME_LIMIT).optional().describe('Discovered workflow id or exact name from discover_workflows.'), dialogs: z.array(z.string().min(1).max(80)).min(1).max(10).optional(), client: z.string().optional(), when },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ workflow, dialogs, client, when: w, ...comparison }) => {
            const win = (await import('../core/analysishistory.ts')).completeDayWindow(requestedToolWindow() || parseTimeWindow(w || 'last 7 days'), w)
            const best = client ? (await pickClient(client)).best : undefined
            const q = { from: win.from, to: win.to, clientId: best?.id }
            const definition = await completionWorkflow({ ...q, workflow, dialogs })
            return json(`${app} workflow completion (${win.label}):`, await workflowCompletionReport({ ...q, definition, ...comparisonArgs(comparison) }))
        }
    )
    server.registerTool(
        'describe_app_events',
        {
            title: `What ${app}'s events mean`,
            description: `Explains ${app} dialogs, screens, buttons, fields and error messages using the app's event vocabulary. Includes coverage, real example values, common dialogs and messages, clients and HogQL guidance. Use for vocabulary details when drilling into events; reval_brief investigates directly. Use the Lens tool reval_brief to investigate app events and session_story for a session timeline.`,
            inputSchema: { days: z.number().int().min(1).max(1500).default(7).describe('How many days of data to look at.') },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ days }) => json(`${app} events (last ${days} days):`, await describeAppEvents(days, clientSource()))
    )
    server.registerTool(
        'session_story',
        {
            title: 'What happened in a session',
            description: `Explains what happened in one ${app} session: dialogs, tabs, fields, button presses, outcomes and error messages in time order. Uses events, with replay links for the person to open. Field names are shown, never typed values. Follow up on sessions from dialog_friction or find_client_incidents.`,
            inputSchema: {
                session_id: z.string().describe('The session id or a PostHog replay link.'),
                max_lines: z.number().int().min(20).max(1000).default(300),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ session_id, max_lines }) => {
            const r = await sessionStory(sessionIdOf(session_id), { maxLines: max_lines, network: insights })
            const head = [
                `Session ${r.session_id}: client ${r.client || '?'}, user ${r.user || '?'}, ${r.start.slice(0, 16).replace('T', ' ')} UTC${r.version ? `, ${r.version}` : ''}.`,
                r.summary,
                r.replay_url ? `Replay for the user (PostHog login needed): ${r.replay_url}` : 'No replay recorded for this session.',
                ...(insights ? [`Server calls: ${r.network}.`] : []),
            ]
            const errs = r.errors.length ? ['', 'Errors:', ...r.errors.map((e) => `- ${e.at} ${e.dialog}: "${e.text}"${e.replay_url ? ` (watch: ${e.replay_url})` : ''}`)] : []
            return text([...head, ...errs, '', 'Timeline (+m:ss from the start of the recording):', ...r.story, r.truncated ? '… (cut; raise max_lines for more)' : ''].join('\n'))
        }
    )
    server.registerTool(
        'dialog_friction',
        {
            title: 'Where clients fail',
            description: `Explains why a ${app} dialog fails: button attempts, outcomes, error messages, affected clients, retry loops and stuck sessions. Optionally narrow to one client or dialog. Each error has an example session for session_story.`,
            inputSchema: {
                client: z.string().optional().describe('A client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code (DlgDetailIRSwap) or part of its name (IR Swap).'),
                when,
                timezone: tz,
                limit: z.number().int().min(1).max(50).default(15),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, when: w, timezone, limit }) => {
            const win = (await import('../core/analysishistory.ts')).completeDayWindow(requestedToolWindow() || parseTimeWindow(w || 'last 7 days', new Date(), timezone), w)
            const best = client ? (await pickClient(client)).best : undefined
            const r = await dialogFriction({ from: win.from, to: win.to, clientId: best?.id, dialog, limit })
            return json(`${app} friction${best ? ` for ${best.name}` : ''}${dialog ? `, dialog "${dialog}"` : ''} (${win.label}):`, { ...r, dialogs: r.dialogs.map(fewClients) })
        }
    )
    server.registerTool(
        'message_doctor',
        {
            title: 'Which error messages mislead',
            description: `Which of Reval's error messages leave people stuck, and what do they do to recover? Groups errors by template and dialog, learns the field labels touched, other dialogs opened and whether people search, then reports recovery, repeated failures and give-ups. Flags dead ends and messages pointing elsewhere, with counts and example sessions.`,
            inputSchema: {
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code or part of its name.'),
                message: z.string().optional().describe('Text to match in an error message or its template, ignoring case.'),
                when,
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, message, when: w }) => {
            const win = requestedToolWindow() || parseTimeWindow(w || 'last 7 days')
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} message doctor${best ? ` for ${best.name}` : ''} (${win.label}):`, await messageDoctor({ from: win.from, to: win.to, clientId: best?.id, dialog, message }))
        }
    )
    server.registerTool(
        'attempt_timings',
        {
            title: 'Slow or failing server calls',
            description: `Shows whether ${app} buttons such as Save, Run or Export are slow, and which server calls fail with HTTP errors. Includes median, 90th percentile and longest waits by dialog/button, method/path, clients and example replay links. Reads network timing on the server from a limited number of recent recordings.`,
            inputSchema: {
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                dialog: z.string().optional().describe('A dialog code or part of its name.'),
                when,
                timezone: tz,
                sessions: z.number().int().min(1).max(40).default(12).describe('How many recent recorded sessions to read.'),
            },
            annotations: { readOnlyHint: true },
        },
        async ({ client, dialog, when: w, timezone, sessions }) => {
            if (!insights) return text('Recording-derived timings require replay insights access.')
            const win = parseTimeWindow(w || 'last 7 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} attempts and their server calls${best ? ` for ${best.name}` : ''}${dialog ? `, dialog "${dialog}"` : ''} (${win.label}):`, await slowAttempts({ from: win.from, to: win.to, clientId: best?.id, dialog, sessions }))
        }
    )
    server.registerTool(
        'top_pains',
        {
            title: 'The week\'s top pains',
            description: `Ranks where ${app} clients struggle most: failing dialogs, retries, unfinished attempts, error messages and clients at risk. Gives counts, changes against the previous period and example session links. Start here for a weekly product summary or what to fix first.`,
            inputSchema: { ...comparisonInputs(), when: z.string().optional().describe('Default: last 7 days (compared with the 7 days before).'), timezone: tz, max: z.number().int().min(1).max(15).default(5) },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ when: w, timezone, max, ...comparison }) => {
            const win = (await import('../core/analysishistory.ts')).completeDayWindow(requestedToolWindow() || parseTimeWindow(w || 'last 7 days', new Date(), timezone), w)
            const pains = await topPains({ from: win.from, to: win.to, max, ...comparisonArgs(comparison) })
            return json(`${app}: top pains (${win.label}):`, { ...pains, pains: pains.pains.map((p) => ({ ...p, clients_hit_count: p.clients_hit.length, clients_hit: p.clients_hit.slice(0, CLIENT_EXAMPLES) })) })
        }
    )
    server.registerTool(
        'find_trade',
        {
            title: 'What happened to a trade',
            description: `Finds what happened to a ${app} trade or link id, such as 4348, including clients, sessions, errors and button attempts. Matches searches and messages that name the id, with replay links for the person.`,
            inputSchema: {
                id: z.string().describe('The trade or link id, digits only, e.g. 4348.'),
                client: z.string().optional().describe('One client (name, code or a user email), to narrow it down.'),
                when: z.string().optional().describe('Default: last 30 days.'),
                timezone: tz,
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ id, client, when: w, timezone }) => {
            const win = requestedToolWindow() || parseTimeWindow(w || 'last 30 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app}: id ${id}${best ? ` for ${best.name}` : ''} (${win.label}):`, await findTrade({ id, from: win.from, to: win.to, clientId: best?.id }))
        }
    )
    server.registerTool(
        'client_signals',
        {
            title: 'Which clients need attention',
            description: `Shows which ${app} clients are at risk or using the app less: fewer sessions, active days or dialogs, absent users and more failed attempts. Compares periods with reasons and numbers. These are warning signs, not a churn prediction; say so and follow up with dialog_friction for the client.`,
            inputSchema: { ...comparisonInputs(),
                client: z.string().optional().describe('One client (name, code or a user email). All clients if left out.'),
                when: z.string().optional().describe('The recent period, in plain words. Default: last 14 days (compared with the 14 days before).'),
                timezone: tz,
                limit: z.number().int().min(1).max(100).default(20),
            },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ client, when: w, timezone, limit, ...comparison }) => {
            const win = requestedToolWindow() || parseTimeWindow(w || 'last 14 days', new Date(), timezone)
            const best = client ? (await pickClient(client)).best : undefined
            return json(`${app} clients, ${win.label} against the period before${best ? ` (${best.name})` : ''}:`, await clientSignalsReport({ from: win.from, to: win.to, clientId: best?.id, limit, ...comparisonArgs(comparison) }))
        }
    )
    server.registerPrompt(
        'where_clients_struggle',
        {
            title: 'Where clients struggle',
            description: `A short report for a product manager: the ${app} dialogs that hurt most, and what happens there.`,
            argsSchema: { client: z.string().optional().describe('One client, or all'), when: z.string().optional().describe('e.g. last 14 days') },
        },
        ({ client, when: w }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Where do ${client ? `${client}'s users` : 'clients'} struggle in ${app}${w ? ` (${w})` : ' (last 14 days)'}?

Call reval_brief first with ${JSON.stringify({ question: 'Where do clients struggle?', ...(client ? { client } : {}), when: w || 'last 14 days' })}.
Relay the returned brief, including its evidence and limits. Add nothing invented. Replays are links for the person only.`,
                    },
                },
            ],
        })
    )
    const briefPrompt = (args: Record<string, string>) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const,
            text: `Call reval_brief first with ${JSON.stringify(args)}. Relay its brief, evidence and limits as returned. Add no invented facts or numbers. Replay links are for the person; never view replay content.`,
        } }],
    })
    server.registerPrompt('weekly_review', {
        title: 'Weekly Reval review', description: 'What should I worry about this week?',
    }, () => briefPrompt({ question: 'Brief me on what needs attention this week', when: 'last 7 days' }))
    server.registerPrompt('client_check', {
        title: 'Check a Reval client', description: 'How is this client doing?',
        argsSchema: { client: z.string().describe('Client name or id') },
    }, ({ client }) => briefPrompt({ question: 'How is this client doing?', client }))
    if (config.features.jira) server.registerPrompt('release_check', {
        title: 'Check after a release', description: 'What needs attention after a release?',
        argsSchema: { release: z.string().optional().describe('Release name or version, if known') },
    }, ({ release }) => briefPrompt({ question: `What should I worry about after release ${release || 'the latest release'}?`, when: 'last 14 days' }))
}
