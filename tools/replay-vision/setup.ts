import {readFileSync} from 'node:fs'

export interface LabConfig {host:string;projectId:string;personalKey:string;token:string;app:string}
export function labConfig():LabConfig {
 const file=process.env.RV_PH_ENV||'/root/briefs/ph-test.env'
 let env:Record<string,string>={}
 try{for(const line of readFileSync(file,'utf8').split('\n')){const m=/^([A-Z_]+)=(.*)$/.exec(line);if(m)env[m[1]]=m[2].trim().replace(/^['"]|['"]$/g,'')}}catch{}
 const projectId=process.env.POSTHOG_PROJECT_ID||env.TEAM,personalKey=process.env.POSTHOG_PERSONAL_API_KEY||env.PERSONAL_KEY,token=process.env.POSTHOG_PROJECT_TOKEN||env.PROJECT_TOKEN
 if(!projectId||!personalKey||!token)throw new Error('PostHog project id, personal key and project token required')
 return {host:process.env.POSTHOG_HOST||'http://127.0.0.1',projectId,personalKey,token,app:process.env.RV_ERP_URL||'http://127.0.0.1:8090'}
}
export async function recordingOptIn(c:LabConfig,on?:boolean):Promise<boolean>{
 const url=`${c.host}/api/projects/${encodeURIComponent(c.projectId)}/`
 const headers={authorization:`Bearer ${c.personalKey}`,'content-type':'application/json'}
 const before=await fetch(url,{headers,signal:AbortSignal.timeout(15_000)})
 if(!before.ok)throw new Error(`project_api_${before.status}`)
 const existing=!!(await before.json()).session_recording_opt_in
 if(on===undefined||on===existing)return existing
 const update=await fetch(url,{method:'PATCH',headers,body:JSON.stringify({session_recording_opt_in:on}),signal:AbortSignal.timeout(15_000)})
 if(!update.ok)throw new Error(`project_opt_in_${update.status}`)
 const check=await fetch(url,{headers,signal:AbortSignal.timeout(15_000)})
 if(!check.ok||!!(await check.json()).session_recording_opt_in!==on)throw new Error('project_opt_in_not_verified')
 return existing
}
export async function checkApplication(c:LabConfig){const r=await fetch(c.app+'/api/method/ping',{signal:AbortSignal.timeout(10_000)});if(!r.ok)throw new Error(`erpnext_${r.status}`)}
export const LAB_USER_PASSWORD='rv-lab-password'
const LAB_ROLES=['System Manager','Accounts User','Accounts Manager','Sales User','Sales Manager','Stock User','Stock Manager','Purchase User','Purchase Manager']
export async function ensureLabUsers(c:LabConfig,emails:string[]):Promise<void>{
 const login=await fetch(c.app+'/api/method/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usr:'Administrator',pwd:'admin'}),signal:AbortSignal.timeout(10_000)})
 const sid=/sid=([^;]+)/.exec(login.headers.get('set-cookie')||'')?.[1];if(!sid)throw new Error('erpnext_admin_login')
 for(const email of new Set(emails)){
  if(!/^rv\.[a-z0-9.]+@example\.test$/.test(email))throw new Error('invalid_lab_user')
  const get=await fetch(`${c.app}/api/resource/User/${encodeURIComponent(email)}`,{headers:{cookie:`sid=${sid}`},signal:AbortSignal.timeout(10_000)})
  if(get.ok){const existing=(await get.json()).data;const have=new Set((existing?.roles||[]).map((x:{role:string})=>x.role));if(LAB_ROLES.every(r=>have.has(r)))continue;const update=await fetch(`${c.app}/api/resource/User/${encodeURIComponent(email)}`,{method:'PUT',headers:{'content-type':'application/json',cookie:`sid=${sid}`},body:JSON.stringify({roles:LAB_ROLES.map(role=>({role}))}),signal:AbortSignal.timeout(15_000)});if(!update.ok)throw new Error(`erpnext_user_roles_${update.status}`);continue}
  if(get.status!==404)throw new Error(`erpnext_user_check_${get.status}`)
  const create=await fetch(c.app+'/api/resource/User',{method:'POST',headers:{'content-type':'application/json',cookie:`sid=${sid}`},body:JSON.stringify({email,first_name:'Replay Vision',last_name:email.split('@')[0],enabled:1,send_welcome_email:0,user_type:'System User',new_password:LAB_USER_PASSWORD,roles:LAB_ROLES.map(role=>({role}))}),signal:AbortSignal.timeout(15_000)})
  if(!create.ok)throw new Error(`erpnext_user_create_${create.status}`)
 }
}

export interface Fixtures {customer:string;item:string;supplier:string}
export async function ensureFixtures(c:LabConfig):Promise<Fixtures>{
 const login=await fetch(c.app+'/api/method/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usr:'Administrator',pwd:'admin'}),signal:AbortSignal.timeout(10_000)})
 const sid=/sid=([^;]+)/.exec(login.headers.get('set-cookie')||'')?.[1]
 if(!sid)throw new Error('erpnext_admin_login')
 const headers={cookie:`sid=${sid}`,'content-type':'application/json'}
 async function ensure(doctype:string,name:string,data:Record<string,unknown>){
  const url=`${c.app}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`
  const get=await fetch(url,{headers,signal:AbortSignal.timeout(10_000)})
  if(get.ok)return
  if(get.status!==404)throw new Error(`fixture_check_${doctype}_${get.status}`)
  const created=await fetch(`${c.app}/api/resource/${encodeURIComponent(doctype)}`,{method:'POST',headers,body:JSON.stringify(data),signal:AbortSignal.timeout(20_000)})
  if(!created.ok)throw new Error(`fixture_create_${doctype}_${created.status}_${(await created.text()).slice(0,180)}`)
 }
 const customer='RV Evaluation Customer',item='RV-EVAL-ITEM',supplier='RV Evaluation Supplier'
 await ensure('Customer',customer,{customer_name:customer,customer_type:'Company',customer_group:'Commercial',territory:'All Territories'})
 await ensure('Item',item,{item_code:item,item_name:'Replay Vision Evaluation Item',item_group:'Products',stock_uom:'Nos',is_stock_item:0,include_item_in_manufacturing:0})
 await ensure('Supplier',supplier,{supplier_name:supplier,supplier_type:'Company',supplier_group:'Local'})
 return {customer,item,supplier}
}
