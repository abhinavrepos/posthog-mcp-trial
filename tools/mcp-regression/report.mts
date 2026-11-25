// Markdown tables for docs/mcp-regression.md from one or two runs: node --import tsx tools/mcp-regression/report.mts <tag> [<before-tag>]
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const repo = resolve(import.meta.dirname, '../..')
const load = (tag: string) => JSON.parse(readFileSync(join(repo, 'run/mcp-regression', tag, 'results.json'), 'utf8')) as any[]
const [tag, before] = process.argv.slice(2), now = load(tag), old = before ? load(before) : undefined
// triage.json: { <run tag>: { <question id>: { taxonomy, cause, fix } } }, written after reading the transcripts.
const triage: Record<string, { taxonomy?: string; cause?: string; fix?: string }> = (() => { try { return JSON.parse(readFileSync(join(import.meta.dirname, 'triage.json'), 'utf8'))[tag] || {} } catch { return {} } })()
const cats = [...new Set(now.map((r) => r.category))]
const rate = (rows: any[], c?: string) => { const xs = c ? rows.filter((r) => r.category === c) : rows; return `${xs.filter((r) => r.pass).length}/${xs.length}` }
console.log(`| Category | ${old ? 'Before | After' : 'Passed'} |\n| --- | ${old ? '--- | ---' : '---'} |`)
for (const c of cats) console.log(`| ${c} | ${old ? rate(old, c) + ' | ' : ''}${rate(now, c)} |`)
console.log(`| **all** | ${old ? '**' + rate(old) + '** | ' : ''}**${rate(now)}** |\n`)
const ms = now.map((r) => r.ms).sort((a, b) => a - b), q = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] / 1000)
console.log(`Latency per question: median ${q(0.5)} s, p90 ${q(0.9)} s, max ${q(1)} s. Calendar-window passes: ${now.filter((r) => r.pass && r.window).map((r) => r.id).join(', ') || 'none'}.\n`)
for (const r of now.filter((r) => !r.pass)) {
    const t = triage[r.id] || {}
    console.log(`#### ${r.id} (${r.category}) — ${t.taxonomy || r.taxonomy}\n- Question: ${r.question}\n- Expected: \`${JSON.stringify(r.expected)}\`\n- Got: \`${String(r.answer).slice(0, 200)}\`${r.detail ? ` (${r.detail})` : ''}${r.window ? ` [${r.window}]` : ''}\n- Tools: ${r.tools.map((x: any) => x.name + (x.error ? ' (error)' : '')).join(', ') || 'none'}${r.toolErrors?.length ? `\n- Tool errors: ${r.toolErrors.map((e: string) => '`' + e.slice(0, 200).replace(/`/g, "'") + '`').join('; ')}` : ''}\n- Root cause: ${t.cause || '(not triaged)'}\n- Fix: ${t.fix || '—'}\n`)
}
