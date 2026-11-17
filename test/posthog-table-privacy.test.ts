import assert from 'node:assert/strict'
import { test } from 'node:test'
process.env.DISTINCT_ID_SEPARATOR ||= '|'
process.env.APP_EVENTS_FILE ||= 'config/app-events.reval.json'
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

test('empty aggregate headers from graded SQL aliases survive repeated privacy passes', () => {
    // The evidence retains only [person]; reconstruct empty headers from the exact SELECT aliases (p13/p14/p19).
    for (const header of ['month|events_count|people_count|anon_events', 'month|events_count', 'event|events_count', 'plan|mau', 'plan|july_users|retained_in_august', 'plan|mau_count', 'Date|PageView']) {
        for (const suffix of ['', '\n', '\n\n', '\nNo results.']) {
            const input = header + suffix
            assert.equal(safetyWith(safetyWith(input, []), []), input)
        }
    }
    assert.equal(safetyWith('ENV|01|C88|user3', []), '[person]')
    assert.equal(safetyWith('ENV|prod|C88|events', []), '[person]')
    assert.equal(safetyWith('month|events_count\n2026-01-01|341421', []), 'month|events_count\n2026-01-01|341421')
})

test('path conversion durations survive while adjacent people and cash remain private', () => {
    // p20 preserves the path edges and units but masks the minute cells; reconstruct those numeric cells.
    const paths = 'Source|Target|Users|Avg. conversion time\n1_DlgTask05|2_DlgTask10|587|8h 14m 3s\n1_DlgTask05|2_DlgList|294|8d 10h'
    assert.equal(safetyWith(safetyWith(paths, []), []), paths)
    const mixed = 'Source|Avg. conversion time|email|notional\nENV|01|C88|user3|8h 14m 3s|jane@example.com|250000'
    const safe = safetyWith(safetyWith(mixed, []), [])
    assert.match(safe, /\[person\]\|8h 14m 3s\|\[person\]\|<amount>/)
    assert.doesNotMatch(safe, /ENV|jane@|250000/)
    assert.match(safetyWith('Source|Avg. conversion time\nDlgTask05|USD 250000', []), /<amount>/)
})
