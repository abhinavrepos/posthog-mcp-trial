// Saves the lab's recordings (synthetic data only) as JSONL fixtures for offline tuning and tests.
//   node --import tsx scripts/replay-lab/fetch.ts out/ground-truth.json out/recordings
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getSnapshotsJsonl } from '../../src/core/posthog.ts'

const truth = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const dir = process.argv[3]; mkdirSync(dir, { recursive: true })
for (const t of Object.values(truth.sessions || truth) as { session_id: string; persona: string }[]) {
    writeFileSync(join(dir, `${t.persona}-${t.session_id}.jsonl`), await getSnapshotsJsonl(t.session_id))
    console.log('saved', t.persona, t.session_id)
}
