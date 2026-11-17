import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { JobRunner, waitForJob } from '../src/core/jobs.ts'
process.env.LENS_JOBS_PER_USER='4' // cap mechanics are tested at 4; the default (8) is checked below
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
const pending=()=>{let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r});return {promise,resolve}}

test('jobs race, complete, compress exact results, share flights, and bind owner and revision',async()=>{
 const db=new DatabaseSync(':memory:'),runner=new JobRunner(db),p=pending();let calls=0
 try {
  const a=runner.start('alice','aggregate',{b:2,a:1},'r',()=>{calls++;return p})
  const b=runner.start('alice','aggregate',{a:1,b:2},'r',()=>{throw Error('duplicate')})
  assert.equal(a.id,b.id);assert.match(a.id,/^[0-9a-f]{32}$/)
  await new Promise<void>(resolve=>setImmediate(resolve))
  const r=await waitForJob(a,undefined,10) as {content:{text:string}[]};assert.equal(JSON.parse(r.content[0].text).job_id,a.id);assert.equal(calls,1)
  assert.throws(()=>runner.get('bob',a.id,'r'),/Unknown or expired/)
  assert.throws(()=>runner.get('alice',a.id,'new'),/settings changed/)
  const result={content:[{type:'text',text:'exact result '.repeat(1000)}]};p.resolve(result)
  assert.deepEqual(await a.done,result);assert.deepEqual(await b.done,result)
  const row=runner.get('alice',a.id,'r');assert.equal(row.status,'completed');assert.ok(row.result!.length<1000);assert.deepEqual(runner.result(row),result)
 // Equal callback arguments must not merge distinct resolved sub-day windows.
 const first=runner.start('alice','window',{},'r',()=>({promise:Promise.resolve({})}),runner.ttlMs,{from:new Date('2026-01-01T01:00:00Z')})
 const second=runner.start('alice','window',{},'r',()=>({promise:Promise.resolve({})}),runner.ttlMs,{from:new Date('2026-01-01T02:00:00Z')})
 assert.notEqual(first.id,second.id);await Promise.all([first.done,second.done])
 }finally{runner.close();db.close()}
})
// Background work starts on a later tick: wait for the condition (bounded), not a fixed few milliseconds.
const until=async(ok:()=>boolean,ms=2000)=>{const end=Date.now()+ms;while(!ok()&&Date.now()<end)await delay(5)}
test('global concurrency, cancellation, failure, expiry and restart',async()=>{
 let now=100000;const db=new DatabaseSync(':memory:'),runner=new JobRunner(db,{concurrency:1,ttlMs:100,now:()=>now});let starts=0,cancelled=0
 const work=()=>{starts++;return {promise:new Promise(()=>{}),cancel:()=>{cancelled++}}}
 const a=runner.start('alice','a',{},'r',work),b=runner.start('alice','b',{},'r',work),c=runner.start('bob','c',{},'r',work)
 await until(()=>starts>=1);await delay(20);assert.equal(starts,1)
 assert.equal(runner.cancel('alice',a.id,'r').status,'cancelled');await until(()=>starts>=2);assert.equal(starts,2);assert.equal(cancelled,1)
 now=100101;runner.prune();assert.throws(()=>runner.get('alice',b.id,'r'),/expired/);assert.throws(()=>runner.get('bob',c.id,'r'),/expired/)
 const fail=runner.start('alice','fail',{},'r',()=>({promise:Promise.reject(new Error('clear failure'))}));await fail.done
 assert.equal(runner.get('alice',fail.id,'r').error,'clear failure')
 // Simulate persisted state left by a process dying, without graceful close.
 db.prepare("INSERT INTO analysis_jobs (id,owner,revision,flight,status,created,updated,expires,result,error) VALUES ('dead','alice','r','old','working',?,?,?,NULL,NULL)").run(now,now,now+100)
 runner.close();const restarted=new JobRunner(db,{now:()=>now});assert.equal(restarted.get('alice','dead','r').status,'failed');assert.match(restarted.get('alice','dead','r').error!,/restarted/);restarted.close();db.close()
})
test('progress tokens send periodic notifications only while the call is waiting',async()=>{
 const p=pending(),seen:unknown[]=[]
 const answer=waitForJob({id:'a',done:p.promise},{_meta:{progressToken:0},sendNotification:async n=>{seen.push(n)}},40,10)
 await delay(25);p.resolve({content:[]});await answer
 assert.ok(seen.length>=1);assert.deepEqual((seen[0] as {params:{progressToken:unknown}}).params.progressToken,0)
 const count=seen.length;await delay(25);assert.equal(seen.length,count)
})

