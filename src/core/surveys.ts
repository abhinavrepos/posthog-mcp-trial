// Surveys made from Lens: a PM describes one in the app's own words (which dialog, which button, which
// message, which clients, which colours) and Lens turns it into a PostHog survey that PostHog's own
// survey script shows. Nothing new is added to the tracked app.
//
// How a survey reaches a user:
//   1. Lens saves a PostHog survey whose conditions carry a "Lens chain" (conditions.lensChain): the
//      ordered steps, the clients, and "wait until the page has loaded".
//   2. The survey renderer PostHog serves (deploy/posthog/survey-engine) follows the chain in the
//      browser. When the last step happens and the page is ready, it sends lens_chain:<id>.
//   3. The survey's own trigger is that event, with no delay, so PostHog shows it at once.
//
// Writes use POSTHOG_SURVEY_API_KEY (survey read and write, this project only). Reads of events and
// answers use the normal read key through HogQL.
import { randomBytes } from 'node:crypto'

import { appEvents, type AppEvents } from './appevents.ts'
import { config, surveysActive } from './config.ts'
import { hogql, PostHogError } from './posthog.ts'
import { clientExpr } from './props.ts'

// ------------------------------------------------------------------ the spec, in the app's words

/** One step of the chain. Exactly one of opens, closes, button, field, message or event. */
export interface StepSpec {
    opens?: string // a dialog id: the user opens it
    closes?: string // a dialog id: the user closes it
    button?: string // a button pressed (Save, Run, Export…), in `dialog` if given
    field?: string // a field touched (its label, e.g. "Trade Date"), in `dialog` if given
    message?: string // text in a message or notice the app shows (case does not matter)
    message_pattern?: string // the same, as a regular expression, e.g. "^Link Id [0-9]+ Added$"
    dialog?: string // with button or field: only in this dialog
    event?: string // any other event, by name, with optional property filters
    properties?: Record<string, string | string[] | PropertyFilter>
}
export interface PropertyFilter {
    operator: Operator
    values: string[]
}
export type Operator = 'exact' | 'is_not' | 'icontains' | 'not_icontains' | 'regex' | 'not_regex'
const OPERATORS: Operator[] = ['exact', 'is_not', 'icontains', 'not_icontains', 'regex', 'not_regex']

export type QuestionSpec =
    | { type: 'rating'; text: string; scale?: 3 | 5 | 7 | 10; low_label?: string; high_label?: string; emoji?: boolean; optional?: boolean; description?: string }
    | { type: 'nps'; text: string; optional?: boolean; description?: string }
    | { type: 'yes_no'; text: string; yes_label?: string; no_label?: string; optional?: boolean; description?: string }
    | { type: 'thumbs'; text: string; optional?: boolean; description?: string } // thumbs up / down
    | { type: 'open'; text: string; placeholder?: string; optional?: boolean; description?: string }
    | { type: 'single' | 'multiple'; text: string; choices: string[]; other?: boolean; optional?: boolean; description?: string }

export interface LookSpec {
    theme?: 'light' | 'dark' // a finished look to start from; any field below overrides it
    background?: string // solid colours as #rrggbb (PostHog works out contrast from them, so no gradients)
    text?: string
    text_subtle?: string // descriptions and scale labels
    button?: string // submit button
    button_text?: string
    rating?: string // rating and choice buttons
    rating_active?: string
    input_background?: string // text boxes
    input_text?: string
    border?: string
    corner_radius?: number // pixels, 0-24
    shadow?: 'none' | 'soft' | 'strong'
    padding?: 'compact' | 'normal' | 'roomy'
    font?: 'app' | 'system' // the app's own font, or the system font
    position?: Position
    max_width?: number // pixels, 280-600
    submit_label?: string
    thank_you?: string // shown after an answer; empty: none
    thank_you_text?: string // a line under it
    placeholder?: string // in text boxes
}
export type Position = 'right' | 'left' | 'center' | 'top_right' | 'top_left' | 'top_center' | 'middle_right' | 'middle_left' | 'middle_center'
const POSITIONS: Position[] = ['right', 'left', 'center', 'top_right', 'top_left', 'top_center', 'middle_right', 'middle_left', 'middle_center']

export interface SurveySpec {
    name: string
    description?: string // for the team; never shown to users
    questions: QuestionSpec[]
    steps: StepSpec[] // in order; other events in between are fine
    within_minutes?: number // the whole chain must happen within this time, from its first step
    reset_on?: StepSpec[] // any of these starts the chain over (e.g. closing the first dialog)
    clients?: string[] // client ids; none: every client
    sample_percent?: number // only this share of those clients' users (fixed per user), default 100
    url_contains?: string // only on pages whose address contains this
    wait_for_page?: boolean // wait for the page to load and loading masks to go (default true)
    max_wait_seconds?: number // give up if the page stays busy this long (default 30)
    show?: 'once' | 'every_time' // once per user (default), or every time the chain completes
    days_between_surveys?: number // no survey for a user who saw any survey this many days ago (default 14)
    max_responses?: number // stop after this many answers
    look?: LookSpec
}

export interface Problem {
    level: 'error' | 'warning'
    where: string
    text: string
}

const COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
type Look = Required<Omit<LookSpec, 'theme'>>
// Bottom right, rounded, a soft shadow and quiet colours: it should feel part of the app, not an ad.
export const THEMES: Record<'light' | 'dark', Look> = {
    light: {
        background: '#ffffff', text: '#14213d', text_subtle: '#5b6577', button: '#0b5cad', button_text: '#ffffff', rating: '#f1f4f8', rating_active: '#0b5cad',
        input_background: '#f7f9fc', input_text: '#14213d', border: '#d8dee8', corner_radius: 14, shadow: 'soft', padding: 'normal', font: 'app', position: 'right',
        max_width: 340, submit_label: 'Submit', thank_you: 'Thank you!', thank_you_text: 'Your answer helps us improve.', placeholder: 'Type your answer…',
    },
    dark: {
        background: '#0f1e33', text: '#f3f6fb', text_subtle: '#a9b4c6', button: '#f5a623', button_text: '#14213d', rating: '#1b2f4d', rating_active: '#f5a623',
        input_background: '#16294a', input_text: '#f3f6fb', border: '#2b4366', corner_radius: 14, shadow: 'strong', padding: 'normal', font: 'app', position: 'right',
        max_width: 340, submit_label: 'Submit', thank_you: 'Thank you!', thank_you_text: 'Your answer helps us improve.', placeholder: 'Type your answer…',
    },
}
const SHADOWS = { none: 'none', soft: '0 10px 30px rgba(15, 23, 42, 0.16)', strong: '0 16px 44px rgba(0, 0, 0, 0.38)' }
const PADDINGS = { compact: '14px 16px', normal: '20px 22px', roomy: '26px 28px' }

// ------------------------------------------------------------------ the chain the browser follows

