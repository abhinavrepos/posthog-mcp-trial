import type {DetectorCode} from './replay-vision-detectors.ts'

export type Severity='High'|'Medium'|'Low'
export const SEVERITY_CONFIG=Object.freeze({version:'severity-v1',windowDays:30,minSessions:20,minUsers:5,anomalousZ:3.5,elevatedZ:2,highUsers:3,highRate:.25,highLostMs:60_000,mediumUsers:2,mediumRate:.1,mediumLostMs:30_000,wilsonZ:1.96})
export interface Baseline {n_sessions:number;n_users:number;median:number;mad:number;p90:number;p95:number;values:number[];sample:'all_admitted'|'sampled';version:string}
export interface SeverityInput {kind:DetectorCode;users_affected:number;users_reached:number|null;median_lost_ms:number;abandoned_users:number;calibrated:boolean;cycles?:number;loops?:number;observed_rate_lower_bound?:boolean;corroborated?:boolean;strong_error?:boolean;weak_only?:boolean}
export interface SeverityResult {severity:Severity;reason:string;calibrated:boolean;users_affected:number;users_reached:number|null;rule:string}
function sorted(values:number[]):number[]{return values.filter(Number.isFinite).sort((a,b)=>a-b)}
function quantile(v:number[],q:number):number{if(!v.length)return 0;return v[Math.max(0,Math.min(v.length-1,Math.ceil(q*v.length)-1))]}
export function buildBaseline(values:number[],nUsers:number,sample:Baseline['sample']='all_admitted'):Baseline {
 const v=sorted(values),med=quantile(v,.5),dev=sorted(v.map(x=>Math.abs(x-med)))
 return {n_sessions:v.length,n_users:Math.max(0,Math.floor(nUsers)||0),median:med,mad:quantile(dev,.5),p90:quantile(v,.9),p95:quantile(v,.95),values:v,sample,version:SEVERITY_CONFIG.version}
}
export function classifyMetric(value:number,baseline:Baseline,floor:number):{band:'anomalous'|'elevated'|'normal';method:'cold'|'z'|'percentile';value:number} {
 if(!Number.isFinite(value)||value<floor)return {band:'normal',method:'cold',value:0}
 if(baseline.n_sessions<SEVERITY_CONFIG.minSessions||baseline.n_users<SEVERITY_CONFIG.minUsers)return {band:'anomalous',method:'cold',value}
 if(baseline.mad>0){const z=.6745*(value-baseline.median)/baseline.mad;return {band:z>=SEVERITY_CONFIG.anomalousZ?'anomalous':z>=SEVERITY_CONFIG.elevatedZ?'elevated':'normal',method:'z',value:z}}
 const percentile=baseline.values.filter(x=>x<=value).length/Math.max(1,baseline.n_sessions)
 return {band:value>baseline.median&&percentile>=.95?'anomalous':value>baseline.median&&percentile>=.9?'elevated':'normal',method:'percentile',value:percentile}
}
export function wilsonLower(success:number,total:number,z=SEVERITY_CONFIG.wilsonZ):number {
 if(!Number.isFinite(success)||!Number.isFinite(total)||total<=0)return 0
 const n=Math.floor(total),p=Math.max(0,Math.min(n,Math.floor(success)))/n,d=1+z*z/n
 return Math.max(0,(p+z*z/(2*n)-z*Math.sqrt((p*(1-p)+z*z/(4*n))/n))/d)
}
export function binaryAnomaly(affected:number,total:number,priorScreenRate:number,allScreenRate:number):boolean {
 return wilsonLower(affected,total)>Math.max(priorScreenRate,allScreenRate)
}
const rank:Record<Severity,number>={Low:0,Medium:1,High:2}
const WEAK_CODES=new Set<string>(['D8','D9','S2','D15'])
/**
 * §12c severity, evaluated in order: High rules, Medium rules, else Low; then the cold-start cap
 * (Medium unless abandonment), the single-user cap and the weak-only cap (Low). D14 stays Low until
 * calibration validates it; S1 without S3 corroboration is weak. The reason names the rule that fired.
 */
export function classifySeverity(raw:SeverityInput):SeverityResult {
 const U=Number.isFinite(raw.users_affected)?Math.max(0,Math.min(1e9,Math.floor(raw.users_affected))):0
 const N=raw.users_reached!==null&&raw.users_reached!==undefined&&Number.isFinite(raw.users_reached)&&raw.users_reached>=U?Math.floor(raw.users_reached):null
 const p=N!==null&&N>0&&!raw.observed_rate_lower_bound?U/N:null
 const T=Number.isFinite(raw.median_lost_ms)?Math.max(0,Math.min(1e12,raw.median_lost_ms)):0
 const A=Number.isFinite(raw.abandoned_users)?Math.max(0,Math.floor(raw.abandoned_users)):0
 const count=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0?Math.min(1e6,Math.floor(v)):0
 const cycles=count(raw.cycles),loops=count(raw.loops)
 const strongPattern=(raw.kind==='D3'&&raw.strong_error!==false)||(raw.kind==='D4'&&cycles>=2)||(raw.kind==='R1'&&loops>=3)
 const C=SEVERITY_CONFIG
 let severity:Severity='Low',rule='anomalous finding (no High/Medium rule met)'
 if(A>=2){severity='High';rule=`${A} users abandoned after friction`}
 else if(U>=C.highUsers&&p!==null&&p>=C.highRate&&T>=C.highLostMs){severity='High';rule=`U ${U}>=${C.highUsers}, p ${(100*p).toFixed(1)}%>=${100*C.highRate}%, median lost ${Math.round(T/1000)} s>=${C.highLostMs/1000} s`}
 else if(U>=C.highUsers&&strongPattern){severity='High';rule=`strong ${raw.kind}${raw.kind==='D4'?` (${cycles} cycles)`:raw.kind==='R1'?` (L=${loops})`:''} in ${U}>=${C.highUsers} users`}
 else if(U>=C.mediumUsers&&((p!==null&&p>=C.mediumRate)||T>=C.mediumLostMs)){severity='Medium';rule=`U ${U}>=${C.mediumUsers} and ${p!==null&&p>=C.mediumRate?`p ${(100*p).toFixed(1)}%>=${100*C.mediumRate}%`:`median lost ${Math.round(T/1000)} s>=${C.mediumLostMs/1000} s`}`}
 else if(U===C.mediumUsers&&strongPattern){severity='Medium';rule=`High pattern (strong ${raw.kind}) failing only the user minimum (U=${U})`}
 if(!raw.calibrated&&severity==='High'&&A===0){severity='Medium';rule+='; capped Medium: uncalibrated screen (cold start, no abandonment)'}
 if(U<=1&&severity!=='Low'){severity='Low';rule+='; capped Low: single user'}
 const weak=raw.weak_only===true||WEAK_CODES.has(raw.kind)||raw.kind==='D14'||(raw.kind==='S1'&&!raw.corroborated)
 if(weak&&severity!=='Low'){severity='Low';rule+=`; capped Low: ${raw.kind==='D14'?'D14 not yet calibrated':'supporting-only signal'}`}
 const reason=`${severity}: ${rule}. U/N ${U}/${N??'unknown'}${raw.observed_rate_lower_bound?' (p lower bound)':''}; median lost ${Math.round(T/1000)} s; A ${A}; ${raw.calibrated?'calibrated':'uncalibrated'}; signal ${raw.kind}`
 return {severity,reason,calibrated:raw.calibrated,users_affected:U,users_reached:N,rule}
}
export function atLeast(a:Severity,b:Severity):boolean{return rank[a]>=rank[b]}
