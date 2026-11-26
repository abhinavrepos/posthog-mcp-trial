import puppeteer,{type Page} from 'puppeteer'
import {LAB_USER_PASSWORD,type LabConfig,type Fixtures} from './setup.ts'

export type Persona='Expert'|'Novice'|'Hurried'|'Careful'|'Explorer'|'Returning'
export type Workflow='invoice'|'purchase'|'item'|'report'
export type Friction='validation_loop'|'dead_button'|'hesitation'|'revisit'|'reopen'|'scroll_hunt'|'slow_wait'|'abandon'
export type Severity='High'|'Medium'|'Low'
export interface Plan {seed:number;phase:'calibration'|'heldout';user:string;persona:Persona;workflow:Workflow;injection?:Friction;dose?:number;planned_severity?:Severity;cohort?:string;cohort_users?:number;abandon_after?:boolean}
export interface Truth {id:string;session_id:string|null;kind:Friction;screen:string;element:string;t_start:number;t_end:number;screen_start?:string;expected_detectors:string[];expected_severity:Severity;dose:number;seed:number;observed:boolean}
export interface Captured {plan:Plan;session_id:string|null;started_at:string;ended_at:string;truth:Truth[];natural:{at:number;kind:string;screen:string;element:string;text:string}[];steps:{name:string;ok:boolean;at:number;detail?:string}[];upload_count:number;recording_started:boolean;network:string[];errors:string[]}

const route:Record<Workflow,string>={invoice:'/desk/sales-invoice/new',purchase:'/desk/purchase-order/new',item:'/desk/item/new',report:'/desk/query-report/Accounts%20Receivable'}
const expected:Record<Friction,string[]>={validation_loop:['D4','D7'],dead_button:['D1','D2'],hesitation:['D6','D8','D12'],revisit:['R1'],reopen:['R2'],scroll_hunt:['S1','S2','S3'],slow_wait:['D10'],abandon:['D5']}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
function rng(seed:number){let x=seed||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296}}
function pace(p:Persona){return {Expert:.65,Novice:1.6,Hurried:.5,Careful:1.2,Explorer:1.4,Returning:.85}[p]}
function screen(path:string){return path.replace(/\/new-[^/]+$/,'/new')}

class Driver {
 cursor={x:100,y:100}
 constructor(readonly page:Page,readonly random:()=>number,readonly speed:number){}
 async move(x:number,y:number){const from=this.cursor,d=Math.hypot(x-from.x,y-from.y),n=Math.max(3,Math.min(30,Math.round(d/24))),bend=(this.random()-.5)*Math.min(50,d*.2)
  for(let i=1;i<=n;i++){const t=i/n,c=4*t*(1-t)*bend;await this.page.mouse.move(from.x+(x-from.x)*t+c,from.y+(y-from.y)*t-c);await sleep(Math.max(10,Math.min(75,(100+160*Math.log2(1+d/80))*this.speed/n)))}this.cursor={x,y}}
 async click(selector:string){const e=await this.page.$(selector);const box=await e?.boundingBox();if(!box||box.width===0||box.height===0)return false;const x=box.x+box.width*(.3+.4*this.random()),y=box.y+box.height*(.3+.4*this.random());await this.move(x,y);await this.page.mouse.click(x,y);return true}
 async hover(selector:string){const e=await this.page.$(selector);const box=await e?.boundingBox();if(!box)return false;await this.move(box.x+box.width*.5,box.y+box.height*.5);return true}
 async type(selector:string,value:string,link=false){if(!await this.click(selector))return false;await this.page.keyboard.down('Control');await this.page.keyboard.press('A');await this.page.keyboard.up('Control');await this.page.keyboard.type(value,{delay:Math.round((24+70*this.random())*this.speed)});if(link){await this.page.waitForFunction((sel)=>{const input=document.querySelector(sel);return !!input?.closest('.awesomplete')?.querySelector('ul li')},{timeout:900},selector).catch(()=>{});await this.page.keyboard.press('ArrowDown');await this.page.keyboard.press('Enter')}else await this.page.keyboard.press('Tab');return true}
 async field(name:string,value:string,link=false){return this.type(`.frappe-control[data-fieldname="${name}"] > .link-field input, .frappe-control[data-fieldname="${name}"] > .control-input-wrapper input, .frappe-control[data-fieldname="${name}"] input`,value,link)}
 async gridField(table:string,row:number,name:string,value:string,link=false){const cell=`[data-fieldname="${table}"] .grid-row[data-idx="${row}"] [data-fieldname="${name}"]`;await this.click(cell);await sleep(120);return this.type(cell+' input',value,link)}
 async retypeFocused(selector:string,value:string,link=false){const element=await this.page.$(selector);if(!element)return false;await element.focus();await this.page.keyboard.down('Control');await this.page.keyboard.press('A');await this.page.keyboard.up('Control');await this.page.keyboard.type(value,{delay:Math.round((24+70*this.random())*this.speed)});if(link){await sleep(550);await this.page.keyboard.press('ArrowDown');await this.page.keyboard.press('Enter')}else await this.page.keyboard.press('Tab');return true}
 async wheel(selector:string,delta:number){const e=await this.page.$(selector),box=await e?.boundingBox();if(!box)return false;await this.move(box.x+box.width*.55,box.y+Math.min(box.height*.5,250));await this.page.mouse.wheel({deltaY:delta});await sleep(180+this.random()*200);return true}
}

