// Load for scripts/stress-rescue.ts: waves of concurrent chat (MCP) calls and status writes against a
// running Lens, until the ingestion is done, then a few settled waves. Writes latencies and errors as JSON.
//   node --import tsx scripts/stress-load.ts <lens url> <tokens.json> <out.json> <clients>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [LENS, tokenFile, out, clientsArg] = process.argv.slice(2)
const CLIENTS = Number(clientsArg || 50), WAVE = Number(process.env.STRESS_WAVE || 100)
const tokens = JSON.parse(readFileSync(tokenFile, 'utf8')) as { admins: string[]; viewers: string[] }
const doneFlag = join(dirname(tokenFile), 'ingest-done')
type Kind = 'rescue_queue' | 'task_map' | 'flow_time' | 'set_rescue_status' | 'page'
const lat: Record<string, number[]> = {}, errors: Record<string, number> = {}
let writesOk = 0, requests = 0
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]
const pad = (n: number) => String(n).padStart(2, '0')

async function call(token: string, name: string, args: unknown): Promise<string | null> {
    // One stateless request per call (Lens's MCP endpoint answers JSON without a session).
    const r = await fetch(LENS + '/mcp', { method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const text = await r.text()
    if (r.status !== 200) return `HTTP ${r.status}`
    const d = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() || '{}')
    if (d.error) return 'rpc: ' + String(d.error.message).slice(0, 80)
    if (d.result?.isError) return 'tool: ' + JSON.stringify(d.result.content).slice(0, 100)
    return null
}
async function one(kind: Kind, phase: string) {
    const t = performance.now()
    let err: string | null = null
    try {
        if (kind === 'rescue_queue') err = await call(pick(tokens.viewers), 'rescue_queue', { when: `last ${pick([14, 28, 56])} days` })
        else if (kind === 'task_map') err = await call(pick(tokens.viewers), 'task_map', pick([{}, { client: `Client ${pad(1 + Math.floor(Math.random() * CLIENTS))}` }]))
        else if (kind === 'flow_time') err = await call(pick(tokens.viewers), 'flow_time', { task: `t_DlgTask${pad(Math.floor(Math.random() * 40))}` })
        else if (kind === 'set_rescue_status') {
            err = await call(pick(tokens.admins), 'set_rescue_status', { client: `C${pad(1 + Math.floor(Math.random() * CLIENTS))}`, status: pick(['open', 'contacted', 'in_progress']), note: 'stress ' + Math.random().toString(36).slice(2, 8) })
            if (!err) writesOk++
        } else if (kind === 'page') {
            const r = await fetch(LENS + '/replays/dashboards?view=rescue&days=' + pick([14, 28]), { headers: { cookie: process.env.STRESS_COOKIE || '' }, signal: AbortSignal.timeout(120_000) })
            await r.text(); if (r.status !== 200) err = `page HTTP ${r.status}`
        }
    } catch (e) { err = (e as Error).name + ': ' + (e as Error).message.slice(0, 60) }
    const key = `${phase}:${kind}`
    ;(lat[key] ||= []).push(performance.now() - t)
    requests++
    if (err) errors[`${key} ${err}`] = (errors[`${key} ${err}`] || 0) + 1
}
function mix(): Kind[] {
    const kinds: Kind[] = []
    for (let i = 0; i < WAVE; i++) {
        const x = Math.random()
        kinds.push(x < 0.55 ? 'rescue_queue' : x < 0.75 ? 'task_map' : x < 0.85 ? 'flow_time' : x < 0.95 ? 'set_rescue_status' : process.env.STRESS_COOKIE ? 'page' : 'rescue_queue')
    }
    return kinds
}
const stats = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); return { n: s.length, p50: q(0.5), p95: q(0.95), max: Math.round(s.at(-1) || 0) } }

let waves = 0
const started = Date.now()
while (!existsSync(doneFlag) && Date.now() - started < 3 * 3600_000) {
    await Promise.all(mix().map((k) => one(k, 'during_ingest')))
    waves++
    if (waves % 10 === 0) console.log(JSON.stringify({ msg: 'load', waves, requests, errors: Object.values(errors).reduce((a, b) => a + b, 0) }))
}
for (let i = 0; i < 5; i++) await Promise.all(mix().map((k) => one(k, 'after_ingest')))
writeFileSync(out, JSON.stringify({ waves_during_ingest: waves, wave_size: WAVE, requests, writes_ok: writesOk,
    latency_ms: Object.fromEntries(Object.entries(lat).sort().map(([k, v]) => [k, stats(v)])), errors }, null, 1))
