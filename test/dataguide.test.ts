import assert from 'node:assert/strict'
import { test } from 'node:test'

Object.assign(process.env,{APP_EVENTS_FILE:'config/app-events.reval.json',POSTHOG_HOST:'http://fake-posthog',POSTHOG_PROJECT_ID:'7',POSTHOG_PERSONAL_API_KEY:'test-key'})
const {dataCoverage,dataGuide}=await import('../src/core/dataguide.ts')
const {clearPosthogCache}=await import('../src/core/posthog.ts')
const now=Date.parse('2026-11-20T16:00:00Z'), dayMs=86400000
const bounds={data_starts:'2025-11-15T08:00:05.918000Z',data_ends:'2026-11-20T14:14:18.450000Z'}
function response(rows:Record<string,unknown>[]) {
    const columns=Object.keys(rows[0] || {})
    return Response.json({columns,results:rows.map(r=>columns.map(k=>r[k]))})
}
test('coverage separates a five-day outage and sparse replay day from the historical year',async t=>{
    clearPosthogCache();t.after(clearPosthogCache);t.mock.method(Date,'now',()=>now)
    const rows:{day:string;n:number}[]=[]
    for(let ms=Date.parse('2025-11-15');ms<=Date.parse('2026-11-14');ms+=dayMs)rows.push({day:new Date(ms).toISOString().slice(0,10),n:1000})
    rows.push({day:'2026-11-20',n:3})
    let calls=0
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        const sql=JSON.parse(String(init.body)).query.query
        if(sql.endsWith('LIMIT 1'))return response([{distinct_id:'C1DEV|01|SEM|SEMOPS'}])
        calls++
        if(sql.includes('AS data_starts'))return response([bounds])
        assert.equal(sql,'SELECT toDate(timestamp) AS day, count() AS n FROM events WHERE timestamp >= now() - INTERVAL 400 DAY GROUP BY day ORDER BY day LIMIT 1000')
        return response(rows)
    })
    const coverage=await dataCoverage()
    assert.deepEqual(coverage.gaps,[{from:'2026-11-15',to:'2026-11-19',days:5}])
    assert.equal(coverage.gaps_total,1)
    assert.deepEqual(coverage.sparse_days,[{day:'2026-11-20',events:3}])
    assert.equal(coverage.latest_event,bounds.data_ends)
    assert.equal(coverage.data_ends,'2026-11-14T23:59:59.999999Z')
    assert.equal(coverage.continuous_from,bounds.data_starts)
    assert.equal(coverage.continuous_to,'2026-11-14T23:59:59.999999Z')
    assert.match(coverage.note,/No or sparse data on 2026-11-15\.\.2026-11-20 \(6 days\)/)
    assert.match(coverage.note,/use continuous_from\.\.continuous_to/)
    assert.deepEqual(await dataCoverage(),coverage);assert.equal(calls,2)
    t.mock.method(Date,'now',()=>now+600001)
    await dataCoverage();assert.equal(calls,4)
    const guide=await dataGuide()
    assert.equal(guide.coverage.data_ends,'2026-11-14T23:59:59.999999Z')
    assert.match(guide.examples[4],/toStartOfWeek\(toDateTime\('2026-11-14', 'UTC'\), 1\)/)
    assert.match(guide.examples[4],/timestamp >= end_week - INTERVAL 4 WEEK AND timestamp < end_week/)
    // Nov 14's week is incomplete: use Oct 12 through Nov 9 exclusive, excluding the Nov 20 fixture.
    const end=new Date(String(guide.coverage.data_ends))
    end.setUTCDate(end.getUTCDate()-(end.getUTCDay()+6)%7);end.setUTCHours(0,0,0,0)
    assert.equal(end.toISOString(),'2026-11-09T00:00:00.000Z')
    assert.equal(new Date(+end-4*7*dayMs).toISOString(),'2026-10-12T00:00:00.000Z')
})
test('failed daily query preserves min/max and reports unknown continuity',async t=>{
    clearPosthogCache();t.after(clearPosthogCache)
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>{
        if(JSON.parse(String(init.body)).query.query.includes('AS data_starts'))return response([bounds])
        return new Response('daily query unavailable',{status:400})
    })
    const coverage=await dataCoverage()
    assert.equal(coverage.data_starts,bounds.data_starts);assert.equal(coverage.data_ends,bounds.data_ends)
    for(const field of ['gaps','gaps_total','sparse_days','continuous_from','continuous_to'] as const)assert.equal(coverage[field],null)
    assert.match(coverage.note,/Daily coverage unavailable/)
})
test('coverage caps gap details and does not infer gaps outside the 400-day horizon',async t=>{
    clearPosthogCache();t.after(clearPosthogCache);t.mock.method(Date,'now',()=>now)
    const start=Date.parse('2026-10-21'), rows:{day:string;n:number}[]=[]
    for(let ms=start;ms<=Date.parse('2026-11-20');ms+=2*dayMs)rows.push({day:new Date(ms).toISOString().slice(0,10),n:100})
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>response(
        JSON.parse(String(init.body)).query.query.includes('AS data_starts') ? [{...bounds,data_starts:'2020-01-01T00:00:00Z'}] : rows))
    const coverage=await dataCoverage()
    assert.equal(coverage.gaps?.length,10);assert.equal(coverage.gaps_total,16)
    assert.equal(coverage.gaps?.[0].from,'2025-10-17')
    assert.deepEqual(coverage.sparse_days,[])
    // One-day gaps (every other day) do not break continuity; the empty stretch before the first row does.
    assert.equal(coverage.continuous_from,'2026-10-21T00:00:00.000Z')
    assert.equal(coverage.continuous_to,bounds.data_ends)
    assert.match(coverage.note,/shorter quiet gap\(s\), such as weekends, do not break continuity/)
})
test('sparse details are capped and a long sparse stretch breaks continuity',async t=>{
    clearPosthogCache();t.after(clearPosthogCache);t.mock.method(Date,'now',()=>now)
    const rows=Array.from({length:30},(_,i)=>({day:new Date(Date.parse('2026-10-22')+i*dayMs).toISOString().slice(0,10),n:i>=10 && i<21 ? 1 : 100}))
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>response(
        JSON.parse(String(init.body)).query.query.includes('AS data_starts') ? [{...bounds,data_starts:'2026-10-22T08:00:00Z'}] : rows))
    const coverage=await dataCoverage()
    assert.deepEqual(coverage.gaps,[]);assert.equal(coverage.gaps_total,0)
    assert.equal(coverage.sparse_days?.length,10)
    assert.equal(coverage.continuous_from,'2026-10-22T08:00:00Z')
    assert.equal(coverage.continuous_to,'2026-10-31T23:59:59.999999Z')
})

test('weekend gaps and quiet weekend days do not break a year of coverage',async t=>{
    clearPosthogCache();t.after(clearPosthogCache);t.mock.method(Date,'now',()=>now)
    const rows:{day:string;n:number}[]=[]
    for(let ms=Date.parse('2025-11-15');ms<=Date.parse('2026-11-20');ms+=dayMs){const wd=new Date(ms).getUTCDay();if(wd===0)continue;rows.push({day:new Date(ms).toISOString().slice(0,10),n:wd===6 ? 2 : 1000})}
    t.mock.method(globalThis,'fetch',async(_url:unknown,init:RequestInit)=>response(
        JSON.parse(String(init.body)).query.query.includes('AS data_starts') ? [{...bounds,data_starts:'2025-11-17T08:00:00Z',data_ends:'2026-11-20T14:00:00Z'}] : rows))
    const coverage=await dataCoverage()
    assert.equal(coverage.continuous_from,'2025-11-17T08:00:00Z')
    assert.equal(coverage.continuous_to,'2026-11-20T14:00:00Z')
    assert.doesNotMatch(coverage.note,/No or sparse data on/)
})
