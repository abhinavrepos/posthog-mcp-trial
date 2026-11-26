import assert from 'node:assert/strict'
import test from 'node:test'
import {binaryAnomaly,buildBaseline,classifyMetric,classifySeverity,wilsonLower,type SeverityInput} from '../src/core/replay-vision-severity.ts'
import {validateInsight,type InsightDraft} from '../src/core/replay-vision-validator.ts'
import {aggregateInsights,type Moment} from '../src/core/replay-vision-aggregate.ts'
import type {Candidate} from '../src/core/replay-vision-detectors.ts'

const base:SeverityInput={kind:'S3',users_affected:3,users_reached:12,median_lost_ms:60_000,abandoned_users:0,calibrated:true}
test('severity exact boundaries and caps',()=>{
 const cases:[Partial<SeverityInput>,string][]=[
  [{users_affected:2},'Medium'],[{users_affected:3},'High'],
  [{users_reached:1004},'Medium'],[{users_reached:12},'High'],
  [{median_lost_ms:59_000},'Medium'],[{median_lost_ms:60_000},'High'],
  [{calibrated:false},'Medium'],[{users_affected:1,users_reached:1,abandoned_users:1},'Low'],
  [{kind:'D8'},'Low'],[{kind:'S2'},'Low'],[{kind:'D14'},'Low'],[{kind:'S1'},'Low'],
  [{users_reached:null,median_lost_ms:0},'Low'],[{observed_rate_lower_bound:true,median_lost_ms:0},'Low'],
  [{abandoned_users:2,users_reached:null,median_lost_ms:0},'High']]
 for(const [patch,want] of cases)assert.equal(classifySeverity({...base,...patch}).severity,want,JSON.stringify(patch))
})
test('MAD zero uses percentile; cold baseline marks uncalibrated path',()=>{
 const b=buildBaseline([...Array(19).fill(0),5],6)
 assert.equal(b.mad,0)
 assert.equal(classifyMetric(5,b,2).method,'percentile')
 assert.equal(classifyMetric(5,b,2).band,'anomalous')
 assert.equal(classifyMetric(1,b,2).band,'normal')
 assert.equal(classifyMetric(5,buildBaseline([0],1),2).method,'cold')
})
test('Wilson comparison uses lower bound and finite totality',()=>{
 assert.ok(wilsonLower(8,10)>wilsonLower(2,10))
 assert.equal(wilsonLower(NaN,0),0)
 assert.equal(binaryAnomaly(8,10,.1,.2),true)
 assert.equal(binaryAnomaly(2,10,.1,.2),false)
})
test('monotone user, time and abandonment doses; arbitrary values always classify',()=>{
 const order={Low:0,Medium:1,High:2}
 for(let u=1;u<=10;u++)for(let t=0;t<=120_000;t+=10_000){const x=classifySeverity({...base,users_affected:u,users_reached:20,median_lost_ms:t});const y=classifySeverity({...base,users_affected:u+1,users_reached:20,median_lost_ms:t+10_000,abandoned_users:Math.min(2,u)});assert.ok(order[y.severity]>=order[x.severity])}
 let seed=91;const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
 for(let i=0;i<1000;i++){const input={...base,users_affected:rnd()%50,users_reached:rnd()%50,median_lost_ms:rnd()%100_000,abandoned_users:rnd()%5};assert.ok(['High','Medium','Low'].includes(classifySeverity(input).severity))}
})
test('one extreme baseline session changes median by at most a rank step',()=>{
 const values=Array.from({length:101},(_,i)=>i)
 const a=buildBaseline(values,30),b=buildBaseline([...values,1e9],30)
 assert.ok(Math.abs(a.median-b.median)<=1);assert.ok(Math.abs(a.mad-b.mad)<=1)
})
test('rubric rejects invented citations and generic claims',()=>{
 const c:Candidate={kind:'D4',start_ms:3000,end_ms:5000,screen:'sales invoice:new',element:'Debit To',step:'Save',event_ids:['1','2'],score:2,facts:{cycles:2},limitations:[],strength:'strong'}
 const d:InsightDraft={screen:c.screen,element:c.element,behaviour:'2 users retried Save twice after Debit To validation',users_affected:2,users_reached:6,sessions_affected:2,citations:[{session_id:'a',offset_ms:3000,event_ids:['1'],url:'http://example/replay/a?t=3'},{session_id:'b',offset_ms:5000,event_ids:['2'],url:'http://example/replay/b?t=5'}],outcome:'No success observed',time_lost_ms:60_000,cause:'Likely cause: Debit To was marked required after Save.',fix:'Fix: validate Debit To before Save on Sales Invoice.',signals:['D4'],confidence:'high',limitations:[],severity:'Medium'}
 assert.equal(validateInsight(d,[c]).valid,true)
 assert.equal(validateInsight({...d,citations:[{...d.citations[0],event_ids:['invented']}]},[c]).valid,false)
 assert.equal(validateInsight({...d,behaviour:'Users experienced frustration'},[c]).valid,false)
 assert.equal(validateInsight(d,[{session_id:'a',candidate:c}]).valid,false,'a citation cannot borrow an event id from another session')
})

test('aggregation counts distinct affected users and requires two cited moments in one single-session observation',()=>{
 const candidate=(at:number):Candidate=>({kind:'D4',start_ms:at,end_ms:at+200,screen:'sales invoice:new',element:'Save',step:'Save',event_ids:[String(at)],score:2,facts:{cycles:2},limitations:[],strength:'strong'})
 const moment=(user:string,session:string,at:number):Moment=>({user_id:user,session_id:session,candidate:candidate(at),time_lost_ms:60_000,abandoned:false})
 const reach=new Map([['sales invoice:new',{users:6,source:'$pageview'}]]),calibrated=new Map([['sales invoice:new',true]])
 const many=aggregateInsights([moment('a','s1',3000),moment('a','s2',5000),moment('b','s3',7000)],reach,calibrated)
 assert.equal(many.length,1);assert.equal(many[0].draft.users_affected,2);assert.equal(many[0].draft.sessions_affected,3)
 assert.equal(aggregateInsights([moment('a','s1',3000),moment('a','s2',5000)],reach,calibrated).length,0)
 const one=aggregateInsights([moment('a','s1',3000),moment('a','s1',5000)],reach,calibrated)
 assert.equal(one.length,1);assert.equal(one[0].draft.single_session,true);assert.equal(one[0].draft.severity,'Low')
})
