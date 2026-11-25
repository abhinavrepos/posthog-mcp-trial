import { auditClient } from '../core/toolcontext.ts'
// MCP tools for in-app surveys: a PM describes a survey in chat, Signal checks it, estimates how many
// would see it and saves it as a draft. Launching is never possible from chat: only on the Surveys page. Every survey and
// its answers are also on the Surveys page (/replays/surveys).
import { jsonResult } from './result.ts'
import { ANALYSIS_OUTPUT } from './structured.ts'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { windowArg } from './timeinput.ts'
import { ToolInputError } from '../core/toolinputerror.ts'

import { appEvents } from '../core/appevents.ts'
import { config, surveysActive } from '../core/config.ts'
import { resolveClient } from '../core/resolve.ts'
import { surveyEvidence } from '../core/surveychecks.ts'
import {
    archiveSurvey,
    compileSurvey,
    conflictsFor,
    queueAlert,
    estimateReach,
    listSurveys,
    saveSurvey,
    freshSurvey,
    stopSurvey,
    surveyOverview,
    surveyResults,
    viewOf,
    type SurveySpec,
} from '../core/surveys.ts'
import { audit, type ChatCaller, type SurveyRole } from '../service/access.ts'

export const SURVEY_TOOLS = ['design_survey', 'save_survey', 'stop_survey', 'list_surveys', 'survey_results']
// Which tools each survey role gets in chat (the same roles as the Surveys page, set on the admin page).
const TOOLS_FOR: Record<SurveyRole, string[]> = {
    none: [],
    view: ['list_surveys', 'survey_results'],
    edit: ['list_surveys', 'survey_results', 'design_survey', 'save_survey'],
    launch: SURVEY_TOOLS,
}
export const surveyToolNames = (role: SurveyRole = 'launch'): string[] => (surveysActive() && appEvents() ? SURVEY_TOOLS.filter((t) => TOOLS_FOR[role].includes(t)) : [])

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
/** Survey counts are over the last N days; window {"last":"Nd"} (or "Nh", rounded up to days) is the same thing. */
const surveyWindow = windowArg.optional().describe('Same as days, as a rolling window: {"last":"365d"}. Survey counts always end now.')
function daysOf(window: unknown, days: number): number {
    if (window === undefined) return days
    const v = typeof window === 'string' ? window : (window as { last?: string }).last
    const m = typeof v === 'string' ? /^(\d{1,5})([hd])$/.exec(v) : null
    if (!m) throw new ToolInputError('Survey counts cover the last N days up to now: use window {"last":"30d"} (or days). Example: {"window":{"last":"365d"}}')
    return Math.min(1500, Math.max(1, Math.ceil(Number(m[1]) / (m[2] === 'h' ? 24 : 1))))
}
const json = jsonResult
const pageUrl = (id?: string) => `${config.service.publicUrl}/replays/surveys${id ? `#${id}` : ''}`

const filter = z.union([
    z.string(),
    z.array(z.string()).min(1).max(50),
    z.object({ operator: z.enum(['exact', 'is_not', 'icontains', 'not_icontains', 'regex', 'not_regex']), values: z.array(z.string()).min(1).max(50) }),
])
const step = z
    .object({
        opens: z.string().optional().describe('Dialog id the user opens, e.g. DlgDetailIRSwap'),
        closes: z.string().optional().describe('Dialog id the user closes'),
        button: z.string().optional().describe('Button pressed: Save, Run, Export…'),
        field: z.string().optional().describe('Field label touched, e.g. "Trade Date"'),
        dialog: z.string().optional().describe('With button or field: only in this dialog'),
        message: z.string().optional().describe('Text in a message or notice the app shows (any case), e.g. "has been scheduled"'),
        message_pattern: z.string().optional().describe('A message as a simple regular expression, e.g. "^Link Id [0-9]+ Added$"'),
        event: z.string().optional().describe('Any other app event by name, with properties'),
        properties: z.record(z.string(), filter).optional().describe('With event: property filters'),
    })
    .describe('One thing the user does. Exactly one of opens, closes, button, field, message, message_pattern, event.')