export interface ChainFilter {
    operator: Operator
    values: string[]
}
export interface ChainStep {
    event: string
    properties?: Record<string, ChainFilter>
}
export interface Audience {
    clients?: string[]
    distinctIdPart?: number
    separator?: string
    eventProperty?: string
    sample?: number // percent of users (1-99), fixed per user
}
export interface LensChain {
    version: 3 // 3: audience with sample, and one survey at a time; older engines refuse it rather than show it to everyone
    id: string
    managedBy: 'lens'
    steps: ChainStep[]
    labels: string[] // the steps in words, for people (the Surveys page, list_surveys)
    withinSeconds?: number
    resetOn?: ChainStep[]
    resetLabels?: string[]
    audience?: Audience
    maxPerUser: number // a user is in at most this many running surveys at once; later ones wait until they finish one
    gapHours: number // never two surveys within this many hours for a user (24 at least)
    quietDaysAfterClose: number // after the user closes a Lens survey with the cross: none for this many days
    ready: { documentComplete: boolean; noVisibleMask: boolean; maxWaitMs: number }
}

const ex = (...values: string[]): ChainFilter => ({ operator: 'exact', values })

function vocab(): AppEvents {
    const reg = appEvents()
    if (!reg) throw new Error('Surveys need the app event file (APP_EVENTS_FILE), which names the dialog, button and message properties.')
    return reg
}

function propName(reg: AppEvents, role: 'dialog' | 'action' | 'button'): string {
    const p = reg.properties[role]?.name
    if (!p) throw new Error(`The app event file has no "${role}" property, so steps cannot name a ${role}.`)
    return p
}

/** The same (in)security rules the browser applies (engine.js): a bounded regex subset. */
export function safeRegex(pattern: string): string | null {
    if (pattern.length > 256 || /\\[1-9]|\(\?/.test(pattern)) return 'backreferences and (?…) groups are not allowed'
    const atoms = pattern.replace(/\\./g, 'X').replace(/\[[^\]]*\]/g, 'X')
    if (/\)[*+?{]/.test(atoms)) return 'a repeated group, like (ab)+, is not allowed'
    const repeats = atoms.match(/[*+]|\{[^}]*\}/g) || []
    if (repeats.length > 1 || atoms.includes('{')) return 'use at most one * or + and no {n} counts'
    try {
        new RegExp(pattern)
    } catch (e) {
        return (e as Error).message
    }
    return null
}

/** A step in the app's words → the event and property filters the browser matches, and a label. */
export function compileStep(s: StepSpec, reg: AppEvents, where: string, problems: Problem[]): { step: ChainStep; label: string } | null {
    const err = (text: string) => (problems.push({ level: 'error', where, text }), null)
    const kinds = (['opens', 'closes', 'button', 'field', 'message', 'message_pattern', 'event'] as const).filter((k) => s[k] !== undefined && s[k] !== '')
    if (kinds.length !== 1) return err(`give exactly one of opens, closes, button, field, message, message_pattern or event (got ${kinds.join(', ') || 'none'})`)
    const kind = kinds[0]
    const str = (v: unknown, what: string) => {
        if (typeof v !== 'string' || !v.trim() || v.length > 500) throw new Error(`${what} must be text (1-500 characters)`)
        return v.trim()
    }
    try {
        if (s.dialog !== undefined && !['button', 'field'].includes(kind)) return err('dialog only goes with button or field (opens and closes name the dialog themselves)')
        const dialogP = () => propName(reg, 'dialog')
        if (kind === 'opens' || kind === 'closes') {
            const d = str(s[kind], kind)
            const actions = kind === 'opens' ? reg.screenActions.open : reg.screenActions.close
            if (!actions.length) return err(`the app event file lists no ${kind === 'opens' ? 'open' : 'close'} actions`)
            return { step: { event: reg.events.screen, properties: { [dialogP()]: ex(d), [propName(reg, 'action')]: ex(...actions) } }, label: `${kind === 'opens' ? 'Opens' : 'Closes'} ${d}` }
        }
        if (kind === 'button' || kind === 'field') {
            const v = str(s[kind], kind)
            const props: Record<string, ChainFilter> = { [propName(reg, kind === 'button' ? 'button' : 'action')]: ex(v) }
            if (s.dialog !== undefined) props[dialogP()] = ex(str(s.dialog, 'dialog'))
            return { step: { event: reg.events.interaction, properties: props }, label: `${kind === 'button' ? 'Presses' : 'Fills'} ${v}${s.dialog ? ` in ${s.dialog}` : ''}` }
        }
        if (kind === 'message' || kind === 'message_pattern') {
            const v = str(s[kind], kind)
            const where_ = [...reg.dialogs.messages, ...reg.dialogs.notices]
            if (!where_.length) return err('the app event file names no message or notice dialogs')
            if (kind === 'message_pattern') {
                const bad = safeRegex(v)
                if (bad) return err(`message_pattern: ${bad}`)
            }
            return {
                step: { event: reg.events.interaction, properties: { [dialogP()]: ex(...where_), [propName(reg, 'button')]: { operator: kind === 'message' ? 'icontains' : 'regex', values: [v] } } },
                label: kind === 'message' ? `Sees a message containing "${v}"` : `Sees a message matching /${v}/`,
            }
        }
        // event
        const name = str(s.event, 'event')
        if (name.startsWith('$') || name.startsWith('lens_chain:') || name.startsWith('survey ')) return err(`"${name}" is PostHog's or Lens's own event; chains follow the app's events`)
        const props: Record<string, ChainFilter> = {}
        for (const [k, raw] of Object.entries(s.properties || {})) {
            if (!/^[A-Za-z_][\w$]{0,99}$/.test(k)) return err(`property name "${k}" must be a plain name`)
            const f: PropertyFilter = typeof raw === 'string' ? { operator: 'exact', values: [raw] } : Array.isArray(raw) ? { operator: 'exact', values: raw } : raw
            if (!f || !OPERATORS.includes(f.operator) || !Array.isArray(f.values) || !f.values.length || f.values.length > 50 || f.values.some((x) => typeof x !== 'string' || x.length > 500))
                return err(`property ${k}: give a text, a list, or {operator: ${OPERATORS.join('|')}, values: [...]}`)
            if (f.operator.endsWith('regex')) for (const v of f.values) {
                const bad = safeRegex(v)
                if (bad) return err(`property ${k}: ${bad}`)
            }
            props[k] = { operator: f.operator, values: f.values }
        }
        const desc = Object.entries(props).map(([k, f]) => `${k} ${f.operator === 'exact' ? '=' : f.operator} ${f.values.join(' or ')}`).join(', ')
        return { step: { event: name, ...(Object.keys(props).length ? { properties: props } : {}) }, label: `${name}${desc ? ` (${desc})` : ''}` }
    } catch (e) {
        return err((e as Error).message)
    }
}

function luminance(hex: string): number {
    const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
}

export const chainIdFor = (name: string) =>
    `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'survey'}-${randomBytes(3).toString('hex')}`.replace(/^-/, '')

export interface Compiled {
    body: Record<string, unknown> // the PostHog survey (POST/PATCH /surveys/)
    chain: LensChain
    problems: Problem[]
}

