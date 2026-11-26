import test from 'node:test'
import assert from 'node:assert/strict'
import {oneToOne,wilsonInterval,type Label,type Hit} from './score.ts'

const truth:Label={id:'truth-1',session_id:'s1',kind:'dead_button',screen:'sales invoice:new',element:'Apply',start_ms:1000,end_ms:2000,expected_detectors:['D1','D2'],cohort:null}
function hit(id:string,override:Partial<Hit>={}):Hit{return {id,session_id:'s1',kind:'D1',screen:'sales invoice:new',element:'Apply',start_ms:1200,end_ms:1400,strength:'strong',...override}}

test('a moment matches only one compatible hit',()=>{
 const result=oneToOne([truth],[hit('a'),hit('b')])
 assert.equal(result.matched.length,1)
 assert.equal(result.usedHit.size,1)
 assert.equal(result.usedTruth.size,1)
 assert.equal(result.matched[0].hit,0)
})
test('session, screen, detector and time must all agree',()=>{
 const result=oneToOne([truth],[hit('session',{session_id:'s2'}),hit('screen',{screen:'item:list'}),hit('kind',{kind:'R1'}),hit('time',{start_ms:8000,end_ms:9000})])
 assert.equal(result.matched.length,0)
})
test('Wilson intervals are bounded and undefined for an empty denominator',()=>{
 assert.equal(wilsonInterval(0,0),null)
 const low=wilsonInterval(0,10)!,high=wilsonInterval(10,10)!
 assert.equal(low[0],0);assert.equal(high[1],1)
 assert.ok(low[1]<1&&high[0]>0)
})
test('truth screen is where the moment started (I3 waits end on the saved record)',async()=>{
 const {truthScreen}=await import('./score.ts')
 assert.equal(truthScreen({kind:'slow_wait',screen:'/desk/buying/purchase-order/PUR-ORD-2026-00042'}),'purchase order:new')
 assert.equal(truthScreen({kind:'slow_wait',screen:'/desk/buying/purchase-order/PUR-ORD-1',screen_start:'/desk/buying/purchase-order/new'}),'purchase order:new')
 assert.equal(truthScreen({kind:'revisit',screen:'/desk/accounts/sales-invoice/new'}),'sales invoice:new')
})
