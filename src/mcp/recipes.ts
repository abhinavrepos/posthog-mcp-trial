// Lens recipes: tested HogQL for the questions product managers ask most, run through posthog_exec as
// `recipe <name> <json>`. Each takes the same window argument as every Lens tool (rolling by default, clamped to
// now) and an optional client (a code, name, user or email: resolved like resolve_client). Names of events and
// properties come from APP_EVENTS_FILE, the client from CLIENT_FROM_DISTINCT_ID / PROP_CLIENT_ID.
import { z } from 'zod'
import { hogql, isTruncated } from '../core/posthog.ts'
import { P } from '../core/props.ts'
import { required, prop } from '../core/appevents.ts'
import { resolveClient } from '../core/resolve.ts'
import { ToolInputError } from '../core/toolinputerror.ts'
import { toolContext, auditClient } from '../core/toolcontext.ts'
import { resolveTime, timeShape, checkTime, windowContext } from './timeinput.ts'

const base = { client: z.string().min(1).max(320).optional(), ...timeShape }
const limit = z.number().int().min(1).max(100).default(10)
export const RECIPES = {
    events_per_client: { help: 'Events per client in the window (all event names, or event: "PageView"/"Event"). With client: that client only.', example: { window: { last: '7d' } }, schema: { ...base, event: z.string().max(200).optional(), limit: limit.default(100) } },
    top_screens: { help: 'Dialogs (dialog_id) opened most often (screen event with action OPEN), most first.', example: { client: 'C08', window: { last: '30d' }, limit: 5 }, schema: { ...base, limit } },
    top_buttons: { help: 'Buttons (action_name on interaction events) pressed most, outside message, notice and menu dialogs, most first.', example: { client: 'C08', window: { last: '30d' }, limit: 5 }, schema: { ...base, limit } },
    exports_by_label: { help: 'Presses of every export button label (any action_name containing "Export": Export, XLS Export, XLSX Export, CSV Export are separate buttons), optionally only in one dialog.', example: { client: 'C08', window: { last: '30d' } }, schema: { ...base, dialog: z.string().max(200).optional() } },
    messages: { help: 'Message and notice texts (messagebox and toast dialogs) with counts; text filters by a case-insensitive substring, kind picks message, notice or both.', example: { client: 'C17', window: { last: '7d' }, text: 'Error saving trade' }, schema: { ...base, text: z.string().max(500).optional(), kind: z.enum(['message', 'notice', 'both']).default('both'), limit: limit.default(20) } },
    error_rate: { help: 'Error messages (messages/notices whose text matches pattern, default "error|failed|could not") as a share of interaction events.', example: { client: 'C08', window: { last: '30d' } }, schema: { ...base, pattern: z.string().max(200).default('error|failed|could not') } },
    active_users: { help: 'Distinct users per UTC day or ISO week, plus distinct users over the whole window.', example: { client: 'C17', window: { from: '2026-11-09', to: '2026-11-22' }, bucket: 'week' }, schema: { ...base, bucket: z.enum(['day', 'week']).default('day') } },
} as const
export type RecipeName = keyof typeof RECIPES

export function recipeList() {
    return { recipes: Object.entries(RECIPES).map(([name, r]) => ({ name, what: r.help, example: `recipe ${name} ${JSON.stringify(r.example)}` })),
        note: 'Every recipe takes window ({"last":"24h"|"7d"}, {"day":"YYYY-MM-DD"} or {"from","to"} inclusive UTC dates; default last 7 days, clamped to now) and an optional client.' }
}

