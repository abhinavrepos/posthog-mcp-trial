import { z } from 'zod'
import { config, surveysActive } from './config.ts'
import { ToolInputError } from './toolinputerror.ts'
import { invalidateSurveyCache, type PostHogSurvey } from './surveys.ts'

const nonempty = z.string().trim().min(1)
const branchTarget = z.union([z.number().int().min(0), z.literal('end')])
const branching = z.discriminatedUnion('type', [
    z.object({ type: z.literal('next_question') }),
    z.object({ type: z.literal('end') }),
    z.object({ type: z.literal('specific_question'), index: z.number().int().min(0) }),
    z.object({ type: z.literal('response_based'), responseValues: z.record(z.string(), branchTarget) }),
])
const common = { id: z.string().optional(), question: nonempty, description: z.string().optional(), descriptionContentType: z.enum(['text', 'html']).optional(), optional: z.boolean().optional(), buttonText: z.string().optional(), translations: z.record(z.string(), z.record(z.string(), z.unknown())).optional() }
const choice = { choices: z.array(nonempty).min(2).max(20), shuffleOptions: z.boolean().optional(), hasOpenChoice: z.boolean().optional() }
export const nativeQuestion = z.discriminatedUnion('type', [
    z.object({ ...common, type: z.literal('open'), validation: z.array(z.object({ type: z.enum(['min_length','max_length','email']), value: z.number().int().positive().nullable().optional() })).nullable().optional(), branching: branching.nullable().optional() }).strict(),
    z.object({ ...common, type: z.literal('link'), link: z.string().refine(x => /^https:\/\/[^/]+|^mailto:[^@]+@[^@]+$/.test(x), 'Use an HTTPS or mailto URL'), branching: branching.nullable().optional() }).strict(),
    z.object({ ...common, type: z.literal('rating'), scale: z.union([z.literal(2),z.literal(3),z.literal(5),z.literal(7),z.literal(10)]).optional(), display: z.enum(['number','emoji']).optional(), lowerBoundLabel: z.string().optional(), upperBoundLabel: z.string().optional(), isNpsQuestion: z.boolean().optional(), branching: branching.nullable().optional() }).strict(),
    z.object({ ...common, type: z.literal('single_choice'), ...choice, branching: branching.nullable().optional() }).strict(),
    z.object({ ...common, type: z.literal('multiple_choice'), ...choice }).strict(),
])
const match = z.enum(['regex','not_regex','exact','is_not','icontains','not_icontains'])
const property = z.object({ key: nonempty, type: z.enum(['person','cohort','group','flag']).default('person'), value: z.unknown().optional(), operator: z.enum(['exact','is_not','icontains','not_icontains','starts_with','not_starts_with','ends_with','not_ends_with','regex','not_regex','gt','gte','lt','lte','is_set','is_not_set','is_date_exact','is_date_after','is_date_before','in','not_in','flag_evaluates_to','icontains_multi','not_icontains_multi']).optional(), group_type_index:z.number().int().nullable().optional(),cohort_name:z.string().nullable().optional() }).strict()
const group = z.object({ properties: z.array(property).default([]), rollout_percentage: z.number().min(0).max(100).optional(), variant:z.string().nullable().optional(), aggregation_group_type_index:z.number().int().nullable().optional() }).strict()
export const nativeSurveyInput = z.object({
    name: nonempty.max(400), description: z.string().optional(),
    type: z.enum(['popover','api','widget','external_survey']).default('popover'),
    questions: z.array(nativeQuestion).min(1),
    appearance: z.object({
        backgroundColor:z.string().optional(), submitButtonColor:z.string().optional(), textColor:z.string().optional(), submitButtonText:z.string().optional(), submitButtonTextColor:z.string().optional(), descriptionTextColor:z.string().optional(), ratingButtonColor:z.string().optional(), ratingButtonActiveColor:z.string().optional(), ratingButtonHoverColor:z.string().optional(), textSubtleColor:z.string().optional(), inputBackground:z.string().optional(), inputTextColor:z.string().optional(), autoDisappear:z.boolean().optional(), displayThankYouMessage:z.boolean().optional(), thankYouMessageHeader:z.string().optional(), thankYouMessageDescription:z.string().optional(), thankYouMessageDescriptionContentType:z.enum(['html','text']).optional(), thankYouMessageCloseButtonText:z.string().optional(), displayIntroScreen:z.boolean().optional(), introScreenHeader:z.string().optional(), introScreenDescription:z.string().optional(), introScreenDescriptionContentType:z.enum(['html','text']).optional(), introScreenButtonText:z.string().optional(), borderColor:z.string().optional(), placeholder:z.string().optional(), position:z.enum(['top_left','top_center','top_right','middle_left','middle_center','middle_right','left','center','right','next_to_trigger']).optional(), shuffleQuestions:z.boolean().optional(), surveyPopupDelaySeconds:z.number().int().min(0).nullable().optional(), allowGoBack:z.boolean().optional(), backButtonText:z.string().optional(), widgetType:z.enum(['button','tab','selector']).optional(), widgetSelector:z.string().optional(), widgetLabel:z.string().optional(), widgetColor:z.string().optional(), tabPosition:z.enum(['top','left','right','bottom']).optional(), fontFamily:z.string().optional(), maxWidth:z.string().optional(), zIndex:z.string().optional(), disabledButtonOpacity:z.string().optional(), boxPadding:z.string().optional(), boxShadow:z.string().optional(), borderRadius:z.string().optional(),
    }).strict().optional(),
    conditions: z.object({ url:z.string().optional(), urlMatchType:match.optional(), selector:z.string().optional(), deviceTypes:z.array(z.enum(['Desktop','Mobile','Tablet'])).optional(), deviceTypesMatchType:match.optional(), seenSurveyWaitPeriodInDays:z.number().int().min(0).optional(), events:z.object({ values:z.array(z.object({name:nonempty,propertyFilters:z.record(z.string(),z.object({operator:match.or(z.enum(['gt','lt'])),values:z.array(z.union([z.string(),z.number()])).min(1)}).strict()).optional()}).strict()).min(1), repeatedActivation:z.boolean().optional() }).strict().optional(), cancelEvents:z.object({values:z.array(z.object({name:nonempty,propertyFilters:z.record(z.string(),z.object({operator:match.or(z.enum(['gt','lt'])),values:z.array(z.union([z.string(),z.number()])).min(1)}).strict()).optional()}).strict()).min(1)}).strict().optional(), actions:z.object({ values:z.array(z.object({id:z.number().int().positive()}).strict()).min(1) }).strict().optional(), linkedFlagVariant:z.string().optional() }).strict().nullable().optional(),
    targeting_flag_filters:z.object({ groups:z.array(group).optional(),multivariate:z.object({variants:z.array(z.object({key:nonempty,name:z.string().optional(),rollout_percentage:z.number().min(0).max(100)}).strict())}).nullable().optional(),aggregation_group_type_index:z.number().int().nullable().optional(),payloads:z.record(z.string(),z.string()).optional(),feature_enrollment:z.boolean().nullable().optional(),early_exit:z.boolean().optional() }).strict().optional(),
    linked_flag_id:z.number().int().positive().nullable().optional(), linked_insight_id:z.number().int().positive().nullable().optional(), targeting_flag_id:z.number().int().positive().optional(), remove_targeting_flag:z.boolean().optional(),
    schedule:z.enum(['once','always','recurring']).nullable().optional(), iteration_count:z.number().int().min(0).max(500).nullable().optional(), iteration_frequency_days:z.number().int().min(1).max(365).nullable().optional(), repeat_until_stopped:z.boolean().optional(), responses_limit:z.number().int().min(0).nullable().optional(),
    response_sampling_start_date:z.iso.datetime().nullable().optional(), response_sampling_interval_type:z.enum(['day','week','month']).nullable().optional(), response_sampling_interval:z.number().int().positive().nullable().optional(), response_sampling_limit:z.number().int().min(0).nullable().optional(), response_sampling_daily_limits:z.record(z.string(),z.number().int().min(0)).nullable().optional(), form_content:z.record(z.string(),z.unknown()).nullable().optional(),
    start_date:z.iso.datetime().nullable().optional(), end_date:z.iso.datetime().nullable().optional(), archived:z.boolean().optional(), enable_partial_responses:z.boolean().optional(), enable_iframe_embedding:z.boolean().optional(), base_language:z.string().max(20).optional(), translations:z.record(z.string(),z.record(z.string(),z.unknown())).optional(), _create_in_folder:z.string().optional(),
    clients:z.array(nonempty).optional(), sample_percent:z.number().min(0).max(100).optional(),
}).strict().superRefine((s,ctx) => {
    s.questions.forEach((q,i) => {
        const b = 'branching' in q ? q.branching : undefined
        if(q.type==='rating' && q.scale===2 && q.display!=='emoji') ctx.addIssue({code:'custom',path:['questions',i,'display'],message:'A 2-point rating requires emoji display'})
        if(q.type==='rating' && q.scale===3 && q.display!=='emoji') ctx.addIssue({code:'custom',path:['questions',i,'display'],message:'A 3-point rating requires emoji display'})
        if(q.type==='rating' && (q.scale===7||q.scale===10) && q.display==='emoji') ctx.addIssue({code:'custom',path:['questions',i,'display'],message:'Emoji display supports scales 2, 3 and 5 only'})
        if (b?.type === 'specific_question' && b.index <= i) ctx.addIssue({code:'custom',path:['questions',i,'branching','index'],message:'Branching must move to a later question'})
        if (b?.type === 'specific_question' && b.index >= s.questions.length) ctx.addIssue({code:'custom',path:['questions',i,'branching','index'],message:'Question index is outside the survey'})
    })
    if (s.appearance?.shuffleQuestions && s.questions.some(q=>'branching' in q && q.branching)) ctx.addIssue({code:'custom',path:['appearance','shuffleQuestions'],message:'Cannot shuffle questions with branching'})
    if (s.schedule!=='recurring' && (s.iteration_count!==undefined || s.iteration_frequency_days!==undefined || s.repeat_until_stopped!==undefined)) ctx.addIssue({code:'custom',path:['schedule'],message:'Iteration fields require schedule recurring'})
    if (s.clients?.length && s.targeting_flag_filters) ctx.addIssue({code:'custom',path:['clients'],message:'Use clients or targeting_flag_filters, not both'})
    if (s.conditions?.linkedFlagVariant && !s.linked_flag_id) ctx.addIssue({code:'custom',path:['conditions','linkedFlagVariant'],message:'linked_flag_id is required for a variant'})
})
export type NativeSurveyInput = z.infer<typeof nativeSurveyInput>