/** Checks a spec and turns it into a PostHog survey. Errors mean nothing may be saved. */
export function compileSurvey(spec: SurveySpec, opts: { chainId?: string; reg?: AppEvents; clientIds?: string[]; maxPerUser?: number } = {}): Compiled {
    const reg = opts.reg ?? vocab()
    const problems: Problem[] = []
    const e = (where: string, text: string) => problems.push({ level: 'error', where, text })
    const w = (where: string, text: string) => problems.push({ level: 'warning', where, text })

    const name = String(spec.name || '').trim()
    if (!name || name.length > 120) e('name', 'give a name of 1-120 characters')

    // Questions
    const qs = Array.isArray(spec.questions) ? spec.questions : []
    if (!qs.length) e('questions', 'give at least one question')
    if (qs.length > 10) e('questions', 'at most 10 questions')
    else if (qs.length > 3) w('questions', `${qs.length} questions: people in the middle of their work rarely answer more than 2 or 3`)
    const questions = qs.map((q, i) => {
        const where = `questions[${i}]`
        const text = String(q?.text || '').trim()
        if (!text || text.length > 300) e(where, 'each question needs text of 1-300 characters')
        const base = { question: text, ...(q.description ? { description: String(q.description).slice(0, 500), descriptionContentType: 'text' } : {}), ...(q.optional ? { optional: true } : {}) }
        switch (q?.type) {
            case 'rating': {
                const scale = q.scale ?? 5
                if (![3, 5, 7, 10].includes(scale)) e(where, 'scale must be 3, 5, 7 or 10')
                if (q.emoji && ![3, 5].includes(scale)) e(where, 'emoji ratings need scale 3 or 5')
                return { type: 'rating', ...base, scale, display: q.emoji ? 'emoji' : 'number', lowerBoundLabel: q.low_label ?? 'Not at all', upperBoundLabel: q.high_label ?? 'Very much' }
            }
            case 'nps':
                return { type: 'rating', ...base, scale: 10, display: 'number', lowerBoundLabel: 'Not likely', upperBoundLabel: 'Very likely' }
            case 'yes_no': {
                const yes = String(q.yes_label || 'Yes').trim(), no = String(q.no_label || 'No').trim()
                if (!yes || !no || yes === no || yes.length > 60 || no.length > 60) e(where, 'yes_label and no_label must differ (1-60 characters)')
                return { type: 'single_choice', ...base, choices: [yes, no] }
            }
            case 'thumbs':
                return { type: 'rating', ...base, scale: 2, display: 'emoji', lowerBoundLabel: '', upperBoundLabel: '' }
            case 'open':
                return { type: 'open', ...base }
            case 'single':
            case 'multiple': {
                const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c).trim()).filter(Boolean) : []
                if (choices.length < 2 || choices.length > 20) e(where, 'give 2-20 choices')
                if (new Set(choices).size !== choices.length) e(where, 'choices must differ')
                return { type: q.type === 'single' ? 'single_choice' : 'multiple_choice', ...base, choices: q.other ? [...choices, 'Other'] : choices, ...(q.other ? { hasOpenChoice: true } : {}) }
            }
            default:
                e(where, 'type must be rating, nps, yes_no, thumbs, open, single or multiple')
                return { type: 'open', ...base }
        }
    })

    // The chain
    const steps = Array.isArray(spec.steps) ? spec.steps : []
    if (!steps.length) e('steps', 'give at least one step: what the user does before the survey shows')
    if (steps.length > 10) e('steps', 'at most 10 steps')
    const compiled = steps.slice(0, 10).map((s, i) => compileStep(s, reg, `steps[${i}]`, problems))
    const resets = (spec.reset_on || []).slice(0, 20).map((s, i) => compileStep(s, reg, `reset_on[${i}]`, problems))
    if ((spec.reset_on || []).length > 20) e('reset_on', 'at most 20 reset steps')
    if (spec.within_minutes !== undefined && !(Number.isFinite(spec.within_minutes) && spec.within_minutes > 0 && spec.within_minutes <= 24 * 60)) e('within_minutes', 'give 1 to 1440 minutes, or leave it out')
    const maxWait = spec.max_wait_seconds ?? 30
    if (!(Number.isFinite(maxWait) && maxWait >= 0 && maxWait <= 600)) e('max_wait_seconds', 'give 0 to 600 seconds')

    // Who
    const clientIds = opts.clientIds ?? (spec.clients || []).map((c) => String(c).trim()).filter(Boolean)
    if (clientIds.length > 500) e('clients', 'at most 500 clients')
    const p = config.properties
    const sample = spec.sample_percent ?? 100
    if (!(Number.isInteger(sample) && sample >= 1 && sample <= 100)) e('sample_percent', 'give a whole percent from 1 to 100')
    const audience: Audience = {
        ...(clientIds.length ? (p.clientFromDistinctId ? { clients: clientIds, distinctIdPart: p.clientFromDistinctId, separator: p.distinctIdSeparator } : { clients: clientIds, eventProperty: p.client }) : {}),
        ...(sample < 100 ? { sample } : {}),
    }
    if (!clientIds.length) w('clients', 'no clients given: every client can see it')

    const chain: LensChain = {
        version: 3,
        id: opts.chainId ?? chainIdFor(name),
        managedBy: 'lens',
        steps: compiled.map((c) => c?.step).filter((x): x is ChainStep => !!x),
        labels: compiled.map((c) => c?.label).filter((x): x is string => !!x),
        ...(spec.within_minutes ? { withinSeconds: Math.round(spec.within_minutes * 60) } : {}),
        ...(resets.length ? { resetOn: resets.map((c) => c?.step).filter((x): x is ChainStep => !!x), resetLabels: resets.map((c) => c?.label).filter((x): x is string => !!x) } : {}),
        ...(Object.keys(audience).length ? { audience } : {}),
        maxPerUser: opts.maxPerUser ?? config.surveys.perUser,
        gapHours: config.surveys.gapHours,
        quietDaysAfterClose: config.surveys.quietDaysAfterClose,
        ready: { documentComplete: spec.wait_for_page !== false, noVisibleMask: spec.wait_for_page !== false, maxWaitMs: Math.round(maxWait * 1000) },
    }
    if (!/^[a-z0-9-]{1,40}$/.test(chain.id)) e('chain', `chain id "${chain.id}" must be 1-40 characters of a-z, 0-9 and -`)
    // A first step that is only "opens a dialog" with every client and every_time shows very often.
    if (steps.length === 1 && steps[0].opens && !clientIds.length && spec.show === 'every_time') w('steps', 'one "opens" step, every client, every time: this will show very often')

    // How often
    const show = spec.show ?? 'once'
    if (!['once', 'every_time'].includes(show)) e('show', 'show must be once or every_time')
    const gap = spec.days_between_surveys ?? 14
    if (!(Number.isInteger(gap) && gap >= 1 && gap <= 365)) e('days_between_surveys', 'give 1 to 365 days: a user always gets at least 24 hours between surveys')
    if (spec.max_responses !== undefined && !(Number.isInteger(spec.max_responses) && spec.max_responses > 0 && spec.max_responses <= 1_000_000)) e('max_responses', 'give a whole number above 0, or leave it out')
    if (spec.url_contains !== undefined && (typeof spec.url_contains !== 'string' || spec.url_contains.length > 500)) e('url_contains', 'give text of up to 500 characters')

    // Look
    const { theme = 'light', ...given } = spec.look || {}
    if (!(theme in THEMES)) e('look.theme', 'theme must be light or dark')
    const look: Look = { ...(THEMES[theme as 'light'] || THEMES.light), ...(Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) as Partial<Look>) }
    for (const k of ['background', 'text', 'text_subtle', 'button', 'button_text', 'rating', 'rating_active', 'input_background', 'input_text', 'border'] as const) {
        if (!COLOR.test(String(look[k]))) e(`look.${k}`, `"${look[k]}" is not a colour like #0b5cad (solid colours only)`)
    }
    if (!POSITIONS.includes(look.position)) e('look.position', `position must be one of ${POSITIONS.join(', ')} (right = bottom right)`)
    if (!(Number.isInteger(look.max_width) && look.max_width >= 280 && look.max_width <= 600)) e('look.max_width', 'give 280 to 600 pixels')
    if (!(Number.isInteger(look.corner_radius) && look.corner_radius >= 0 && look.corner_radius <= 24)) e('look.corner_radius', 'give 0 to 24 pixels')
    if (!(look.shadow in SHADOWS)) e('look.shadow', 'shadow must be none, soft or strong')
    if (!(look.padding in PADDINGS)) e('look.padding', 'padding must be compact, normal or roomy')
    if (!['app', 'system'].includes(look.font)) e('look.font', 'font must be app or system')
    for (const [k, max] of [['submit_label', 40], ['thank_you', 120], ['thank_you_text', 300], ['placeholder', 120]] as const) {
        if (String(look[k] ?? '').length > max) e(`look.${k}`, `at most ${max} characters`)
    }
    if (!problems.some((x) => x.where.startsWith('look.'))) {
        for (const [fg, bg, where] of [[look.text, look.background, 'text on background'], [look.button_text, look.button, 'button text on button'], [look.input_text, look.input_background, 'typed text on text boxes']] as const) {
            const r = contrast(fg, bg)
            if (r < 4.5) w(`look`, `${where} has contrast ${r.toFixed(1)}:1; under 4.5:1 is hard to read`)
        }
    }

    const body: Record<string, unknown> = {
        name,
        description: String(spec.description || '').slice(0, 1000),
        type: 'popover',
        questions,
        schedule: show === 'every_time' ? 'always' : 'once',
        conditions: {
            events: { repeatedActivation: show === 'every_time', values: [{ name: `lens_chain:${chain.id}` }] },
            seenSurveyWaitPeriodInDays: gap,
            ...(spec.url_contains ? { url: spec.url_contains, urlMatchType: 'icontains' } : {}),
            lensChain: chain,
        },
        appearance: {
            backgroundColor: look.background, textColor: look.text, textSubtleColor: look.text_subtle, submitButtonColor: look.button, submitButtonTextColor: look.button_text,
            ratingButtonColor: look.rating, ratingButtonActiveColor: look.rating_active, inputBackground: look.input_background, inputTextColor: look.input_text,
            borderColor: look.border, borderRadius: `${look.corner_radius}px`, boxShadow: SHADOWS[look.shadow], boxPadding: PADDINGS[look.padding],
            fontFamily: look.font === 'app' ? 'inherit' : 'system-ui', position: look.position, maxWidth: `${look.max_width}px`,
            submitButtonText: look.submit_label, placeholder: look.placeholder, displayThankYouMessage: !!look.thank_you,
            thankYouMessageHeader: look.thank_you || undefined, thankYouMessageDescription: look.thank_you_text || undefined, surveyPopupDelaySeconds: 0,
        },
        ...(spec.max_responses ? { responses_limit: spec.max_responses } : {}),
    }
    return { body, chain, problems }
}

