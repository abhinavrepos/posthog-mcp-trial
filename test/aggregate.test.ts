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
        return body.query.includes('GROUP BY') ? response([{ period: body.values.from, app_version: '26.3', events: 10, users: 2 }])
            : body.query.startsWith('SELECT count() AS events') ? response([{ events: new Date(body.values.from).getUTCFullYear() - 2018 }])
            : response([{ users: 3 }])
    })
    const r = await aggregateEvents({ ...q, metrics: ['events', 'users'], group_by: ['app_version'], bucket: 'month', filters: [{ dimension: 'dialog', op: 'eq', value: "DlgX'); DROP TABLE events; --" }] })
    assert.equal(r.queries, 48)
    assert.equal(seen.find((s) => s.query.includes('GROUP BY'))!.values.f0, "DlgX'); DROP TABLE events; --")
    // Without groups: events counted one year at a time (5+6+7+8 from the fake); distinct users once over all four.
    seen.length = 0
    const t2 = await aggregateEvents({ ...q, metrics: ['events', 'users'] })
    assert.deepEqual(t2.totals, { events: 26, users: 3 })
    const yearly = seen.filter((x) => x.query.startsWith('SELECT count() AS events')).map((x) => [x.values.from, x.values.to])
    assert.deepEqual(yearly, [['2023-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'], ['2024-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'], ['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'], ['2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']])
    const whole = seen.filter((x) => /uniqExact\(distinct_id\) AS users \$\{?|uniqExact\(distinct_id\) AS users FROM/.test(x.query) && !x.query.includes('GROUP BY'))
    assert.equal(whole.length, 1); assert.equal(whole[0].values.from, '2023-01-01T00:00:00.000Z'); assert.equal(whole[0].values.to, '2027-01-01T00:00:00.000Z')
    assert.equal(r.rows.length, 48); assert.equal(r.rows[0].period, '2023-01-01')
    assert.equal((r.totals as Record<string, unknown>).users, null); assert.match((r.limits as {distinct:string}).distinct, /must not be summed/)
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
        ? response(Array.from({ length: 4 }, (_, i) => ({ dialog: 'D' + i, events: 10 - i }))) : response([{ events: 7 }]))
    const r = await aggregateEvents({ from: new Date('2026-01-01'), to: new Date('2026-03-01'), group_by: ['dialog'], limit: 3 })
    assert.equal(r.rows.length, 4); assert.equal(r.groups_omitted, 1)
    assert.ok(r.rows.some(r=>r.is_other)); assert.match(r.limits!.truncated!, /To get the rest/)
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

test('bucket chunks keep exact distincts across year boundaries and do not add window totals', async t => {
    const { splitBuckets } = await import('../src/core/aggregate.ts')
    const from = new Date('2023-12-28'), to = new Date('2025-01-08')
    const chunks = splitBuckets(from, to, 'week')
    assert.equal(+chunks[0].from, +from); assert.equal(+chunks.at(-1)!.to, +to)
    for (let i=1;i<chunks.length;i++) {
        assert.equal(+chunks[i-1].to,+chunks[i].from)
        assert.equal(chunks[i].from.getUTCDay(),1)
    }
    const seen: string[] = []
    t.mock.method(globalThis,'fetch',async (_u:unknown,init:RequestInit)=>{
        const body=JSON.parse(String(init.body)).query
        seen.push(body.values.from)
        const d=new Date(body.values.from);d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7)
        return response([{period:d.toISOString(),events:8,sessions:1,clients:1}])
    })
    const r=await aggregateEvents({from,to,bucket:'week',metrics:['events','sessions','clients']})
    assert.equal(r.rows.length,chunks.length)
    assert.equal(new Set(r.rows.map(r=>r.period)).size,chunks.length)
    assert.equal((r.totals as Record<string, unknown>).events,8*chunks.length)
    assert.equal((r.totals as Record<string, unknown>).sessions,null);assert.equal((r.totals as Record<string, unknown>).clients,null)
    assert.ok(r.rows.every(r=>r.sessions===1))
    assert.equal(seen.length,chunks.length)
    assert.match((r.limits as {distinct:string}).distinct,/Exact sessions, clients/)
})

test('live truncation recounts other distincts exactly and bounds retained groups', async t=>{
    const queries: string[]=[]
    t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>{
        const body=JSON.parse(String(init.body)).query;queries.push(body.query)
        if(body.query.includes('AND NOT')) return response([{period:'2025-04-01',events:12,sessions:1,clients:2}])
        return response(Array.from({length:3},(_,i)=>({period:'2025-04-01',client:'C'+i,app_version:'v',events:10-i,sessions:1,clients:1})))
    })
    try {
        process.env.LENS_AGG_MAX_GROUPS='2'
        const r=await aggregateEvents({from:new Date('2025-04-01'),to:new Date('2025-05-01'),bucket:'month',group_by:['client','app_version'],metrics:['events','sessions','clients']})
        assert.equal(r.rows.length,3)
        const other=r.rows.find(r=>r.is_other)!
        assert.equal(other.events,12);assert.equal(other.sessions,1);assert.equal(other.clients,2)
        assert.equal((r.totals as Record<string, unknown>).events,31)
        assert.match(r.limits!.truncated!,/Top 2 groups per bucket plus other/)
        assert.match(r.limits!.truncated!,/filters on client or app_version/)
        assert.match(queries[0],/LIMIT 3$/)
        assert.match(queries[1],/uniqExact.*AND NOT/)
    }finally{delete process.env.LENS_AGG_MAX_GROUPS}
})

