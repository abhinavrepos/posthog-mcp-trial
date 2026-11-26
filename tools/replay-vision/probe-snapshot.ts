// Root-cause probe for "recordings without a FullSnapshot" (Test Engineer, 2026-11-26).
// One fresh browser session through the proxy, then PostHog's public snapshot API is asked what it stored.
//   RV_BLOCK_SELECTOR=none  npx tsx tools/replay-vision/probe-snapshot.ts   -> default recorder config
//   (unset)                 npx tsx tools/replay-vision/probe-snapshot.ts   -> harness config (svg,script,style blocked)
//   --checkpoint            also calls the recorder's full-snapshot checkpoint after load (harness does this)
// Prints the /s/ upload sizes and HTTP statuses the browser saw and the rrweb event types the API returned.
import {spawn} from 'node:child_process'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import puppeteer from 'puppeteer'
import {labConfig,ensureLabUsers,recordingOptIn,LAB_USER_PASSWORD} from './setup.ts'

const c=labConfig();process.env.POSTHOG_HOST=c.host;process.env.POSTHOG_PROJECT_ID=c.projectId;process.env.POSTHOG_PERSONAL_API_KEY=c.personalKey
const {getRecording,getSnapshotsJsonl}=await import('../../src/core/posthog.ts')
const port=Number(process.env.RV_PROXY_PORT||8097),base=dirname(fileURLToPath(import.meta.url)),user='rv.probe.0@example.test'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const before=await recordingOptIn(c,true)
const proxy=spawn(process.execPath,['--import','tsx',join(base,'proxy.ts')],{env:{...process.env,RV_PROXY_PORT:String(port)},stdio:['ignore','pipe','inherit']})
try{
 await new Promise<void>((ok,no)=>{const t=setTimeout(()=>no(new Error('proxy_timeout')),10000);proxy.stdout!.on('data',d=>{if(String(d).includes('"proxy"')){clearTimeout(t);ok()}})})
 await ensureLabUsers(c,[user])
 const uploads:{bytes:number;status?:number}[]=[],pending=new Map<unknown,{bytes:number;status?:number}>()
 const browser=await puppeteer.launch({headless:'shell',args:['--no-sandbox',...(process.argv.includes('--headless-ua')?[]:['--disable-blink-features=AutomationControlled'])]})
 let session_id:string|null=null;const all:string[]=[]
 try{
  const page=await browser.newPage();await page.setViewport({width:1440,height:900})
  // posthog-js drops events from user agents containing HeadlessChrome (bot filter); the harness presents a desktop Chrome UA.
  if(!process.argv.includes('--headless-ua')){const major=/Chrome\/(\d+)/.exec(await browser.userAgent())?.[1]||'148';await page.setUserAgent({userAgent:`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`})}
  const login=await fetch(`http://127.0.0.1:${port}/api/method/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({usr:user,pwd:LAB_USER_PASSWORD})})
  const sid=/sid=([^;]+)/.exec(login.headers.get('set-cookie')||'')?.[1];if(!sid)throw new Error('login')
  await page.setCookie({name:'sid',value:sid,domain:'127.0.0.1',path:'/'},{name:'rv_user',value:user,domain:'127.0.0.1',path:'/'})
  page.on('request',r=>{if(new URL(r.url()).origin===new URL(c.host).origin&&all.length<60)all.push(r.method()+' '+new URL(r.url()).pathname)});page.on('request',r=>{if(new URL(r.url()).pathname==='/s/'&&r.method()==='POST'){const u={bytes:r.postData()?.length||0};uploads.push(u);pending.set(r,u)}})
  page.on('response',r=>{const u=pending.get(r.request());if(u)u.status=r.status()})
  await page.goto(`http://127.0.0.1:${port}/desk/sales-invoice/new`,{waitUntil:'domcontentloaded'})
  await page.waitForSelector('[data-fieldname="customer"] input',{visible:true,timeout:20000})
  await page.waitForFunction(()=>(window as any).posthog?.__loaded,{timeout:15000})
  if(process.argv.includes('--checkpoint'))await page.evaluate(()=>(window as any).posthog?.sessionRecording?._tryTakeFullSnapshot?.())
  session_id=await page.evaluate(()=>(window as any).posthog.get_session_id())
  await sleep(1500);await page.mouse.click(700,300);await page.mouse.move(400,400);await sleep(6000)
  await page.close();await sleep(1500)
 }finally{await browser.close()}
 const dir=await mkdtemp(join(tmpdir(),'rv-probe-')),file=join(dir,'s.jsonl')
 let types:Record<string,number>={},first:string|null=null,meta:any=null,lastErr=''
 for(let i=0;i<30&&!first;i++){
  try{meta=await getRecording(session_id!);await getSnapshotsJsonl(session_id!,file)
   types={};const lines=(await readFile(file,'utf8')).split('\n').filter(Boolean)
   for(const l of lines){const [,e]=JSON.parse(l);const k=e.type===3?`3:${e.data?.source}`:String(e.type);types[k]=(types[k]||0)+1}
   if(lines.length){const [,e]=JSON.parse(lines[0]);first=String(e.type)}
  }catch(e){lastErr=String((e as Error).message).slice(0,80)}
  if(!first)await sleep(3000)
 }
 await rm(dir,{recursive:true,force:true})
 if(process.argv.includes('--verbose'))console.error(all.join('\n'));console.log(JSON.stringify({headless_ua:process.argv.includes('--headless-ua'),block_selector:process.env.RV_BLOCK_SELECTOR||'svg,script,style',checkpoint:process.argv.includes('--checkpoint'),session_id,uploads,api:{start_time:meta?.start_time,first_event_type:first,event_types:types,error:first?undefined:lastErr}},null,1))
}finally{proxy.kill('SIGTERM');await recordingOptIn(c,before).catch(()=>{})}