// ------------------------------------------------------------------ PostHog

export interface PostHogSurvey {
    id: string
    name: string
    description?: string
    type: string
    questions: { id?: string; type: string; question: string; choices?: string[]; scale?: number; display?: string; lowerBoundLabel?: string; upperBoundLabel?: string; optional?: boolean }[]
    conditions: { events?: { values?: { name: string }[]; repeatedActivation?: boolean }; url?: string; seenSurveyWaitPeriodInDays?: number; lensChain?: LensChain } | null
    appearance: Record<string, unknown> | null
    start_date: string | null
    end_date: string | null
    archived?: boolean
    created_at: string
    created_by?: { email?: string } | null
    schedule?: string
    responses_limit?: number | null
    targeting_flag?: unknown
}

export function requireSurveys(): void {
    if (!config.surveys.enabled) throw new Error('Surveys are switched off (FEATURE_SURVEYS=off).')
    if (!surveysActive()) throw new Error('Surveys need POSTHOG_SURVEY_API_KEY in .secrets.env. Run the installer again (it makes the key), or deploy/posthog/survey-engine/key.sh.')
}

async function surveyApi<T>(path: string, init: RequestInit = {}): Promise<T> {
    requireSurveys()
    const res = await fetch(`${config.posthog.host}/api/projects/${config.posthog.projectId}/surveys/${path}`, {
        ...init,
        headers: { authorization: `Bearer ${config.posthog.surveyApiKey}`, 'content-type': 'application/json', ...(config.posthog.surveyGate ? { 'x-lens-survey-gate': config.posthog.surveyGate } : {}), ...init.headers },
        signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail = text.slice(0, 300)
        try {
            const j = JSON.parse(text)
            detail = j.detail || j.attr ? `${j.attr ? j.attr + ': ' : ''}${j.detail}` : detail
        } catch {}
        if (!detail.trim()) detail = res.status >= 500 ? 'PostHog is not answering (starting up or down)' : res.statusText
        throw new PostHogError(`PostHog surveys ${init.method || 'GET'} → ${res.status}: ${detail}`, res.status)
    }
    return (res.status === 204 ? undefined : await res.json()) as T
}

export type Status = 'draft' | 'running' | 'stopped' | 'archived'
export const statusOf = (s: Pick<PostHogSurvey, 'start_date' | 'end_date' | 'archived'>): Status =>
    s.archived ? 'archived' : !s.start_date ? 'draft' : s.end_date ? 'stopped' : 'running'

export async function listSurveys(): Promise<PostHogSurvey[]> {
    const out: PostHogSurvey[] = []
    let path = '?limit=100'
    for (let i = 0; i < 20 && path; i++) {
        const page = await surveyApi<{ results: PostHogSurvey[]; next: string | null }>(path)
        out.push(...page.results)
        path = page.next ? `?${new URL(page.next).searchParams.toString()}` : ''
    }
    return out
}

export const getSurvey = (id: string) => surveyApi<PostHogSurvey>(`${checkId(id)}/`)

function checkId(id: string): string {
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) throw new Error(`"${id}" is not a survey id`)
    return id
}