test('invalid dates and reversed windows fail as input errors before querying',async()=>{
    await assert.rejects(aggregateEvents({from:new Date('bad'),to:new Date()}),/valid dates/)
    await assert.rejects(aggregateEvents({from:new Date('2026-01-02'),to:new Date('2026-01-01')}),/from must be before/)
})

test('whole-window rollup budget exhaustion releases sets and merges exact bucket rollups', async()=>{
    const {tasksDb}=await import('../src/core/tasks.ts')
    const {storeAggregateDaily,ROLLUP_DIMENSIONS}=await import('../src/core/aggregatedaily.ts')
    const {required}=await import('../src/core/appevents.ts')
    const row={...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?required().events.screen:''])),n:4,users:['u'],sessions:['same-session']} as import('../src/core/aggregatedaily.ts').DailyRow
    storeAggregateDaily(tasksDb,'2024-12-31',[row]);storeAggregateDaily(tasksDb,'2025-01-01',[row])
    try {
        process.env.LENS_AGG_MAX_DISTINCT='2'
        const r=await aggregateEvents({from:new Date('2024-12-31'),to:new Date('2025-01-02'),bucket:'month',metrics:['events','sessions']})
        assert.equal(r.source,'history');assert.equal(r.queries,0)
        assert.equal(r.rows.length,2);assert.ok(r.rows.every(r=>r.sessions===1))
        assert.deepEqual(r.totals,{events:8,sessions:null})
        assert.match(r.note,/LENS_AGG_MAX_DISTINCT/)
        assert.match((r.limits as {distinct:string}).distinct,/must not be summed/)
    }finally{delete process.env.LENS_AGG_MAX_DISTINCT}
})

test('sane monthly breakdowns remain complete instead of always truncating at twenty',async t=>{
    t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>{
        const body=JSON.parse(String(init.body)).query
        assert.match(body.query,/LIMIT 201$/)
        return response(Array.from({length:100},(_,i)=>({period:'2025-07-01',client:'C'+i,events:1,sessions:1,clients:1})))
    })
    const r=await aggregateEvents({from:new Date('2025-07-01'),to:new Date('2025-08-01'),bucket:'month',group_by:['client'],metrics:['events','sessions','clients']})
    assert.equal(r.rows.length,100);assert.equal(r.groups_omitted,0)
    assert.equal(r.limits!.truncated,undefined)
    assert.equal((r.totals as Record<string,unknown>).events,100)
})

test('"all time" style windows are shortened to the last four years with a note, not refused',async(t)=>{
    const seen:string[]=[]
    t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>{const b=JSON.parse(String(init.body));seen.push(b.query.values.from);return response([{events:5}])})
    const r=await aggregateEvents({from:new Date('2010-01-01'),to:new Date('2026-01-01'),metrics:['events']}) as {window:{from:string},note:string}
    assert.equal(r.window.from.slice(0,10),new Date(+new Date('2026-01-01')-1461*86400000).toISOString().slice(0,10))
    assert.match(r.note,/shortened to the last four years/)
    assert.ok(seen.every(f=>f>='2022'),'no query reaches back to 2010')
})

test('a whole-window distinct count that exceeds memory falls back to approximate uniq and says so; events stay exact',async(t)=>{
    const queries:string[]=[]
    t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>{
        const sql=JSON.parse(String(init.body)).query.query as string; queries.push(sql)
        if(sql.includes('uniqExact(')) return new Response(JSON.stringify({detail:'Code: 241. DB::Exception: Query memory limit exceeded'}),{status:500})
        return sql.includes('GROUP BY') ? response([{dialog:'A',events:10,sessions:4},{dialog:'B',events:6,sessions:3}]) : response([{sessions:6,events:16}])
    })
    const r=await aggregateEvents({from:new Date('2023-01-01'),to:new Date('2026-11-01'),group_by:['dialog'],metrics:['events','sessions']}) as {rows:Record<string,unknown>[],totals:Record<string,number|null>,limits:{approximate?:string},note:string}
    assert.equal(r.rows.length,2)
    assert.equal(r.totals.events,16)
    assert.equal(r.totals.sessions,6)
    assert.match(r.limits.approximate!,/sessions are approximate .*bucket: 'month'/)
    assert.match(r.note,/distinct counts are approximate/)
    assert.ok(queries.some(q=>q.includes('uniq(') && !q.includes('uniqExact(')),'retried with uniq')
})
