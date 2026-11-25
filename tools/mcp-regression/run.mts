// MCP regression: each question in questions.json is answered by Claude (Sonnet by default) in its own headless
// session with only the Lens MCP server connected, against a real PostHog. Answers are graded against ClickHouse.
//
//   LENS_MCP_CONFIG=run/mcp-regression/lens-mcp.json CLICKHOUSE_URL=http://<clickhouse>:8123 \
//     node --import tsx tools/mcp-regression/run.mts [id|category ...]
//
// LENS_MCP_CONFIG: an MCP config JSON with one stdio server named "lens" (src/mcp/stdio.ts and its PostHog env;
// it holds keys, so keep it under run/, which git ignores). PARALLEL (6), TIMEOUT_S (360), MODEL (sonnet),
// CLAUDE_CONFIG_DIR (passed through), TAG (run folder name). Writes run/mcp-regression/<tag>/: one stream-json
// transcript per question and results.json; prints a summary. Grading rules: see docs/mcp-regression.md.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, createWriteStream, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface Expect { tool?: string; tool2?: string; answer?: string; any_text?: string; no_tool_error?: boolean }
interface Question { id: string; category: string; question: string; kind: 'count' | 'number' | 'numbers' | 'text' | 'list' | 'answer_sql' | 'behaviour'
    sql?: string; window_days?: number; expected?: number; expect_text?: string; expect_text_any?: string[]; k?: number; tolerance?: number; tool?: string; expect?: Expect; note?: string }
interface ToolCall { name: string; input: unknown; error: boolean; result: string; ms?: number }

const repo = resolve(import.meta.dirname, '../..')
const questions: Question[] = JSON.parse(readFileSync(join(import.meta.dirname, 'questions.json'), 'utf8'))
const filters = process.argv.slice(2)
const todo = filters.length ? questions.filter((q) => filters.some((f) => q.id === f || q.category === f)) : questions
const PARALLEL = Number(process.env.PARALLEL || 6), TIMEOUT_S = Number(process.env.TIMEOUT_S || 360), MODEL = process.env.MODEL || 'sonnet'
const CH = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123'
const CONFIG = resolve(process.env.LENS_MCP_CONFIG || join(repo, 'run/mcp-regression/lens-mcp.json'))
const tag = process.env.TAG || new Date().toISOString().replace(/[:.]/g, '-')
const out = join(repo, 'run/mcp-regression', tag); mkdirSync(join(out, 'empty'), { recursive: true })
const BUILTIN = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'Task', 'NotebookEdit', 'TodoWrite', 'ScheduleWakeup', 'CronCreate', 'Monitor', 'Skill']

async function ch(sql: string): Promise<string[][]> {
    const r = await fetch(CH, { method: 'POST', body: sql + ' FORMAT TSV' })
    const text = await r.text(); if (!r.ok) throw new Error(`ClickHouse: ${text.slice(0, 300)}`)
    return text.split('\n').filter((l) => l !== '').map((l) => l.split('\t'))
}
const ts = (ms: number) => `toDateTime64('${new Date(ms).toISOString().replace('T', ' ').replace('Z', '')}', 3, 'UTC')`
const fill = (sql: string, from: number, to: number) => sql.replaceAll('{from}', ts(from)).replaceAll('{to}', ts(to))