/** Saves a new draft, or changes an existing survey (its chain keeps its id, so a running one keeps working). */
export async function saveSurvey(spec: SurveySpec, opts: { id?: string; clientIds?: string[] } = {}): Promise<{ survey?: PostHogSurvey; compiled: Compiled }> {
    let chainId: string | undefined
    let old: PostHogSurvey | undefined
    if (opts.id) {
        old = await getSurvey(opts.id)
        chainId = old.conditions?.lensChain?.managedBy === 'lens' ? old.conditions.lensChain.id : undefined
        if (!chainId) throw new Error(`Survey ${opts.id} was not made by Lens; change it in PostHog, or make a new one here.`)
    }
    const compiled = compileSurvey(spec, { chainId, clientIds: opts.clientIds })
    if (compiled.problems.some((p) => p.level === 'error')) return { compiled }
    // A question that kept its place and type keeps its id, so its earlier answers stay with it.
    if (old) {
        const qs = compiled.body.questions as { type: string; id?: string }[]
        qs.forEach((q, i) => {
            const was = old!.questions?.[i]
            if (was?.id && was.type === q.type) q.id = was.id
        })
    }
    const survey = opts.id
        ? await surveyApi<PostHogSurvey>(`${encodeURIComponent(opts.id)}/`, { method: 'PATCH', body: JSON.stringify(compiled.body) })
        : await surveyApi<PostHogSurvey>('', { method: 'POST', body: JSON.stringify(compiled.body) })
    return { survey, compiled }
}

/** Starts a draft, or starts a stopped survey again. PostHog activates the survey's flag only on this PATCH. */
export async function launchSurvey(id: string): Promise<PostHogSurvey> {
    const s = await getSurvey(id)
    const st = statusOf(s)
    if (st === 'running') return s
    if (st === 'archived') throw new Error('This survey is archived.')
    if (s.conditions?.lensChain && !s.conditions.lensChain.steps?.length) throw new Error('This survey has no chain steps.')
    const now = new Date().toISOString()
    return surveyApi<PostHogSurvey>(`${encodeURIComponent(id)}/`, { method: 'PATCH', body: JSON.stringify(st === 'draft' ? { start_date: now } : { end_date: null }) })
}

export async function stopSurvey(id: string): Promise<PostHogSurvey> {
    const s = await getSurvey(id)
    if (statusOf(s) !== 'running') return s
    return surveyApi<PostHogSurvey>(`${encodeURIComponent(id)}/`, { method: 'PATCH', body: JSON.stringify({ end_date: new Date().toISOString() }) })
}

/** Hides a survey from lists; a running one is stopped first. */
export async function archiveSurvey(id: string): Promise<PostHogSurvey> {
    await stopSurvey(id)
    return surveyApi<PostHogSurvey>(`${encodeURIComponent(checkId(id))}/`, { method: 'PATCH', body: JSON.stringify({ archived: true }) })
}

// ------------------------------------------------------------------ for people: a survey in words

export interface SurveyView {
    id: string
    name: string
    description: string
    status: Status
    made_by_lens: boolean
    chain_id?: string
    steps: string[]
    reset_on: string[]
    within_minutes?: number
    clients: string[] | 'all'
    sample_percent: number
    pacing?: { per_user: number; gap_hours: number; quiet_days_after_close: number }
    url_contains?: string
    waits_for_page: boolean
    show: 'once' | 'every_time'
    days_between_surveys: number
    max_responses?: number
    questions: { id?: string; type: string; text: string; choices?: string[]; scale?: number }[]
    look: LookSpec
    started?: string
    stopped?: string
    created: string
    created_by?: string
}

/** A PostHog question as the Lens type: nps, thumbs and yes_no are ratings and choices underneath. */
export function kindOf(q: PostHogSurvey['questions'][number]): string {
    if (q.type === 'rating' && q.scale === 10 && q.lowerBoundLabel === 'Not likely') return 'nps'
    if (q.type === 'rating' && q.scale === 2 && q.display === 'emoji') return 'thumbs'
    if (q.type === 'rating') return q.display === 'emoji' ? 'emoji rating' : 'rating'
    if (q.type === 'single_choice' && q.choices?.length === 2 && /^yes$/i.test(q.choices[0]) && /^no$/i.test(q.choices[1])) return 'yes_no'
    return { single_choice: 'single', multiple_choice: 'multiple' }[q.type] || q.type
}

/** PostHog's appearance back as Lens look fields (only those set). */
export function lookOf(a: Record<string, unknown>): LookSpec {
    const key = <T extends string>(m: Record<T, string>, v: unknown) => (Object.entries(m) as [T, string][]).find(([, x]) => x === v)?.[0]
    const px = (v: unknown) => (typeof v === 'string' && /^\d+px$/.test(v) ? parseInt(v) : undefined)
    const out: LookSpec = {
        background: a.backgroundColor as string, text: a.textColor as string, text_subtle: a.textSubtleColor as string, button: a.submitButtonColor as string,
        button_text: a.submitButtonTextColor as string, rating: a.ratingButtonColor as string, rating_active: a.ratingButtonActiveColor as string,
        input_background: (a.inputBackground ?? a.inputBackgroundColor) as string, input_text: a.inputTextColor as string, border: a.borderColor as string,
        corner_radius: px(a.borderRadius), shadow: key(SHADOWS, a.boxShadow), padding: key(PADDINGS, a.boxPadding),
        font: a.fontFamily === 'inherit' ? 'app' : a.fontFamily ? 'system' : undefined, position: a.position as Position, max_width: px(a.maxWidth),
        submit_label: a.submitButtonText as string, thank_you: a.displayThankYouMessage ? (a.thankYouMessageHeader as string) : '',
        thank_you_text: a.thankYouMessageDescription as string, placeholder: a.placeholder as string,
    }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null)) as LookSpec
}

export function viewOf(s: PostHogSurvey): SurveyView {
    const c = s.conditions?.lensChain
    const lens = c?.managedBy === 'lens'
    const a = s.appearance || {}
    return {
        id: s.id,
        name: s.name,
        description: s.description || '',
        status: statusOf(s),
        made_by_lens: lens,
        ...(lens ? { chain_id: c!.id } : {}),
        steps: lens ? c!.labels || [] : (s.conditions?.events?.values || []).map((v) => `Event ${v.name}`),
        reset_on: lens ? c!.resetLabels || [] : [],
        ...(lens && c!.withinSeconds ? { within_minutes: Math.round(c!.withinSeconds / 6) / 10 } : {}),
        clients: lens && c!.audience?.clients ? c!.audience.clients : 'all',
        sample_percent: lens ? c!.audience?.sample ?? 100 : 100,
        ...(lens && c!.maxPerUser ? { pacing: { per_user: c!.maxPerUser, gap_hours: c!.gapHours ?? 24, quiet_days_after_close: c!.quietDaysAfterClose ?? 7 } } : {}),
        ...(s.conditions?.url ? { url_contains: s.conditions.url } : {}),
        waits_for_page: lens ? c!.ready.documentComplete : false,
        show: s.schedule === 'always' ? 'every_time' : 'once',
        days_between_surveys: s.conditions?.seenSurveyWaitPeriodInDays ?? 0,
        ...(s.responses_limit ? { max_responses: s.responses_limit } : {}),
        questions: (s.questions || []).map((q) => ({ id: q.id, type: kindOf(q), text: q.question, ...(q.choices ? { choices: q.choices } : {}), ...(q.scale ? { scale: q.scale } : {}) })),
        look: lookOf(a),
        ...(s.start_date ? { started: s.start_date } : {}),
        ...(s.end_date ? { stopped: s.end_date } : {}),
        created: s.created_at,
        ...(s.created_by?.email ? { created_by: s.created_by.email } : {}),
    }
}