const question = z.object({
    type: z.enum(['rating', 'nps', 'yes_no', 'thumbs', 'open', 'single', 'multiple']).describe('rating: 1-N numbers (or emoji); nps: 0-10; yes_no: two buttons; thumbs: up/down; open: text box; single/multiple: choices'),
    text: z.string().describe('The question as the user reads it'),
    description: z.string().optional(),
    scale: z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(10)]).optional().describe('rating only, default 5'),
    low_label: z.string().optional(),
    high_label: z.string().optional(),
    emoji: z.boolean().optional(),
    choices: z.array(z.string()).optional().describe('single/multiple only'),
    yes_label: z.string().optional().describe('yes_no: default Yes'),
    no_label: z.string().optional().describe('yes_no: default No'),
    other: z.boolean().optional().describe('single/multiple: add an "Other" choice with a text box'),
    placeholder: z.string().optional(),
    optional: z.boolean().optional(),
})
const color = z.string().optional()
const look = z
    .object({
        theme: z.enum(['light', 'dark']).optional().describe('A finished look (light: white, ION blue; dark: navy, amber). Fields below override it.'),
        background: color, text: color, text_subtle: color.describe('descriptions and scale labels'), button: color.describe('submit button'), button_text: color,
        rating: color.describe('rating and choice buttons'), rating_active: color, input_background: color, input_text: color, border: color,
        corner_radius: z.number().int().optional().describe('0-24 px, default 14'),
        shadow: z.enum(['none', 'soft', 'strong']).optional(),
        padding: z.enum(['compact', 'normal', 'roomy']).optional(),
        font: z.enum(['app', 'system']).optional().describe("app: Reval's own font (default)"),
        position: z.enum(['right', 'left', 'center', 'top_right', 'top_left', 'top_center', 'middle_right', 'middle_left', 'middle_center']).optional().describe('right = bottom right (default)'),
        max_width: z.number().int().optional().describe('280-600 px, default 340'),
        submit_label: z.string().optional(),
        thank_you: z.string().optional().describe('Heading after an answer; "" for none'),
        thank_you_text: z.string().optional(),
        placeholder: z.string().optional().describe('In text boxes'),
    })
    .describe('Colours as #rrggbb, solid only. The footer always reads the brand set at install ("Survey by ION").')
export const specShape = {
    name: z.string().describe('Name for the team (users do not see it)'),
    description: z.string().optional(),
    questions: z.array(question).min(1).max(10),
    steps: z.array(step).min(1).max(10).describe('In order. Other events in between are fine. The survey shows as soon as the last step happens and the page has loaded.'),
    within_minutes: z.number().optional().describe('All steps within this many minutes of the first'),
    reset_on: z.array(step).max(20).optional().describe('Any of these starts the chain over, e.g. closing the first dialog'),
    clients: z.array(z.string()).max(500).optional().describe('Client names or ids. Leave out for every client.'),
    sample_percent: z.number().int().optional().describe('Only this % of those users (fixed per user), default 100'),
    url_contains: z.string().optional(),
    wait_for_page: z.boolean().optional().describe('Wait until the page has loaded and loading masks are gone (default true)'),
    max_wait_seconds: z.number().optional().describe('Skip if the page stays busy this long (default 30)'),
    show: z.enum(['once', 'every_time']).optional().describe('once per user (default) or every time the steps happen'),
    days_between_surveys: z.number().int().optional().describe('No survey for a user who saw any survey within this many days (default 14, at least 1)'),
    max_responses: z.number().int().optional(),
    look: look.optional(),
}

/** Client names → ids. Unclear names stop the save with the candidates, never guess. */
async function clientIds(names: string[] = []): Promise<{ ids: string[]; unclear: string[] }> {
    const ids: string[] = []
    const unclear: string[] = []
    for (const n of names) {
        const m = await resolveClient({ text: n, clientHint: n })
        if (m[0] && m[0].confidence >= 0.7 && !(m[1] && m[1].confidence >= m[0].confidence)) {ids.push(m[0].id);auditClient(m[0].id)}
        else unclear.push(m.length ? `"${n}": ${m.slice(0, 4).map((x) => `${x.name} (${x.id})`).join(', ')}?` : `"${n}": no client matches`)
    }
    return { ids: [...new Set(ids)], unclear }
}