export function nativePayload(spec: NativeSurveyInput): Record<string,unknown> {
    const { clients, sample_percent, ...body } = spec
    if (clients?.length || sample_percent !== undefined) {
        const escaped=clients?.map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))||[]
        const pattern=`^[^|]*\\|[^|]*\\|(?:${escaped.join('|')})\\|`
        const properties=escaped.length?[{key:'distinct_id',type:'person',value:pattern,operator:'regex'}]:[]
        if(properties.length || (sample_percent??100)<100) body.targeting_flag_filters={groups:[{properties,rollout_percentage:sample_percent??100}]} as typeof body.targeting_flag_filters
    }
    return body
}
export function nativeValidation(raw: unknown): NativeSurveyInput {
    const parsed = nativeSurveyInput.safeParse(raw)
    if (!parsed.success) throw new ToolInputError(parsed.error.issues.map(i => `${i.path.join('.') || 'survey'}: ${i.message}`).join('; '))
    return parsed.data
}
async function api<T>(path: string, method='GET', body?: unknown): Promise<T> {
    if (!surveysActive()) throw new ToolInputError('Survey API key is not configured')
    const response=await fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/surveys/${path}`,{method,headers:{authorization:`Bearer ${config.posthog.surveyApiKey}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)})
    if(!response.ok){
        const content=(await response.text()).slice(0,2000)
        let detail=content
        try {
            const error=JSON.parse(content) as Record<string,unknown>
            detail=typeof error.detail==='string'?`${error.attr?`${error.attr}: `:''}${error.detail}`:Object.entries(error).filter(([key])=>!['type','code'].includes(key)).map(([key,value])=>`${key}: ${Array.isArray(value)?value.join(', '):String(value)}`).join('; ')||content
        } catch { /* Plain-text API error. */ }
        throw new ToolInputError(`PostHog surveys ${response.status}: ${detail.slice(0,1000)}`)
    }
    if(method!=='GET') invalidateSurveyCache()
    return response.json() as Promise<T>
}
export async function saveNativeSurvey(raw:unknown,id?:string):Promise<PostHogSurvey>{
    const input=nativeValidation(raw)
    if(id && !/^[0-9a-f-]{8,64}$/i.test(id)) throw new ToolInputError('Invalid survey_id')
    const payload=nativePayload(input)
    if(id){
        const old=await api<PostHogSurvey>(`${id}/`)
        const prior=old.questions||[]
        const qs=payload.questions as typeof prior
        qs.forEach(q=>{ if(!q.id){ const matches=prior.filter(p=>p.type===q.type&&p.question===q.question); if(matches.length===1) q.id=matches[0].id } })
        return api<PostHogSurvey>(`${id}/`,'PATCH',payload)
    }
    return api<PostHogSurvey>('','POST',payload)
}

