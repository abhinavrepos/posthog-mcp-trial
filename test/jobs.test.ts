import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { JobRunner, waitForJob } from '../src/core/jobs.ts'
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
test('global concurrency, two per user, cancellation, failure, expiry and restart',async()=>{
 let now=1000;const db=new DatabaseSync(':memory:'),runner=new JobRunner(db,{concurrency:1,ttlMs:100,now:()=>now});let starts=0,cancelled=0
 const work=()=>{starts++;return {promise:new Promise(()=>{}),cancel:()=>{cancelled++}}}
 const a=runner.start('alice','a',{},'r',work),b=runner.start('alice','b',{},'r',work),c=runner.start('bob','c',{},'r',work)
 assert.throws(()=>runner.start('alice','d',{},'r',work),/Two analysis/)
 await until(()=>starts>=1);await delay(20);assert.equal(starts,1)
 assert.equal(runner.cancel('alice',a.id,'r').status,'cancelled');await until(()=>starts>=2);assert.equal(starts,2);assert.equal(cancelled,1)
 now=1101;runner.prune();assert.throws(()=>runner.get('alice',b.id,'r'),/expired/);assert.throws(()=>runner.get('bob',c.id,'r'),/expired/)
 const fail=runner.start('alice','fail',{},'r',()=>({promise:Promise.reject(new Error('clear failure'))}));await fail.done
 assert.equal(runner.get('alice',fail.id,'r').error,'clear failure')
 // Simulate persisted state left by a process dying, without graceful close.
 db.prepare("INSERT INTO analysis_jobs VALUES ('dead','alice','r','old','working',?,?,?,NULL,NULL)").run(now,now,now+100)
 runner.close();const restarted=new JobRunner(db,{now:()=>now});assert.equal(restarted.get('alice','dead','r').status,'failed');assert.match(restarted.get('alice','dead','r').error!,/restarted/);restarted.close();db.close()
})
test('progress tokens send periodic notifications only while the call is waiting',async()=>{
 const p=pending(),seen:unknown[]=[]
 const answer=waitForJob({id:'a',done:p.promise},{_meta:{progressToken:0},sendNotification:async n=>{seen.push(n)}},40,10)
 await delay(25);p.resolve({content:[]});await answer
 assert.ok(seen.length>=1);assert.deepEqual((seen[0] as {params:{progressToken:unknown}}).params.progressToken,0)
 const count=seen.length;await delay(25);assert.equal(seen.length,count)
})