export async function drivePlan(c:LabConfig,plan:Plan,fixtures:Fixtures):Promise<Captured>{
 const random=rng(plan.seed),proxy=`http://127.0.0.1:${process.env.RV_PROXY_PORT||8091}`,errors:string[]=[],network:string[]=[],truth:Truth[]=[],natural:Captured['natural']=[],steps:Captured['steps']=[]
 let session_id:string|null=null,upload_count=0,recording_started=false
 const started_at=new Date().toISOString(),browser=await puppeteer.launch({headless:'shell',args:['--no-sandbox','--disable-blink-features=AutomationControlled']})
 try{
  const page=await browser.newPage();await page.setViewport({width:1440,height:900})
  const major=/Chrome\/(\d+)/.exec(await browser.userAgent())?.[1]||'148'
  await page.setUserAgent({userAgent:`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`})
  const login=await fetch(proxy+'/api/method/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usr:plan.user,pwd:LAB_USER_PASSWORD}),signal:AbortSignal.timeout(15_000)})
  const sid=/sid=([^;]+)/.exec(login.headers.get('set-cookie')||'')?.[1]
  if(!sid)throw new Error(`persona_login_${login.status}`)
  await page.setCookie({name:'sid',value:sid,domain:'127.0.0.1',path:'/'},{name:'rv_case',value:plan.injection||'',domain:'127.0.0.1',path:'/'},{name:'rv_delay',value:String(plan.dose||0),domain:'127.0.0.1',path:'/'},{name:'rv_user',value:plan.user,domain:'127.0.0.1',path:'/'})
  page.on('request',r=>{if(r.url().startsWith(c.host+'/')){const path=new URL(r.url()).pathname;if(['/s/','/e/','/i/v0/e/'].includes(path)&&r.method()==='POST')upload_count++;if(network.length<30)network.push(`request ${r.method()} ${path} ${r.postData()?.length||0}B`)}})
  page.on('response',r=>{if(r.url().startsWith(c.host+'/')&&network.length<35)network.push(`response ${r.status()} ${new URL(r.url()).pathname}`)})
  page.on('requestfailed',r=>{if(r.url().startsWith(c.host+'/')&&errors.length<5)errors.push(`posthog_request_${r.failure()?.errorText||'failed'}`)})
  page.on('pageerror',e=>{if(errors.length<5)errors.push(`page_${String((e as Error)?.message??e).slice(0,100)}`)})
  page.on('dialog',dialog=>{void dialog.accept().catch(()=>{})})
  const d=new Driver(page,random,pace(plan.persona))
  async function go(path:string){await page.goto(proxy+path,{waitUntil:'domcontentloaded',timeout:15_000}).catch((e:unknown)=>{if(!String(e).includes('Navigation timeout'))throw e});await page.waitForSelector('.page-container',{timeout:15_000});await sleep(1000+400*random())}
  async function mark(kind:Friction,element:string,start:number,end:number,observed=true,startScreen?:string){if(!session_id)return;truth.push({id:`${plan.seed}:${truth.length}`,session_id,kind,screen:screen(await page.evaluate(()=>location.pathname)),...(startScreen?{screen_start:screen(startScreen)}:{}),element,t_start:start,t_end:end,expected_detectors:kind==='slow_wait'&&(plan.dose||0)<3000?[]:expected[kind],expected_severity:plan.planned_severity||'Low',dose:plan.dose||1,seed:plan.seed,observed})}
  async function step(name:string,ok:boolean,detail?:string){steps.push({name,ok,at:Date.now(),detail})}
  async function documentStatus(doctype:string):Promise<number|null>{const name=decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)||'');if(!name||name.startsWith('new-'))return null;const url=`${c.app}/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`;for(let attempt=0;attempt<4;attempt++){const r=await fetch(url,{headers:{cookie:`sid=${sid}`},signal:AbortSignal.timeout(5000)}).catch(()=>null);if(r?.ok)return Number((await r.json()).data?.docstatus);await sleep(450)}return null}
  async function collect(){const data=await page.evaluate(()=>({marks:(window as any).RV_TRUTH||[],dialogs:[...document.querySelectorAll('.modal.show .modal-body,.msgprint,[role="alert"]')].map(x=>(x as HTMLElement).innerText.trim().replace(/\s+/g,' ').slice(0,180)).filter(Boolean)}));for(const t of data.dialogs)natural.push({at:Date.now(),kind:/required|missing|invalid/i.test(t)?'validation':'dialog',screen:screen(new URL(page.url()).pathname),element:'unknown',text:t});return data}
  await go(route[plan.workflow])
  if(plan.workflow==='invoice'||plan.workflow==='purchase')await page.waitForSelector(`[data-fieldname="${plan.workflow==='invoice'?'customer':'supplier'}"] input`,{visible:true,timeout:15_000})
  if(plan.workflow==='invoice'||plan.workflow==='purchase')await page.waitForSelector('[data-fieldname="items"] .grid-row[data-idx="1"]',{visible:true,timeout:15_000})
  if(plan.workflow==='report')await page.waitForSelector('[data-fieldname="report_date"] input',{visible:true,timeout:15_000})
  await page.waitForFunction(()=>(window as any).posthog?.__loaded,{timeout:15_000}).catch(()=>errors.push('posthog_not_loaded'))
  session_id=await page.evaluate(()=>(window as any).posthog?.get_session_id?.()||null)
  recording_started=await page.evaluate(()=>(window as any).posthog?.sessionRecordingStarted?.()||false)
  // Identify/bootstrap and recorder startup may race on a fresh browser
  // profile. Request a full rrweb checkpoint in the identified session.
  await page.evaluate(()=>(window as any).posthog?.sessionRecording?._tryTakeFullSnapshot?.())
  await sleep(650)
  await step('opened_'+plan.workflow,!!session_id)
  if(plan.persona==='Novice'){await d.hover('.page-title');await sleep(1100)}
  if(plan.persona==='Hurried'){await d.hover('.page-title');await sleep(120)}
  if(plan.persona==='Careful'){await d.move(620,260);await sleep(700)}
  if(plan.persona==='Explorer'){await d.hover('.page-title');await sleep(450)}
  if(plan.injection==='hesitation'){
   const start=Date.now(),focused=await d.click('[data-fieldname="due_date"] input');await sleep(3000+Math.floor(random()*6000));await d.type('[data-fieldname="due_date"] input','28-12-2026');await d.click('[data-fieldname="due_date"] .control-label');const renamed=await page.evaluate(()=>(window as any).RV_TRUTH?.some((x:any)=>x.kind==='hesitation'&&x.phase==='start'));await mark('hesitation','Effective Value Date',start,Date.now(),focused&&renamed)
  }
  if(plan.injection==='dead_button'){
   const start=Date.now();let clicks=0;for(let i=0;i<5;i++){if(await d.click('#rv-dead-apply'))clicks++;await sleep(80+Math.floor(random()*80))}await sleep(2700);await mark('dead_button','Apply',start,Date.now(),clicks===5)
  }
  if(plan.injection==='revisit'){
   const start=Date.now();for(let i=0;i<2;i++){await go('/desk/customer');await go(route[plan.workflow])}await mark('revisit','Customer ↔ '+plan.workflow,start,Date.now())
  }
  if(plan.injection==='reopen'){
   const start=Date.now();for(let i=0;i<2;i++){await go('/desk/sales-invoice');await go(route[plan.workflow])}await mark('reopen','Sales Invoice',start,Date.now())
  }
  if(plan.injection==='scroll_hunt'){
   await go('/desk/item')
   const start=Date.now();let wheels=0;for(const delta of [1800,1800,-650,2200,-900,2600,-800,1900])if(await d.wheel('#rv-scroll-list',delta))wheels++
   const found=await d.click('#rv-scroll-list [data-rv-target="true"]');await mark('scroll_hunt','Item 190',start,Date.now(),wheels===8&&found)
   await go(route[plan.workflow])
  }
  if(plan.workflow==='invoice'||plan.workflow==='purchase'){
   const isInvoice=plan.workflow==='invoice'
   const partyField=isInvoice?'customer':'supplier',partyValue=isInvoice?fixtures.customer:fixtures.supplier
   const partyEntered=await d.field(partyField,partyValue,true)
   await step('party_input_attempted',partyEntered)
   if(isInvoice)await d.field('due_date','2026-12-26')
   else await d.field('schedule_date','2026-12-26')
   const itemOk=await d.gridField('items',1,'item_code',fixtures.item,true)
   const qtyOk=await d.gridField('items',1,'qty','2')
   const rateOk=await d.gridField('items',1,'rate','125')
   await step('line_item_entered',itemOk&&qtyOk&&rateOk,`item=${itemOk},qty=${qtyOk},rate=${rateOk}`)
   if(plan.injection==='abandon'){const start=Date.now();await d.click('[data-fieldname="items"] .control-label');await sleep(900);await mark('abandon','Items',start,Date.now());await go('/desk/customer')}
   else {
    const startScreen=await page.evaluate(()=>location.pathname),start=Date.now(),saveClicked=await d.click('.primary-action');if(plan.injection==='validation_loop'){await sleep(350);await d.retypeFocused('[data-fieldname="customer"] input',fixtures.customer,true);await d.click('.primary-action');await sleep(350);await d.retypeFocused('[data-fieldname="due_date"] input','28-12-2026');await d.click(plan.abandon_after?'#rv-validation-save':'.primary-action');const count=await page.evaluate(()=>(window as any).RV_TRUTH?.filter((x:any)=>x.kind==='validation_loop'&&x.phase==='error').length||0);await mark('validation_loop','Debit To',start,Date.now(),saveClicked&&count===2)
     if(plan.abandon_after){await sleep(2200);const left=Date.now();await d.hover('.page-title');await sleep(600);await mark('abandon','Items',left,Date.now(),count===2);await go('/desk/customer');await step('abandoned_after_errors',true)}}
    if(plan.injection==='slow_wait'&&!plan.abandon_after){await sleep((plan.dose||6000)+500);const marks=await page.evaluate(()=>(window as any).RV_TRUTH?.filter((x:any)=>x.kind==='slow_wait')||[]);await mark('slow_wait','Save',start,Date.now(),saveClicked&&marks.some((x:any)=>x.phase==='start')&&marks.some((x:any)=>x.phase==='end'),startScreen)}
    if(!plan.abandon_after){await sleep(1800);const saved=await page.evaluate(()=>!location.pathname.includes('/new-')&&!document.querySelector('.page-title')?.textContent?.includes('Not Saved'))
    await step('saved_draft',saved,saved?undefined:(await collect()).dialogs.join(' | ').slice(0,140))
    if(saved){const submit=await d.click('.primary-action');if(submit){await sleep(550);await d.click('.modal.show .btn-modal-primary');await sleep(1200)}const doctype=isInvoice?'Sales Invoice':'Purchase Order';let status=await documentStatus(doctype);for(let attempt=0;status!==1&&attempt<5;attempt++){await sleep(500);status=await documentStatus(doctype)}await step('submitted',status===1,`docstatus=${status??'unknown'}`)}}
   }
  }else if(plan.workflow==='item'){
   await d.field('item_code',`RV-EVAL-${plan.seed}`)
   await d.field('item_name',`Replay Vision Item ${plan.seed}`)
   await d.click('.primary-action');await sleep(1100)
   const saved=await page.evaluate(()=>!location.pathname.includes('/new-'));await step('item_created',saved)
   if(saved){await go('/desk/item');await d.field('name',`RV-EVAL-${plan.seed}`);await step('item_list_searched',true)}
  }else {
   await sleep(500)
   const dateSet=await d.type('[data-fieldname="report_date"] input','01-11-2026')
   await page.keyboard.press('Enter');await sleep(650)
   const grouped=await d.click('[data-fieldname="group_by_party"] input')
   await sleep(700)
   const values=await page.evaluate(()=>({date:(window as any).frappe?.query_report?.get_filter_value?.('report_date'),group:(window as any).frappe?.query_report?.get_filter_value?.('group_by_party')}))
   await step('report_filters_applied',dateSet&&grouped&&String(values.date||'').includes('2026-11-01'),JSON.stringify(values))
   const down=await d.wheel('.page-container',530),up=await d.wheel('.page-container',-240)
   await step('report_inspected',down&&up)
  }
  await collect()
  await page.evaluate(()=>(window as any).posthog?.capture?.('rv_lab_complete',{rv_lab:true}))
  await sleep(3400)
  await page.close()
 }catch(e){errors.push(e instanceof Error?e.message.slice(0,180):'drive_error')}
 finally{await browser.close().catch(()=>{})}
 return {plan,session_id,started_at,ended_at:new Date().toISOString(),truth,natural,steps,upload_count,recording_started,network,errors}
}
