// Experimental design: who does what, with which seed. Seeds are the resumability key; never renumber.
import type {Friction,Persona,Plan,Severity,Workflow} from './personas.ts'
export const personas:Persona[]=['Expert','Novice','Hurried','Careful','Explorer','Returning']
export const workflows:Workflow[]=['invoice','purchase','report']
// Held-out injected cohorts (architecture I1-I7). Dose = number of distinct affected users (1/3/6) for I2, I5, I6, I7;
// I2 is also run with abandonment; I3 uses 2/6/15 s waits (2 s is below the D10 floor: a negative dose control).
// Planned severity follows the architecture's planning rule, not the product rule: 1 user Low; >=3 users with no
// abandonment and <60 s lost Medium; >=3 users with abandonment or >=60 s lost High. Orchestrator decision 1
// (30-review.md, after run A/B): the product rule 'strong D4 >= 2 cycles in U >= 3 -> High' is kept and the plan
// follows it, so I2 validation-loop cohorts with >= 3 users are planned High (runs A/B used Medium).
export interface Cohort {id:string;injection:Friction;workflow:Workflow;users:number;dose:number;abandon_after?:boolean;planned:Severity|null}
export const COHORTS:Cohort[]=[
 {id:'I2-validation-u1',injection:'validation_loop',workflow:'invoice',users:1,dose:2,planned:'Low'},
 {id:'I2-validation-u3',injection:'validation_loop',workflow:'invoice',users:3,dose:2,planned:'High'},
 {id:'I2-validation-u6',injection:'validation_loop',workflow:'invoice',users:6,dose:2,planned:'High'},
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
/** Held-out seed bases. Run A/B: controls 2000x0, cohorts 2200xx. Run C (fresh held-out after the v6 freeze):
 * controls 3000x0, cohorts 3200xx, and cohort users rotated by 3 so user-cohort pairings differ from run A. */
export type HeldoutRun='A'|'C'
export const RUN_SEEDS:Record<HeldoutRun,{control:number;cohort:number;rotate:number}>={A:{control:200000,cohort:220000,rotate:0},C:{control:300000,cohort:320000,rotate:3}}
export const cohortSeed=(run:HeldoutRun,i:number,j:number)=>RUN_SEEDS[run].cohort+i*10+j
export const controlSeeds=(run:HeldoutRun)=>Array.from({length:18},(_,i)=>RUN_SEEDS[run].control+Math.floor(i/3)*10+i%3)
export function plans(smoke:false|'invoice'|'purchase'=false,run:HeldoutRun='A'):{calibration:Plan[];heldout:Plan[]}{
 if(smoke)return {calibration:[],heldout:[{seed:smoke==='purchase'?771002:771001,phase:'heldout',user:'rv.smoke.0@example.test',persona:'Careful',workflow:smoke==='purchase'?'purchase':'invoice',injection:smoke==='purchase'?undefined:'validation_loop',dose:2,planned_severity:'Low'}]}
 const calibration:Plan[]=[],heldout:Plan[]=[]
 for(let repeat=0;repeat<CALIBRATION_REPEATS;repeat++)for(let u=0;u<6;u++)for(let w=0;w<3;w++)calibration.push({seed:100000+repeat*100+u*10+w,phase:'calibration',user:`rv.cal.${u}@example.test`,persona:personas[u],workflow:workflows[w]})
 for(let u=0;u<6;u++)for(let w=0;w<3;w++)heldout.push({seed:RUN_SEEDS[run].control+u*10+w,phase:'heldout',user:`rv.eval.${u}@example.test`,persona:personas[u],workflow:workflows[w]})
 // Seeds 210000-210014 were a superseded pilot (one session per injection, per-session severity); see harness-superseded.jsonl.
 COHORTS.forEach((k,i)=>{for(let j=0;j<k.users;j++){const u=(i+j+RUN_SEEDS[run].rotate)%6;heldout.push({seed:cohortSeed(run,i,j),phase:'heldout',user:`rv.eval.${u}@example.test`,persona:personas[u],workflow:k.workflow,injection:k.injection,dose:k.dose,planned_severity:k.planned??'Low',cohort:k.id,cohort_users:k.users,abandon_after:k.abandon_after})}})
 return {calibration,heldout}
}
export const CONTROL_SEEDS=controlSeeds('A')

/** Development set for decision 4 (hesitation gap): I1 sessions by the CALIBRATION users with their own seeds, captured
 * into out/erpnext-dev. Never part of calibration baselines, held-out scoring or run C. */
export function devPlans():Plan[]{return Array.from({length:6},(_,u)=>({seed:130000+u,phase:'calibration' as const,user:`rv.cal.${u}@example.test`,persona:personas[u],workflow:'invoice' as const,injection:'hesitation' as const,dose:6,planned_severity:'Medium' as const,cohort:'dev-I1'}))}
