import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(process.cwd(), '.url-blockers-'))
Object.assign(process.env, { TRIAGE_ENV_FILE: join(dir, 'none'), TRIAGE_DB: join(dir, 'triage.db'), TASKS_DB: join(dir, 'tasks.db') })
const { safetyWith } = await import('../src/core/aisafety.ts')
const { setAnonymise } = await import('../src/core/anonymise.ts')
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
setAnonymise({ mode: 'standard' })
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('malformed clip query escapes do not abort privacy filtering of a tool answer', () => {
    for (const clip of ['%', '%E9', '%E0%A4%A']) {
        const out = safetyWith(`https://lens.example/replays?clip=${clip}&notional=250000`, [])
        assert.match(out, /notional=<amount>/)
    }
})

test('UTF-8 percent-encoded names are masked in links, including nested encoding', () => {
    for (const name of ['José', 'José Álvarez', 'Jane Smith', '李明华', 'İpek']) {
        for (let encoded = encodeURIComponent(name), depth = 0; depth < 3; depth++, encoded = encodeURIComponent(encoded)) {
            for (const url of [`https://app.example/people/${encoded}`, `https://app.example/?name=${encoded}`, `https://app.example/?${new URLSearchParams({ name })}`]) {
                const out = safetyWith(url, [name])
                assert.match(out, /\[person\]/, url)
                assert.ok(!out.includes(encoded), out)
            }
        }
    }
})
