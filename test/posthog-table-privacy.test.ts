import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.DISTINCT_ID_SEPARATOR ||= '|'
const { safetyWith } = await import('../src/core/aisafety.ts')

test('PostHog pipe tables keep counts, dates, rates and durations; distinct ids inside cells are masked', () => {
    // Real execute-sql output: the distinct id carries its own separators.
    assert.equal(safetyWith('total|toasts|who\n266202|0|ENV|01|C88|user3', []), 'total|toasts|who\n266202|0|[person]')
    // Real funnel output.
    const funnel = 'Date range: 2026-10-01 00:00:00 to 2026-10-31 23:59:59 (UTC)\n\nMetric|PageView|PageView\nTotal person count|900|900\nConversion rate|100%|100%\nMedian conversion time|-|2h 43m 31s'
    assert.equal(safetyWith(funnel, []), funnel)
    // Real trends output.
    const trend = 'Date|PageView\n2025-11-01|900\n2025-12-01|900'
    assert.equal(safetyWith(trend, []), trend)
    assert.equal(safetyWith('dialog|events_count\nDlgTask22|132286', []), 'dialog|events_count\nDlgTask22|132286')
})

test('privacy still holds inside tables: money columns, unnamed large numbers, emails, client users and stray ids', () => {
    assert.match(safetyWith('client|notional\nC01|250000', []), /C01\|<amount>/)
    assert.match(safetyWith('x|y\n250000|3', []), /<amount>\|3/)
    assert.doesNotMatch(safetyWith('day|user_email\n2026-01-01|jane.doe@client.example', []), /jane\.doe/)
    assert.doesNotMatch(safetyWith('Breakdown|PageView\nJane Doe|900', ['Jane Doe']), /Jane Doe/)
    assert.doesNotMatch(safetyWith('name|events\nJane Doe|12', ['Jane Doe']), /Jane Doe/)
    // A distinct id in prose (no table) is masked exactly as before.
    assert.equal(safetyWith('user ENV|01|C88|user3 failed twice', []), 'user [person] failed twice')
})