test('two runners preserve live ownership, renew leases and only recover abandoned jobs',async()=>{
 let now=100000
 const db=new DatabaseSync(':memory:'),a=new JobRunner(db,{now:()=>now}),p=pending()
 const job=a.start('alice','slow',{},'r',()=>p)
 await new Promise<void>(r=>setImmediate(r))
 const b=new JobRunner(db,{now:()=>now})
 try {
  assert.notEqual(a.instanceId,b.instanceId)
  assert.equal(a.get('alice',job.id,'r').status,'working')
  const lease=Number(db.prepare('SELECT lease_expires FROM analysis_jobs WHERE id=?').get(job.id)!.lease_expires)
  now+=15000;a.renewLease()
  assert.ok(Number(db.prepare('SELECT lease_expires FROM analysis_jobs WHERE id=?').get(job.id)!.lease_expires)>lease)
  const joined=b.start('alice','slow',{},'r',()=>{throw Error('duplicate')})
  assert.equal(joined.id,job.id)
  p.resolve({answer:42});await job.done
  assert.equal(a.get('alice',job.id,'r').status,'completed');assert.deepEqual(await joined.done,{answer:42})
  db.prepare("INSERT INTO analysis_jobs (id,owner,revision,flight,status,created,updated,expires,owner_instance,lease_expires) VALUES ('abandoned','alice','r','old','working',?,?,?,'gone',?)").run(now,now,now+1000000,now-60001)
  const c=new JobRunner(db,{now:()=>now});assert.equal(c.get('alice','abandoned','r').status,'failed');c.close()
 } finally {a.close();b.close();db.close()}
})
test('the per-user cap reaches the agent as an actionable busy message with its own job ids', async () => {
    // Found by the agent evaluation: the cap surfaced as "The tool could not complete" and the agent retried blindly.
    const { JobCapError } = await import('../src/core/jobs.ts'), { toolError } = await import('../src/mcp/toolerror.ts')
    const mapped = toolError(new JobCapError(['aaa111', 'bbb222']), 'workflow_completion', 'cid')
    assert.equal(mapped.kind, 'busy')
    assert.match(mapped.result.content[0].text, /aaa111, bbb222/); assert.match(mapped.result.content[0].text, /get_job_result/)
})

