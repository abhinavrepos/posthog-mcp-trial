import { ToolInputError } from './toolinputerror.ts'
import { requestedToolWindow } from './toolcontext.ts'
import { analyticalWindow } from './timewindow.ts'
import { rememberClientSurvey } from './surveylocal.ts'
import { LRUCache } from 'lru-cache'
import { config, surveysActive } from './config.ts'
import { hogql, PostHogError } from './posthog.ts'
import { clientExpr } from './props.ts'

interface CachedSurveyAnswer { value: unknown; at: number; retryAt?: number }
const surveyCache = new LRUCache<string, CachedSurveyAnswer>({ max:128,maxSize:8*1024*1024,sizeCalculation:(entry,key)=>Buffer.byteLength(JSON.stringify(entry))+Buffer.byteLength(key) })
const surveyFlights=new Map<string,Promise<unknown>>()
let surveyGeneration=0
export function invalidateSurveyCache():void{surveyGeneration++;surveyCache.clear();surveyFlights.clear()}
export interface SurveyFreshness{stale:true;cached_at:string}
const freshness=(at:number):SurveyFreshness=>({stale:true,cached_at:new Date(at).toISOString()})
async function cachedSurvey<T>(key:unknown[],load:()=>Promise<T>,stale?:(value:T,at:number)=>T):Promise<T>{
    requireSurveys()
    const scope=[config.posthog.host,config.posthog.projectId,config.posthog.personalApiKey,config.posthog.surveyApiKey]
    const k=JSON.stringify([scope,key,requestedToolWindow()]);const hit=surveyCache.get(k);const age=hit?Date.now()-hit.at:Infinity
    const ttl=key[0]==='list'||key[0]==='get'?30000:60000
    if(hit&&age<ttl)return structuredClone(hit.value) as T
    if(hit&&stale&&age<300000&&hit.retryAt&&Date.now()<hit.retryAt)return stale(structuredClone(hit.value) as T,hit.at)
    let flight=surveyFlights.get(k) as Promise<T>|undefined
    if(!flight){
        if(surveyFlights.size>=64){if(hit&&stale&&age<300000)return stale(structuredClone(hit.value) as T,hit.at);throw new Error('Survey reads are busy; retry shortly.')}
        const generation=surveyGeneration
        flight=Promise.resolve().then(load).then(value=>{if(generation===surveyGeneration)surveyCache.set(k,{value:structuredClone(value),at:Date.now()});return value}).catch(error=>{if(hit&&generation===surveyGeneration&&surveyCache.peek(k)===hit)surveyCache.set(k,{...hit,retryAt:Date.now()+5000});throw error}).finally(()=>{if(surveyFlights.get(k)===flight)surveyFlights.delete(k)})
        surveyFlights.set(k,flight)
    }
    if(hit&&stale&&age<300000){void flight.catch(()=>{});return stale(structuredClone(hit.value) as T,hit.at)}
    return structuredClone(await flight)
}
let surveyQueryTail:Promise<unknown>=Promise.resolve();let surveyQueries=0
export function surveyQuery(query:string,values:Record<string,unknown>={}){
    if(typeof values.days==='number'){
        const window=requestedToolWindow()||analyticalWindow(`last ${values.days} days`)!
        query=query.replaceAll('timestamp > now() - toIntervalDay({days})','timestamp >= {history_from} AND timestamp < {history_to}')
        values={...values,history_from:window.from.toISOString(),history_to:window.to.toISOString()}
    }
    if(surveyQueries>=64)return Promise.reject(new PostHogError('Survey query queue is busy; retry shortly.',503))
    surveyQueries++
    const run=surveyQueryTail.then(()=>hogql(query,values)).finally(()=>{surveyQueries--})
    surveyQueryTail=run.catch(()=>{})
    return run
}
export interface PostHogSurvey{
    id:string;name:string;description?:string;type:string
    questions:{id?:string;type:string;question:string;choices?:string[];hasOpenChoice?:boolean;scale?:number;display?:string;lowerBoundLabel?:string;upperBoundLabel?:string;optional?:boolean;description?:string;buttonText?:string;branching?:unknown}[]
    conditions:{events?:{values?:{name:string}[];repeatedActivation?:boolean};actions?:{values?:{id:number}[]};url?:string;urlMatchType?:string;selector?:string;deviceTypes?:string[];seenSurveyWaitPeriodInDays?:number;linkedFlagVariant?:string}|null
    appearance:Record<string,unknown>|null;start_date:string|null;end_date:string|null;archived?:boolean;created_at:string;created_by?:{email?:string}|null;schedule?:string;responses_limit?:number|null;iteration_count?:number|null;iteration_frequency_days?:number|null;targeting_flag?:{filters?:{groups?:{properties?:{key:string;value:unknown}[];rollout_percentage?:number}[]}}|null;linked_flag?:unknown
}
export function requireSurveys():void{if(!config.surveys.enabled)throw new Error('Surveys are switched off.');if(!surveysActive())throw new Error('POSTHOG_SURVEY_API_KEY is required.')}
async function surveyApi<T>(path:string,init:RequestInit={}):Promise<T>{
    requireSurveys()
    const res=await fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/surveys/${path}`,{...init,headers:{authorization:`Bearer ${config.posthog.surveyApiKey}`,'content-type':'application/json',...init.headers},signal:AbortSignal.timeout(30000)})
    if(!res.ok){const detail=(await res.text().catch(()=>'' )).slice(0,1000);throw new PostHogError(`PostHog surveys ${init.method||'GET'} → ${res.status}: ${detail}`,res.status)}
    if(init.method&&init.method!=='GET')invalidateSurveyCache()
    return (res.status===204?undefined:await res.json()) as T
}
export type Status='draft'|'running'|'stopped'|'archived'
export const statusOf=(s:Pick<PostHogSurvey,'start_date'|'end_date'|'archived'>):Status=>s.archived?'archived':!s.start_date?'draft':s.end_date?'stopped':'running'
async function migrateIfNeeded(raw:PostHogSurvey):Promise<PostHogSurvey>{
    const survey=normalSurvey(raw)
    if(!(survey.conditions as Record<string,unknown>|null)?.lensChain)return survey
    const {migrateLegacySurvey}=await import('./native-surveys.ts')
    return normalSurvey(await migrateLegacySurvey(survey))
}
export async function freshSurvey(id:string):Promise<PostHogSurvey|null>{try{return migrateIfNeeded(await surveyApi<PostHogSurvey>(`${checkId(id)}/`))}catch(e){if(/\b404\b|not found/i.test(String((e as Error)?.message??e)))return null;throw e}}
export function listSurveys():Promise<PostHogSurvey[]>{return cachedSurvey(['list'],loadSurveys)}
async function loadSurveys():Promise<PostHogSurvey[]>{const out:PostHogSurvey[]=[];const failures:string[]=[];let path='?limit=100';for(let i=0;i<20&&path;i++){const page=await surveyApi<{results:PostHogSurvey[];next:string|null}>(path);if(!Array.isArray(page.results))throw new PostHogError('PostHog surveys → 502: unreadable answer (invalid survey list)',502);for(const raw of page.results){
            try { out.push(await migrateIfNeeded(raw)) }
            catch { console.error('survey migration failed',raw.id);failures.push(raw.id) }
        };path=page.next?`?${new URL(page.next).searchParams.toString()}`:''}
    if(failures.length)throw new ToolInputError(`Could not migrate legacy surveys ${failures.join(', ')}. Signal will retry; these surveys must be reviewed before use.`)
    return out}
function normalSurvey(s:PostHogSurvey):PostHogSurvey{if(!s||typeof s.id!=='string')throw new PostHogError('Invalid PostHog survey',502);return {...s,name:String(s.name??''),questions:Array.isArray(s.questions)?s.questions:[],created_at:String(s.created_at??'')}}
export const getSurvey=(id:string):Promise<PostHogSurvey>=>cachedSurvey(['get',checkId(id)],async()=>migrateIfNeeded(await surveyApi<PostHogSurvey>(`${id}/`)))
function checkId(id:string):string{if(!/^[0-9a-f-]{8,64}$/i.test(id))throw new ToolInputError(`"${String(id).slice(0,80)}" is not a survey id; use list_surveys.`);return id}
function rememberSurvey(s:PostHogSurvey):PostHogSurvey{rememberClientSurvey(s.id,s.name,[],statusOf(s));return s}
export async function launchSurvey(id:string):Promise<PostHogSurvey>{const s=await surveyApi<PostHogSurvey>(`${checkId(id)}/`);const status=statusOf(s);if(status==='running')return s;if(status==='archived')throw new ToolInputError('This survey is archived.');return rememberSurvey(await surveyApi<PostHogSurvey>(`${id}/`,{method:'PATCH',body:JSON.stringify(status==='draft'?{start_date:new Date().toISOString()}:{end_date:null})}))}
export async function stopSurvey(id:string):Promise<PostHogSurvey>{const s=await surveyApi<PostHogSurvey>(`${checkId(id)}/`);if(statusOf(s)!=='running')return s;return rememberSurvey(await surveyApi<PostHogSurvey>(`${id}/`,{method:'PATCH',body:JSON.stringify({end_date:new Date().toISOString()})}))}
export async function archiveSurvey(id:string):Promise<PostHogSurvey>{await stopSurvey(id);return rememberSurvey(await surveyApi<PostHogSurvey>(`${checkId(id)}/`,{method:'PATCH',body:JSON.stringify({archived:true})}))}
export interface SurveyView{
    id:string;name:string;description:string;status:Status;made_by_lens:boolean;steps:string[];reset_on:string[];clients:string[]|'all';sample_percent:number;url_contains?:string;show:'once'|'every_time';days_between_surveys:number;max_responses?:number;questions:{id?:string;type:string;text:string;choices?:string[];scale?:number}[];look:Record<string,unknown>;started?:string;stopped?:string;created:string;created_by?:string;type:string;conditions:PostHogSurvey['conditions'];appearance:PostHogSurvey['appearance'];schedule?:string;iteration_count?:number|null;iteration_frequency_days?:number|null
}
export function kindOf(q:PostHogSurvey['questions'][number]):string{
    if(q.type==='rating'&&q.scale===10&&q.lowerBoundLabel==='Not likely')return 'nps'
    if(q.type==='rating'&&q.scale===2&&q.display==='emoji')return 'thumbs'
    if(q.type==='single_choice'&&q.choices?.length===2&&/^yes$/i.test(q.choices[0])&&/^no$/i.test(q.choices[1]))return 'yes_no'
    return q.type==='single_choice'?'single':q.type==='multiple_choice'?'multiple':q.type
}
export function viewOf(s:PostHogSurvey):SurveyView{
    const filters=s.targeting_flag?.filters?.groups||[]
    const audienceProperties=filters.flatMap(g=>g.properties||[])
    const direct=audienceProperties.filter(p=>p.key==='client').flatMap(p=>Array.isArray(p.value)?p.value.map(String):[String(p.value)])
    const regex=audienceProperties.find(p=>p.key==='distinct_id'&&typeof p.value==='string')?.value
    const prefix='^[^|]*\\|[^|]*\\|(?:'
    const clients=direct.length?direct:typeof regex==='string'&&regex.startsWith(prefix)&&regex.endsWith(')\\|')?regex.slice(prefix.length,-3).split('|').map(c=>c.replace(/\\([.*+?^${}()|[\]\\])/g,'$1')):filters.length?['Targeted in PostHog']:[]
    const sample=filters[0]?.rollout_percentage??100
    const steps=[...(s.conditions?.events?.values||[]).map(v=>`Event ${v.name}`),...(s.conditions?.actions?.values||[]).map(v=>`Action ${v.id}`)]
    const a=s.appearance||{}
    return {id:s.id,name:s.name,description:s.description||'',status:statusOf(s),made_by_lens:false,steps,reset_on:[],clients:clients.length?clients:'all',sample_percent:sample,...(s.conditions?.url?{url_contains:s.conditions.url}:{}),show:s.schedule==='always'?'every_time':'once',days_between_surveys:s.conditions?.seenSurveyWaitPeriodInDays??0,...(s.responses_limit?{max_responses:s.responses_limit}:{}),questions:s.questions.map(q=>({id:q.id,type:kindOf(q),text:q.question,...(q.choices?{choices:q.choices}:{}),...(q.scale?{scale:q.scale}:{})})),look:{background:a.backgroundColor,text:a.textColor,text_subtle:a.textSubtleColor,button:a.submitButtonColor,button_text:a.submitButtonTextColor,rating:a.ratingButtonColor,rating_active:a.ratingButtonActiveColor,input_background:a.inputBackground,input_text:a.inputTextColor,border:a.borderColor,position:a.position,submit_label:a.submitButtonText,thank_you:a.thankYouMessageHeader,thank_you_text:a.thankYouMessageDescription,placeholder:a.placeholder},...(s.start_date?{started:s.start_date}:{}),...(s.end_date?{stopped:s.end_date}:{}),created:s.created_at,...(s.created_by?.email?{created_by:s.created_by.email}:{}),type:s.type,conditions:s.conditions,appearance:s.appearance,schedule:s.schedule,iteration_count:s.iteration_count,iteration_frequency_days:s.iteration_frequency_days}
}
export interface Conflict{survey_id:string;name:string;since:string;clients:string[]|'all';share:number;text:string}
export interface Results {
    survey: SurveyView
    spec?: Record<string, unknown>
    freshness?: SurveyFreshness
    days: number
    shown: number
    dismissed: number
    answered: number
    response_rate: number | null // answered / shown
    questions: {
        id?: string
        text: string
        type: string
        answers: number
        average?: number
        distribution?: Record<string, number>
        nps?: { score: number; promoters: number; passives: number; detractors: number }
        recent?: { at: string; client: string; text: string }[]
    }[]
    by_client: { client: string; shown: number; answered: number; dismissed: number }[]
    by_client_truncated?: boolean
    by_day: { day: string; shown: number; answered: number }[]
    conflicts: Conflict[] // users this survey shares with earlier running surveys
    conflict_summary?: string
}

const RECENT_TEXT = 30
// posthog-js sends "survey sent" after each question with one $survey_submission_id (partial answers),
// so answers are counted per submission. Older versions have no id: each event is one submission.
const SUBMISSION = `coalesce(nullIf(toString(properties.$survey_submission_id), ''), toString(uuid))`
const ANSWERED = `uniqIf(${SUBMISSION}, event = 'survey sent')`

// Resolve each question from the latest event, which holds the SDK's cumulative answers.
// A UUID breaks timestamp ties, and also gives answer pages a stable order.
function questionRaw(s: PostHogSurvey, index: number, values: Record<string, unknown>, prefix = ''): string {
    const q = s.questions[index]
    const keys = [q.id ? `$survey_response_${q.id}` : '', index === 0 ? '$survey_response' : `$survey_response_${index}`].filter(Boolean)
    values[`${prefix}question_text`] = q.question
    const present = (raw: string) => `nullIf(nullIf(nullIf(${raw}, ''), 'null'), '\"\"')`
    const direct = keys.map((key, i) => {
        values[`${prefix}key${i}`] = key
        return present(`JSONExtractRaw(properties, {${prefix}key${i}})`)
    })
    const fallback = `JSONExtractRaw(arrayFirst(x -> JSONExtractString(x, 'question') = {${prefix}question_text} AND isNotNull(${present("JSONExtractRaw(x, 'response')")}), JSONExtractArrayRaw(properties, '$survey_questions')), 'response')`
    return `coalesce(${[...direct, present(fallback)].join(', ')})`
}

function questionSource(s: PostHogSurvey, index: number, days: number, submissions?: string[]) {
    const values: Record<string, unknown> = { id: s.id, days, ...(submissions ? { submissions } : {}) }
    const raw = questionRaw(s, index, values)
    // Wrap nullable answers in a tuple: argMax otherwise skips an empty latest answer and
    // resurrects an older event. Keep only this question in aggregate memory, not all properties.
    const source = `SELECT submission, last_at, client, ifNull(answer_raw, '') AS raw,
            if(startsWith(raw, '"'), JSONExtractString(raw), raw) AS value
        FROM (
            SELECT ${SUBMISSION} AS submission, max(timestamp) AS last_at,
                argMax(toString(${clientExpr()}), tuple(timestamp, uuid)) AS client,
                tupleElement(argMax(tuple(${raw}), tuple(timestamp, uuid)), 1) AS answer_raw
            FROM events WHERE timestamp > now() - toIntervalDay({days})
                AND event = 'survey sent' AND toString(properties.$survey_id) = {id}
                ${submissions ? `AND ${SUBMISSION} IN {submissions}` : ''}
            GROUP BY submission
        ) WHERE answer_raw IS NOT NULL`
    return { source, values }
}

// The paging/count pass needs only answer presence, not the text or client. Keeping a boolean
// per submission avoids retaining every written answer in aggregate memory before the key sort.
function questionKeys(s: PostHogSurvey, index: number, days: number) {
    const values: Record<string, unknown> = { id: s.id, days }
    const raw = questionRaw(s, index, values)
    const source = `SELECT submission, last_at FROM (
        SELECT ${SUBMISSION} AS submission, max(timestamp) AS last_at,
            tupleElement(argMax(tuple(isNotNull(${raw})), tuple(timestamp, uuid)), 1) AS answer_present
        FROM events WHERE timestamp > now() - toIntervalDay({days})
            AND event = 'survey sent' AND toString(properties.$survey_id) = {id}
        GROUP BY submission
    ) WHERE answer_present`
    return { source, values }
}

export interface SurveyAnswers {
    freshness?: SurveyFreshness
    answers: { text: string; client: string; at: string }[]
    total: number
    next?: string // pass as `after` for the next page; absent on the last page
}

// PostHog refuses OFFSET on API-key queries, so pages continue after the last answer seen
// (newest first, by time then submission id).
const cursorOf = (at: string, submission: string) => Buffer.from(JSON.stringify([at, submission])).toString('base64url')
function parseCursor(after: unknown): { at: string; submission: string } | null {
    if (!after || typeof after !== 'string' || after.length > 600) return null
    try {
        const [at, submission] = JSON.parse(Buffer.from(after, 'base64url').toString())
        if (typeof at !== 'string' || typeof submission !== 'string' || Number.isNaN(Date.parse(at))) return null
        return { at, submission }
    } catch {
        return null
    }
}

async function answerPage(s: PostHogSurvey, index: number, days: number, after: string | undefined, limit: number): Promise<SurveyAnswers> {
    const { source, values } = questionKeys(s, index, days)
    const c = parseCursor(after)
    const where = c ? `WHERE last_at < toDateTime64({after_at}, 6, 'UTC') OR (last_at = toDateTime64({after_at}, 6, 'UTC') AND submission < {after_sub})` : ''
    // Count before applying the cursor. Sort only (time, submission), never answer text/client.
    const keys = await surveyQuery(`SELECT last_at AS at, submission, total FROM (
            SELECT last_at, submission, count() OVER () AS total FROM (${source})
        ) ${where} ORDER BY last_at DESC, submission DESC LIMIT {limit}`,
        { ...values, limit: limit + 1, ...(c ? { after_at: c.at, after_sub: c.submission } : {}) })
    const page = keys.slice(0, limit)
    const selected = questionSource(s, index, days, page.map((r) => String(r.submission)))
    const rows = page.length ? await surveyQuery(`SELECT value AS text, client, last_at AS at, submission FROM (${selected.source}) LIMIT {limit}`,
        { ...selected.values, limit }) : []
    const bySubmission = new Map(rows.map((r) => [String(r.submission), r]))
    const last = page.at(-1)
    // A cursor beyond the last answer has no row carrying the window count.
    const total = keys.length ? Number(keys[0].total) : Number((await surveyQuery(`SELECT count() AS total FROM (${source}) LIMIT 1`, values))[0]?.total || 0)
    return {
        answers: page.flatMap((key) => {
            const r = bySubmission.get(String(key.submission))
            return r ? [{ text: String(r.text), client: String(r.client), at: String(r.at) }] : []
        }),
        total,
        ...(keys.length > limit && last ? { next: cursorOf(String(last.at), String(last.submission)) } : {}),
    }
}

/** Written answers over all submissions, newest first. An index is accepted for older questions without an id. */
export async function surveyAnswers(id: string, question: string, after?: string, limit = 50, days = 90): Promise<SurveyAnswers> {
    checkId(id)
    const n = Number(limit)
    const size = Number.isFinite(n) ? Math.min(200, Math.max(1, Math.floor(n))) : 50
    const cursor = parseCursor(after) ? after : undefined
    return cachedSurvey(['answers', id, question, days, cursor ?? null, size], async () => {
        const s = await getSurvey(id)
        const index = s.questions.findIndex((q) => q.id === question)
        const at = index >= 0 ? index : s.questions.findIndex((q, i) => !q.id && String(i) === question)
        if (at < 0) throw new ToolInputError('Question not found. Use a question id from get_survey.')
        return answerPage(s, at, days, cursor, size)
    }, (value, time) => ({ ...value, freshness: freshness(time) }))
}

function ratingResult(q: PostHogSurvey['questions'][number], r: Record<string, unknown>): Results['questions'][number] {
    const out: Results['questions'][number] = { id: q.id, text: q.question, type: q.type, answers: 0 }
    const thumbs = kindOf(q) === 'thumbs'
    const bins = ratingBins(q)
    out.answers = Number(r.answers || 0)
    out.distribution = Object.fromEntries(bins.map((n) => [thumbs ? n === 1 ? 'Thumbs up' : 'Thumbs down' : String(n), Number(r[`bin_${n}`] || 0)]))
    const total = Number(r.numeric_answers || 0)
    if (!thumbs && total) {
        out.average = Math.round(Number(r.average) * 100) / 100
        if (q.scale === 10) {
            const pro = Number(r.promoters), det = Number(r.detractors)
            out.nps = { score: Math.round((pro - det) / total * 100), promoters: pro, passives: total - pro - det, detractors: det }
        }
    }
    return out
}

function ratingBins(q: PostHogSurvey['questions'][number]): number[] {
    return kindOf(q) === 'thumbs' ? [1, 2] : Array.from({ length: (q.scale ?? 5) + (q.scale === 10 ? 1 : 0) }, (_, k) => q.scale === 10 ? k : k + 1)
}

// All rating questions share one submission aggregation and one scan of survey-sent events.
// The tuple includes nullable values so an empty latest answer never revives an older answer.
async function ratingResults(s: PostHogSurvey, days: number): Promise<Map<number, Results['questions'][number]>> {
    const indices = s.questions.flatMap((q, i) => q.type === 'rating' ? [i] : [])
    if (!indices.length) return new Map()
    const values: Record<string, unknown> = { id: s.id, days }
    const raw = indices.map((i) => questionRaw(s, i, values, `r${i}_`))
    const columns = indices.flatMap((i, at) => {
        const value = `tupleElement(latest, ${at + 1})`
        const number = `if(isFinite(toFloat(if(startsWith(${value}, '\"'), JSONExtractString(${value}), ${value}))), toFloat(if(startsWith(${value}, '\"'), JSONExtractString(${value}), ${value})), NULL)`
        return [
            `countIf(isNotNull(${value})) AS r${i}_answers`,
            `count(${number}) AS r${i}_numeric_answers`,
            `avg(${number}) AS r${i}_average`,
            `countIf(${number} >= 9) AS r${i}_promoters`,
            `countIf(${number} <= 6) AS r${i}_detractors`,
            ...ratingBins(s.questions[i]).map((n) => `countIf(${number} = ${n}) AS r${i}_bin_${n}`),
        ]
    })
    const rows = await surveyQuery(`SELECT ${columns.join(', ')} FROM (
        SELECT ${SUBMISSION} AS submission, argMax(tuple(${raw.join(', ')}), tuple(timestamp, uuid)) AS latest
        FROM events WHERE timestamp > now() - toIntervalDay({days})
            AND event = 'survey sent' AND toString(properties.$survey_id) = {id}
        GROUP BY submission
    ) LIMIT 1`, values)
    const row = rows[0] || {}
    return new Map(indices.map((i) => [i, ratingResult(s.questions[i], Object.fromEntries(
        Object.entries(row).filter(([key]) => key.startsWith(`r${i}_`)).map(([key, value]) => [key.slice(`r${i}_`.length), value])
    ))]))
}

async function questionResults(s: PostHogSurvey, index: number, days: number): Promise<Results['questions'][number]> {
    const q = s.questions[index]
    const out: Results['questions'][number] = { id: q.id, text: q.question, type: q.type, answers: 0 }
    if (q.type !== 'single_choice' && q.type !== 'multiple_choice') {
        const page = await answerPage(s, index, days, undefined, RECENT_TEXT)
        out.answers = page.total
        out.recent = page.answers.map((a) => ({ ...a, text: a.text.slice(0, 2000) }))
        return out
    }
    const { source, values } = questionSource(s, index, days)
    const counts = await surveyQuery(`SELECT count() AS answers FROM (${source}) LIMIT 1`, values)
    out.answers = Number(counts[0]?.answers || 0)
    out.distribution = Object.fromEntries((q.choices || []).map((c) => [c, 0]))
    // "Other" choices can have arbitrarily many distinct labels. Page the aggregates too:
    // never rely on HogQL's implicit 100-row limit or cap the underlying submissions.
    // Keyset pages (PostHog refuses OFFSET on API-key queries): continue after the last label.
    for (let after: string | null = null; ;) {
        const rows: Record<string, unknown>[] = await surveyQuery(`SELECT label, count() AS n FROM (
                SELECT if(startsWith(choice, '"'), JSONExtractString(choice), choice) AS label
                FROM (SELECT arrayJoin(if(startsWith(raw, '['), JSONExtractArrayRaw(raw), [raw])) AS choice FROM (${source}))
            ) ${after === null ? '' : 'WHERE label > {after}'} GROUP BY label ORDER BY label LIMIT 1000`, { ...values, ...(after === null ? {} : { after }) })
        for (const r of rows) out.distribution[String(r.label)] = Number(r.n)
        if (rows.length < 1000) break
        after = String(rows[rows.length - 1].label)
    }
    return out
}

export function surveyResults(id: string, days = 90): Promise<Results> {
    return cachedSurvey(['results', checkId(id), days], () => loadSurveyResults(id, days),
        (value, at) => ({ ...value, freshness: freshness(at) }))
}

async function loadSurveyResults(id: string, days: number): Promise<Results> {
    const s = await getSurvey(id)
    const view = viewOf(s)
    const conflicts: Conflict[] = []
    const client = clientExpr()
    const values = { id: s.id, days }
    const [counts, perClient, perDay] = await Promise.all([
        surveyQuery(
            `SELECT event, if(event = 'survey sent', uniq(${SUBMISSION}), count()) AS n FROM events WHERE timestamp > now() - toIntervalDay({days})
             AND event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) = {id}
             GROUP BY event LIMIT 10`,
            values
        ),
        surveyQuery(
            `SELECT toString(${client}) AS client, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered, countIf(event = 'survey dismissed') AS dismissed
             FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) = {id}
             GROUP BY client ORDER BY shown DESC, client LIMIT 5001`,
            values
        ),
        surveyQuery(
            `SELECT toString(toDate(timestamp)) AS day, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered
             FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent') AND toString(properties.$survey_id) = {id}
             GROUP BY day ORDER BY day LIMIT 1500`,
            values
        ),
    ])
    const ratings = await ratingResults(s, days)
    const questions: Results['questions'] = []
    for (let i = 0; i < (s.questions || []).length; i++) {
        questions.push(ratings.get(i) ?? await questionResults(s, i, days))
    }
    const n = (e: string) => Number(counts.find((r) => r.event === e)?.n || 0)
    const shown = n('survey shown')
    const answered = n('survey sent')
    return {
        survey: view,
        spec: {name:s.name,description:s.description,type:s.type,questions:s.questions,appearance:s.appearance,conditions:s.conditions,schedule:s.schedule,iteration_count:s.iteration_count,iteration_frequency_days:s.iteration_frequency_days,responses_limit:s.responses_limit},
        days,
        shown,
        dismissed: n('survey dismissed'),
        answered,
        response_rate: shown ? Math.round((answered / shown) * 1000) / 10 : null,
        questions,
        by_client_truncated: perClient.length > 5000,
        by_client: perClient.slice(0, 5000).map((r) => ({ client: String(r.client), shown: Number(r.shown), answered: Number(r.answered), dismissed: Number(r.dismissed) })),
        by_day: perDay.map((r) => ({ day: String(r.day), shown: Number(r.shown), answered: Number(r.answered) })),
        conflicts,
    }
}

/** Every survey with its headline numbers, for list_surveys and the Surveys page. */
type Overview = SurveyView & { shown: number; answered: number; dismissed: number; freshness?: SurveyFreshness }
export function surveyOverview(days = 30): Promise<Overview[]> {
    return cachedSurvey(['overview', days], () => loadSurveyOverview(days),
        (value, at) => value.map((row) => ({ ...row, freshness: freshness(at) })))
}

async function loadSurveyOverview(days: number): Promise<Overview[]> {
    const list = (await listSurveys()).filter((s) => !s.archived)
    if (!list.length) return []
    const rows = await surveyQuery(
        `SELECT toString(properties.$survey_id) AS id, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered, countIf(event = 'survey dismissed') AS dismissed
         FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) IN {ids}
         GROUP BY id LIMIT {limit}`,
        { days, ids: list.map((s) => s.id), limit: list.length }
    )
    const by = new Map(rows.map((r) => [String(r.id), r]))
    const order: Record<Status, number> = { running: 0, draft: 1, stopped: 2, archived: 3 }
    return list
        .map((s) => {
            const r = by.get(s.id)
            return { ...viewOf(s), shown: Number(r?.shown || 0), answered: Number(r?.answered || 0), dismissed: Number(r?.dismissed || 0) }
        })
        .sort((a, b) => order[a.status] - order[b.status] || b.created.localeCompare(a.created))
}
