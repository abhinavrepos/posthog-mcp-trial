import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after,test } from 'node:test'
const dir=mkdtempSync(join(tmpdir(),'lens-dimensions-'))
Object.assign(process.env,{TRIAGE_DB:join(dir,'m.db'),TASKS_DB:join(dir,'t.db'),APP_EVENTS_FILE:'config/app-events.reval.json'})
const {tasksDb}=await import('../src/core/tasks.ts')
const {dailyAggregate,storeAggregateDaily,ROLLUP_DIMENSIONS,ingestAggregateDaily}=await import('../src/core/aggregatedaily.ts')
const {aggregateEvents}=await import('../src/core/aggregate.ts')
const {required}=await import('../src/core/appevents.ts')
import type { DailyRow } from '../src/core/aggregatedaily.ts'
const reg=required(),DAY=86400000
const days=['2026-01-30','2026-01-31','2026-02-01','2026-02-02','2026-03-01']
const raw:{day:string;dims:Record<string,string>;user:string;sid:string}[]=[]
for(const [d,day] of days.entries()) {
 const rows:DailyRow[]=[]
 for(let i=0;i<250;i++) {
  const dims={event:i%2?reg.events.screen:reg.events.interaction,client:'C'+i%3,app_version:'v'+i%2,dialog:'D'+i%4,dialog_name:'Title'+i%4,tab:'tab'+i%2,action:i%2?'OPEN':'CHANGE',button:'button'+i%5}
  const user='u'+i%7,sid=i%11===0?'cross-midnight':'session-'+d+'-'+i%13
  raw.push({day,dims,user,sid});rows.push({...dims,n:1,users:[user],sessions:[sid]})
 }
 assert.equal(storeAggregateDaily(tasksDb,day,rows),true)
}
// Empty processed days are coverage too, spanning multiple months without inventing activity.
for(let t=Date.parse(days[0]);t<=Date.parse(days.at(-1)!);t+=DAY){const day=new Date(t).toISOString().slice(0,10);if(!days.includes(day))storeAggregateDaily(tasksDb,day,[])}
after(()=>{tasksDb.close();rmSync(dir,{recursive:true,force:true})})
const metrics=['events','sessions','users','clients'] as const
function count(rows:typeof raw){return {events:rows.length,sessions:new Set(rows.map(r=>r.sid)).size,users:new Set(rows.map(r=>r.user)).size,clients:new Set(rows.map(r=>r.dims.client)).size}}
test('every dimension and metric equals full raw event computation across days and months',async()=>{
 for(const [from,to] of [['2026-01-30','2026-02-03'],['2026-01-30','2026-03-02'],['2026-02-01','2026-03-02']])for(const dim of ROLLUP_DIMENSIONS)for(const bucket of ['none','day','week','month','quarter','year'] as const) {
  const q={from:new Date(from),to:new Date(to),group_by:[dim],metrics:[...metrics],bucket,limit:200}
  const result=await aggregateEvents(q);assert.equal(result.source,'history');const observed=raw.filter(r=>r.day>=from&&r.day<to)
  assert.deepEqual(result.totals,count(observed))
  const groups=new Map<string,typeof raw>()
  const period=(day:string)=>{const d=new Date(day);return bucket==='week'?new Date(+d-((d.getUTCDay()+6)%7)*DAY).toISOString().slice(0,10):bucket==='month'?day.slice(0,7)+'-01':bucket==='quarter'||bucket==='year'?'2026-01-01':day}
  for(const r of observed){const key=JSON.stringify([bucket==='none'?'':period(r.day),r.dims[dim]]);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(r)}
  assert.equal(result.rows.length,groups.size)
  for(const r of result.rows){const rows=groups.get(JSON.stringify([r.period||'',r[dim]]))!;for(const metric of metrics)assert.equal(r[metric],count(rows)[metric],`${dim}/${bucket}/${metric}`)}
 }
})
test('two dimensions, all filter operators, events override, cross-day sessions and exact totals independent of row limit',()=>{
 for(const op of ['eq','neq','in'] as const) {
  const q={from:new Date('2026-01-30'),to:new Date('2026-03-02'),metrics:[...metrics],group_by:['dialog','button'],events:[reg.events.interaction],filters:[{dimension:'client',op,value:op==='in'?['C0','C1']:'C0'}],limit:1}
  const result=dailyAggregate(tasksDb,q)!
  const selected=raw.filter(r=>r.dims.event===reg.events.interaction&&(op==='neq'?r.dims.client!=='C0':op==='eq'?r.dims.client==='C0':['C0','C1'].includes(r.dims.client)))
  assert.deepEqual(result.totals,count(selected));assert.equal(result.rows.length,2);assert.ok(result.groups_omitted>0);assert.ok(result.rows.some(r=>r.is_other));assert.match(result.limits.truncated!, /To get the rest/)
  const shown=result.rows.find(r=>!r.is_other)!,other=result.rows.find(r=>r.is_other)!
  const complement=selected.filter(r=>r.dims.dialog!==shown.dialog || r.dims.button!==shown.button)
  for(const metric of metrics)assert.equal(other[metric],count(complement)[metric])
 }
 assert.equal(dailyAggregate(tasksDb,{from:new Date('2026-01-29'),to:new Date('2026-02-02')}),undefined)
 assert.equal(dailyAggregate(tasksDb,{from:new Date('2026-01-30T12:00Z'),to:new Date('2026-02-02')}),undefined)
})
test('ingestion counts all event-day rows including empty session identities and uses bound days',async()=>{
 let seen=''
 await ingestAggregateDaily(tasksDb,'2026-04-01',async(sql,values)=>{seen=sql;assert.equal(values.from,'2026-04-01');assert.equal(values.to,'2026-04-02');return [{...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?reg.events.screen:''])),n:3,users:[''],sessions:['']}]})
 const result=dailyAggregate(tasksDb,{from:new Date('2026-04-01'),to:new Date('2026-04-02'),metrics:[...metrics]})!
 assert.deepEqual(result.totals,{events:3,sessions:1,users:1,clients:1});assert.match(seen,/groupUniqArray/);assert.doesNotMatch(seen,/session.*!= ''/)
})

