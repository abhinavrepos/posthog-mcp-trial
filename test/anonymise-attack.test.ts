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
const DB = await import('../src/core/db.ts'); const { db } = DB
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

// Round 2: keep each fixture/settings change local; earlier rounds rename ZX901.
const round2Defaults = { on: true, lens: true, posthog: 'block', triage: true, codes: true, emails: true, message: '', round: false } as const
function round2Test(name: string, run: () => void | Promise<void>) {
 test(`round 2: ${name}`, async () => {
  const before = A.anonSettings()
  try { A.setAnonymise(round2Defaults); await run() } finally { A.setAnonymise(before) }
 })
}
function round2Fixture() { A.syncClients([{ id: 'RTK91', name: 'Kwambe Fintrust Holdings' }, { id: 'RTN92', name: 'Northwind Treasury' }, { id: 'BETA', name: 'Zorquill Financial' }]) }
for (const input of ['Nortwind', 'Northwnid', 'Northwiind', 'NorthwXnd']) round2Test(`one-edit spelling ${input}`, () => {
 round2Fixture(); hidden(input, G.guardResponse(input))
 assert.ok(G.guardRequest(call({ note: input })).answer, `one-edit input=${input} must be refused`)
})
for (const [input, reason] of [
 ['Nxrthwxnd', 'Two substitutions exceed the documented one-typo limit.'],
 ['Nor.thwind', 'Punctuation inside a word is outside letter-only fuzzy token matching.'],
 ['North-wind', 'Splitting one word is outside the documented word-level typo matcher.'],
 ['North wind', 'Splitting one word into two is outside the documented word-level typo matcher.'],
 ['N0rthw1nd', 'Two leetspeak substitutions exceed the one-typo limit.'],
 ['K.F.H.', 'Automatic initials are documented as contiguous capitals (KFH); dotted aliases require configuration.'],
 ['K F H', 'Automatic initials are documented as contiguous capitals (KFH); spaced aliases require configuration.'],
] as const) test(`round 2 known limit: ${input}`, t => t.skip(reason))
round2Test('capital initials and Title-case common codes', () => {
 round2Fixture()
 for (const input of ['KFH', 'BETA', 'Beta']) hidden(input, G.guardResponse(input))
 assert.equal(G.guardResponse('beta release'), 'beta release')
})
round2Test('codes off still hides names, initials and typos', () => {
 round2Fixture(); A.setAnonymise({ codes: false })
 assert.equal(G.guardResponse('RTK91'), 'RTK91')
 assert.equal(G.guardRequest(call({ client: 'RTK91' })).msg?.params.arguments.client, 'RTK91')
 for (const input of ['Kwambe Fintrust Holdings', 'KFH', 'Northwnid']) hidden(input, G.guardResponse(input))
})
round2Test('emails off preserves email and re-enabling invalidates cached matcher', () => {
 const input = 'person@outside-example.test'
 A.setAnonymise({ emails: false }); assert.equal(G.guardResponse(input), input)
 assert.ok(G.guardRequest(call({ note: input })).msg)
 A.setAnonymise({ emails: true }); hidden(input, G.guardResponse(input))
 assert.ok(G.guardRequest(call({ note: input })).answer)
})
round2Test('lens off leaves PostHog block and triage active', () => {
 A.setAnonymise({ lens: false, posthog: 'block' })
 assert.deepEqual(['lens','posthog','triage'].map(p => A.anonFor(p as 'lens' | 'posthog' | 'triage')), [false,true,true])
 assert.equal(G.guardResponse('ZX901'), 'ZX901')
 assert.ok(P.anonRefusal(exec('call execute-sql {}')).refusal)
 hidden('ZX901', G.guardResponse('ZX901', 'posthog_cleaned'))
})
for (const method of ['tools/call', 'prompts/get']) round2Test(`custom refusal does not leak names through ${method}`, () => {
 const input = 'Contact Quenlark Acme Holdings Ltd for access.'
 // Saving a message that names a client is refused; one stored before that rule is cleaned when sent.
 assert.throws(() => A.setAnonymise({ message: input }), /names a client/)
 const { setSetting } = DB
 setSetting('anon', { ...A.anonSettings(), message: input }); A.forgetMatcher()
 const request = { ...call({ client: 'ZQX' }), method }
 const output = G.guardRequest(request).answer
 assert.ok(output, 'refusal path reached')
 hidden(input, output, 'Quenlark Acme Holdings Ltd')
 setSetting('anon', { ...A.anonSettings(), message: '' }); A.forgetMatcher()
})
round2Test('UUID parts remain unchanged, standalone hex client code is hidden', () => {
 A.syncClients([{ id: 'deadbeef', name: 'Hexquartz Treasury' }])
 const uuid = 'deadbeef-1234-4567-89ab-0123456789ab'
 assert.equal(G.guardResponse(uuid), uuid)
 hidden('deadbeef', G.guardResponse('deadbeef'))
})
test('round 2 known limit: UUID-shaped code smuggling', t => t.skip('UUIDs are explicitly never altered, even when a hex component equals a client code; changing this would violate UUID protection.'))
const jsonFence = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```'
const fromFence = (text: string) => JSON.parse(text.slice(8, text.lastIndexOf('\n```')))
round2Test('JSON camelCase count keys and deeply nested arrays', () => {
 const input = { eventCount: 1234, users: [[1234, 5678]], rows: [[{ sessionCount: 9876 }]], userId: 1234, eventRate: 1234 }
 assert.deepEqual(fromFence(A.roundCounts(jsonFence(input))), { eventCount: 1200, users: [[1200,5700]], rows: [[{sessionCount:9900}]], userId:1234,eventRate:1234 })
})
for (const [input, reason] of [
 ['There were 1234 events.', 'Prose counts are explicitly outside JSON-block rounding.'],
 [jsonFence({eventCount:'1234'}), 'Numeric strings are strings, outside numeric count rounding.'],
] as const) test(`round 2 known rounding limit: ${input}`, t => t.skip(reason))
round2Test('round switch changes response JSON counts immediately', () => {
 const input = { content: [{ type: 'text', text: jsonFence({ eventCount:1234 }) }] }
 assert.equal(G.guardResponse(input).content[0].text, input.content[0].text)
 A.setAnonymise({ round:true })
 assert.equal(fromFence(G.guardResponse(input).content[0].text).eventCount,1200)
})
round2Test('structured numeric arrays obey the same count policy as JSON fences', () => {
 A.setAnonymise({ round:true })
 const input = { users:[[1234]], eventCount:1234 }
 const output = G.guardResponse(input)
 assert.deepEqual(output, {users:[[1200]],eventCount:1200}, `rounding bypass input=${JSON.stringify(input)} output=${JSON.stringify(output)}`)
})
round2Test('structured counts include errors and hits, like JSON fences', () => {
 A.setAnonymise({ round:true })
 const input = { errors:1234, hits:5678 }
 const output = G.guardResponse(input)
 assert.deepEqual(output, {errors:1200,hits:5700}, `rounding bypass input=${JSON.stringify(input)} output=${JSON.stringify(output)}`)
})
// Generate cryptographically valid URLs, then change only URL syntax accepted by the real verifier.
for (const variant of ['canonical', 'query order', 'extra parameter', 'encoded filename', 'encoded query keys', 'relative'] as const) round2Test(`signed clip URL ${variant}`, async () => {
 const L = await import('../src/core/links.ts')
 const secret = 'round-two-test-secret'
 const { createHmac } = await import('node:crypto')
 const name = 'attack_0-10.mp4'
 const exp = String(Math.floor(Date.now()/1000)+3600)
 const sig = createHmac('sha256',secret).update(`${name}.${exp}`).digest('base64url')
 const original = `https://lens.example/clips/${name}?exp=${exp}&sig=${sig}`
 const url = new URL(original, 'https://lens.example')
 assert.ok(L.verifyClipLink(name,url.searchParams.get('exp'),url.searchParams.get('sig'),secret))
 if (variant === 'query order') url.search = `?sig=${url.searchParams.get('sig')}&exp=${url.searchParams.get('exp')}`
 if (variant === 'extra parameter') url.search = '?download=1&' + url.search.slice(1)
 let input = url.href
 if (variant === 'encoded filename') input = input.replace(name,'%61ttack_0-10.mp4')
 if (variant === 'encoded query keys') input = input.replace('exp=','%65xp=').replace('sig=','%73ig=')
 if (variant === 'relative') input = url.pathname + url.search
 const parsed = new URL(input, 'https://lens.example')
 assert.ok(L.verifyClipLink(decodeURIComponent(parsed.pathname.split('/').at(-1)!),parsed.searchParams.get('exp'),parsed.searchParams.get('sig'),secret))
 const output = G.guardResponse(input)
 assert.ok(!output.includes('/clips/'), `signed clip leak input=${input} output=${output}`)
 assert.ok(output.includes('/replays?clip='), `sign-in link input=${input} output=${output}`)
 assert.equal(output, `${variant === 'relative' ? '' : 'https://lens.example'}/replays?clip=${name}`, `rewrite must consume the entire signed URL input=${input} output=${output}`)
})
round2Test('unknown-client hook masks nested client fields even if callback throws', () => {
 let calls = 0
 A.whenUnknownClient(() => { calls++; throw new Error('refresh unavailable') })
 try {
  assert.deepEqual(A.hideClientsDeep({ clients:[['UNLISTED_ROUND_TWO']] }).value, {clients:[['[client]']]})
  assert.equal(calls,1)
 } finally { A.whenUnknownClient(() => {}) }
})
round2Test('MCP instructions put privacy first only when Lens coverage is on', async () => {
 const { serverInstructions } = await import('../src/mcp/instructions.ts')
 assert.ok(serverInstructions(false).startsWith('Clients are known here only by codename'))
 A.setAnonymise({ lens:false })
 assert.ok(!serverInstructions(false).includes('Clients are known here only by codename'))
})
round2Test('false-positive observations (notes, not failures)', () => {
 round2Fixture()
 for (const input of ['Beta testing is complete.', 'A north wind is forecast.', 'The northwinds are cold.', 'The KFH protocol is enabled.']) {
  const output = G.guardResponse(input)
  if (output !== input) console.log(`ROUND2_FALSE_POSITIVE input=${JSON.stringify(input)} output=${JSON.stringify(output)}`)
 }
})
// Last: include cold matcher construction, exclude roster provisioning; no earlier case pays for this roster.
round2Test('200 KB answer with 2,000 clients cleans within 1.5 seconds', () => {
 const roster = Array.from({length:2000}, (_,i) => {
  let n=i, suffix=''; do { suffix=String.fromCharCode(97+n%26)+suffix; n=Math.floor(n/26) } while(n)
  return {id:`PERF${i.toString().padStart(4,'0')}`,name:`Zyvq${suffix.padStart(4,'a')} Treasury`}
 })
 A.syncClients(roster)
 const lead = roster.map(c => c.id).join(' ') + '\n'
 const input = lead + 'ordinary telemetry measurements completed successfully. '.repeat(Math.ceil((204800-lead.length)/55)).slice(0,204800-lead.length)
 assert.equal(Buffer.byteLength(input),204800)
 const start=performance.now()
 const output=G.guardResponse(input)
 const elapsed=performance.now()-start
 console.log(`ROUND2_PERFORMANCE bytes=${input.length} clients=${roster.length} elapsed_ms=${elapsed.toFixed(1)}`)
 assert.ok(!/PERF\d{4}/.test(output), 'all 2,000 client codes must be cleaned')
 assert.ok(elapsed<1500, `200 KB / 2,000 clients took ${elapsed.toFixed(1)}ms; budget 1500ms`)
})
