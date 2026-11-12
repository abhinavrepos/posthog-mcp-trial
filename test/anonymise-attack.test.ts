// Adversarial privacy checks (written by Codex as a red team): every way found to get a client name or code out
// of the anonymisation layer, and the known limits as skipped tests with the reason.
import baseAssert from 'node:assert/strict'
let assertions = 0
const assert: typeof baseAssert = new Proxy(baseAssert, { get(target, key) {
 const value = Reflect.get(target, key)
 return typeof value === 'function' ? (...args: unknown[]) => { assertions++; return Reflect.apply(value, target, args) } : value
} })
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { after, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
const dir = mkdtempSync(join(tmpdir(), 'anon-attack-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.POSTHOG_PERSONAL_API_KEY ||= 'phx_test'
const { db } = await import('../src/core/db.ts')
const A = await import('../src/core/anonymise.ts')
const G = await import('../src/mcp/anonymise.ts')
const P = await import('../src/mcp/posthog-proxy.ts')
const { refreshRoster } = await import('../src/core/anonroster.ts')
const { triage } = await import('../src/core/triage.ts')
const { codenameRedirect } = await import('../src/service/privacy.ts')
after(() => { console.log(`ATTACK_ASSERTIONS=${assertions}`); db.close(); rmSync(dir, { recursive: true, force: true }) })
const clients = [
 { id: 'ZQX', name: 'Quenlark Acme Holdings Ltd' },
 { id: 'ZX901', name: 'Vexquill' },
 { id: 'DELTA', name: 'Deltavane Treasury' },
 { id: 'OB77', name: "O'Brien & Sons Ltd" },
 { id: 'SG88', name: 'Société Générale Test' },
]
A.syncClients(clients)
A.setAnonymise({ on: true })
const cn = (id = 'ZQX') => A.codenameOf(id)!
const call = (args: unknown, name = 'echo') => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
function hidden(input: string, output: unknown, sensitive = input) {
 assert.ok(!JSON.stringify(output).includes(sensitive), `client leak input=${JSON.stringify(input)} output=${JSON.stringify(output)}`)
}
// Each attack has its own test so one leak never suppresses later assertions.
const forms: [string, string][] = [
 ['case', 'QUENLARK ACME HOLDINGS LTD'], ['lowercase', 'quenlark acme holdings ltd'],
 ...[' ', '  ', '\n', '\t', '_', '-', '.', '+', '%20', '%2D', '%5F'].map(s => [`separator ${JSON.stringify(s)}`, ['Quenlark','Acme','Holdings','Ltd'].join(s)] as [string,string]),
 ['markdown', '**Quenlark Acme Holdings Ltd**'], ['backticks', '`Quenlark Acme Holdings Ltd`'],
 ['possessive', "Vexquill's"], ['plural', 'Vexquills'],
 ['full width', 'Ｖｅｘｑｕｉｌｌ'], ['zero width', 'Vex\u200bquill'], ['Cyrillic', 'Vеxquill'], ['Greek', 'Quenlark Αcme Holdings Ltd'],
 ['HTML ampersand', "O'Brien &amp; Sons Ltd"], ['HTML apostrophe', 'O&#39;Brien & Sons Ltd'],
 ['JSON escaped', '\\u0056exquill'], ['stripped accents', 'Societe Generale Test'], ['added accents', 'Véxquill'],
 ['URL encoded punctuation', 'O%27Brien%20%26%20Sons%20Ltd'],
 ['accent canonical decomposition', 'Société Générale Test'.normalize('NFD')],
]
for (const [label, input] of forms) test(`output encoding: ${label}`, () => {
 const output = G.guardResponse({ text: input })
 // The entire distinctive spelling remains recoverable if present verbatim.
 hidden(input, output)
})
for (const c of clients) for (const input of [c.id, c.name, c.name.toUpperCase(), c.id.toLowerCase()]) {
 // Lowercase common words are intentionally ordinary prose; no claim that 'delta' is confidential here.
 if (input === 'delta') { test('common-word lowercase ambiguity', t => t.skip('delta is intentionally ordinary prose, not an unambiguous client identifier')); continue }
 for (const where of ['text', 'url path', 'url query', 'key', 'nested array', 'long']) test(`output ${where}: ${input}`, () => {
 const payload = where === 'key' ? { [input]: 1 } : where === 'nested array' ? [[[input]]] : where === 'url path' ? `https://example.test/${input}` : where === 'url query' ? `https://example.test/?q=${input}` : where === 'long' ? 'x '.repeat(20000) + input : input
 hidden(input, G.guardResponse(payload))
 })
}
const positions = (s: string) => [{ client: s }, { note: s }, { nested: { note: s } }, { list: [s] }, { [s]: 7 }, { note: JSON.stringify({ name: s }) }]
for (const c of clients) for (const [i, args] of positions(c.id).entries()) test(`inbound ${c.id} position ${i}`, () => {
 assert.ok(G.guardRequest(call(args)).answer, `real code must be refused: ${JSON.stringify(args)}`)
})
for (const c of clients) test(`inbound name ${c.name}`, () => {
 for (const args of positions(c.name)) assert.ok(G.guardRequest(call(args)).answer, `name refused ${JSON.stringify(args)}`)
})
// Known limit (Admin → Client privacy for AI explains it): free text in a tool or prompt argument that names a
// client is refused, so the refusal confirms that a guessed name is a client (never its codename).
for (const method of ['tools/call','prompts/get']) test(`oracle: ${method} free text`, (t) => t.skip('known limit: a refusal confirms a guessed name is a client, never its codename'))
for (const method of ['resources/read','completion/complete']) test(`oracle: ${method}`, () => {
 // A real downstream handler returns a constant acknowledgement. Compare only AI-visible answers.
 const probe = (value: string) => {
 const params = method === 'tools/call' || method === 'prompts/get' ? { name: 'echo', arguments: { note: value } } : method === 'resources/read' ? { uri: `lens://note/${value}` } : { argument: { name: 'note', value }, ref: { type: 'ref/prompt', name: 'echo' } }
 const g = G.guardRequest({ jsonrpc: '2.0', id: 1, method, params })
 return g.answer ?? G.guardResponse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'accepted' }] } })
 }
 const known = probe('ZX901'), unknown = probe('UNLISTED901')
 assert.equal(JSON.stringify(known), JSON.stringify(unknown), `membership oracle input=ZX901/UNLISTED901 output=${JSON.stringify([known,unknown])}`)
})
test('registry unknown names, case, extras and codename variants', () => {
 const reg = { tools: () => new Map([['echo', ['client']]]), prompts: () => new Map([['echo', ['client']]]) }
 for (const name of ['ZQX','ZX901','unknown','ECHO']) assert.deepEqual(G.guardRequest(call({},name),'lens_refused',reg).answer?.error, { code: -32602, message: 'Unknown tool.' }, `unknown tool ${name}`)
 for (const variant of [cn(),cn().toLowerCase(),A.slug(cn()),`  ${cn().replace(' ','   ')}  `]) {
 assert.equal(G.guardRequest(call({client:variant,extra:'ZX901'}),'lens_refused',reg).msg?.params.arguments.client,'ZQX',`codename works ${variant}`)
 assert.equal(A.clientOfCodename(variant),'ZQX',`codename lookup ${variant}`)
 assert.equal(A.revealCodenames(variant).trim(),'ZQX',`codename reveal ${variant}`)
 }
 assert.throws(() => G.revealArgs('echo',{client:'901'}), 'numeric string client refused')
 for (const args of positions('ZX901')) assert.ok(G.guardRequest(call(args)).answer, `sequence ${JSON.stringify(args)}`)
})
const exec = (command: string) => call({command},'exec')
for (const command of ['call execute-sql {}','call\u00a0execute-sql {}','call\u2003execute-sql {}','call\texecute-sql {}','call\r\nexecute-sql {}',' call execute-sql {} ', '"call" execute-sql {}','CALL execute-sql {}','call --json execute-sql {}','tools;call execute-sql {}','tools&call execute-sql {}','tools|call execute-sql {}','tools\ncall execute-sql {}','ca\\ll execute-sql {}','\\u0063all execute-sql {}','call execute-sql '+ ' '.repeat(20000)+'{}']) test(`proxy block ${JSON.stringify(command.slice(0,75))}`, () => {
 A.setAnonymise({on:true,posthog:'block'})
 assert.ok(P.anonRefusal(exec(command)).refusal, `data command refused ${JSON.stringify(command)}`)
})
test('empty command cannot itself retrieve data', () => { assert.ok(P.anonRefusal(exec('')).value, 'empty command harmless'); assert.ok(P.anonRefusal(exec('tools')).value, 'lookup allowed') })
class Capture extends Writable {
 statusCode=200; headersSent=false; chunks:Buffer[]=[]
 setHeader(_n:string,_v:string) {}
 writeHead(status:number,_headers:unknown={}) { this.statusCode=status;this.headersSent=true;return this }
 _write(c:Buffer,_e:BufferEncoding,cb:()=>void) { this.chunks.push(Buffer.from(c));cb() }
 get text() { return Buffer.concat(this.chunks).toString('utf8') }
}
async function invoke() {
 const req=Object.assign(Readable.from([JSON.stringify(exec('call execute-sql {}'))]),{method:'POST',url:'/posthog-mcp',headers:{authorization:'Bearer t','content-type':'application/json'}})
 const res=new Capture()
 await P.handlePosthogMcp(req as never,res as never,{url:'http://localhost/mcp',apiKey:'k',token:'t',name:'lens',enabled:true})
 return res.text
}
for (const sse of [false,true]) test(`proxy filter ${sse?'tiny-byte SSE':'JSON'}`,async t=>{
 A.setAnonymise({on:true,posthog:'filter'})
 await refreshRoster(0,{knownClients:async()=>clients})
 const data=JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:clients.map(c=>c.name+' '+c.id).join('; ')}]}})
 const body=sse?`event: message\ndata: ${data}\n\ndata: ZX901\n\n`:data
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(controller){for(const b of Buffer.from(body))controller.enqueue(Uint8Array.of(b));controller.close()}}),{headers:{'content-type':sse?'text/event-stream':'application/json'}}))
 const output=await invoke()
 for(const c of clients) { hidden(c.id,output);hidden(c.name,output) }
 assert.ok(output.includes(cn()),'proxy returned actual filtered upstream response')
})
test('triage AI receives anonymised fields and roster',async t=>{
 A.setAnonymise({on:true})
 t.mock.method(globalThis,'fetch',async(_u:unknown,init:RequestInit)=>new Response(JSON.stringify({columns:['id','name','events'],results:/GROUP BY id/.test(String(init?.body))?clients.map(c=>[c.id,c.name,10]):[]}),{headers:{'content-type':'application/json'}}))
 let sent:unknown
 const ticket={kind:'rci',key:'ZX901',summary:clients[0].name,description:clients[1].name,reporter:{name:clients[3].name,email:'user@external.example',timeZone:'UTC'},fields:{client:'ZX901',userEmail:'user@external.example',screen:clients[4].name},extra:{ZX901:clients[2].name}}
 await triage(ticket as never,{clip:false,ai:{async readTicket(t,ctx){sent={t,ctx};return {} }}})
 assert.ok(sent,'AI callback was reached')
 for(const c of clients){hidden(c.id,sent);hidden(c.name,sent)}
})
test('redirect client parameters and case variants; unrelated params untouched',()=>{
 for(const key of ['client','client_id','clients']) for(const value of [cn(),cn().toUpperCase(),A.slug(cn())]) {
 let location=''; const res={writeHead(_s:number,h:Record<string,string>){location=h.location},end(){}}
 assert.ok(codenameRedirect({method:'GET'} as never,res as never,new URL(`http://x/?${key}=${encodeURIComponent(value)}`)),`redirect ${key} ${value}`)
 assert.equal(new URL(location,'http://x').searchParams.get(key),'ZQX',`resolved ${key} ${value}`)
 }
 for(const [key,value] of [['q',cn()],['client','unknown-slug'],['screen',cn()]]) assert.equal(codenameRedirect({method:'GET'} as never,{} as never,new URL(`http://x/?${key}=${value}`)),false,`leave ${key}=${value}`)
})
test('same transport observes activation; rename and roster invalidation',async()=>{
 A.setAnonymise({on:false})
 const server=new McpServer({name:'attack',version:'1'})
 server.registerTool('echo',{inputSchema:{client:z.string()}},async()=>({content:[{type:'text',text:'ZX901 Vexquill'}]}))
 const client=new Client({name:'attack-client',version:'1'})
 const [a,b]=InMemoryTransport.createLinkedPair()
 await server.connect(a);G.guardTransport(a,G.registryOf(server));await client.connect(b)
 try {
 assert.ok(JSON.stringify(await client.callTool({name:'echo',arguments:{client:'ZX901'}})).includes('ZX901'),'off baseline')
 A.setAnonymise({on:true})
 hidden('ZX901',await client.callTool({name:'echo',arguments:{client:cn('ZX901')}}))
 A.syncClients([{id:'ZX901',name:'Newquill Ltd'}])
 for(const input of ['Vexquill','Newquill Ltd','ZX901']) hidden(input,G.guardResponse(input))
 A.hideClients('warm matcher')
 A.syncClients([{id:'NEW902',name:'Freshquill Ltd'}])
 for(const input of ['NEW902','Freshquill Ltd']) hidden(input,G.guardResponse(input))
 } finally {await client.close();await server.close()}
})
test('reversed/hex strings are outside best-effort filter guarantees',t=>t.skip('Filter mode explicitly documents arbitrary SQL re-encoding as unsupported; block mode is tested instead.'))