test('incremental backfill leaves expired and failed source days unavailable',async()=>{
 const {storeAttempts}=await import('../src/core/tasks.ts')
 const {backfillPerformanceHistory}=await import('../src/core/performancehistory.ts')
 for(const [day,reason] of [['2026-04-02','analysis_unavailable:'],['2026-04-03','query_failed:']]) {
  storeAttempts(day,[],{finalized:true,analysisSessions:[]})
  tasksDb.prepare('INSERT OR REPLACE INTO task_state VALUES (?,?)').run(reason+day,'source unavailable')
 }
 let queries=0
 await backfillPerformanceHistory(2,async()=>{queries++;return []})
 assert.equal(queries,0)
 assert.equal(dailyAggregate(tasksDb,{from:new Date('2026-04-02'),to:new Date('2026-04-04')}),undefined)
})

test('rollup budgets abort while accumulating groups and distinct memberships, never return partial counts',()=>{
 const q={from:new Date('2026-01-30'),to:new Date('2026-02-03'),group_by:['dialog'],metrics:['users','sessions'],limit:1}
 try {
  process.env.LENS_AGG_MAX_GROUPS='1'
  assert.throws(()=>dailyAggregate(tasksDb,q),/LENS_AGG_MAX_GROUPS/)
  delete process.env.LENS_AGG_MAX_GROUPS
  process.env.LENS_AGG_MAX_DISTINCT='2'
  assert.throws(()=>dailyAggregate(tasksDb,q),/LENS_AGG_MAX_DISTINCT/)
  delete process.env.LENS_AGG_MAX_DISTINCT
  process.env.LENS_AGG_MAX_DAILY_DECOMPRESSED_BYTES='100'
  assert.throws(()=>dailyAggregate(tasksDb,q),/decompressed-size guard/)
 }finally {for(const key of ['LENS_AGG_MAX_GROUPS','LENS_AGG_MAX_DISTINCT','LENS_AGG_MAX_DAILY_DECOMPRESSED_BYTES'])delete process.env[key]}
 assert.ok(dailyAggregate(tasksDb,q))
})