/** The question in its own Claude session; tool calls and results from the stream-json transcript. */
function ask(q: Question): Promise<{ answer: string; final: string; tools: ToolCall[]; ms: number; timedOut: boolean; cost?: number; turns?: number; exit: number | null; stderr: string }> {
    return new Promise((done) => {
        const prompt = `${q.question} End with a line ANSWER: <value>`
        const args = ['-p', prompt, '--model', MODEL, '--mcp-config', CONFIG, '--strict-mcp-config', '--allowedTools', 'mcp__lens__*',
            '--disallowedTools', ...BUILTIN, '--output-format', 'stream-json', '--verbose', '--no-session-persistence']
        const t0 = Date.now()
        const child = spawn('claude', args, { cwd: join(out, 'empty'), env: { ...process.env, MCP_TOOL_TIMEOUT: String(TIMEOUT_S * 1000) }, stdio: ['ignore', 'pipe', 'pipe'] })
        const log = createWriteStream(join(out, `${q.id}.jsonl`))
        let buf = '', stderr = '', final = '', cost: number | undefined, turns: number | undefined, timedOut = false
        const tools: ToolCall[] = [], pending = new Map<string, { call: ToolCall; at: number }>()
        const line = (l: string) => {
            if (!l.trim()) return
            log.write(`${Date.now() - t0}\t${l}\n`)
            let m: any; try { m = JSON.parse(l) } catch { return }
            if (m.type === 'assistant') for (const b of m.message?.content || []) {
                if (b.type === 'tool_use') { const call: ToolCall = { name: String(b.name).replace(/^mcp__lens__/, ''), input: b.input, error: false, result: '' }; tools.push(call); pending.set(b.id, { call, at: Date.now() }) }
            }
            if (m.type === 'user') for (const b of m.message?.content || []) {
                if (b.type !== 'tool_result') continue
                const p = pending.get(b.tool_use_id); if (!p) continue
                const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c: any) => c.text || '').join('\n')
                p.call.error = !!b.is_error || /^MCP error|"error"\s*:/.test(text); p.call.result = text.slice(0, 4000); p.call.ms = Date.now() - p.at
            }
            if (m.type === 'result') { final = String(m.result ?? ''); cost = m.total_cost_usd; turns = m.num_turns }
        }
        child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1) } })
        child.stderr.on('data', (d) => { stderr += d })
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000) }, TIMEOUT_S * 1000)
        child.on('close', (exit) => {
            clearTimeout(timer); line(buf); log.end()
            const answers = [...final.matchAll(/^\**ANSWER:?\**:?\s*(.*)$/gim)]
            done({ answer: (answers.at(-1)?.[1] ?? '').replace(/\*+/g, '').trim(), final, tools, ms: Date.now() - t0, timedOut, cost, turns, exit, stderr: stderr.slice(-2000) })
        })
    })
}