test('fast calls beyond two bypass detached admission; four handles count and overflow names only own ids', async () => {
 const db=new DatabaseSync(':memory:'), runner=new JobRunner(db,{concurrency:8})
 try {
  const fast=Array.from({length:8},(_,i)=>runner.start('alice','fast',{i},'r',()=>({promise:Promise.resolve(i)})))
  assert.deepEqual(await Promise.all(fast.map(j=>j.done)),[0,1,2,3,4,5,6,7])
  const slow=Array.from({length:5},(_,i)=>runner.start('alice','slow',{i},'r',()=>pending()))
  const other=runner.start('bob','slow',{},'r',()=>pending());runner.detach('bob',other.id,'r')
  for(const j of slow.slice(0,4))runner.detach('alice',j.id,'r')
  assert.throws(()=>runner.detach('alice',slow[4].id,'r'),(e:unknown)=>{
   assert.ok(e instanceof Error);assert.match(e.message,/4 analyses/)
   for(const j of slow.slice(0,4))assert.ok(e.message.includes(j.id))
   assert.ok(!e.message.includes(other.id));return true
  })
  assert.equal(runner.get('alice',slow[4].id,'r').status,'cancelled')
  // Even with four detached handles, a fast result is admitted.
  const quick=runner.start('alice','quick',{},'r',()=>({promise:Promise.resolve(42)}))
  assert.equal(await quick.done,42);runner.detach('alice',quick.id,'r')
 } finally {runner.close();db.close()}
})
test('bounded global queue rejects overflow as busy, with single-flight still admitted', async () => {
 const {JobQueueError}=await import('../src/core/jobs.ts'),{toolError}=await import('../src/mcp/toolerror.ts')
 const db=new DatabaseSync(':memory:'),runner=new JobRunner(db,{concurrency:1,queueLimit:1})
 try {
  const a=runner.start('a','slow',{},'r',()=>pending())
  runner.start('b','slow',{},'r',()=>pending())
  assert.equal(runner.start('a','slow',{},'r',()=>pending()).id,a.id)
  assert.throws(()=>runner.start('c','slow',{},'r',()=>pending()),JobQueueError)
  assert.equal(toolError(new JobQueueError(),'aggregate_events','cid').kind,'busy')
 } finally {runner.close();db.close()}
})
test('long polling finishes early, waits for running work, and wakes for cancellation or expiry', async () => {
 const db=new DatabaseSync(':memory:'),runner=new JobRunner(db,{ttlMs:10000})
 try {
  const p=pending(),a=runner.start('alice','a',{},'r',()=>p)
  let start=Date.now();const early=runner.poll('alice',a.id,'r',500)
  setTimeout(()=>p.resolve(42),30);await early
  assert.ok(Date.now()-start<400);assert.equal(runner.get('alice',a.id,'r').status,'completed')
  const b=runner.start('alice','b',{},'r',()=>pending())
  start=Date.now();await runner.poll('alice',b.id,'r',50)
  assert.ok(Date.now()-start>=40);assert.equal(runner.get('alice',b.id,'r').status,'working')
  const cancelled=runner.poll('alice',b.id,'r',500);setTimeout(()=>runner.cancel('alice',b.id,'r'),20)
  await cancelled;assert.equal(runner.get('alice',b.id,'r').status,'cancelled')
  const exp=runner.start('alice','exp',{},'r',()=>pending(),30)
  await assert.rejects(runner.poll('alice',exp.id,'r',500),/expired/)
 } finally {runner.close();db.close()}
})
test('dispatch waits its budget before detached-cap refusal and still admits parallel fast calls', async () => {
 const {createJobDispatch}=await import('../src/mcp/jobtools.ts')
 const db=new DatabaseSync(':memory:'),runner=new JobRunner(db,{concurrency:8})
 let slow=false
 const dispatch=createJobDispatch({who:'dispatch-cap'},{runner,budgetMs:30,work:()=>slow ? pending() : {promise:Promise.resolve({content:[]})}})
 try {
  assert.equal((await Promise.all([0,1,2,3].map(i=>dispatch.execute('example',{i},undefined,{},async()=>({}))))).length,4)
  slow=true
  for(let i=0;i<4;i++)await dispatch.execute('example',{i},undefined,{},async()=>({}))
  const start=Date.now()
  await assert.rejects(dispatch.execute('example',{i:5},undefined,{},async()=>({})),/4 analyses.*get_job_result/)
  assert.ok(Date.now()-start>=25)
 } finally {runner.close();db.close()}
})

test('per-person detached analyses default to 8',()=>{
    const saved=process.env.LENS_JOBS_PER_USER; delete process.env.LENS_JOBS_PER_USER
    try { const db=new DatabaseSync(':memory:'), r=new JobRunner(db); assert.equal((r as unknown as {perUser:number}).perUser,8); r.close(); db.close() }
    finally { process.env.LENS_JOBS_PER_USER=saved }
})

test('quick restart eventually fails abandoned leases and identical resubmits run', async () => {
 let now=100000
 const db=new DatabaseSync(':memory:'),a=new JobRunner(db,{now:()=>now}),p=pending()
 const original=a.start('alice','slow',{},'r',()=>p)
 await new Promise<void>(r=>setImmediate(r))
 // Transfer the lease to a dead instance without graceful shutdown.
 db.prepare("UPDATE analysis_jobs SET owner_instance='dead' WHERE id=?").run(original.id)
 const b=new JobRunner(db,{now:()=>now})
 try {
  assert.equal(b.get('alice',original.id,'r').status,'working')
  const joined=b.start('alice','slow',{},'r',()=>pending())
  assert.equal(joined.id,original.id)
  now+=90001;b.prune()
  assert.equal(b.get('alice',original.id,'r').status,'failed')
  await joined.done
  const next=b.start('alice','slow',{},'r',()=>({promise:Promise.resolve(42)}))
  assert.notEqual(next.id,original.id);assert.equal(await next.done,42)
 } finally {a.close();b.close();db.close()}
})
