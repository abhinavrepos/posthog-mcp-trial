import assert from 'node:assert/strict'
import test from 'node:test'
import {gzipSync} from 'node:zlib'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {readTimeline,screenKey} from '../src/core/replay-timeline.ts'
import {detectCandidates} from '../src/core/replay-vision-detectors.ts'

const base=Date.parse('2026-11-26T00:00:00Z')
const packed=(value:unknown)=>gzipSync(Buffer.from(JSON.stringify(value))).toString('latin1')
const event=(ms:number,type:number,data:unknown)=>['main',{timestamp:base+ms,type,data}]
const root={id:1,type:2,tagName:'div',childNodes:[
  {id:2,type:2,tagName:'button',childNodes:[{id:8,type:3,textContent:'Save'}]},
  {id:5,type:2,tagName:'div',childNodes:[{id:4,type:2,tagName:'label',childNodes:[{id:9,type:3,textContent:'Debit To'}]},{id:3,type:2,tagName:'input',attributes:{value:'sensitive-value'}}]},
]}
async function withEvents<T>(events:unknown[],f:(file:string)=>Promise<T>):Promise<T>{const dir=mkdtempSync(join(tmpdir(),'rv-normalize-')),file=join(dir,'session.jsonl');try{writeFileSync(file,events.map(e=>JSON.stringify(e)).join('\n')+'\n');return await f(file)}finally{rmSync(dir,{recursive:true,force:true})}}

test('client-gzipped FullSnapshot, adjacent field label, chained clicks and visible error cite exact offsets',async()=>{
  const rows=[event(0,4,{href:'http://app/desk/sales-invoice/new-1?secret=private',width:1000,height:800}),event(1,2,packed({node:root,initialOffset:{top:0,left:0}})),
    event(100,3,{source:2,type:2,id:2,x:10,y:20}),event(300,3,{source:2,type:2,id:2,x:29,y:20}),event(500,3,{source:2,type:2,id:2,x:48,y:20}),
    event(700,3,{source:5,id:3,text:'********'}),
    event(1000,3,{source:0,adds:packed([{parentId:1,node:{id:6,type:2,tagName:'div',attributes:{role:'alert'},childNodes:[{id:7,type:3,textContent:'Debit To is required'}]}}]),removes:[],texts:[],attributes:[]}),
    event(2000,3,{source:2,type:2,id:2,x:10,y:20}),event(2050,6,{plugin:'rrweb/console@1',payload:{level:'error',payload:['secret console payload']}}),event(2100,3,{source:0,adds:[],removes:[],texts:[],attributes:[]}),
  ]
  await withEvents(rows,async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});assert.equal(t.coverage.state,'complete');assert.equal(t.items.find(e=>e.kind==='input_activity')?.label,'Debit To');assert.ok(!JSON.stringify(t).includes('sensitive-value'));assert.ok(!JSON.stringify(t).includes('Debit To is required'));const hits=detectCandidates(t);assert.ok(hits.some(h=>h.kind==='D1'&&h.facts.clicks===3));assert.ok(!JSON.stringify(t).includes('secret console payload'));const d3=hits.filter(h=>h.kind==='D3');assert.equal(d3.length,1,'a visible error alone is not an error click; the console error after the 2 s click is');assert.equal(d3[0].facts.error_kind,'console');assert.equal(d3[0].start_ms,2000);assert.ok(d3[0].event_ids.every(id=>t.items.some(e=>e.event_id===id)));assert.equal(t.items.find(e=>e.kind==='click')?.offset_ms,100)})
})

test('bad route escapes, malformed shapes, deep nodes and gzip bombs remain bounded',async()=>{
  assert.doesNotThrow(()=>screenKey('/desk/%F0%A'))
  let deep='{"id":1,"type":3,"textContent":"secret"}';for(let i=2;i<5000;i++)deep=`{"id":${i},"type":2,"tagName":"div","childNodes":[${deep}]}`
  const huge=gzipSync(Buffer.from(`{"node":${deep}}`)).toString('latin1')
  await withEvents([event(0,4,{href:'/',width:800,height:600}),event(1,2,huge),event(2,3,{source:1,positions:[{x:'wrong',y:null,timeOffset:-9}]})],async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});assert.ok(['complete','partial','oversize'].includes(t.coverage.state));assert.ok(t.items.length<10000)})
  const bomb=packed({node:{text:'x'.repeat(9*1024*1024)}})
  await withEvents([event(0,4,{href:'/',width:800,height:600}),event(1,2,bomb)],async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});assert.equal(t.coverage.state,'oversize');assert.ok(t.coverage.reasons.some(x=>x.includes('cap')))})
})

test('randomized type damage and truncation never escape the parser',async()=>{
  let seed=32107;const next=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0}
  const valid=JSON.stringify(event(0,4,{href:'/',width:800,height:600}))
  for(let i=0;i<100;i++){const damaged=valid.slice(0,next()%valid.length)+(next()%2?'~':'');await withEvents([damaged,event(i,3,{source:next()%9,positions:[{x:next()%2?null:'bad',y:next(),timeOffset:-next()}],adds:next()%2?[]:'bad'})],async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});assert.ok(['complete','partial','oversize'].includes(t.coverage.state));assert.ok(t.items.length<=200000)})}
})