const num = (s: string) => { const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s.replace(/(\d)[   ](?=\d{3}\b)/g, '$1')); return m ? Number(m[0].replace(/,/g, '')) : NaN }
const norm = (s: string) => s.toLowerCase().replace(/[`"'*.]/g, '').replace(/\s+/g, ' ').trim()

async function grade(q: Question, r: Awaited<ReturnType<typeof ask>>, t0: number, t1: number) {
    const called = (n?: string) => !n || r.tools.some((t) => t.name === n)
    const toolErrors = r.tools.filter((t) => t.error).map((t) => `${t.name}: ${t.result.slice(0, 300)}`)
    let expected: unknown, pass = false, detail = '', window: string | undefined
    const ans = r.answer
    if (q.kind === 'count' || q.kind === 'number') {
        let lo: number, hi: number
        if (q.expected !== undefined) lo = hi = q.expected
        else if (q.window_days) {
            // Rolling window ending at the moment of the call, somewhere in [t0, t1]: lo counts what is inside for every
            // such moment, hi what is inside for any of them (documented edge tolerance).
            const N = q.window_days * 86400000
            lo = Number((await ch(fill(q.sql!, t1 - N, t0)))[0]?.[0]); hi = Number((await ch(fill(q.sql!, t0 - N, t1)))[0]?.[0])
        } else lo = hi = Number((await ch(q.sql!))[0]?.[0])
        const tol = q.tolerance ?? 0, v = num(ans)
        expected = lo === hi ? lo : { min: lo, max: hi }
        pass = v >= lo - tol && v <= hi + tol
        if (!pass && q.window_days && Number.isFinite(v)) {
            // "Last N days" read as N calendar days, clamped to now like every window: ending with today (up to now), or
            // N complete days ending yesterday. Accepted, reported apart. Counting rows dated after now is not.
            const D = 86400000, today = Math.floor(t0 / D) * D, N = q.window_days * D
            for (const [label, f, t] of [['calendar incl. today up to now', today + D - N, t1], ['calendar to yesterday', today - N, today]] as const) {
                const c = Number((await ch(fill(q.sql!, f, t)))[0]?.[0]), c0 = label.endsWith('now') ? Number((await ch(fill(q.sql!, f, t0)))[0]?.[0]) : c
                if (v >= Math.min(c, c0) && v <= Math.max(c, c0)) { pass = true; window = label; break }
            }
        }
        if (!pass && Number.isFinite(v)) detail = `off by ${v < lo ? v - lo : v - hi} (${(((v < lo ? v - lo : v - hi) / Math.max(1, hi)) * 100).toFixed(3)}%)`
    } else if (q.kind === 'numbers') {
        const want = (await ch(q.sql!)).map((row) => Number(row[0])), got = (ans.match(/\d[\d,]*/g) || []).map((s) => Number(s.replace(/,/g, '')))
        expected = want; pass = want.length === got.length && want.every((w, i) => w === got[i])
    } else if (q.kind === 'text') {
        const want = q.expect_text_any || [q.expect_text ?? (await ch(q.sql!))[0]?.[0] ?? '']
        expected = want.length === 1 ? want[0] : want
        pass = want.some((w) => w !== '' && (norm(ans) === norm(w) || new RegExp(`(^|[^a-z0-9])${norm(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(norm(ans))))
    } else if (q.kind === 'list') {
        const want = (await ch(q.sql!)).map((row) => norm(row[0])), got = ans.replace(/\([^)]*\)/g, '').replace(/:\s*[\d,.]+/g, '').split(/[,;\n]|\s\|\s/).map((s) => norm(s.replace(/^\s*\d+[.)]\s*/, '').replace(/\s*\(.*\)$/, ''))).filter(Boolean)
        const k = q.k || want.length, hit = want.filter((w) => got.includes(w)).length
        expected = want; pass = hit / k >= 0.6; detail = `overlap ${hit}/${k}`
    } else if (q.kind === 'answer_sql') {
        const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(ans)?.[0]
        expected = 'a session id that satisfies the SQL'
        pass = !!id && Number((await ch(q.sql!.replaceAll('{answer}', `'${id}'`)))[0]?.[0]) > 0
        if (!id) detail = 'no session id in the answer'
    } else {
        const e = q.expect || {}, all = [ans, r.final, ...r.tools.map((t) => t.result)].join('\n')
        expected = e
        const checks = [called(e.tool) || `tool ${e.tool} not called`, called(e.tool2) || `tool ${e.tool2} not called`,
            !e.answer || new RegExp(e.answer, 'i').test(ans) || `answer does not match /${e.answer}/`,
            !e.any_text || new RegExp(e.any_text, 'i').test(all) || `no text matching /${e.any_text}/`,
            !e.no_tool_error || !toolErrors.length || 'tool error']
        const bad = checks.filter((c) => c !== true); pass = !bad.length; detail = bad.join('; ')
    }
    if (pass && q.tool && !called(q.tool)) { pass = false; detail = `tool ${q.tool} not called` }
    const failure = pass ? undefined : r.timedOut ? 'timeout' : !ans ? 'no ANSWER line' : toolErrors.length ? 'tool error(s)' : 'wrong answer'
    // First-pass taxonomy; triage.json overrides it after a person (or agent) has read the transcript.
    const taxonomy = pass ? undefined : r.timedOut ? 'timeout' : toolErrors.some((e) => /Invalid arguments|Input validation|-32602|Example:/.test(e)) ? 'misleading description'
        : toolErrors.length ? 'tool bug' : 'model reasoning'
    return { expected, pass, detail, failure, toolErrors, window, taxonomy }
}