/** Rewrites an old Signal survey once. Multi-step order has no native equivalent, so those
 * surveys are stopped for review; a single step keeps its native trigger and current status. */
const legacyMigrations=new Map<string,Promise<PostHogSurvey>>()
export function migrateLegacySurvey(survey:PostHogSurvey):Promise<PostHogSurvey>{
    const pending=legacyMigrations.get(survey.id)
    if(pending)return pending
    const run=performLegacyMigration(survey).finally(()=>legacyMigrations.delete(survey.id))
    legacyMigrations.set(survey.id,run)
    return run
}
async function performLegacyMigration(survey:PostHogSurvey):Promise<PostHogSurvey>{
    const conditions=survey.conditions as Record<string,unknown>|null
    const chain=conditions?.lensChain as {managedBy?:string;steps?:{event?:string;properties?:Record<string,{operator:string;values:string[]}>}[];audience?:{clients?:string[];sample?:number};ready?:{maxWaitMs?:number};maxPerUser?:number;quietDaysAfterClose?:number;gapHours?:number}|undefined
    if(chain?.managedBy!=='lens')return survey
    const steps=Array.isArray(chain.steps)?chain.steps:[]
    const last=steps.at(-1)
    // Multiple steps cannot preserve ordering; stop them before replacing the trigger.
    if((steps.length!==1||!last?.event)&&survey.start_date&&!survey.end_date)await api(`${survey.id}/`,'PATCH',{end_date:new Date().toISOString()})
    if(!last?.event)throw new ToolInputError(`Legacy survey ${survey.id} has no usable final event. It is stopped; edit its trigger before relaunch.`)
    const native:Record<string,unknown>={...conditions}
    delete native.lensChain;delete native.events
    native.events={values:[{name:last.event,...(last.properties?{propertyFilters:last.properties}:{})}],repeatedActivation:(conditions?.events as {repeatedActivation?:boolean}|undefined)?.repeatedActivation??false}
    native.seenSurveyWaitPeriodInDays=Math.max(Number(native.seenSurveyWaitPeriodInDays)||0,Number(chain.quietDaysAfterClose)||0,Math.ceil((Number(chain.gapHours)||0)/24),chain.maxPerUser?1:0)
    const appearance={...(survey.appearance||{}),surveyPopupDelaySeconds:chain.ready?2:0}
    const audience=chain.audience
    const pattern=audience?.clients?.length?`^[^|]*\\|[^|]*\\|(?:${audience.clients.map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})\\|`:undefined
    const targeting_flag_filters=pattern||audience?.sample&&audience.sample<100?{groups:[{properties:pattern?[{key:'distinct_id',type:'person',value:pattern,operator:'regex'}]:[],rollout_percentage:audience?.sample??100}]}:undefined
    const recurrence=survey.schedule==='recurring' && chain.maxPerUser && !survey.iteration_count?{iteration_count:chain.maxPerUser}:{}
    const review=steps.length>1?'Migration review: this survey used an ordered event sequence. Native PostHog uses its final event only; review before relaunch.':chain.maxPerUser?'Migration note: the former simultaneous-survey cap has no native equivalent.':''
    const description=review?`${survey.description||''}${survey.description?'\n\n':''}${review}`:survey.description
    const body={conditions:native,appearance,...(description?{description}:{}),...recurrence,...(targeting_flag_filters?{targeting_flag_filters}:{})}
    return api<PostHogSurvey>(`${survey.id}/`,'PATCH',body)
}