test('finalized backfills reject empty and reduced source totals and disclose source_expired',async()=>{
 const {storeAttempts}=await import('../src/core/tasks.ts')
 for(const [day,rows] of [
  ['2026-05-01',[]],
  ['2026-05-02',[{...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?reg.events.screen:''])),n:10,users:['u'],sessions:['s1']}]],
  ['2026-05-03',[{...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?reg.events.screen:''])),n:1,users:['u'],sessions:['s1','s2']}]],
 ] as const) {
  storeAttempts(day,[],{finalized:true,analysisSessions:[]})
  tasksDb.prepare('UPDATE task_ingest SET sessions=2,events=10 WHERE day=?').run(day)
  assert.equal(await ingestAggregateDaily(tasksDb,day,async sql=>sql.includes('uniqExact') ? [{sessions: rows.length ? rows[0].sessions.length : 0, events: rows.reduce((n,r)=>n+r.n,0)}] : structuredClone(rows) as unknown as Record<string,unknown>[]),false)
  assert.equal(tasksDb.prepare('SELECT reason FROM aggregate_dimension_skipped WHERE day=?').get(day)?.reason,'source_expired')
  const result=await aggregateEvents({from:new Date(day),to:new Date(Date.parse(day)+DAY)})
  assert.equal(result.coverage.status,'unavailable');assert.match(JSON.stringify(result),/source_expired/)
  assert.deepEqual(result.totals,{})
  const {analyticalResult}=await import('../src/mcp/historyresult.ts')
  const {jsonResult}=await import('../src/mcp/result.ts')
  const disclosed=analyticalResult('aggregate_events',{},jsonResult('Counts',result)) as {_lensJson:{value:{coverage:{status:string;reason:string}}}}
  assert.equal(disclosed._lensJson.value.coverage.status,'unavailable');assert.equal(disclosed._lensJson.value.coverage.reason,'source_expired')
 }
})

test('cross-midnight session-owned totals do not expire a valid event-day rollup', async () => {
 const day='2026-06-01'
 tasksDb.prepare('INSERT OR REPLACE INTO task_ingest VALUES (?,1,10,0,0,0,?,1)').run(day,'2026-06-04')
 const rows=[{...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?reg.events.screen:''])),n:1,users:['u'],sessions:['s']}]
 assert.equal(await ingestAggregateDaily(tasksDb,day,async sql=>sql.includes('uniqExact') ? [{sessions:1,events:10}] : rows),true)
 assert.equal(dailyAggregate(tasksDb,{from:new Date(day),to:new Date('2026-06-02')})!.totals.events,1)
})

test('coverage and rows share a read snapshot during concurrent replacement and roll back errors', async t => {
 const {DatabaseSync}=await import('node:sqlite')
 const {initAggregateDaily,dailyVocabulary}=await import('../src/core/aggregatedaily.ts')
 const file=join(dir,'snapshot.db'),reader=new DatabaseSync(file),writer=new DatabaseSync(file)
 reader.exec('PRAGMA journal_mode=WAL');initAggregateDaily(reader)
 const day='2026-07-01',q={from:new Date(day),to:new Date('2026-07-02')}
 const rows=[{...Object.fromEntries(ROLLUP_DIMENSIONS.map(d=>[d,d==='event'?reg.events.screen:''])),n:3,users:['u'],sessions:['s']}] as DailyRow[]
 const prepare=reader.prepare.bind(reader)
 let replace=false
 t.mock.method(reader,'prepare',(sql:string)=>{
  const statement=prepare(sql)
  if (!sql.startsWith('SELECT count(*) n FROM aggregate_dimension_daily')) return statement
  const get=statement.get.bind(statement)
  t.mock.method(statement,'get',(...args:Parameters<typeof get>)=>{
   const result=get(...args)
   if (replace) {replace=false;writer.prepare('DELETE FROM aggregate_dimension_daily WHERE day=?').run(day)}
   return result
  })
  return statement
 })
 try {
  storeAggregateDaily(writer,day,rows);replace=true
  assert.equal(dailyAggregate(reader,q)!.totals.events,3)
  assert.equal(dailyAggregate(reader,q),undefined)
  storeAggregateDaily(writer,day,rows);replace=true
  assert.equal(dailyVocabulary(reader,q.from,q.to)!.total,3)
  storeAggregateDaily(writer,day,rows)
  writer.prepare('UPDATE aggregate_dimension_daily SET value=?').run(Buffer.from('invalid'))
  assert.throws(()=>dailyAggregate(reader,q),/could not be decoded/)
  reader.exec('BEGIN; ROLLBACK')
 } finally {reader.close();writer.close()}
})