/** A chain step back in the app's words (opens, button, message…) when it is one, else the event. */
export function stepSpecOf(st: ChainStep, reg: AppEvents | null = appEvents()): StepSpec {
    const raw: StepSpec = { event: st.event, ...(st.properties ? { properties: st.properties } : {}) }
    if (!reg) return raw
    const props = st.properties || {}
    const keys = Object.keys(props)
    const name = (role: 'dialog' | 'action' | 'button') => reg.properties[role]?.name
    const one = (k: string | undefined) => (k && props[k]?.operator === 'exact' && props[k].values.length === 1 ? props[k].values[0] : undefined)
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))
    const only = (...ks: (string | undefined)[]) => same(keys, ks.filter((k): k is string => !!k))
    const dialog = one(name('dialog'))
    const actions = (k: string | undefined) => (k && props[k]?.operator === 'exact' ? props[k].values : [])
    if (st.event === reg.events.screen && dialog && only(name('dialog'), name('action'))) {
        if (same(actions(name('action')), reg.screenActions.open)) return { opens: dialog }
        if (same(actions(name('action')), reg.screenActions.close)) return { closes: dialog }
    }
    if (st.event !== reg.events.interaction) return raw
    const msgDialogs = [...reg.dialogs.messages, ...reg.dialogs.notices]
    const b = name('button')
    if (b && only(name('dialog'), b) && same(actions(name('dialog')), msgDialogs) && props[b].values.length === 1) {
        if (props[b].operator === 'icontains') return { message: props[b].values[0] }
        if (props[b].operator === 'regex') return { message_pattern: props[b].values[0] }
    }
    for (const [role, kind] of [['button', 'button'], ['action', 'field']] as const) {
        const k = name(role)
        const v = one(k)
        if (v && (only(k) || (dialog && only(k, name('dialog'))))) return { [kind]: v, ...(only(k) ? {} : { dialog }) }
    }
    return raw
}

/** A spec back from a Lens survey, so a change can start from what is there. */
export function specOf(s: PostHogSurvey): Partial<SurveySpec> {
    const v = viewOf(s)
    const c = s.conditions?.lensChain
    const raw = (st: ChainStep): StepSpec => stepSpecOf(st)
    return {
        name: v.name,
        description: v.description,
        steps: c?.steps.map(raw) || [],
        ...(c?.resetOn ? { reset_on: c.resetOn.map(raw) } : {}),
        ...(v.within_minutes ? { within_minutes: v.within_minutes } : {}),
        ...(v.clients !== 'all' ? { clients: v.clients } : {}),
        ...(v.sample_percent < 100 ? { sample_percent: v.sample_percent } : {}),
        ...(v.url_contains ? { url_contains: v.url_contains } : {}),
        wait_for_page: v.waits_for_page,
        ...(c ? { max_wait_seconds: c.ready.maxWaitMs / 1000 } : {}),
        show: v.show,
        days_between_surveys: v.days_between_surveys,
        ...(v.max_responses ? { max_responses: v.max_responses } : {}),
        look: Object.fromEntries(Object.entries(v.look).filter(([, x]) => x !== undefined && x !== null)) as LookSpec,
    }
}

// ------------------------------------------------------------------ one survey at a time

export interface Conflict {
    survey_id: string
    name: string
    since: string
    clients: string[] | 'all' // the clients both surveys want
    share: number // percent of those clients' users that the other survey holds
    text: string
}

/**
 * Running Lens surveys launched before this one that want some of the same users. Users already in as
 * many unfinished surveys as the limit allows wait for this one (the browser engine enforces it) and
 * get it later, after they answer or dismiss one of those. For a draft, every running survey counts,
 * since it would launch after them.
 */
export function conflictsFor(chain: LensChain, self: { id?: string; start_date?: string | null }, surveys: PostHogSurvey[]): Conflict[] {
    const mine = chain.audience?.clients?.map((c) => c.toLowerCase())
    const myStart = self.start_date ? Date.parse(self.start_date) : Infinity
    const out: Conflict[] = []
    for (const y of surveys) {
        const c = y.conditions?.lensChain as (LensChain & { oneAtATime?: boolean }) | undefined
        if (y.id === self.id || statusOf(y) !== 'running' || c?.managedBy !== 'lens' || !(c.maxPerUser || c.oneAtATime)) continue
        const yStart = Date.parse(y.start_date || '') || 0
        if (!(yStart < myStart || (yStart === myStart && y.id < (self.id || '')))) continue
        const theirs = c.audience?.clients?.map((x) => x.toLowerCase())
        const both: string[] | 'all' = !mine && !theirs ? 'all' : !mine ? theirs! : !theirs ? mine : mine.filter((x) => theirs.includes(x))
        if (both !== 'all' && !both.length) continue
        const share = c.audience?.sample ?? 100
        const who = both === 'all' ? 'Every client' : both.map((x) => x.toUpperCase()).join(', ')
        out.push({
            survey_id: y.id, name: y.name, since: y.start_date!, clients: both, share,
            text: `${who}: ${share === 100 ? 'all' : `${share}% of`} their users are in "${y.name}" (running since ${y.start_date!.slice(0, 10)}).`,
        })
    }
    return out
}

export interface QueueAlert {
    level: 'clear' | 'overlap' | 'some_wait' | 'queued' | 'all_queued'
    alert: string // for the person making the survey
    queued: string[] // clients whose users all wait ("*" = every client not named)
    some_wait: string[] // clients where some users wait (samples)
    overlap: string[] // clients whose users are in other running surveys
    limit: number
}

/**
 * The notice for the person setting up a survey. Any overlap with another running survey gets a
 * survey-fatigue warning, even under the limit; users at the limit are queued and told to come later.
 */
