// MCP tools for in-app surveys: a PM describes a survey in chat, Lens checks it, estimates how many
// would see it, saves it as a draft, and launches it only after the person says so. Every survey and
// its answers are also on the Surveys page (/replays/surveys).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { appEvents } from '../core/appevents.ts'
import { config, surveysActive } from '../core/config.ts'
import { resolveClient } from '../core/resolve.ts'
import {
    archiveSurvey,
    compileSurvey,
    conflictsFor,
    queueAlert,
    estimateReach,
    listSurveys,
    getSurvey,
    launchSurvey,
    saveSurvey,
    specOf,
    stopSurvey,
    surveyOverview,
    surveyResults,
    viewOf,
    type SurveySpec,
} from '../core/surveys.ts'
import { audit, type ChatCaller, type SurveyRole } from '../service/access.ts'
import { checkTicket, recordLaunch } from '../core/launches.ts'
import { launchCheck } from '../service/surveyspage.ts'

export const SURVEY_TOOLS = ['design_survey', 'save_survey', 'launch_survey', 'stop_survey', 'list_surveys', 'survey_results']
// Which tools each survey role gets in chat (the same roles as the Surveys page, set on the admin page).
const TOOLS_FOR: Record<SurveyRole, string[]> = {
    none: [],
    view: ['list_surveys', 'survey_results'],
    edit: ['list_surveys', 'survey_results', 'design_survey', 'save_survey'],
    launch: SURVEY_TOOLS,
}
export const surveyToolNames = (role: SurveyRole = 'launch'): string[] => (surveysActive() && appEvents() ? SURVEY_TOOLS.filter((t) => TOOLS_FOR[role].includes(t)) : [])

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
const json = (label: string, value: unknown) => text(`${label}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``)
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
        if (m[0] && m[0].confidence >= 0.7 && !(m[1] && m[1].confidence >= m[0].confidence)) ids.push(m[0].id)
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
            description: `Checks an in-app ${app} survey described in ${app}'s words (dialogs, buttons, messages, clients, colours) and estimates how many sessions would have seen it in the last 14 days. Users are protected from survey fatigue: at least ${config.surveys.gapHours} hours between surveys, at most ${config.surveys.perUser} running at once, and ${config.surveys.quietDaysAfterClose} quiet days after they close one. When this survey's users are already in another running survey, it returns a ⚠ notice (overlap, or queued users who get it later); always pass it on to the person, first and in full. Saves nothing. Use describe_app_events for dialog ids and button names. Then show the person the plan and problems, and save_survey when they agree.`,
            inputSchema: { ...specShape, estimate: z.boolean().default(true).describe('Count past sessions that went through the steps') },
            annotations: { readOnlyHint: true },
        },
        async (args) => {
            const { estimate, ...spec } = args
            const { ids, unclear } = await clientIds(spec.clients)
            const c = compileSurvey(spec as SurveySpec, { clientIds: ids })
            const errors = c.problems.filter((p) => p.level === 'error')
            const reach = estimate && !errors.length ? await estimateReach(c.chain).catch((e) => ({ error: (e as Error).message })) : undefined
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
                reach_last_14_days: reach,
            })
        }
    )

    reg(
        'save_survey',
        {
            title: 'Save a survey as a draft, or change one',
            description: `Saves an in-app ${app} survey as a draft (users see nothing until launch_survey), or changes one Lens made (give survey_id and every field: start from the "spec" survey_results returns; a running survey changes for users at once, so say so first). The same fields as design_survey.`,
            inputSchema: { ...specShape, survey_id: z.string().optional().describe('Change this survey instead of making a new one') },
        },
        async (args) => {
            const { survey_id, ...spec } = args
            const { ids, unclear } = await clientIds(spec.clients)
            if (unclear.length) return json('Which clients? Nothing was saved:', unclear)
            const out = await saveSurvey(spec as SurveySpec, { id: survey_id, clientIds: ids })
            if (!out.survey) return json('Nothing was saved. Fix these first:', out.compiled.problems)
            audit(who, survey_id ? 'survey.changed' : 'survey.created', { survey: out.survey.id, name: out.survey.name })
            const v = viewOf(out.survey)
            const conflicts = conflictsFor(out.compiled.chain, out.survey, await listSurveys())
            return json(
                `${queueAlert(out.compiled.chain, conflicts).alert}\n\n${survey_id ? 'Changed' : 'Saved as a draft'}: "${v.name}" (${v.status}). ${v.status === 'draft' ? 'Users see nothing yet. Ask the person before launch_survey.' : ''} Page: ${pageUrl(v.id)}`,
                { survey: v, warnings: out.compiled.problems, queue: queueAlert(out.compiled.chain, conflicts), already_in: conflicts.map((x) => x.text) }
            )
        }
    )

    reg(
        'launch_survey',
        {
            title: 'Show a survey to users',
            description: `Starts showing a survey to ${app} users (or starts a stopped one again). Two steps, never one: first call it with only survey_id, which returns the four rules of how it works; show them to the person word for word, with any ⚠ notice, and ask for the Jira ticket this launch is for and for them to type that they acknowledge it launches a survey to Reval users. Only after they did, call again with jira_ticket, acknowledged: true and confirm: true. Never fill in a ticket or the acknowledgement yourself.`,
            inputSchema: {
                survey_id: z.string(),
                jira_ticket: z.string().optional().describe('The Jira ticket the person gave for this launch, e.g. REVAL-1234'),
                acknowledged: z.boolean().optional().describe('true only when the person typed that they acknowledge this launches a survey to Reval users'),
                confirm: z.boolean().optional().describe('true only when the person said to launch it'),
            },
            annotations: { destructiveHint: false, openWorldHint: true },
        },
        async ({ survey_id, jira_ticket, acknowledged, confirm }) => {
            const check = await launchCheck(survey_id)
            const rules = check.rules.map((r, i) => `${i + 1}. ${r}`).join('\n')
            if (confirm !== true || acknowledged !== true || !jira_ticket) {
                return text(`Not launched yet. Show the person this, word for word:\n\n${check.queue && check.queue.level !== 'clear' ? check.queue.alert + '\n\n' : ''}Before "${check.survey.name}" goes live, the four rules of how it works:\n${rules}\n\nTo launch, they give the Jira ticket for this launch and confirm: "${check.acknowledgement}"\nThen call launch_survey again with jira_ticket, acknowledged: true and confirm: true.`)
            }
            const ticket = await checkTicket(jira_ticket)
            if (!ticket.ok) return text(`Not launched: ${ticket.error} Ask the person for the right ticket.`)
            const launched = await launchSurvey(survey_id)
            const v = viewOf(launched)
            recordLaunch({ survey_id: v.id, survey_name: v.name, ticket: ticket.key, ticket_summary: ticket.summary ?? null, launched_by: who, via: 'chat', rules: check.rules })
            audit(who, 'survey.launched', { survey: v.id, name: v.name, ticket: ticket.key })
            const chain = launched.conditions?.lensChain
            const conflicts = chain ? conflictsFor(chain, launched, await listSurveys()) : []
            return json(`${chain ? queueAlert(chain, conflicts).alert + '\n\n' : ''}Running: "${v.name}", launched under ${ticket.key}${ticket.summary ? ` (${ticket.summary})` : ''}. It shows as soon as a user does the steps. Answers: survey_results, or ${pageUrl(v.id)}`, { steps: v.steps, clients: v.clients, sample_percent: v.sample_percent, ticket: ticket.key, ...(chain ? { queue: queueAlert(chain, conflicts) } : {}), already_in: conflicts.map((x) => x.text) })
        }
    )

    reg(
        'stop_survey',
        {
            title: 'Stop a survey',
            description: 'Stops showing a survey. Answers stay. archive: true also hides it from lists.',
            inputSchema: { survey_id: z.string(), archive: z.boolean().default(false) },
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
            description: `Every in-app survey (made in Lens or in PostHog): status, the steps that show it, clients, and how many were shown and answered.`,
            inputSchema: { days: z.number().int().min(1).max(365).default(30).describe('Counts over this many days') },
            annotations: { readOnlyHint: true },
        },
        async ({ days }) => {
            const list = await surveyOverview(days)
            return json(`${list.length} surveys; counts over the last ${days} days. Page: ${pageUrl()}`, list.map((s) => ({ id: s.id, name: s.name, status: s.status, made_by_lens: s.made_by_lens, steps: s.steps, clients: s.clients, shown: s.shown, answered: s.answered, dismissed: s.dismissed, questions: s.questions.map((q) => q.text) })))
        }
    )

    reg(
        'survey_results',
        {
            title: 'What did users answer?',
            description: 'A survey\'s numbers: how often its steps completed, shown, answered and dismissed, each question\'s answers (ratings, NPS, choices, recent written answers), per client and per day.',
            inputSchema: { survey_id: z.string(), days: z.number().int().min(1).max(365).default(90) },
            annotations: { readOnlyHint: true },
        },
        async ({ survey_id, days }) => {
            const r = await surveyResults(survey_id, days)
            const spec = r.survey.made_by_lens ? specOf(await getSurvey(survey_id)) : undefined
            return json(`Results, last ${days} days. Page: ${pageUrl(survey_id)}${spec ? '. "spec" is the survey as it is now: change fields there and pass them to save_survey with survey_id.' : ''}`, { ...r, ...(spec ? { spec } : {}) })
        }
    )
}
