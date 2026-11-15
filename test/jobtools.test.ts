import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { JobRunner } from '../src/core/jobs.ts'
import type { JobOptions } from '../src/mcp/jobtools.ts'
const dir = mkdtempSync(join(tmpdir(), 'lens-jobtools-'))
Object.assign(process.env, { TRIAGE_DB: join(dir, 'm.db'), TASKS_DB: join(dir, 't.db'), APP_EVENTS_FILE: 'config/app-events.reval.json' })
const { tasksDb } = await import('../src/core/tasks.ts')
const { storeAggregateDaily } = await import('../src/core/aggregatedaily.ts')
const { registerTools, wrapTools } = await import('../src/mcp/tools.ts')
const { db, all } = await import('../src/core/db.ts')
const { setAnonymise } = await import('../src/core/anonymise.ts')
const { installJobTools } = await import('../src/mcp/jobtools.ts')
const { jsonResult } = await import('../src/mcp/result.ts')
storeAggregateDaily(tasksDb, '2026-01-01', [])
after(() => { tasksDb.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
async function connect(who: string, options?: JobOptions) {
    const server = new McpServer({ name: 'test', version: '1' })
    const caller = { who, surveyRole: 'none' as const, dashboardRole: 'share' as const, admin: false }
    if (options) {
        installJobTools(server, wrapTools(server, false, caller, options))
        server.registerTool('aggregate_events', { inputSchema: { when: z.string().optional() } }, async () => { throw Error('raw callback should run in job work') })
    } else registerTools(server, undefined, caller)
    const client = new Client({ name: 'test', version: '1' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a); await client.connect(b)
    return { client, server, close: async () => { await client.close(); await server.close() } }
}
const args = { from: '2026-01-01', to: '2026-01-01' }
const call = (c: Client) => c.callTool({ name: 'aggregate_events', arguments: args })
const poll = (c: Client, id: string) => c.callTool({ name: 'get_job_result', arguments: { job_id: id } })
const text = (r: unknown) => JSON.stringify(r)
const handle = (r: unknown): string => JSON.parse((r as { content: { text: string }[] }).content[0].text).job_id
const rows = (who: string) => all<Record<string, unknown>>('SELECT * FROM tool_audit WHERE user_email=? ORDER BY id', who)
const memory = () => { const db = new DatabaseSync(':memory:'); const runner = new JobRunner(db); return { runner, close: () => { runner.close(); db.close() } } }
const turn = () => new Promise<void>(r => setImmediate(r))

test('ordinary MCP jobs execute raw callbacks in workers; native Tasks are not advertised', async () => {
    assert.throws(() => registerTools(new McpServer({ name: 'raw', version: '1' }), undefined, undefined, true), /reserved for isolated analysis workers/)
    const alice = await connect('worker-alice')
    try {
        const list = await alice.client.listTools()
        assert.equal(list.tools.find(t => t.name === 'aggregate_events')?.execution?.taskSupport, 'forbidden')
        assert.equal(alice.client.getServerCapabilities()?.tasks, undefined)
        const result = await call(alice.client)
        assert.ok(!result.isError, text(result)); assert.match(text(result), /coverage/)
        const row = rows('worker-alice')
        assert.equal(row.length, 1); assert.equal(row[0].error_kind, null); assert.equal(row[0].result_kind, 'job_result')
        // SDK refuses task augmentation for a tool without taskSupport, before any job can start.
        await assert.rejects(alice.client.request({ method: 'tools/call', params: { name: 'aggregate_events', arguments: args, task: { ttl: 60000 } } }, (await import('@modelcontextprotocol/sdk/types.js')).CreateTaskResultSchema))
    } finally { await alice.close() }
})

test('all job tools cost five; polling costs one and every refused call is audited', async () => {
    const m = memory(); let executions = 0
    const c = await connect('limited', { runner: m.runner, work: () => { executions++; return { promise: Promise.resolve({ content: [] }) } } })
    try {
        for (let i = 0; i < 12; i++) assert.ok(!(await call(c.client)).isError)
        const refused = await call(c.client)
        assert.equal(refused.isError, true); assert.match(text(refused), /Rate limit.*60 calls/); assert.equal(executions, 12)
        const refusedPoll = await poll(c.client, 'a'.repeat(32))
        assert.match(text(refusedPoll), /Rate limit/)
        const audit = rows('limited'); assert.equal(audit.length, 14)
        assert.equal(audit[12].error_kind, 'rate_limit'); assert.equal(audit[13].tool, 'get_job_result'); assert.equal(audit[13].error_kind, 'rate_limit')
    } finally { await c.close(); m.close() }
    const n = memory(), p = await connect('poll-limited', { runner: n.runner })
    try {
        for (let i = 0; i < 60; i++) assert.match(text(await poll(p.client, 'b'.repeat(32))), /Unknown or expired job id/)
        assert.match(text(await poll(p.client, 'b'.repeat(32))), /Rate limit/)
        assert.equal(rows('poll-limited').length, 61)
    } finally { await p.close(); n.close() }
})

test('strict time validation precedes job dispatch and workers receive resolved arguments', async () => {
    const m = memory(); let executions = 0
    const c = await connect('validation', { runner: m.runner, work: (_name, input, window) => {
        executions++; assert.equal(input.when, '2026-01-01 to 2026-01-01'); assert.equal(window?.from.toISOString(), '2026-01-01T00:00:00.000Z')
        return { promise: Promise.resolve({ content: [] }) }
    } })
    try {
        for (const input of [{ ...args, unknown: 'secret' }, { period: 'today', ...args }, { from: '2026-02-30', to: '2026-03-01' }]) {
            const result = await c.client.callTool({ name: 'aggregate_events', arguments: input })
            assert.equal(result.isError, true); assert.match(text(result), /Invalid arguments/)
        }
        assert.equal(executions, 0); assert.ok(!(await call(c.client)).isError); assert.equal(executions, 1)
        assert.equal(rows('validation').length, 4)
    } finally { await c.close(); m.close() }
})

for (const later of [false, true]) test(`internal job failures are mapped with correlation ids (${later ? 'poll' : 'immediate'})`, async () => {
    const m = memory(); let reject!: (e: Error) => void
    const c = await connect(`failure-${later}`, { runner: m.runner, budgetMs: later ? 1 : 1000, work: () => ({ promise: new Promise((_r, j) => { reject = j; if (!later) j(Error('/root/private/query.sql DB::Exception secret')) }) }) })
    try {
        let result = await call(c.client)
        if (later) { const id = handle(result); await turn(); reject(Error('/root/private/query.sql DB::Exception secret')); await turn(); result = await poll(c.client, id) }
        assert.equal(result.isError, true); assert.match(text(result), /Correlation id:/); assert.doesNotMatch(text(result), /\/root|DB::Exception|secret/)
        assert.equal(rows(`failure-${later}`).at(-1)?.error_kind, 'internal')
    } finally { await c.close(); m.close() }
})

for (const later of [false, true]) test(`job results get coverage, privacy filtering and hashed audit linkage (${later ? 'poll' : 'immediate'})`, async () => {
    setAnonymise({ mode: 'standard' })
    const m = memory(); let resolve!: (v: unknown) => void
    const raw = jsonResult('Analysis', { email: 'customer@example.com', cash: 123456789 })
    const c = await connect(`safe-${later}`, { runner: m.runner, budgetMs: later ? 1 : 1000, work: () => ({ promise: later ? new Promise(r => { resolve = r }) : Promise.resolve(raw) }) })
    try {
        let result = await call(c.client), id: string
        if (later) {
            id = handle(result)
            const start = rows(`safe-${later}`)[0]
            assert.equal(start.result_kind, 'job_started'); assert.equal(start.error_kind, null); assert.equal(start.is_error, 0)
            assert.equal(start.job_hash, createHash('sha256').update(id).digest('hex')); assert.ok(!text(start).includes(id))
            await turn(); resolve(raw); await turn(); result = await poll(c.client, id)
        } else id = String(m.runner.db.prepare('SELECT id FROM analysis_jobs').get()!.id)
        assert.ok(!result.isError, text(result)); assert.match(text(result), /coverage/); assert.match(text(result), /\[person\]/)
        assert.doesNotMatch(text(result), /customer@example.com|123456789/)
        const row = m.runner.db.prepare('SELECT * FROM analysis_jobs').get() as never
        assert.deepEqual(m.runner.result(row), raw) // persisted value has no boundary formatting
        const audit = rows(`safe-${later}`); assert.equal(audit.length, later ? 2 : 1)
        assert.equal(audit.at(-1)?.result_kind, 'job_result'); assert.ok(!text(audit).includes(id))
        assert.equal(audit.at(-1)?.job_hash, createHash('sha256').update(id).digest('hex'))
    } finally { await c.close(); m.close() }
})

test('stored jobs refuse changed privacy modes and hide missing, expired and other-user ids identically', async () => {
    setAnonymise({ mode: 'standard' })
    const m = memory(); let resolve!: (v: unknown) => void
    const a = await connect('privacy-owner', { runner: m.runner, budgetMs: 1, work: () => ({ promise: new Promise(r => { resolve = r }) }) })
    const b = await connect('privacy-other', { runner: m.runner })
    try {
        const id = handle(await call(a.client)); await turn(); resolve(jsonResult('', { email: 'customer@example.com' })); await turn()
        const other = await poll(b.client, id), missing = await poll(a.client, '0'.repeat(32))
        assert.match(text(other), /Unknown or expired job id/); assert.match(text(missing), /Unknown or expired job id/)
        setAnonymise({ mode: 'open' })
        const changed = await poll(a.client, id)
        assert.equal(changed.isError, true); assert.match(text(changed), /Privacy or access settings changed/); assert.doesNotMatch(text(changed), /customer@example.com/)
        assert.equal(rows('privacy-owner').at(-1)?.error_kind, 'privacy_changed')
        m.runner.db.prepare('UPDATE analysis_jobs SET expires=0 WHERE id=?').run(id)
        assert.match(text(await poll(a.client, id)), /Unknown or expired job id/)
    } finally { setAnonymise({ mode: 'standard' }); await a.close(); await b.close(); m.close() }
})


test('every background analysis uses the heavy limiter weight', async () => {
    const { JOB_TOOLS } = await import('../src/mcp/jobtools.ts')
    const { ToolLimiter } = await import('../src/mcp/ratelimit.ts')
    for (const name of JOB_TOOLS) assert.throws(() => new ToolLimiter(4, 600, 4).acquire('user', 'token', name), /Rate limit/, name)
})

test('read-only dispatch defaults to jobs, preserves fast/write results, and bounds newly covered tools',async()=>{
 const {jobBacked}=await import('../src/mcp/jobtools.ts')
 for(const name of ['reval_brief','session_story','task_map','flow_time','client_experience','new_read_only_tool'])assert.equal(jobBacked(name,true),true)
 for(const name of ['resolve_client','get_replay_link','find_task','list_dashboards','get_job_result'])assert.equal(jobBacked(name,true),false)
 assert.equal(jobBacked('save_survey',false),false)
 const m=memory(),server=new McpServer({name:'default-jobs',version:'1'})
 let finish!:(value:unknown)=>void,executions=0
 const dispatch=wrapTools(server,false,{who:'all-readonly'}, {runner:m.runner,budgetMs:5,work:(_n,_a,_w,execute)=>{executions++;return {promise:execute()}}})
 installJobTools(server,dispatch)
 server.registerTool('reval_brief',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>new Promise(r=>{finish=r}) as never)
 server.registerTool('resolve_client',{inputSchema:{},annotations:{readOnlyHint:true}},async()=>({content:[{type:'text',text:'fast result'}]}))
 server.registerTool('write_test',{inputSchema:{},annotations:{readOnlyHint:false}},async()=>({content:[{type:'text',text:'write result'}]}))
 const client=new Client({name:'new-tools',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair()
 await server.connect(a);await client.connect(b)
 try {
  assert.match(text(await client.callTool({name:'resolve_client',arguments:{}})),/fast result/)
  assert.match(text(await client.callTool({name:'write_test',arguments:{}})),/write result/)
  assert.equal(executions,0)
  const response=await client.callTool({name:'reval_brief',arguments:{}}),id=handle(response)
  assert.match(id,/^[0-9a-f]{32}$/);assert.equal(executions,1)
  finish({content:[{type:'text',text:'completed brief'}]});await turn()
  assert.match(text(await poll(client,id)),/completed brief/)
 }finally{await client.close();await server.close();m.close()}
})

test('worker pool reuses a small number of threads across sequential analytical calls',async()=>{
 const {AnalysisWorkerPool}=await import('../src/mcp/jobpool.ts')
 const pool=new AnalysisWorkerPool(1)
 try {
  const data={name:'aggregate_events',args:{when:'2026-01-01 to 2026-01-01'},window:{from:new Date('2026-01-01'),to:new Date('2026-01-02'),label:'test',precision:'range'}}
  const a=await pool.run(data).promise,b=await pool.run(data).promise
  assert.deepEqual(a,b)
  assert.equal((pool as unknown as {slots:unknown[]}).slots.length,1)
 }finally{pool.close()}
})