const results: any[] = []
if (process.env.REGRADE) {
    // Re-grade a finished run (REGRADE=<tag>) with the current rules; nothing is asked again.
    const dir = join(repo, 'run/mcp-regression', process.env.REGRADE), old: any[] = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'))
    for (const row of old) {
        const q = questions.find((x) => x.id === row.id)!, t1 = row.t1 ?? statSync(join(dir, `${row.id}.jsonl`)).mtimeMs, t0 = row.t0 ?? t1 - row.ms
        const r = { answer: row.answer, final: row.final, tools: row.tools.map((t: any) => ({ ...t, result: t.result || '' })), ms: row.ms, timedOut: row.timedOut, exit: row.exit, stderr: '' }
        Object.assign(row, { window: undefined, taxonomy: undefined, detail: '' }, await grade(q, r, t0, t1), { t0, t1, question: q.question })
        console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.id} ${row.category} answer=${JSON.stringify(row.answer).slice(0, 60)} expected=${JSON.stringify(row.expected).slice(0, 70)}${row.detail ? ' ' + row.detail : ''}${row.window ? ' [' + row.window + ']' : ''}`)
    }
    writeFileSync(join(dir, 'results.json'), JSON.stringify(old, null, 1)); summary(old, dir); process.exit(0)
}
function summary(rows: any[], dir: string) {
    const triage: Record<string, { taxonomy?: string }> = (() => { try { return JSON.parse(readFileSync(join(import.meta.dirname, 'triage.json'), 'utf8'))[dir.split('/').pop()!] || {} } catch { return {} } })()
    for (const r of rows) if (!r.pass && triage[r.id]?.taxonomy) r.taxonomy = triage[r.id].taxonomy
    const tax = new Map<string, number>(); for (const r of rows) if (!r.pass) tax.set(r.taxonomy, (tax.get(r.taxonomy) || 0) + 1)
    if (tax.size) console.log('failures by kind: ' + [...tax].map(([k, n]) => `${k} ${n}`).join(', '))
    const by = new Map<string, { n: number; pass: number }>()
    for (const r of rows) { const c = by.get(r.category) || { n: 0, pass: 0 }; c.n++; if (r.pass) c.pass++; by.set(r.category, c) }
    console.log(`\n${rows.filter((r) => r.pass).length} of ${rows.length} passed (${dir})`)
    for (const [c, v] of by) console.log(`  ${c}: ${v.pass}/${v.n}`)
}
let next = 0
async function worker() {
    for (;;) {
        const q = todo[next++]; if (!q) return
        const t0 = Date.now(), r = await ask(q), t1 = Date.now()
        let g: Awaited<ReturnType<typeof grade>>
        try { g = await grade(q, r, t0, t1) } catch (e) { g = { expected: null, pass: false, detail: `grading failed: ${(e as Error).message}`, failure: 'grading error', toolErrors: [], window: undefined, taxonomy: 'harness' } }
        const row = { t0, t1, id: q.id, category: q.category, question: q.question, answer: r.answer, ...g, ms: r.ms, turns: r.turns, cost: r.cost, timedOut: r.timedOut, exit: r.exit,
            tools: r.tools.map((t) => ({ name: t.name, input: t.input, error: t.error, ms: t.ms, result: t.result.slice(0, 600) })), final: r.final.slice(-1500), note: q.note }
        results.push(row)
        console.log(`${g.pass ? 'PASS' : 'FAIL'} ${q.id} ${q.category} ${(r.ms / 1000).toFixed(0)}s tools=${r.tools.map((t) => t.name + (t.error ? '!' : '')).join(',')} answer=${JSON.stringify(r.answer).slice(0, 80)} expected=${JSON.stringify(g.expected).slice(0, 80)}${g.detail ? ' ' + g.detail : ''}${g.window ? ' [' + g.window + ']' : ''}`)
        writeFileSync(join(out, 'results.json'), JSON.stringify(results.sort((a, b) => a.id.localeCompare(b.id)), null, 1))
    }
}
await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker))
summary(results, out)
