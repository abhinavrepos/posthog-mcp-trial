// Privacy OFF (open mode) and mode switches: what the stored history holds must not depend on the mode it was built in.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(tmpdir(), 'lens-open-mode-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.POSTHOG_PERSONAL_API_KEY ||= 'test'
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { setAnonymise } = await import('../src/core/anonymise.ts')
const { safetyWith } = await import('../src/core/aisafety.ts')
const { appEvents, cleanMessage, generalise } = await import('../src/core/appevents.ts')
const { analyticalResult } = await import('../src/mcp/historyresult.ts')
after(() => { setAnonymise({ mode: 'standard' }); tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

const reg = appEvents()!
const message = 'Counterparty limit exceeded: 250000.00 USD'

test('stored message text and templates are the same in every privacy mode', () => {
    const seen = new Set<string>()
    for (const mode of ['open', 'standard', 'private'] as const) {
        setAnonymise({ mode })
        seen.add(JSON.stringify([cleanMessage(message, reg, 300, true), generalise(message, reg, 200, true)]))
    }
    // One error is one template whichever mode a day was ingested in; no cash amount is stored for the dashboards.
    assert.deepEqual([...seen], [JSON.stringify(['Counterparty limit exceeded: <amount>', 'Counterparty limit exceeded: <amount>'])])
})

test('open mode still shows live message text unmasked', () => {
    setAnonymise({ mode: 'open' })
    assert.equal(cleanMessage(message, reg), message)
    setAnonymise({ mode: 'standard' })
    assert.equal(cleanMessage(message, reg), 'Counterparty limit exceeded: <amount>')
})

test('a release named after the app is a label, not cash', () => {
    setAnonymise({ mode: 'standard' })
    const out = safetyWith({ examples: ['Reval 26.3', 'REVAL 27.0.1'], text: 'Fee 26.30 on Reval 26.3' }, [])
    assert.deepEqual(out.examples, ['Reval 26.3', 'REVAL 27.0.1'])
    assert.equal(out.text, 'Fee <amount> on Reval 26.3')
})

test('oversized answers lose data rows first, never the request echo', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ period: '2026-01-01', client: `C${i}`, events: 1000 + i, sessions: 10, users: 2 }))
    const value = { window: { from: '2026-01-01', to: '2026-01-31' }, metrics: ['events', 'sessions', 'users'], group_by: ['client'], filters: [] as unknown[], rows }
    const out = analyticalResult('aggregate_events', { from: '2026-01-01', to: '2026-01-31' }, { _lensJson: { label: 'x', value } }) as { _lensJson: { value: Record<string, unknown> } }
    const v = out._lensJson.value as { metrics: string[]; group_by: string[]; rows: unknown[]; omitted_rows_by_path: Record<string, number> }
    assert.deepEqual(v.metrics, ['events', 'sessions', 'users'])
    assert.deepEqual(v.group_by, ['client'])
    assert.ok(v.rows.length > 50 && v.rows.length < 2000, String(v.rows.length))
    assert.deepEqual(Object.keys(v.omitted_rows_by_path), ['rows'])
    assert.equal(v.omitted_rows_by_path.rows! + v.rows.length, 2000)
    assert.ok(JSON.stringify(v).length <= 27500 + 2000)
})
