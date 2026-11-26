import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {readTimeline,screenKey} from '../src/core/replay-timeline.ts'
import {analyzeFile} from '../src/core/replay-vision.ts'
import {detectCandidates} from '../src/core/replay-vision-detectors.ts'

const start=new Date(1795713816821).toISOString()
const sample='/root/briefs/rv/exp/snapshots.jsonl'
test('installer creates a private, stable shared secret and replaces empty value',()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-secret-'))
 try{writeFileSync(join(dir,'.env'),'A=1\nRECORDING_API_JWT_SECRET=\n')
  const cmd=join(process.cwd(),'deploy/posthog/install-posthog-hobby.sh')
  execFileSync('bash',[cmd,'--ensure-recording-secret'],{env:{...process.env,POSTHOG_INSTALL_DIR:dir}})
  const first=readFileSync(join(dir,'.env'),'utf8')
  assert.match(first,/RECORDING_API_JWT_SECRET=\S{40,}/)
  assert.equal(statSync(join(dir,'.env')).mode&0o777,0o600)
  execFileSync('bash',[cmd,'--ensure-recording-secret'],{env:{...process.env,POSTHOG_INSTALL_DIR:dir}})
  assert.equal(readFileSync(join(dir,'.env'),'utf8'),first)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('real research fixture produces bounded, cited, complete timeline',async()=>{
 const r=await readTimeline(sample,{start_time:start})
 assert.equal(r.coverage.state,'complete');assert.equal(r.coverage.lines,206)
 assert.equal(r.coverage.pointer_seen,true);assert.equal(r.coverage.click_seen,true)
 const hits=detectCandidates(r);assert.ok(hits.some(x=>x.kind==='D1'))
 assert.ok(hits.every(x=>x.event_ids.every(id=>r.items.some(e=>e.event_id===id))))
 const isolated=await analyzeFile(sample,{start_time:start},5000)
 assert.equal(isolated.coverage.state,'complete')
})
test('screen routes remove record identities and query strings',()=>{
 assert.equal(screenKey('/desk/sales-invoice/new-sales-invoice-123?email=a'), 'sales invoice:new')
 assert.equal(screenKey('/desk/accounts/sales-invoice/new-sales-invoice-123'),'sales invoice:new')
 assert.equal(screenKey('/desk/sales-invoice/new'),'sales invoice:new')
 assert.equal(screenKey('/desk/sales-invoice/SINV-2026-0001'), 'sales invoice:form')
 assert.equal(screenKey('/orders/123456?secret=x'),'/orders/:id')
})
test('parser tolerates corrupt lines and never retains raw values',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-parser-')),file=join(dir,'r.jsonl')
 try{
  let seed=0x12345678;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0}
  const corpus=readFileSync(sample,'utf8').split('\n').filter(Boolean)
  for(let round=0;round<60;round++){
   const lines=corpus.slice(0,Math.max(2,rnd()%40)).map(s=>rnd()%8===0?s.slice(0,rnd()%s.length):s)
   lines.push(JSON.stringify(['orphan',{type:3,timestamp:rnd()%3===0?-1:1795713816821,data:{source:rnd()%8,positions:[{x:'bad',y:null,timeOffset:-400}],adds:'\u001f\u008bBOMB',node:{childNodes:Array(100).fill({bad:true})}}}]))
   if(round%6===0)lines.push('{'+'x'.repeat(100_000))
   writeFileSync(file,lines.join('\n')+'\n')
   const t=await readTimeline(file,{start_time:start})
   assert.ok(['complete','partial','oversize'].includes(t.coverage.state))
   assert.ok(t.items.length<=200_000)
   assert.ok(!JSON.stringify(t).includes('phc_xEtp'))
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('poisoned gzip and missing snapshot are partial; worker deadline returns safely',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rv-poison-')),file=join(dir,'r.jsonl')
 try{
  writeFileSync(file,JSON.stringify(['w',{type:3,timestamp:1795713816821,data:{source:0,adds:'\u001f\u008bnot gzip'}}])+'\n')
  const r=await readTimeline(file,{start_time:start});assert.equal(r.coverage.state,'partial')
  const isolated=await analyzeFile(file,{start_time:start},1)
  assert.ok(['partial','oversize'].includes(isolated.coverage.state))
 }finally{rmSync(dir,{recursive:true,force:true})}
})
