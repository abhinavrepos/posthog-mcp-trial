import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { PostHogSurvey, SurveySpec } from '../src/core/surveys.ts'

// The system temp folder: the image runs its tests as a user who cannot write to the app folder.
const dir = mkdtempSync(join(tmpdir(), 'survey-blockers-'))
Object.assign(process.env, {
    TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'),
    APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_HOST: 'http://localhost',
    POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'test-read', POSTHOG_SURVEY_API_KEY: 'test-survey', FEATURE_SURVEYS: 'on',
})
const surveys = await import('../src/core/surveys.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { specShape } = await import('../src/mcp/surveytools.ts')
const { z } = await import('zod')
const id = '01a1c6d6-8086-0000-b54b-4feed4e4f2b0'
const spec: SurveySpec = { name: 'Feedback 🦉', questions: [{ type: 'open', text: 'Why?' }], steps: [{ opens: 'DlgA' }] }
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

function saved(input: SurveySpec): PostHogSurvey {
    const compiled = surveys.compileSurvey(input, { chainId: 'feedback' })
    return { id, created_at: '2026-11-01T00:00:00Z', start_date: '2026-11-02T00:00:00Z', end_date: null,
        ...compiled.body, questions: (compiled.body.questions as PostHogSurvey['questions']).map((q, i) => ({ ...q, id: `q${i}` })) } as PostHogSurvey
}

test('results return a complete editable spec for all ten questions and preserve running answer IDs', async (t) => {
    const original = saved({ ...spec, max_wait_seconds: 0, questions: [
        { type: 'rating', text: 'Ease?', scale: 7, low_label: 'Hard', high_label: 'Easy', optional: true, description: 'Your work' },
        { type: 'rating', text: 'Mood?', emoji: true, scale: 3 },
        { type: 'nps', text: 'Recommend?' }, { type: 'thumbs', text: 'Good?' },
        { type: 'yes_no', text: 'Worked?' }, { type: 'yes_no', text: 'Ready?', yes_label: 'Ready', no_label: 'Later' },
        { type: 'open', text: 'Why? 🦉' }, { type: 'single', text: 'Which?', choices: ['A', 'B'], other: true },
        { type: 'multiple', text: 'All?', choices: ['One', 'Two'], other: true }, { type: 'open', text: 'Anything else?', optional: true },
    ] })
    let current = original
    surveys.invalidateSurveyCache(); t.after(surveys.invalidateSurveyCache)
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') { current = { ...current, ...JSON.parse(String(init.body)) }; return Response.json(current) }
        return Response.json(current)
    })
    const editable = surveys.specOf(await surveys.getSurvey(id))
    assert.equal(z.object(specShape).safeParse(editable).success, true, 'the spec advertised by survey_results must be accepted by save_survey')
    const out = await surveys.saveSurvey({ ...editable, name: 'Changed title' } as SurveySpec, { id })
    assert.ok(out.survey)
    assert.equal(out.survey.start_date, original.start_date)
    assert.deepEqual(out.survey.questions, original.questions, 'all question content and answer IDs survive a name-only edit')
    assert.equal(out.compiled.chain.ready.maxWaitMs, 0)
})

test('removing max_responses from a running survey clears its saved PostHog limit', async (t) => {
    let current = saved({ ...spec, max_responses: 10 })
    surveys.invalidateSurveyCache(); t.after(surveys.invalidateSurveyCache)
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') current = { ...current, ...JSON.parse(String(init.body)) }
        return Response.json(current)
    })
    const out = await surveys.saveSurvey(spec, { id })
    assert.equal(out.survey?.responses_limit, null, 'omitting an optional limit must remove the old limit on PATCH')
})

test('rescue drafts retry a real saveSurvey name conflict with a dated name', async (t) => {
    const { draftRescueSurvey } = await import('../src/core/rescuesurveys.ts')
    const names: string[] = []
    surveys.invalidateSurveyCache(); t.after(surveys.invalidateSurveyCache)
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body)); names.push(body.name)
            if (names.length === 1) return Response.json({ detail: 'There is already a survey with this name.' }, { status: 400 })
            return Response.json({ ...saved(spec), ...body, start_date: null })
        }
        return Response.json({ results: [{ ...saved(spec), name: names[0] }] })
    })
    const rescueQueue = async () => ({ clients: [{ client: 'ACME', client_name: 'Acme', reasons: [{ kind: 'work_moving_out' }] }] })
    const result = await draftRescueSurvey('ACME', 'pm', { rescueQueue: rescueQueue as never, setRescueAction: (async () => ({})) as never })
    assert.equal(result.survey_id, id)
    assert.equal(names.length, 2)
    assert.match(names[1], / · \d{4}-\d{2}-\d{2}$/)
})

test('a concurrent same-name create cannot overwrite another PM recent draft', async (t) => {
    const other = { ...saved({ ...spec, questions: [{ type: 'open', text: 'Other PM question' }], clients: ['BETA'] }),
        start_date: null, created_at: new Date().toISOString() }
    const patches: unknown[] = []
    surveys.invalidateSurveyCache(); t.after(surveys.invalidateSurveyCache)
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'POST') return Response.json({ detail: 'There is already a survey with this name.' }, { status: 400 })
        if (init?.method === 'PATCH') { patches.push(init.body); return Response.json({ ...other, ...JSON.parse(String(init.body)) }) }
        return Response.json({ results: [other] })
    })
    await assert.rejects(surveys.saveSurvey(spec), /already exists/)
    assert.deepEqual(patches, [], 'a naming collision must never authorize replacing someone else draft')
})

test('reordering and inserting questions keep historical answers attached to their original question IDs', async (t) => {
    const first = { type: 'open' as const, text: 'What worked?' }, second = { type: 'open' as const, text: 'What failed?' }
    let current = saved({ ...spec, questions: [first, second] })
    surveys.invalidateSurveyCache(); t.after(surveys.invalidateSurveyCache)
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
        if (init?.method === 'PATCH') current = { ...current, ...JSON.parse(String(init.body)) }
        return Response.json(current)
    })
    const reordered = await surveys.saveSurvey({ ...spec, questions: [second, first] }, { id })
    assert.deepEqual(reordered.survey?.questions.map(q => q.id), ['q1', 'q0'], 'existing answer keys must follow the questions when reordered')
    const inserted = await surveys.saveSurvey({ ...spec, questions: [{ type: 'open', text: 'New question' }, second, first] }, { id })
    assert.deepEqual(inserted.survey?.questions.map(q => q.id), [undefined, 'q1', 'q0'], 'a new question must not steal an existing question answer key')
})
