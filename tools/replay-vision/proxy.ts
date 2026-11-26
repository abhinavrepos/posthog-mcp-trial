import {createServer,request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {labConfig} from './setup.ts'
import {injectionScript} from './injections.ts'

// RV_BLOCK_SELECTOR=none reproduces the default recorder config (used only for the root-cause A/B probe).
const blockSelector=process.env.RV_BLOCK_SELECTOR||'svg,script,style'
const config=labConfig(),upstreamUrl=new URL(config.app),port=Number(process.env.RV_PROXY_PORT||8091)
// The PostHog loader retrieves unmodified array.js and recorder assets locally.
const posthogScript=(user:string)=>`<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog&&window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],o="init capture identify get_session_id sessionRecordingStarted startSessionRecording".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(config.token)},{api_host:${JSON.stringify(config.host)},defaults:'2025-05-24',person_profiles:'identified_only',capture_pageview:true,session_recording:${blockSelector==='none'?'{}':JSON.stringify({blockSelector})},bootstrap:{distinctID:${JSON.stringify(user)},isIdentifiedID:true}});</script>`
const server=createServer((req,res)=>{
 const path=req.url||'/'
 if(!path.startsWith('/')||path.startsWith('//')){res.writeHead(400);res.end('Invalid path');return}
 const requester=upstreamUrl.protocol==='https:'?httpsRequest:httpRequest
 const upstream=requester(new URL(path,upstreamUrl),{method:req.method,headers:{...req.headers,host:upstreamUrl.host,'accept-encoding':'identity'}},response=>{
  const type=String(response.headers['content-type']||'')
  const html=/^\/(desk|app)(\/|\?|$)/.test(path)&&type.includes('text/html')
  if(!html){res.writeHead(response.statusCode||502,response.headers);response.pipe(res);return}
  const chunks:Buffer[]=[];let bytes=0
  response.on('data',chunk=>{bytes+=chunk.length;if(bytes<=8*1024*1024)chunks.push(chunk)})
  response.on('end',()=>{
   if(bytes>8*1024*1024){res.writeHead(502);res.end('ERPNext HTML exceeds proxy limit');return}
   const body=Buffer.concat(chunks).toString('utf8')
   if(!body.includes('</head>')){res.writeHead(502);res.end('ERPNext head missing');return}
   const caseId=/\brv_case=([a-z_]+)/.exec(String(req.headers.cookie||''))?.[1]||''
   const dose=Math.min(15_000,Math.max(0,Number(/\brv_delay=(\d+)/.exec(String(req.headers.cookie||''))?.[1]||0)))
   const user=decodeURIComponent(/\brv_user=([^;]+)/.exec(String(req.headers.cookie||''))?.[1]||'')
   const distinctId=/^rv\.[a-z0-9.]+@example\.test$/.test(user)?user:'rv.unknown@example.test'
   const output=body.replace('</head>',posthogScript(distinctId)+`<script>${injectionScript(JSON.stringify(caseId),dose)}</script></head>`)
   const headers={...response.headers,'content-length':Buffer.byteLength(output)};delete headers['content-encoding']
   res.writeHead(response.statusCode||502,headers);res.end(output)
  })
 })
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('ERPNext unavailable')})
 req.pipe(upstream)
})
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({proxy:`http://127.0.0.1:${port}`,upstream:config.app})))
