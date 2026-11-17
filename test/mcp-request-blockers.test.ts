import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'

const dir = mkdtempSync(join(process.cwd(), '.mcp-request-blockers-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'main.db'), TASKS_DB: join(dir, 'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json' })
const { analyticalResult } = await import('../src/mcp/historyresult.ts')
const { jsonResult } = await import('../src/mcp/result.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const { db } = await import('../src/core/db.ts')
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })

test('find_trade size limiting preserves every session before its paging cursor', () => {
    // A real page has at most ten sessions, each with up to eight error messages.
    const sessions = Array.from({ length: 10 }, (_, i) => ({
        session_id: `session-${i}`, first_seen: `2026-10-01T10:${String(59 - i).padStart(2, '0')}:00Z`,
        client: '', user: '', how: ['searched for it'],
        errors_after: Array.from({ length: 8 }, () => ({ at: '2026-10-01T11:00:00Z', dialog: 'Trade', text: 'Validation failed: '.repeat(150) })),
        attempts_after: [],
    }))
    const expectedIds = sessions.map(s => s.session_id)
    const cursor = `${sessions.at(-1)!.first_seen}|${sessions.at(-1)!.session_id}`
    const result = analyticalResult('find_trade', { from: '2026-10-01', to: '2026-10-01' }, jsonResult('Trade 1006', {
        id: '1006', sessions, more_sessions: true, next_cursor: cursor,
    })) as ReturnType<typeof jsonResult>
    const value = result._lensJson.value as { sessions: typeof sessions; next_cursor: string; omitted_rows_by_path: Record<string, number> }
    assert.deepEqual(value.sessions.map(s => s.session_id), expectedIds, 'paging must not jump past sessions removed by the output cap')
    assert.equal(value.sessions.length, 10)
    assert.equal(value.next_cursor, cursor)
    assert.ok(JSON.stringify(value).length < 28000, 'bound nested evidence rather than losing sessions')
    assert.ok(Object.keys(value.omitted_rows_by_path).some(path => path.includes('errors_after')))
})
