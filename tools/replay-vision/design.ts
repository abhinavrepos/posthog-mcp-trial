// Experimental design: who does what, with which seed. Seeds are the resumability key; never renumber.
import type {Friction,Persona,Plan,Severity,Workflow} from './personas.ts'
export const personas:Persona[]=['Expert','Novice','Hurried','Careful','Explorer','Returning']
export const workflows:Workflow[]=['invoice','purchase','report']
// Held-out injected cohorts (architecture I1-I7). Dose = number of distinct affected users (1/3/6) for I2, I5, I6, I7;
// I2 is also run with abandonment; I3 uses 2/6/15 s waits (2 s is below the D10 floor: a negative dose control).
// Planned severity follows the architecture's planning rule, not the product rule: 1 user Low; >=3 users with no
// abandonment and <60 s lost Medium; >=3 users with abandonment or >=60 s lost High.
export interface Cohort {id:string;injection:Friction;workflow:Workflow;users:number;dose:number;abandon_after?:boolean;planned:Severity|null}
export const COHORTS:Cohort[]=[
 {id:'I2-validation-u1',injection:'validation_loop',workflow:'invoice',users:1,dose:2,planned:'Low'},
 {id:'I2-validation-u3',injection:'validation_loop',workflow:'invoice',users:3,dose:2,planned:'Medium'},
 {id:'I2-validation-u6',injection:'validation_loop',workflow:'invoice',users:6,dose:2,planned:'Medium'},
 {id:'I2-validation-abandon-u3',injection:'validation_loop',workflow:'invoice',users:3,dose:2,abandon_after:true,planned:'High'},
 {id:'I5-dead-apply-u1',injection:'dead_button',workflow:'invoice',users:1,dose:5,planned:'Low'},
 {id:'I5-dead-apply-u3',injection:'dead_button',workflow:'invoice',users:3,dose:5,planned:'Medium'},
 {id:'I5-dead-apply-u6',injection:'dead_button',workflow:'invoice',users:6,dose:5,planned:'Medium'},
 {id:'I6-scroll-hunt-u1',injection:'scroll_hunt',workflow:'report',users:1,dose:200,planned:'Low'},
 {id:'I6-scroll-hunt-u3',injection:'scroll_hunt',workflow:'report',users:3,dose:200,planned:'Medium'},
 {id:'I6-scroll-hunt-u6',injection:'scroll_hunt',workflow:'report',users:6,dose:200,planned:'Medium'},
 {id:'I7-revisit-u1',injection:'revisit',workflow:'invoice',users:1,dose:2,planned:'Low'},
 {id:'I7-revisit-u3',injection:'revisit',workflow:'invoice',users:3,dose:2,planned:'Medium'},
 {id:'I7-revisit-u6',injection:'revisit',workflow:'invoice',users:6,dose:2,planned:'Medium'},
 {id:'I1-hesitation-u3',injection:'hesitation',workflow:'invoice',users:3,dose:6,planned:'Medium'},
 {id:'I3-wait-2s-u3',injection:'slow_wait',workflow:'purchase',users:3,dose:2000,planned:null},
 {id:'I3-wait-6s-u3',injection:'slow_wait',workflow:'purchase',users:3,dose:6000,planned:'Medium'},
 {id:'I3-wait-15s-u3',injection:'slow_wait',workflow:'purchase',users:3,dose:15000,planned:'Medium'},
 {id:'R2-reopen-u3',injection:'reopen',workflow:'invoice',users:3,dose:3,planned:'Medium'},
 {id:'D5-abandon-u3',injection:'abandon',workflow:'invoice',users:3,dose:1,planned:'High'},
]
export const CALIBRATION_REPEATS=4
export function plans(smoke:false|'invoice'|'purchase'=false):{calibration:Plan[];heldout:Plan[]}{
 if(smoke)return {calibration:[],heldout:[{seed:smoke==='purchase'?771002:771001,phase:'heldout',user:'rv.smoke.0@example.test',persona:'Careful',workflow:smoke==='purchase'?'purchase':'invoice',injection:smoke==='purchase'?undefined:'validation_loop',dose:2,planned_severity:'Low'}]}
 const calibration:Plan[]=[],heldout:Plan[]=[]
 for(let repeat=0;repeat<CALIBRATION_REPEATS;repeat++)for(let u=0;u<6;u++)for(let w=0;w<3;w++)calibration.push({seed:100000+repeat*100+u*10+w,phase:'calibration',user:`rv.cal.${u}@example.test`,persona:personas[u],workflow:workflows[w]})
 for(let u=0;u<6;u++)for(let w=0;w<3;w++)heldout.push({seed:200000+u*10+w,phase:'heldout',user:`rv.eval.${u}@example.test`,persona:personas[u],workflow:workflows[w]})
 // Seeds 210000-210014 were a superseded pilot (one session per injection, per-session severity); see harness-superseded.jsonl.
 COHORTS.forEach((k,i)=>{for(let j=0;j<k.users;j++){const u=(i+j)%6;heldout.push({seed:220000+i*10+j,phase:'heldout',user:`rv.eval.${u}@example.test`,persona:personas[u],workflow:k.workflow,injection:k.injection,dose:k.dose,planned_severity:k.planned??'Low',cohort:k.id,cohort_users:k.users,abandon_after:k.abandon_after})}})
 return {calibration,heldout}
}
export const CONTROL_SEEDS=Array.from({length:18},(_,i)=>200000+Math.floor(i/3)*10+i%3)
