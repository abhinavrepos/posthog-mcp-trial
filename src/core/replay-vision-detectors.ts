import type {Timeline, TimelineItem} from './replay-timeline.ts'

export const DETECTOR_CONFIG = Object.freeze({version:'rv-d1-15-r1-r2-s1-s3-v1',rageClicks:3,rageGapMs:1000,rageManhattanPx:30,deadResponseMs:2500,validationCycles:2,hesitationMs:3000,waitMs:3000,strongWaitMs:10000,scrollReversals:3,scrollWindowMs:15000})
export type DetectorCode='D1'|'D2'|'D3'|'D4'|'D5'|'D6'|'D7'|'D8'|'D9'|'D10'|'R1'|'R2'|'D12'|'S1'|'S2'|'S3'|'D14'|'D15'
export interface Candidate {kind:DetectorCode; start_ms:number;end_ms:number;score:number;screen:string;element:string;step:string;event_ids:string[];facts:Record<string,number|string|boolean>;limitations:string[];strength:'strong'|'medium'|'weak'}
const strength=(k:DetectorCode):Candidate['strength']=>['D1','D3','D4','D5'].includes(k)?'strong':['D8','D9','S2','D14','D15'].includes(k)?'weak':'medium'
const timed=(a:TimelineItem,b:TimelineItem)=>b.offset_ms-a.offset_ms
const manhattan=(a:TimelineItem,b:TimelineItem)=>Math.abs((a.x??0)-(b.x??0))+Math.abs((a.y??0)-(b.y??0))
export function detectCandidates(timeline:Timeline, cfg=DETECTOR_CONFIG):Candidate[] {
 const out:Candidate[]=[], events=timeline.items.slice().sort((a,b)=>a.offset_ms-b.offset_ms||a.event_id.localeCompare(b.event_id))
 let screen=timeline.screens[0]??'unknown_screen';const visits:{screen:string;start:number;end:number;id:string}[]=[]
 const add=(kind:DetectorCode,group:TimelineItem[],facts:Candidate['facts']={},element?:string)=>{if(!group.length)return;const first=group[0],last=group.at(-1)!;out.push({kind,start_ms:first.offset_ms,end_ms:last.offset_ms,score:group.length,screen:first.screen||screen,element:element||first.label||'unknown_element',step:'unknown_step',event_ids:group.slice(0,8).map(e=>e.event_id),facts,limitations:timeline.coverage.state==='complete'?[]:[timeline.coverage.state],strength:strength(kind)})}
 for(const e of events){if(e.kind==='navigation'&&e.screen){screen=e.screen;const prev=visits.at(-1);if(!prev||prev.screen!==screen||e.offset_ms-prev.end>2000)visits.push({screen,start:e.offset_ms,end:e.offset_ms,id:e.event_id});else prev.end=e.offset_ms}e.screen=screen}
 const clicks=events.filter(e=>e.kind==='click' && (e.interaction===2||e.interaction===3||e.interaction===4||e.interaction===5||e.interaction===undefined))
 // rrweb interaction type 2=click, 3=contextmenu, 4=dblclick, 5=focus. Only 2 is a primary click.
 const primary=clicks.filter(e=>e.interaction===2||e.interaction===undefined)
 const rageIds=new Set<string>()
 for(let i=0;i<primary.length;){let j=i+1;while(j<primary.length&&timed(primary[j-1],primary[j])<=cfg.rageGapMs&&primary[j].offset_ms>=primary[j-1].offset_ms&&manhattan(primary[j-1],primary[j])<=cfg.rageManhattanPx&&primary[j].screen===primary[i].screen&&primary[j].frame_id===primary[i].frame_id)j++;if(j-i>=cfg.rageClicks){const group=primary.slice(i,j);add('D1',group,{clicks:group.length});for(const e of group)rageIds.add(e.event_id)}i=j}
 const isClickable=(e:TimelineItem)=>e.tag==='button'||e.role==='button'||e.tag==='a'
 for(const c of primary) {
  if(rageIds.has(c.event_id)||!isClickable(c)||c.tag==='a'||!c.label)continue
  const next=events.find(e=>e.offset_ms>c.offset_ms&&e.offset_ms<=c.offset_ms+cfg.deadResponseMs&&(['mutation','navigation'].includes(e.kind)||e.kind==='scroll'&&e.offset_ms-c.offset_ms<=100))
  if(!next&&timeline.coverage.dom_seen&&timeline.coverage.state==='complete')add('D2',[c],{response_ms:cfg.deadResponseMs})
 }
 // Validation: repeated Save/Submit clicks with a visible error or an app error between attempts.
 const submits=primary.filter(e=>['Save','Submit'].includes(e.label??''))
 for(let i=0;i<submits.length;){let j=i+1;while(j<submits.length&&submits[j].screen===submits[i].screen&&timed(submits[j-1],submits[j])<120_000)j++;const group=submits.slice(i,j);const edits=events.filter(e=>e.kind==='input_activity'&&e.screen===submits[i].screen&&e.offset_ms>=group[0].offset_ms&&e.offset_ms<=group.at(-1)!.offset_ms);const errors=events.filter(e=>e.kind==='error'&&e.screen===submits[i].screen&&e.offset_ms>=group[0].offset_ms&&e.offset_ms<=group.at(-1)!.offset_ms+1000);if(group.length>=cfg.validationCycles&&edits.length>=1&&errors.length>=2)add('D4',[...group,...errors].sort((a,b)=>a.offset_ms-b.offset_ms),{cycles:group.length});i=j}
 for(const c of primary){const e=events.find(x=>x.kind==='error'&&x.source==='rrweb'&&x.offset_ms>=c.offset_ms&&x.offset_ms-c.offset_ms<=1000);if(e)add('D3',[c,e],{delay_ms:e.offset_ms-c.offset_ms,visible_error:true})}
 const starts=events.filter(e=>e.kind==='coverage'&&e.label==='wait_start'),ends=events.filter(e=>e.kind==='coverage'&&e.label==='wait_end')
 for(const s of starts){const end=ends.find(e=>e.window_id===s.window_id&&e.offset_ms>=s.offset_ms);const click=[...primary].reverse().find(e=>e.offset_ms<=s.offset_ms&&s.offset_ms-e.offset_ms<=1000);if(end&&click&&end.offset_ms-click.offset_ms>=cfg.waitMs)add('D10',[click,s,end],{wait_ms:end.offset_ms-click.offset_ms,keys_during_wait:events.filter(e=>e.kind==='input_activity'&&e.offset_ms>s.offset_ms&&e.offset_ms<end.offset_ms).length})}
 // Form abandonment is emitted only when a visible new-form screen was left after an edit and no save transition.
 for(const v of visits){if(!v.screen.endsWith(':new'))continue;const departure=visits.find(x=>x.start>v.start&&x.screen!==v.screen);if(!departure)continue;const end=departure.start;const attempt=events.filter(e=>e.screen===v.screen&&e.offset_ms>=v.start&&e.offset_ms<=end);if(!attempt.some(e=>e.kind==='input_activity'))continue;const saved=departure.screen===v.screen.replace(/:new$/,':form');if(saved)continue;const last=attempt.at(-1);if(last&&end-last.offset_ms>1000)add('D5',[attempt[0],last],{edited:true,success_observed:false})}
 // D6/D7 field hesitation/returns. These are candidate metrics pending field baselines.
 const byField=new Map<string,TimelineItem[]>()
 for(const e of events)if(e.kind==='focus'&&e.label){const key=e.screen+'|'+e.label;byField.set(key,[...(byField.get(key)||[]),e])}
 for(const group of byField.values()){
  if(group.length>=3)add('D7',group,{returns:group.length})
  for(const f of group){const next=events.find(e=>e.kind==='input_activity'&&e.label===f.label&&e.offset_ms>=f.offset_ms);if(next&&timed(f,next)>=cfg.hesitationMs)add('D6',[f,next],{hesitation_ms:timed(f,next)})}
 }
 const pointers=events.filter(e=>e.kind==='pointer'&&e.x!==undefined&&e.y!==undefined)
 for(let i=0;i<pointers.length;i++){
   const a=pointers[i],b=pointers[i+1]
   if(b&&b.offset_ms-a.offset_ms>=2500&&a.label&&!events.some(e=>e.kind==='click'&&e.offset_ms>=a.offset_ms&&e.offset_ms<=b.offset_ms&&e.label===a.label))add('D8',[a,b],{dwell_ms:b.offset_ms-a.offset_ms})
   const window=pointers.slice(i,i+40).filter(e=>e.offset_ms-a.offset_ms<=1500)
   if(window.length<6)continue
   let path=0,reversals=0,prev=0
   for(let j=1;j<window.length;j++){const dx=window[j].x!-window[j-1].x!;path+=Math.abs(dx);const dir=Math.sign(dx);if(dir&&prev&&dir!==prev&&Math.abs(dx)>=30)reversals++;if(dir)prev=dir}
   if(reversals>=4&&path>=600&&Math.abs(window.at(-1)!.x!-a.x!)<=path*.3){add('D9',[a,window.at(-1)!],{reversals,path_px:path});i+=window.length-1}
 }
 for(const c of out.filter(x=>['D6','D8','D4'].includes(x.kind))){const help=events.find(e=>e.kind==='click'&&['Help','Search'].includes(e.label??'')&&e.screen===c.screen&&e.offset_ms>=c.end_ms&&e.offset_ms-c.end_ms<=30_000);if(help){const before=events.find(e=>e.event_id===c.event_ids[0]);if(before)add('D12',[before,help],{delay_ms:help.offset_ms-c.end_ms})}}
 // Navigation loops and screen reopenings in the observed task window.
 for(let i=0;i<visits.length-2;i++)if(visits[i].screen===visits[i+2].screen&&visits[i].screen!==visits[i+1].screen){const a=events.find(e=>e.event_id===visits[i].id),b=events.find(e=>e.event_id===visits[i+2].id);if(a&&b)add('R1',[a,b],{loops:1,via:visits[i+1].screen})}
 const byScreen=new Map<string,typeof visits>();for(const v of visits)byScreen.set(v.screen,[...(byScreen.get(v.screen)||[]),v]);for(const vv of byScreen.values())if(vv.length>=3){const a=events.find(e=>e.event_id===vv[0].id),b=events.find(e=>e.event_id===vv.at(-1)!.id);if(a&&b)add('R2',[a,b],{reopens:vv.length})}
 // S1/S2/S3: scroll positions, per container and screen. P is a lower-bound until cross-session baseline exists.
 const scrolls=new Map<string,TimelineItem[]>();for(const e of events)if(e.kind==='scroll'&&e.scroll_y!==undefined){const key=`${e.screen}|${e.window_id}|${e.scroll_id??-1}`;scrolls.set(key,[...(scrolls.get(key)||[]),e])}
 for(const group of scrolls.values()){if(group.length<2)continue;const H=Math.max(1,timeline.height||800),P=Math.max(H,...group.map(e=>(e.scroll_y??0)+H));let distance=0,reversals=0,extreme=group[0].scroll_y!,direction=0;const reversalEvents:TimelineItem[]=[];for(let i=1;i<group.length;i++){const y=group[i].scroll_y!,prev=group[i-1].scroll_y!;distance+=Math.abs(y-prev);const d=Math.sign(y-prev);if(d&&direction&&d!==direction&&Math.abs(y-extreme)>=Math.max(.25*H,200)){reversals++;reversalEvents.push(group[i]);direction=d;extreme=y}else if(!direction&&d){direction=d;extreme=y}else if(d===direction)extreme=y}const facts={distance_px:distance,d_over_h:distance/H,d_over_p:distance/P,reversals,page_lower_bound_px:P};if(distance>=2*P)add('S1',[group[0],group.at(-1)!],facts);if(reversals)add('S2',[group[0],...reversalEvents],facts);if(reversals>=cfg.scrollReversals&&group.at(-1)!.offset_ms-group[0].offset_ms<=cfg.scrollWindowMs&&!events.some(e=>(e.kind==='click'||e.kind==='input_activity')&&e.offset_ms>=group[0].offset_ms&&e.offset_ms<=group.at(-1)!.offset_ms)||distance>=2*P)add('S3',[group[0],group.at(-1)!],facts)}
 // Weak, supporting observations.
 for(let i=1;i<events.length;i++){const a=events[i-1],b=events[i];if(b.offset_ms-a.offset_ms>=60_000&&a.kind!=='navigation'&&b.kind!=='navigation')add('D15',[a,b],{idle_ms:b.offset_ms-a.offset_ms})}
 for(let i=1;i<primary.length;i++)if(primary[i].label&&primary[i].label===primary[i-1].label&&timed(primary[i-1],primary[i])>1000&&timed(primary[i-1],primary[i])<10_000)add('D14',[primary[i-1],primary[i]],{repeat_ms:timed(primary[i-1],primary[i])})
 return out.slice(0,5000)
}
