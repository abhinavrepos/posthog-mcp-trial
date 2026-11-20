import assert from 'node:assert/strict'
import { test } from 'node:test'
const { analyticalWindow } = await import('../src/core/timewindow.ts')
const now = new Date('2026-11-15T09:00:00Z')
const span = (t: string) => { const w = analyticalWindow(t, now)!; return [w.from.toISOString().slice(0, 10), new Date(+w.to - 1).toISOString().slice(0, 10)] }
test('calendar-to-date, since and all-time phrases end at the current time', () => {
    assert.deepEqual(span('this month'), ['2026-11-01', '2026-11-15'])
    assert.deepEqual(span('year to date'), ['2026-01-01', '2026-11-15'])
    assert.deepEqual(span('YTD'), ['2026-01-01', '2026-11-15'])
    assert.deepEqual(span('this quarter'), ['2026-10-01', '2026-11-15'])
    assert.deepEqual(span('this week'), ['2026-11-09', '2026-11-15'])
    assert.deepEqual(span('since March 2024'), ['2024-03-01', '2026-11-15'])
    assert.deepEqual(span('since 2023'), ['2023-01-01', '2026-11-15'])
    assert.deepEqual(span('since 2024-02-01'), ['2024-02-01', '2026-11-15'])
    assert.equal(span('all time')[1], '2026-11-15'); assert.deepEqual(span('since the beginning of our data'), span('all time'))
    assert.equal(analyticalWindow('sometime around then', now), undefined)
})
