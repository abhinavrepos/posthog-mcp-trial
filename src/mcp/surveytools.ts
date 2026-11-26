// PostHog native surveys. A save is a draft unless start_date is explicitly supplied.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { auditClient } from '../core/toolcontext.ts'
import { config, surveysActive } from '../core/config.ts'
import { appEvents } from '../core/appevents.ts'
import { resolveClient } from '../core/resolve.ts'
import { ToolInputError } from '../core/toolinputerror.ts'
import { nativePayload, nativeSurveyInput, nativeValidation, saveNativeSurvey } from '../core/native-surveys.ts'
import { archiveSurvey, freshSurvey, stopSurvey, surveyOverview, surveyResults, viewOf } from '../core/surveys.ts'
import { audit, type ChatCaller, type SurveyRole } from '../service/access.ts'
import { jsonResult } from './result.ts'
import { ANALYSIS_OUTPUT } from './structured.ts'
import { windowArg } from './timeinput.ts'

export const SURVEY_TOOLS = ['design_survey','save_survey','stop_survey','list_surveys','survey_results']
const TOOLS_FOR:Record<SurveyRole,string[]>={none:[],view:['list_surveys','survey_results'],edit:['list_surveys','survey_results','design_survey','save_survey'],launch:SURVEY_TOOLS}
export const surveyToolNames=(role:SurveyRole='launch'):string[]=>(surveysActive()&&appEvents()?SURVEY_TOOLS.filter(t=>TOOLS_FOR[role].includes(t)):[])
const result=jsonResult
const pageUrl=(id?:string)=>`${config.service.publicUrl}/replays/surveys${id?'#'+id:''}`
const text=(s:string)=>({content:[{type:'text' as const,text:s}]})
const surveyWindow=windowArg.optional()
function daysOf(window:unknown,days:number):number{
    if(window===undefined)return days
    const v=typeof window==='string'?window:(window as {last?:string}).last
    const m=typeof v==='string'?/^(\d{1,5})([hd])$/.exec(v):null
    if(!m)throw new ToolInputError('Use a rolling survey window such as {"last":"30d"}.')
    return Math.min(1500,Math.max(1,Math.ceil(Number(m[1])/(m[2]==='h'?24:1))))
}
async function resolveClients(names:string[]|undefined):Promise<string[]|undefined>{
    if(!names?.length)return undefined
    const ids:string[]=[]
    for(const name of names){
        const matches=await resolveClient({text:name,clientHint:name})
        if(!matches[0]||matches[0].confidence<0.7||(matches[1]&&matches[1].confidence>=matches[0].confidence))throw new ToolInputError(`Client "${name}" is ambiguous or unknown. Use a client id from resolve_client.`)
        ids.push(matches[0].id);auditClient(matches[0].id)
    }
    return [...new Set(ids)]
}
export function registerSurveyTools(server:McpServer,caller:Pick<ChatCaller,'who'|'surveyRole'>={who:'mcp',surveyRole:'launch'}):void{
    const allowed=new Set(surveyToolNames(caller.surveyRole));if(!allowed.size)return
    const reg=((name:string,...rest:unknown[])=>(allowed.has(name)?(server.registerTool as (...a:unknown[])=>unknown)(name,...rest):undefined)) as typeof server.registerTool
    reg('design_survey',{title:'Validate a native PostHog survey',description:'Validate every field of a native PostHog survey before saving. Supply name, type, questions, and optional appearance, conditions, targeting, schedule and audience. Event triggers may carry propertyFilters, e.g. {"name":"PageView","propertyFilters":{"dialog_id":{"operator":"exact","values":["DlgRepAmort"]}}}; clients:["SEM"] limits the audience. Example: {"name":"Feedback","questions":[{"type":"open","question":"Why?"}]}.',inputSchema:nativeSurveyInput.strict(),outputSchema:ANALYSIS_OUTPUT,annotations:{readOnlyHint:true}},async args=>{
        const spec=nativeValidation(args)
        const clients=await resolveClients(spec.clients)
        const body=nativePayload({...spec,clients})
        return result('Valid native PostHog survey. Save it with save_survey; launch it on the Surveys page.',{survey:body,page:pageUrl(),note:'PostHog evaluates native conditions and targeting when launched.'})
    })
    reg('save_survey',{title:'Save or update a native PostHog survey',description:'Create a native PostHog survey as a draft, or update one with survey_id. Provide the complete survey spec. Set start_date explicitly to launch; end_date stops it. Example: {"name":"Feedback","questions":[{"type":"open","question":"Why?"}]}.',inputSchema:nativeSurveyInput.extend({survey_id:z.string().optional()}).strict()},async args=>{
        const {survey_id,...raw}=args
        const spec=nativeValidation(raw)
        if(caller.surveyRole!=='launch'){
            if(spec.start_date || spec.end_date || spec.archived) throw new ToolInputError('The launch survey role is required to start, stop or archive a survey.')
            if(survey_id){const old=await freshSurvey(survey_id);if(!old)throw new ToolInputError('Survey not found.');if(viewOf(old).status!=='draft')throw new ToolInputError('The launch survey role is required to change a running or stopped survey.')}
        }
        const clients=await resolveClients(spec.clients)
        const saved=await saveNativeSurvey({...spec,clients},survey_id)
        audit(caller.who,survey_id?'survey.changed':'survey.created',{survey:saved.id,name:saved.name})
        return result(`${survey_id?'Updated':spec.start_date?'Created and launched':'Saved draft'}: "${saved.name}". Page: ${pageUrl(saved.id)}`,{survey:saved})
    })
    reg('stop_survey',{title:'Stop or archive a survey',description:'Stop a running survey, preserving answers. archive true also hides it from lists. Example: {survey_id: UUID, archive: true}.',inputSchema:{survey_id:z.string(),archive:z.boolean().default(false)}},async({survey_id,archive})=>{
        const s=archive?await archiveSurvey(survey_id):await stopSurvey(survey_id)
        audit(caller.who,archive?'survey.archived':'survey.stopped',{survey:s.id,name:s.name})
        return text(`${archive?'Archived':'Stopped'}: "${s.name}".`)
    })
    reg('list_surveys',{title:'List surveys',description:'Native PostHog surveys, status and shown/answered/dismissed counts. Example: {days: 30}.',inputSchema:{days:z.number().int().min(1).max(1500).default(30),window:surveyWindow},outputSchema:ANALYSIS_OUTPUT,annotations:{readOnlyHint:true}},async({days,window})=>{
        const n=daysOf(window,days);const surveys=await surveyOverview(n)
        return result(`${surveys.length} surveys; counts over ${n} days.`,surveys)
    })
    reg('survey_results',{title:'Survey results and answers',description:'Shown, answered, dismissed, breakdowns and answers for one survey. Example: {survey_id: UUID, days: 90}.',inputSchema:{survey_id:z.string(),days:z.number().int().min(1).max(1500).default(90),window:surveyWindow},outputSchema:ANALYSIS_OUTPUT,annotations:{readOnlyHint:true}},async({survey_id,days,window})=>{
        const n=daysOf(window,days);const data=await surveyResults(survey_id,n)
        return result(`Results over ${n} days. Page: ${pageUrl(survey_id)}`,data)
    })
}
