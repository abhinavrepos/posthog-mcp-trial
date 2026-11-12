import { rememberClientSurvey } from './surveylocal.ts'
import { rescueQueue, setRescueAction, RescueInputError, type RescueParams } from './rescue.ts'
import { saveSurvey, type SurveySpec } from './surveys.ts'
import { surveysActive } from './config.ts'
import { tasksDb } from './tasks.ts'

const defaults = { rescueQueue, setRescueAction, saveSurvey, surveysActive }
/** view: the period the person is looking at, so the survey asks about the reason they saw. */
export async function draftRescueSurvey(client: string, by: string, injected: Partial<typeof defaults> = {}, view: Omit<RescueParams, 'include_snoozed'> = {}) {
    const d = { ...defaults, ...injected }
    if (!d.surveysActive()) throw new RescueInputError('Surveys are switched off or not configured.')
    const c = (await d.rescueQueue({ ...view, include_snoozed: true })).clients.find(c => c.client === client)
    if (!c) throw new RescueInputError('This client has no current rescue reasons.')
    const reason = c.reasons.find(r => r.kind !== 'worse_since_snoozed')!
    const exports = reason.kind === 'work_moving_out'
    const fallback = tasksDb.prepare('SELECT d.task_id,c.name,c.dialog FROM task_daily d JOIN task_catalog c USING(task_id) WHERE d.client=? GROUP BY d.task_id ORDER BY sum(d.attempts) DESC,d.task_id LIMIT 1').get(client) as { task_id: string; name: string; dialog: string } | undefined
    const task = reason.task_name || c.critical_task?.task_name || fallback?.name
    const taskId = reason.task_id || c.critical_task?.task_id || fallback?.task_id
    const catalog = taskId ? tasksDb.prepare('SELECT dialog FROM task_catalog WHERE task_id=?').get(taskId) as { dialog: string } | undefined : undefined
    const dialog = reason.dialog || catalog?.dialog
    if (!exports && !dialog) throw new RescueInputError('Choose a critical task before asking this client in-app.')
    const spec: SurveySpec = {
        name: `[Rescue] ${c.client_name} – ${exports ? 'exports' : task || dialog}`,
        clients: [client], steps: exports ? [{ button: 'XLSX Export' }] : [{ opens: dialog! }],
        questions: exports ? [
            { type: 'single', text: 'What do you do with the exported file?', choices: ['Reporting', 'Audit', 'Fix numbers in a spreadsheet', 'Load into another system', 'Other'] },
            { type: 'open', text: 'What would make it easier?' },
        ] : [{ type: 'rating', scale: 5, text: `How easy was ${task || dialog} for you this month?` }, { type: 'open', text: 'What would make it easier?' }],
    }
    // PostHog refuses a name used before, archived surveys included: asking the same client twice adds the date, then a number.
    const day = new Date().toISOString().slice(0, 10), base = spec.name
    let result: Awaited<ReturnType<typeof d.saveSurvey>> | undefined
    for (let n = 0; !result; n++) {
        if (n) spec.name = `${base} · ${day}${n > 1 ? ` (${n})` : ''}`
        try { result = await d.saveSurvey(spec, { clientIds: [client] }) }
        catch (e) { if (n >= 5 || !/already a survey with this name/i.test(String((e as Error)?.message))) throw e }
    }
    if (!result.survey) throw new RescueInputError('Could not create draft: ' + result.compiled.problems.map(p => p.text).join('; '))
    rememberClientSurvey(result.survey.id, spec.name, [client], 'draft')
    await d.setRescueAction(client, { note: `Draft survey "${spec.name}" made on ${day}. Review and launch it on the Surveys page.` }, by, view)
    return { survey_id: result.survey.id, open: '/replays/surveys#' + encodeURIComponent(result.survey.id), message: `Draft survey "${spec.name}" is ready to review.` }
}