export function queueAlert(chain: LensChain, conflicts: Conflict[]): QueueAlert {
    const limit = chain.maxPerUser ?? 1
    const gap = chain.gapHours ?? 24
    const quiet = chain.quietDaysAfterClose ?? 7
    const surveys = (n: number) => `${n} running survey${n === 1 ? '' : 's'}`
    const mine = chain.audience?.clients?.map((c) => c.toLowerCase())
    const keys = mine ?? [...new Set([...conflicts.flatMap((c) => (c.clients === 'all' ? [] : c.clients)), '*'])]
    const queued: string[] = []
    const some: string[] = []
    const overlap: string[] = []
    const names = new Map<string, string[]>()
    for (const k of keys) {
        const hold = conflicts.filter((c) => c.clients === 'all' || (k !== '*' && c.clients.includes(k)))
        names.set(k, hold.map((c) => `"${c.name}"`))
        if (hold.filter((c) => c.share === 100).length >= limit) queued.push(k)
        else if (hold.length >= limit) some.push(k)
        else if (hold.length) overlap.push(k)
    }
    const label = (k: string) => (k === '*' ? 'every other client' : k.toUpperCase())
    const listOf = (ks: string[]) => [...new Set(ks.flatMap((k) => names.get(k)!))].join(', ')
    const pacing = `Lens keeps at least ${gap} hours between any two surveys for a user, never shows more than ${limit} at a time, after a user closes a survey with the cross it leaves them alone for ${quiet} days, and a survey they ignore twice stops coming back.`
    const fatigue = 'Asking the same people for feedback repeatedly can feel intrusive and tends to lower both the response rate and the quality of the answers.'
    const advice = 'Please consider narrowing the clients, using a sample, or launching once the other survey has ended.'
    const all = queued.length === keys.length && keys.length > 0
    const parts: string[] = []
    if (all) parts.push(`⚠ Queued: every user this survey targets is already taking part in ${surveys(limit)} (${listOf(queued)}), the maximum per user. Nobody will see it for now. They are not dropped: each will receive it later, once they have answered or closed one of those surveys and at least ${gap} hours after their last one. Ending one of those surveys frees them sooner.`)
    else {
        if (queued.length) parts.push(`⚠ Queued for ${queued.map(label).join(', ')}: their users are already taking part in ${surveys(limit)} (${listOf(queued)}), the maximum per user. They will receive this survey later, once they have answered or closed one of those and at least ${gap} hours after their last survey.`)
        if (some.length) parts.push(`⚠ Some users of ${some.map(label).join(', ')} may have to wait: part of them are already in ${surveys(limit)} (${listOf(some)}).`)
        if (overlap.length) parts.push(`⚠ Survey fatigue: users of ${overlap.map(label).join(', ')} are already taking part in another running survey (${listOf(overlap)}).`)
    }
    const level: QueueAlert['level'] = all ? 'all_queued' : queued.length ? 'queued' : some.length ? 'some_wait' : overlap.length ? 'overlap' : 'clear'
    if (level === 'clear') parts.push(`None of this survey's users is taking part in another running survey. ${pacing}`)
    else parts.push(`${fatigue} ${pacing} ${advice}`)
    return { level, alert: parts.join(' '), queued, some_wait: some, overlap, limit }
}

/** The alert as one line (MCP replies, the page). */
export const conflictSummary = (chain: LensChain, conflicts: Conflict[]) => queueAlert(chain, conflicts).alert

// ------------------------------------------------------------------ reach and results (HogQL, read key)

function hogCondition(step: ChainStep, i: number, values: Record<string, unknown>): string {
    values[`e${i}`] = step.event
    const parts = [`event = {e${i}}`]
    let j = 0
    for (const [k, f] of Object.entries(step.properties || {})) {
        const key = `p${i}_${j++}`
        values[key] = f.values
        // Lists (messages) arrive as JSON text: compare their first item.
        const col = `if(startsWith(toString(properties.${k}), '['), JSONExtractString(toString(properties.${k}), 1), toString(properties.${k}))`
        const one = (v: string, n: number) => {
            values[`${key}_${n}`] = v
            return f.operator.includes('regex') ? `match(${col}, {${key}_${n}})` : f.operator.includes('icontains') ? `positionCaseInsensitive(${col}, {${key}_${n}}) > 0` : ''
        }
        let pos: string
        if (f.operator === 'exact' || f.operator === 'is_not') {
            pos = `${col} IN {${key}}`
        } else pos = `(${f.values.map(one).join(' OR ')})`
        parts.push(f.operator.startsWith('is_not') || f.operator.startsWith('not_') ? `NOT ${pos}` : pos)
    }
    return parts.join(' AND ')
}

export interface Reach {
    days: number
    sessions: number
    users: number
    clients: number
    by_step: { step: string; sessions: number }[]
    top_clients: { client: string; sessions: number }[]
    note: string
}

/**
 * How many sessions in the last `days` days went through the chain in order (other events in between
 * allowed), for the clients given. The browser follows a chain per page, so a reload in the middle
 * starts over there: this is an upper bound.
 */
export async function estimateReach(chain: LensChain, days = 14): Promise<Reach> {
    const values: Record<string, unknown> = { days }
    const conds = chain.steps.map((s, i) => hogCondition(s, i, values))
    const window = chain.withinSeconds ?? 86_400
    const client = clientExpr()
    let who = ''
    if (chain.audience?.clients) {
        values.clients = chain.audience.clients.map((c) => c.toLowerCase())
        who = `AND lower(toString(${client})) IN {clients}`
    }
    const events = [...new Set(chain.steps.map((s) => s.event))]
    values.events = events
    const rows = await hogql(
        `SELECT level, count() AS sessions, uniq(person) AS users, uniq(cl) AS clients, groupArray(10)(cl) AS sample
         FROM (
            SELECT $session_id AS sid, any(distinct_id) AS person, any(toString(${client})) AS cl,
                   windowFunnel(${Math.max(1, Math.round(window))})(toDateTime(timestamp), ${conds.join(', ')}) AS level
            FROM events
            WHERE timestamp > now() - toIntervalDay({days}) AND event IN {events} AND $session_id != '' ${who}
            GROUP BY sid
         )
         GROUP BY level ORDER BY level LIMIT 20`,
        values
    )
    const at = (n: number) => rows.filter((r) => Number(r.level) >= n).reduce((a, r) => a + Number(r.sessions), 0)
    const full = rows.find((r) => Number(r.level) === chain.steps.length)
    let top: { client: string; sessions: number }[] = []
    if (full && Number(full.sessions)) {
        const tops = await hogql(
            `SELECT cl AS client, count() AS sessions FROM (
                SELECT $session_id AS sid, any(toString(${client})) AS cl,
                       windowFunnel(${Math.max(1, Math.round(window))})(toDateTime(timestamp), ${conds.join(', ')}) AS level
                FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN {events} AND $session_id != '' ${who}
                GROUP BY sid) WHERE level = {n} GROUP BY cl ORDER BY sessions DESC LIMIT 10`,
            { ...values, n: chain.steps.length }
        )
        top = tops.map((r) => ({ client: String(r.client), sessions: Number(r.sessions) }))
    }
    const share = (chain.audience?.sample ?? 100) / 100
    return {
        days,
        sessions: Math.round(Number(full?.sessions || 0) * share),
        users: Math.round(Number(full?.users || 0) * share),
        clients: Number(full?.clients || 0),
        by_step: chain.labels.map((label, i) => ({ step: label, sessions: at(i + 1) })),
        top_clients: top,
        note: `Sessions in the last ${days} days where the steps happened in this order${chain.withinSeconds ? ` within ${Math.round(chain.withinSeconds / 60)} minutes` : ''}${share < 1 ? `, times the ${share * 100}% sample (steps per step are not scaled)` : ''}. An upper bound: the browser starts a chain over on a page reload, and "once per user" and the days between surveys lower it further.`,
    }
}

export interface Results {
    survey: SurveyView
    days: number
    chain_completed?: number // lens_chain:<id> events: the steps happened and the page was ready
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
    by_day: { day: string; shown: number; answered: number }[]
    conflicts: Conflict[] // users this survey shares with earlier running surveys
    conflict_summary?: string
    queue?: QueueAlert
}

