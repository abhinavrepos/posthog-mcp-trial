import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'

test('queue is idempotent, end revisions supersede old runs, feature defaults off',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-queue-'))
 try{
  const script=`import {queueReplayVision,replayVisionEnabled} from './src/service/replayvision-worker.ts';import {one} from './src/core/db.ts';const a=queueReplayVision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-11-26T12:00:00Z','C1','D1');const b=queueReplayVision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-11-26T12:00:00Z','C1','D1');const c=queueReplayVision('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-11-26T12:01:00Z','C1','D1');console.log(JSON.stringify({a,b,c,old:one('SELECT state FROM rv_run WHERE id=?',a),off:!replayVisionEnabled()}))`
  const out=execFileSync('npx',['tsx','-e',script],{cwd:process.cwd(),env:{...process.env,TRIAGE_DB:join(dir,'triage.db'),FEATURE_REPLAY_VISION:'off'},encoding:'utf8'})
  const result=JSON.parse(out.trim())
  assert.equal(result.a,result.b);assert.notEqual(result.a,result.c);assert.equal(result.old.state,'superseded');assert.equal(result.off,true)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('browser provider key is encrypted at rest and requires a separate master key',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-key-'))
 try{
  const script=`import {storeProviderKey,readProviderKey} from './src/core/replay-vision-secrets.ts';import {one} from './src/core/db.ts';const key='sk-ant-'+'A'.repeat(32);storeProviderKey(key,'admin@example.test');const row=one('SELECT ciphertext FROM rv_secret WHERE name=?','anthropic');console.log(JSON.stringify({ciphertext:row.ciphertext,roundtrip:readProviderKey()===key}))`
  const out=execFileSync('npx',['tsx','-e',script],{cwd:process.cwd(),env:{...process.env,TRIAGE_DB:join(dir,'triage.db'),REPLAY_VISION_MASTER_KEY:'11'.repeat(32)},encoding:'utf8'})
  const result=JSON.parse(out.trim());assert.equal(result.roundtrip,true);assert.ok(!result.ciphertext.includes('sk-ant-'))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('baseline includes zero-hit visits and distinct users',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-baseline-'))
 try{
  const script=`import {run,one} from './src/core/db.ts';import {runMetrics,recomputeBaselines} from './src/core/replay-vision-baseline.ts';const now=new Date().toISOString();for(let i=0;i<2;i++)run('INSERT INTO rv_run(project_id,session_id,recording_end,analysis_version,mode,distinct_id,state,completed_at,metrics_json) VALUES(?,?,?,?,?,?,?,?,?)','1','session'+i,now,'v1','deterministic','user'+i,'complete',now,JSON.stringify(runMetrics(['sales invoice:new'],i?[{kind:'D4',screen:'sales invoice:new'}]:[],20,100)));recomputeBaselines();console.log(JSON.stringify(one('SELECT n_sessions,n_users,median,rate,aux_json FROM rv_baseline WHERE detector=? AND screen_key=?','D4','sales invoice:new')))`
  const out=execFileSync('npx',['tsx','-e',script],{cwd:process.cwd(),env:{...process.env,TRIAGE_DB:join(dir,'triage.db')},encoding:'utf8'})
  const result=JSON.parse(out.trim());assert.equal(result.n_sessions,2);assert.equal(result.n_users,2);assert.equal(result.median,0);assert.equal(result.rate,.5);assert.deepEqual(JSON.parse(result.aux_json).values,[0,1])
 }finally{rmSync(dir,{recursive:true,force:true})}
})