export function registerSurveyTools(server: McpServer, caller: Pick<ChatCaller, 'who' | 'surveyRole'> = { who: 'mcp', surveyRole: 'launch' }): void {
    const allowed = new Set(surveyToolNames(caller.surveyRole))
    if (!allowed.size) return
    // Only the tools this caller's survey role allows exist for them at all.
    const reg = ((name: string, ...rest: unknown[]) => (allowed.has(name) ? (server.registerTool as (...a: unknown[]) => unknown)(name, ...rest) : undefined)) as typeof server.registerTool
    const who = caller.who
    const app = appEvents()!.app

    reg(
        'design_survey',
        {
            title: 'Check a survey before saving it',
            description: `Checks an in-app ${app} survey without saving it. Answers e.g. "will this survey work?", "how many users would see it?". Compiles the steps; errors (block saving) and warnings (do not) are in problems: a step's dialog, button or field, or the client audience, that matched nothing in the last 30 days is warned about with close matches (e.g. LinkListReqv for DlgHedgeDesigListReport). Estimates reach: sessions that went through the steps over days of history (default 14; more than 90 uses the last 90 and says so in reach.note). Steps name what ${app} sends: opens/closes = dialog_id, button = exact action_name (Export, XLS Export, XLSX Export and CSV Export are four buttons), message = text shown. Show all problems and overlap/fatigue warnings, then save_survey. Use posthog_exec recipes to look up dialog and button names. ${'A slow estimate returns a job_id: poll get_job_result.'} Example: {"name":"Hedge export","questions":[{"type":"rating","text":"How easy was the export?"}],"steps":[{"opens":"LinkListReqv"},{"button":"Export","dialog":"LinkListReqv"}],"clients":["C08"]}`,
            inputSchema: { ...specShape, days:z.number().int().min(1).max(1500).default(14).describe('Days of history for the reach estimate (more than 90 uses 90)'), window: surveyWindow,estimate: z.boolean().default(true).describe('Count past sessions that went through the steps') },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async (args) => {
            const { estimate, days: rawDays, window, ...spec } = args as typeof args & { window?: unknown }
            const days = daysOf(window, rawDays)
            const { ids, unclear } = await clientIds(spec.clients)
            const c = compileSurvey(spec as SurveySpec, { clientIds: ids })
            const errors = c.problems.filter((p) => p.level === 'error')
            // A year of events makes the reach scan expensive. The estimate describes the
            // recent audience and explicitly reports the window actually queried. Checks and estimate run together.
            const reachDays = Math.min(days,90)
            const [evidence, reach] = await Promise.all([errors.length ? [] : surveyEvidence(c.chain), estimate && !errors.length ? estimateReach(c.chain,reachDays) : undefined])
            c.problems.push(...evidence)
            const conflicts = conflictsFor(c.chain, {}, await listSurveys())
            const q = queueAlert(c.chain, conflicts)
            return json(`${q.level === 'clear' ? '' : q.alert + '\n\n'}${errors.length || unclear.length ? 'This survey cannot be saved yet:' : 'The survey checks out. Show the person this plan (lead with any ⚠ alert above), then save_survey.'}`, {
                steps: c.chain.labels,
                reset_on: c.chain.resetLabels || [],
                clients: ids.length ? ids : 'every client',
                unclear_clients: unclear,
                shows: `${spec.show === 'every_time' ? 'every time' : 'once per user'}, as soon as the last step happens${spec.wait_for_page === false ? '' : ' and the page has loaded'}`,
                problems: c.problems,
                surveys_per_user: { ...queueAlert(c.chain, conflicts), already_in: conflicts.map((x) => x.text) },
                reach: {days,result:reach,...(days>reachDays ? {note:`Reach estimate capped at ${reachDays} days (requested ${days} days).`} : {})},
            })
        }
    )

    reg(
        'save_survey',
        {
            title: 'Save a survey as a draft, or change one',
            description: `Saves a ${app} survey as a draft, or changes a draft (survey_id plus its complete spec). Same spec as design_survey; run design_survey first. Users see nothing until someone launches it on the Surveys page: this tool cannot launch, and running or stopped surveys can only be changed on that page. Example: {"name":"Hedge export","questions":[{"type":"rating","text":"How easy was the export?"}],"steps":[{"opens":"LinkListReqv"},{"button":"Export","dialog":"LinkListReqv"}]}`,
            inputSchema: { ...specShape, survey_id: z.string().optional().describe('Change this survey instead of making a new one') },
        },
        async (args) => {
            const { survey_id, ...spec } = args
            if (survey_id) {
                const current = await freshSurvey(survey_id)
                if (!current) return text(`No survey ${survey_id}. Nothing was saved.`)
                const status = viewOf(current).status
                if (status !== 'draft') return text(`"${current.name}" is ${status}. Chat changes drafts only; change it on the Surveys page: ${pageUrl(survey_id)}. Nothing was saved.`)
            }
            const { ids, unclear } = await clientIds(spec.clients)
            if (unclear.length) return json('Which clients? Nothing was saved:', unclear)
            const out = await saveSurvey(spec as SurveySpec, { id: survey_id, clientIds: ids })
            if (!out.survey) return json('Nothing was saved. Fix these first:', out.compiled.problems)
            audit(who, survey_id ? 'survey.changed' : 'survey.created', { survey: out.survey.id, name: out.survey.name })
            const v = viewOf(out.survey)
            const conflicts = conflictsFor(out.compiled.chain, out.survey, await listSurveys())
            return json(
                `${queueAlert(out.compiled.chain, conflicts).alert}\n\n${survey_id ? 'Changed' : 'Saved as a draft'}: "${v.name}" (${v.status}). ${v.status === 'draft' ? 'Users see nothing yet. Chat cannot launch surveys: someone with the launch role launches it on the Surveys page.' : ''} Page: ${pageUrl(v.id)}`,
                { survey: v, warnings: out.compiled.problems, queue: queueAlert(out.compiled.chain, conflicts), already_in: conflicts.map((x) => x.text) }
            )
        }
    )

    reg(
        'stop_survey',
        {
            title: 'Stop a survey',
            description: 'Stops a running survey; answers stay. archive: true also hides it from lists. Get the survey_id from list_surveys. Example: {"survey_id":"01a20f7f-a88f-0000-e846-86bf537bde32"}',
            inputSchema: { survey_id: z.string({ error: 'survey_id is required (from list_surveys)' }), archive: z.boolean().default(false) },
        },
        async ({ survey_id, archive }) => {
            const s = archive ? await archiveSurvey(survey_id) : await stopSurvey(survey_id)
            audit(who, archive ? 'survey.archived' : 'survey.stopped', { survey: s.id, name: s.name })
            return text(`${archive ? 'Archived' : 'Stopped'}: "${s.name}". Users no longer see it.`)
        }
    )

    reg(
        'list_surveys',
        {
            title: 'Which surveys are there?',
            description: 'Lists every survey with id, name, status (draft, running, stopped), steps, audience, and how often it was shown, answered and dismissed in the last days (default 30, up to 1500). Answers e.g. "how many surveys are there?", "is survey X running?", "which survey was shown most?" (use days: 1500 or window {"last":"1500d"} for all time). For one survey\'s answers by question use survey_results. Example: {"window":{"last":"365d"}}',
            inputSchema: { days: z.number().int().min(1).max(1500).default(30).describe('Counts over this many days'), window: surveyWindow },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ days: rawDays, window }) => {
            const days = daysOf(window, rawDays)
            const list = await surveyOverview(days)
            return json(`${list.length} surveys; counts over the last ${days} days. Page: ${pageUrl()}`, list.map((s) => ({ id: s.id, name: s.name, status: s.status, ...(s.freshness ? { freshness: s.freshness } : {}), made_by_lens: s.made_by_lens, steps: s.steps, clients: s.clients, shown: s.shown, answered: s.answered, dismissed: s.dismissed, questions: s.questions.map((q) => q.text) })))
        }
    )

    reg(
        'survey_results',
        {
            title: 'What did users answer?',
            description: 'One survey\'s results over the last days (default 90, up to 1500): times shown, answered and dismissed, answers by question, client and day, and recent written answers. Answers e.g. "how many times was survey X shown?", "what did users answer?". Get the survey_id from list_surveys (names are not ids). Example: {"survey_id":"01a20f7f-a88f-0000-e846-86bf537bde32","window":{"last":"365d"}}',
            inputSchema: { survey_id: z.string({ error: 'survey_id is required (from list_surveys)' }), days: z.number().int().min(1).max(1500).default(90), window: surveyWindow },
            outputSchema: ANALYSIS_OUTPUT, annotations: { readOnlyHint: true },
        },
        async ({ survey_id, days: rawDays, window }) => {
            const days = daysOf(window, rawDays)
            const r = await surveyResults(survey_id, days)
            const spec = r.spec
            return json(`Results, last ${days} days. Page: ${pageUrl(survey_id)}${spec ? '. "spec" is the survey as it is now: change fields there and pass them to save_survey with survey_id.' : ''}`, { ...r, ...(spec ? { spec } : {}) })
        }
    )
}