/** `recipe` / `recipe <name> <json>`. Returns the rows and the exact HogQL that produced them. */
export async function runRecipe(command: string): Promise<Record<string, unknown>> {
    const m = /^\s*recipe(?:\s+([\w-]+))?\s*([\s\S]*)$/i.exec(command)
    if (!m) throw new ToolInputError('Use recipe <name> <json>.')
    if (!m[1]) return recipeList()
    const name = m[1] as RecipeName, recipe = RECIPES[name]
    if (!recipe) throw new ToolInputError(`Unknown recipe ${m[1]}. Recipes: ${Object.keys(RECIPES).join(', ')}. Example: recipe top_screens ${JSON.stringify(RECIPES.top_screens.example)}`)
    let raw: unknown = {}
    if (m[2].trim()) { try { raw = JSON.parse(m[2]) } catch { throw new ToolInputError(`The recipe arguments must be JSON. Example: recipe ${name} ${JSON.stringify(recipe.example)}`) } }
    const parsed = z.object(recipe.schema as Record<string, z.ZodType>).strict().superRefine(checkTime as never).safeParse(raw)
    if (!parsed.success) throw new ToolInputError(`Invalid arguments for recipe ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).slice(0, 3).join('; ')}. Example: recipe ${name} ${JSON.stringify(recipe.example)}`)
    const args = parsed.data as Record<string, any>
    const w = resolveTime(args, 7)
    const ctx = toolContext.getStore(); if (ctx) ctx.window = w
    const reg = required()
    let client: string | undefined
    if (args.client) {
        const best = (await resolveClient({ text: args.client, from: w.from, to: w.to }))[0]
        if (!best) throw new ToolInputError(`No client matches "${args.client}". Call resolve_client to find the client code. Example: recipe ${name} ${JSON.stringify(recipe.example)}`)
        client = best.id; auditClient(best.id)
    }
    const dialog = prop(reg, 'dialog'), action = prop(reg, 'action'), button = prop(reg, 'button')
    // Messages arrive as a JSON list in action_name, sometimes encoded twice ([\"text\"]): match on the raw value,
    // show it without the list's brackets, quotes and escapes.
    const text = `if(startsWith(${button}, '['), replaceRegexpAll(${button}, ${String.raw`'[\\[\\]"\\\\]'`}, ''), ${button})`
    const where = [`timestamp >= {from}`, `timestamp < {to}`, ...(client ? [`toString(${P.client}) = {client}`] : [])]
    const values: Record<string, unknown> = { from: w.from.toISOString(), to: w.to.toISOString(), client, screen: reg.events.screen, interaction: reg.events.interaction,
        messages: reg.dialogs.messages, notices: reg.dialogs.notices, menu: reg.dialogs.menu, open: reg.screenActions.open }
    let sql: string
    switch (name) {
        case 'events_per_client':
            if (args.event) { where.push('event = {event}'); values.event = args.event }
            sql = `SELECT toString(${P.client}) AS client, count() AS events FROM events WHERE ${where.join(' AND ')} GROUP BY client ORDER BY events DESC LIMIT ${args.limit}`; break
        case 'top_screens':
            sql = `SELECT ${dialog} AS dialog_id, count() AS opens FROM events WHERE ${where.join(' AND ')} AND event = {screen} AND ${action} IN {open} GROUP BY dialog_id ORDER BY opens DESC, dialog_id LIMIT ${args.limit}`; break
        case 'top_buttons':
            sql = `SELECT ${button} AS button, count() AS presses FROM events WHERE ${where.join(' AND ')} AND event = {interaction} AND ${dialog} NOT IN {messages} AND ${dialog} NOT IN {notices} AND ${dialog} NOT IN {menu} AND ${button} != '' GROUP BY button ORDER BY presses DESC, button LIMIT ${args.limit}`; break
        case 'exports_by_label':
            if (args.dialog) { where.push(`${dialog} = {dialog}`); values.dialog = args.dialog }
            sql = `SELECT ${button} AS label, count() AS presses FROM events WHERE ${where.join(' AND ')} AND event = {interaction} AND positionCaseInsensitive(${button}, 'export') > 0 AND ${dialog} NOT IN {messages} AND ${dialog} NOT IN {notices} GROUP BY label ORDER BY presses DESC`; break
        case 'messages': {
            const dialogs = args.kind === 'message' ? '{messages}' : args.kind === 'notice' ? '{notices}' : 'arrayConcat({messages}, {notices})'
            if (args.text) { where.push(`positionCaseInsensitive(${button}, {text}) > 0`); values.text = args.text }
            sql = `SELECT ${text} AS message, ${dialog} AS dialog_id, count() AS times FROM events WHERE ${where.join(' AND ')} AND event = {interaction} AND has(${dialogs}, ${dialog}) GROUP BY message, dialog_id ORDER BY times DESC LIMIT ${args.limit}`; break
        }
        case 'error_rate':
            values.pattern = `(?i)${args.pattern}`
            sql = `SELECT countIf(event = {interaction} AND (has({messages}, ${dialog}) OR has({notices}, ${dialog})) AND match(${button}, {pattern})) AS error_messages, countIf(event = {interaction}) AS interaction_events, round(100 * error_messages / nullIf(interaction_events, 0), 3) AS error_percent FROM events WHERE ${where.join(' AND ')}`; break
        case 'active_users':
            sql = `SELECT ${args.bucket === 'week' ? 'toStartOfWeek(timestamp, 1)' : 'toDate(timestamp)'} AS ${args.bucket === 'week' ? 'week_start' : 'day'}, uniq(distinct_id) AS users FROM events WHERE ${where.join(' AND ')} GROUP BY 1 ORDER BY 1`; break
    }
    const rows = await hogql(sql!, values, { timeoutMs: +w.to - +w.from > 31 * 86_400_000 ? 300_000 : 60_000 })
    const out: Record<string, unknown>[] = rows
    let total: number | undefined
    if (name === 'active_users') total = Number((await hogql(`SELECT uniq(distinct_id) AS users FROM events WHERE ${where.join(' AND ')}`, values, { timeoutMs: 300_000 }))[0]?.users)
    return { recipe: name, window: windowContext(w), client: client ?? 'all clients', rows: out, ...(total !== undefined ? { users_in_window: total } : {}),
        ...(isTruncated(rows) ? { truncated: true } : {}), hogql: sql!.replace(/\s+/g, ' ') }
}