const RECENT_TEXT = 30
// posthog-js sends "survey sent" after each question with one $survey_submission_id (partial answers),
// so answers are counted per submission. Older versions have no id: each event is one submission.
const SUBMISSION = `coalesce(nullIf(toString(properties.$survey_submission_id), ''), toString(uuid))`
const ANSWERED = `uniqIf(${SUBMISSION}, event = 'survey sent')`

export async function surveyResults(id: string, days = 90): Promise<Results> {
    const s = await getSurvey(id)
    const view = viewOf(s)
    const chain = s.conditions?.lensChain?.managedBy === 'lens' ? s.conditions.lensChain : undefined
    const conflicts = chain && view.status !== 'archived' && view.status !== 'stopped' ? conflictsFor(chain, view.status === 'running' ? s : { id: s.id }, await listSurveys()) : []
    const client = clientExpr()
    const values = { id: s.id, days, chain: view.chain_id ? `lens_chain:${view.chain_id}` : '' }
    const [counts, perClient, perDay, sent] = await Promise.all([
        hogql(
            `SELECT event, if(event = 'survey sent', uniq(${SUBMISSION}), count()) AS n FROM events WHERE timestamp > now() - toIntervalDay({days})
             AND ((event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) = {id}) OR (event = {chain} AND {chain} != ''))
             GROUP BY event LIMIT 10`,
            values
        ),
        hogql(
            `SELECT toString(${client}) AS client, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered, countIf(event = 'survey dismissed') AS dismissed
             FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) = {id}
             GROUP BY client ORDER BY shown DESC LIMIT 100`,
            values
        ),
        hogql(
            `SELECT toString(toDate(timestamp)) AS day, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered
             FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent') AND toString(properties.$survey_id) = {id}
             GROUP BY day ORDER BY day LIMIT 400`,
            values
        ),
        hogql(
            // The latest event of each submission holds all its answers so far.
            `SELECT max(timestamp) AS last_at, any(toString(${client})) AS client, argMax(properties, timestamp) AS props
             FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event = 'survey sent' AND toString(properties.$survey_id) = {id}
             GROUP BY ${SUBMISSION} ORDER BY last_at DESC LIMIT 5000`,
            values
        ),
    ])
    const n = (e: string) => Number(counts.find((r) => r.event === e)?.n || 0)
    const answers = sent.map((r) => ({ at: String(r.last_at), client: String(r.client), props: (typeof r.props === 'string' ? JSON.parse(r.props) : r.props) as Record<string, unknown> }))
    const questions = (s.questions || []).map((q, i) => {
        // posthog-js sends $survey_response_<question id> and $survey_questions [{id, question, response}];
        // older versions $survey_response, _1, _2… A question whose id changed is found by its text.
        const keys = [q.id ? `$survey_response_${q.id}` : '', i === 0 ? '$survey_response' : `$survey_response_${i}`].filter(Boolean)
        const has = (v: unknown) => v !== undefined && v !== null && v !== ''
        const pick = (props: Record<string, unknown>) => {
            const direct = keys.map((k) => props[k]).find(has)
            if (has(direct)) return direct
            const list = Array.isArray(props.$survey_questions) ? (props.$survey_questions as { question?: string; response?: unknown }[]) : []
            return list.find((x) => x?.question === q.question && has(x.response))?.response
        }
        const got = answers.map((a) => ({ ...a, v: pick(a.props) })).filter((a) => has(a.v))
        const out: Results['questions'][number] = { id: q.id, text: q.question, type: q.type, answers: got.length }
        if (kindOf(q) === 'thumbs') {
            // PostHog's thumbs: 1 is up, 2 is down.
            const nums = got.map((a) => Number(a.v))
            out.distribution = { 'Thumbs up': nums.filter((x) => x === 1).length, 'Thumbs down': nums.filter((x) => x === 2).length }
        } else if (q.type === 'rating') {
            const nums = got.map((a) => Number(a.v)).filter(Number.isFinite)
            out.distribution = Object.fromEntries(Array.from({ length: (q.scale ?? 5) + (q.scale === 10 ? 1 : 0) }, (_, k) => q.scale === 10 ? k : k + 1).map((k) => [String(k), nums.filter((x) => x === k).length]))
            if (nums.length) out.average = Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
            if (q.scale === 10 && nums.length) {
                const pro = nums.filter((x) => x >= 9).length, det = nums.filter((x) => x <= 6).length
                out.nps = { score: Math.round(((pro - det) / nums.length) * 100), promoters: pro, passives: nums.length - pro - det, detractors: det }
            }
        } else if (q.type === 'single_choice' || q.type === 'multiple_choice') {
            const dist: Record<string, number> = Object.fromEntries((q.choices || []).map((c) => [c, 0]))
            for (const a of got) for (const c of Array.isArray(a.v) ? a.v : [a.v]) dist[String(c)] = (dist[String(c)] || 0) + 1
            out.distribution = dist
        } else {
            out.recent = got.slice(0, RECENT_TEXT).map((a) => ({ at: a.at, client: a.client, text: String(a.v).slice(0, 2000) }))
        }
        return out
    })
    const shown = n('survey shown')
    const answered = n('survey sent')
    return {
        survey: view,
        days,
        ...(view.chain_id ? { chain_completed: n(values.chain) } : {}),
        shown,
        dismissed: n('survey dismissed'),
        answered,
        response_rate: shown ? Math.round((answered / shown) * 1000) / 10 : null,
        questions,
        by_client: perClient.map((r) => ({ client: String(r.client), shown: Number(r.shown), answered: Number(r.answered), dismissed: Number(r.dismissed) })),
        by_day: perDay.map((r) => ({ day: String(r.day), shown: Number(r.shown), answered: Number(r.answered) })),
        conflicts,
        ...(chain ? { conflict_summary: conflictSummary(chain, conflicts), queue: queueAlert(chain, conflicts) } : {}),
    }
}

/** Every survey with its headline numbers, for list_surveys and the Surveys page. */
export async function surveyOverview(days = 30): Promise<(SurveyView & { shown: number; answered: number; dismissed: number })[]> {
    const list = (await listSurveys()).filter((s) => !s.archived)
    if (!list.length) return []
    const rows = await hogql(
        `SELECT toString(properties.$survey_id) AS id, countIf(event = 'survey shown') AS shown, ${ANSWERED} AS answered, countIf(event = 'survey dismissed') AS dismissed
         FROM events WHERE timestamp > now() - toIntervalDay({days}) AND event IN ('survey shown', 'survey sent', 'survey dismissed') AND toString(properties.$survey_id) IN {ids}
         GROUP BY id LIMIT 1000`,
        { days, ids: list.map((s) => s.id) }
    ).catch(() => [] as Record<string, unknown>[])
    const by = new Map(rows.map((r) => [String(r.id), r]))
    const order: Record<Status, number> = { running: 0, draft: 1, stopped: 2, archived: 3 }
    return list
        .map((s) => {
            const r = by.get(s.id)
            return { ...viewOf(s), shown: Number(r?.shown || 0), answered: Number(r?.answered || 0), dismissed: Number(r?.dismissed || 0) }
        })
        .sort((a, b) => order[a.status] - order[b.status] || b.created.localeCompare(a.created))
}
