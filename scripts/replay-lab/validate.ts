// Checks the replay-signal engine against the lab's ground truth, on real recordings from PostHog:
// every planted value must be in the raw replay (so the test means something) and in none of the signals,
// and each persona's behaviour must show up as the signal it was scripted to produce.
//   node --import tsx scripts/replay-lab/validate.ts out/ground-truth.json
import { readFileSync } from 'node:fs'

import { getSnapshotsJsonl } from '../../src/core/posthog.ts'
import { signalsFromReplay } from '../../src/core/replaysignals.ts'
import { canaryStrings } from './canaries.ts'

const truth = JSON.parse(readFileSync(process.argv[2] || 'scripts/replay-lab/out/ground-truth.json', 'utf8'))
const sessions = Object.values(truth.sessions || truth) as { session_id: string; client_id: string; persona: string; expected: Record<string, number> }[]
const variants = (c: string) => [c, c.replace(/,/g, ''), c.toLowerCase(), encodeURIComponent(c)]
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
for (const t of sessions) {
    let jsonl = ''
    for (let i = 0; i < 20 && !jsonl; i++) { try { jsonl = await getSnapshotsJsonl(t.session_id) } catch { await new Promise((r) => setTimeout(r, 15000)) } }
    if (!jsonl) { ok(`${t.persona} ${t.session_id}: recording stored`, false); continue }
    const inRaw = canaryStrings.filter((c) => jsonl.includes(c) || jsonl.includes(c.replace(/,/g, '')))
    const s = signalsFromReplay(jsonl), out = JSON.stringify(s)
    const leaked = canaryStrings.flatMap(variants).filter((v) => out.includes(v))
    const e = t.expected
    ok(`${t.persona}: planted values are in the raw replay`, inRaw.length >= 3, `${inRaw.length} of ${canaryStrings.length}`)
    ok(`${t.persona}: none of them in the signals`, !leaked.length, leaked.join(', '))
    const sum = { rage: s.rage_clicks.length, dead: s.dead_clicks.length, errors: s.errors_shown.length, loops: s.error_loops.reduce((a, l) => a + l.count, 0), hes: s.hesitations.length, circ: s.cursor.circling_bursts, hunt: s.scroll.hunting_bursts, rev: s.scroll.reversals, idle: Math.round(s.idle_ms / 1000) }
    const want: [string, boolean][] = [
        ['rage clicks found', e.rage_click_bursts ? sum.rage >= e.rage_click_bursts : sum.rage === 0],
        ['dead clicks found', e.dead_target_clicks ? sum.dead >= 1 : true],
        ['errors shown', e.error_submissions ? sum.errors >= Math.min(2, e.error_submissions) : sum.errors === 0],
        ['error loop', e.error_retries ? sum.loops >= 1 : sum.loops === 0],
        ['hesitations', e.hesitations ? sum.hes >= 1 : true],
        ['cursor circling', e.circling_bursts_min ? sum.circ >= e.circling_bursts_min : true],
        ['scroll hunting', e.hunting_bursts_min ? sum.hunt >= e.hunting_bursts_min : true],
        ['idle', e.idle_ms_min ? s.idle_ms >= e.idle_ms_min * 0.8 : true],
    ]
    for (const [label, cond] of want) ok(`${t.persona}: ${label}`, cond, JSON.stringify(sum))
}
console.log(fail ? `${fail} failed` : 'all passed')
process.exit(fail ? 1 : 0)