test('an unrelated app exception after a click cannot become an error-click finding',async()=>{
  const rows=[event(0,4,{href:'http://app/desk/sales-invoice/new',width:800,height:600}),event(1,2,packed({node:root})),event(100,3,{source:2,type:2,id:2,x:10,y:20})]
  await withEvents(rows,async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString(),app_events:[{timestamp:new Date(base+150).toISOString(),event:'$exception'}]});assert.ok(!detectCandidates(t).some(h=>h.kind==='D3'))})
})

test('two visible validation cycles and an overlay wait produce bounded detector evidence',async()=>{
  const alert=(id:number)=>({parentId:1,node:{id,type:2,tagName:'div',attributes:{role:'alert'},childNodes:[{id:id+100,type:3,textContent:'Debit To is required'}]}})
  const mask={parentId:1,node:{id:40,type:2,tagName:'div',attributes:{class:'freeze'}}}
  const rows=[event(0,4,{href:'http://app/desk/sales-invoice/new',width:1000,height:800}),event(1,2,packed({node:root})),
    event(100,3,{source:2,type:2,id:2,x:10,y:20}),event(200,3,{source:0,adds:packed([alert(20)]),removes:[],texts:[],attributes:[]}),
    event(300,3,{source:5,id:3,text:'*'}),event(1000,3,{source:2,type:2,id:2,x:10,y:20}),event(1100,3,{source:0,adds:packed([alert(22)]),removes:[],texts:[],attributes:[]}),
    event(2000,3,{source:2,type:2,id:2,x:10,y:20}),event(2100,3,{source:0,adds:packed([mask]),removes:[],texts:[],attributes:[]}),
    event(6100,3,{source:0,adds:[],removes:packed([{id:40,parentId:1}]),texts:[],attributes:[]})]
  await withEvents(rows,async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});const hits=detectCandidates(t);assert.ok(hits.some(h=>h.kind==='D4'&&Number(h.facts.cycles)>=2));assert.ok(hits.some(h=>h.kind==='D10'&&Number(h.facts.wait_ms)>=3000));assert.ok(hits.every(h=>h.event_ids.every(id=>t.items.some(e=>e.event_id===id))))})
})

test('a data-label attribute mutation relabels the button (Frappe Save -> Submit), so Submit is not a repeated Save',async()=>{
  // Shape taken from ERPNext session 01a21970-ec54-…: the primary action keeps its node, gets data-label="Submit" by an
  // attribute mutation, and its inner text is re-rendered as new spans whose text alone is not a vocabulary label.
  const frappe={id:1,type:2,tagName:'div',childNodes:[{id:20,type:2,tagName:'button',attributes:{class:'primary-action','data-label':'Save'},childNodes:[{id:21,type:2,tagName:'span',childNodes:[{id:22,type:3,textContent:'Save'}]}]}]}
  const rows=[event(0,4,{href:'http://app/desk/sales-invoice/new-1',width:1000,height:800}),event(1,2,{node:frappe,initialOffset:{top:0,left:0}}),
    event(100,3,{source:2,type:2,id:21,x:10,y:10}),
    event(400,3,{source:0,adds:[],removes:[{parentId:20,id:21}],texts:[],attributes:[{id:20,attributes:{'data-label':'Submit'}}]}),
    event(410,3,{source:0,adds:[{parentId:20,node:{id:30,type:2,tagName:'span',attributes:{},childNodes:[]}},{parentId:30,node:{id:31,type:3,textContent:'bmit'}}],removes:[],texts:[],attributes:[]}),
    event(2100,3,{source:2,type:2,id:30,x:10,y:10}),event(2105,3,{source:2,type:2,id:20,x:10,y:10}),
  ]
  await withEvents(rows,async file=>{
    const t=await readTimeline(file,{start_time:new Date(base).toISOString()}),clicks=t.items.filter(e=>e.kind==='click')
    assert.deepEqual(clicks.map(c=>c.label),['Save','Submit','Submit'])
    assert.ok(!detectCandidates(t).some(c=>c.kind==='D14'&&c.element==='Save'))
  })
  // A lower-ranked attribute (title) cannot override an explicit aria-label; removing the label attribute clears it.
  const aria={id:1,type:2,tagName:'div',childNodes:[{id:40,type:2,tagName:'button',attributes:{'aria-label':'Apply'},childNodes:[]}]}
  const rows2=[event(0,4,{href:'http://app/desk/item',width:1000,height:800}),event(1,2,{node:aria,initialOffset:{top:0,left:0}}),
    event(100,3,{source:0,adds:[],removes:[],texts:[],attributes:[{id:40,attributes:{title:'Save'}}]}),event(200,3,{source:2,type:2,id:40,x:1,y:1}),
    event(300,3,{source:0,adds:[],removes:[],texts:[],attributes:[{id:40,attributes:{'aria-label':null}}]}),event(400,3,{source:2,type:2,id:40,x:1,y:1})]
  await withEvents(rows2,async file=>{const t=await readTimeline(file,{start_time:new Date(base).toISOString()});assert.deepEqual(t.items.filter(e=>e.kind==='click').map(c=>c.label),['Apply',undefined])})
})
