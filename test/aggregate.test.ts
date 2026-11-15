import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dir = mkdtempSync(join(tmpdir(), 'lens-aggregate-'))
process.env.TRIAGE_DB = join(dir, 'm.db'); process.env.TASKS_DB = join(dir, 't.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.POSTHOG_PROJECT_ID ||= '1'; process.env.POSTHOG_PERSONAL_API_KEY ||= 'phx_test'
const { aggregateEvents, DIMENSIONS } = await import('../src/core/aggregate.ts')
after(() => rmSync(dir, { recursive: true, force: true }))
const response = (rows: Record<string, unknown>[]) => { const columns = [...new Set(rows.flatMap(Object.keys))]; return new Response(JSON.stringify({ columns, results: rows.map((r) => columns.map((c) => r[c])) }), { status: 200 }) }
const q = { from: new Date('2023-01-01'), to: new Date('2027-01-01') }

test('compiles a bounded, aggregate-only query with bound values and exact distinct counts', async (t) => {
    const seen: { query: string; values: Record<string, unknown> }[] = []
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body)).query; seen.push(body)
        return body.query.includes('GROUP BY') ? response([{ period: '2024-01-01T00:00:00Z', app_version: '26.3', events: 10, users: 2 }, { period: '2024-02-01T00:00:00Z', app_version: '26.3', events: 7, users: 2 }])
            : body.query.startsWith('SELECT count() AS events') ? response([{ events: new Date(body.values.from).getUTCFullYear() - 2018 }])
            : response([{ users: 3 }])
    })
    const r = await aggregateEvents({ ...q, metrics: ['events', 'users'], group_by: ['app_version'], bucket: 'month', filters: [{ dimension: 'dialog', op: 'eq', value: "DlgX'); DROP TABLE events; --" }] })
    assert.equal(r.queries, 4)
    assert.equal(seen.find((s) => s.query.includes('GROUP BY'))!.values.f0, "DlgX'); DROP TABLE events; --")
    // Without groups: events counted one year at a time (5+6+7+8 from the fake); distinct users once over all four.
    seen.length = 0
    const t2 = await aggregateEvents({ ...q, metrics: ['events', 'users'] })
    assert.deepEqual(t2.totals, { events: 26, users: 3 })
    const yearly = seen.filter((x) => x.query.startsWith('SELECT count() AS events')).map((x) => [x.values.from, x.values.to])
    assert.deepEqual(yearly, [['2023-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'], ['2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'], ['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'], ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']])
    const whole = seen.filter((x) => /uniqExact\(distinct_id\) AS users \$\{?|uniqExact\(distinct_id\) AS users FROM/.test(x.query) && !x.query.includes('GROUP BY'))
    assert.equal(whole.length, 1); assert.equal(whole[0].values.from, '2023-01-01T00:00:00.000Z'); assert.equal(whole[0].values.to, '2027-01-01T00:00:00.000Z')
    assert.equal(r.rows.length, 2); assert.equal(r.rows[0].period, '2024-01-01')
    for (const s of seen) {
        assert.match(s.query, /timestamp >= \{from\} AND timestamp < \{to\} AND event IN \{events\}/)
        assert.ok(!s.query.includes('DROP TABLE'), 'filter values are bound, never inlined')
        assert.doesNotMatch(s.query, /\buniq\(/); assert.doesNotMatch(s.query, /SELECT \*/)
    }
    assert.ok(seen.some((x) => /uniqExact\(distinct_id\)/.test(x.query)))
})
test('no person dimension, unknown names and oversized requests are refused', async () => {
    assert.ok(!('user' in DIMENSIONS) && !('distinct_id' in DIMENSIONS) && !('email' in DIMENSIONS))
    await assert.rejects(aggregateEvents({ ...q, group_by: ['distinct_id'] }), /Unknown dimension/)
    await assert.rejects(aggregateEvents({ ...q, group_by: ['dialog', 'tab', 'button'] }), /at most two/)
    await assert.rejects(aggregateEvents({ ...q, metrics: ['revenue' as never] }), /Unknown metric/)
    await assert.rejects(aggregateEvents({ ...q, limit: 500 }), /limit/)
})
test('more groups than the limit are reported, never silently dropped', async (t) => {
    t.mock.method(globalThis, 'fetch', async (_u: unknown, init: RequestInit) => JSON.parse(String(init.body)).query.query.includes('GROUP BY')
        ? response(Array.from({ length: 4 }, (_, i) => ({ dialog: 'D' + i, events: 10 - i }))) : response([{ events: 34 }]))
    const r = await aggregateEvents({ from: new Date('2026-01-01'), to: new Date('2026-03-01'), group_by: ['dialog'], limit: 3 })
    assert.equal(r.rows.length, 3); assert.equal(r.groups_omitted, 1)
})

test('weekly periods split on Mondays so no week is cut in two', async () => {
    const { splitByYear } = await import('../src/core/aggregate.ts')
    for (const c of splitByYear(new Date('2023-01-01'), new Date('2027-01-01'), true).slice(1)) assert.equal(c.from.getUTCDay(), 1)
    assert.equal(splitByYear(new Date('2026-01-01'), new Date('2026-06-01'), false).length, 1)
})

test('exhausted rollup budgets fall back to exact live counts and explain the reason',async t=>{
 const {tasksDb}=await import('../src/core/tasks.ts')
 const {storeAggregateDaily,ROLLUP_DIMENSIONS}=await import('../src/core/aggregatedaily.ts')
 const {required}=await import('../src/core/appevents.ts')
 const rows=['A','B'].map(dialog=>({...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?required().events.screen:''])),dialog,n:1,users:['u'],sessions:['s']})) as import('../src/core/aggregatedaily.ts').DailyRow[]
 storeAggregateDaily(tasksDb,'2026-06-01',rows)
 let calls=0
 t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>{calls++;return JSON.parse(String(init.body)).query.query.includes('GROUP BY') ? response([{dialog:'A',events:1},{dialog:'B',events:1}]) : response([{events:2,sessions:1}])})
 for(const budget of ['LENS_AGG_MAX_GROUPS','LENS_AGG_MAX_DISTINCT']) {
  try {
   process.env[budget]='1'
   const result=await aggregateEvents({from:new Date('2026-06-01'),to:new Date('2026-06-02'),group_by:['dialog'],metrics:['events','sessions']})
   assert.equal(result.source,'live');assert.deepEqual(result.totals,{events:2,sessions:1});assert.match(result.note,new RegExp(budget));assert.equal(result.rows.length,2)
  }finally{delete process.env[budget]}
 }
 assert.ok(calls>=4)
})
