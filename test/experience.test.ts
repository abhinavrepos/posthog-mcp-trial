// The product-manager layer over replay signals: which replays get read, findings against other clients,
// the Copilot tool and the Client story section. Real lab recordings drive the end-to-end part.
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

const dir = mkdtempSync(join(tmpdir(), 'xp-'))
process.env.TRIAGE_DB = join(dir, 'lens.db')
process.env.TASKS_DB = join(dir, 'tasks.db')
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
const { db } = await import('../src/core/db.ts')
const { tasksDb } = await import('../src/core/tasks.ts')
const X = await import('../src/core/experience.ts')
const { canaryStrings } = await import('../scripts/replay-lab/canaries.ts')
after(() => { db.close(); tasksDb.close(); rmSync(dir, { recursive: true, force: true }) })

const FIX = new URL('./fixtures/replay-lab/', import.meta.url)
const truth = JSON.parse(readFileSync(new URL('ground-truth.json', FIX), 'utf8'))
const sessions = Object.values(truth.sessions || truth) as { session_id: string; client_id: string; client_name: string; persona: string; duration_ms: number }[]
const fixture = (id: string) => readFileSync(new URL(readdirSync(FIX).find((f) => f.includes(id))!, FIX), 'utf8')
const today = new Date().toISOString().slice(0, 10)

test('fair order: every client gets replays read before any client gets many', () => {
    const list = [...Array(6)].map((_, i) => ({ session_id: 'a' + i, client: 'A', user: 'u', start: '' })).concat([{ session_id: 'b0', client: 'B', user: 'u', start: '' }, { session_id: 'c0', client: 'C', user: 'u', start: '' }])
    assert.deepEqual(X.fairOrder(list, 4).map((c) => c.client), ['A', 'B', 'C', 'A'])
})

test('real lab recordings: read, stored, and each persona comes out as it behaved', async () => {
    // Three rounds of the six personas (the same recordings under new ids) so every client has enough replays.
    const cands = sessions.flatMap((s) => [0, 1, 2].map((k) => ({ session_id: `${s.session_id}-${k}`, client: s.client_id, user: `${s.persona}-${k}@lab`, start: new Date().toISOString(), real: s.session_id, duration: s.duration_ms })))
    tasksDb.exec("CREATE TABLE IF NOT EXISTS client_names(client TEXT PRIMARY KEY, name TEXT NOT NULL)")
    for (const s of sessions) tasksDb.prepare('INSERT OR REPLACE INTO client_names VALUES (?,?)').run(s.client_id, s.client_name)
    const r = await X.processReplays(100, {
        candidates: async () => cands,
        jsonl: async (id) => fixture(cands.find((c) => c.session_id === id)!.real),
        durationMs: async (id) => cands.find((c) => c.session_id === id)!.duration,
        // The lab's labels, as Reval's own events would report them across clients.
        names: async () => ['Notional', 'Rate', 'Trade Date', 'Counterparty', 'Save', 'Preview'],
    })
    assert.equal(r.read, cands.length, JSON.stringify(r))
    const by = (persona: string) => X.clientExperience(sessions.find((s) => s.persona === persona)!.client_id)
    const smooth = by('smooth'), errors = by('error-looping'), rage = by('rage-dead'), scroll = by('scroll-hunting'), idle = by('idle')
    assert.equal(smooth.verdict, 'smooth', smooth.summary)
    assert.notEqual(errors.verdict, 'smooth'); assert.ok(errors.findings.some((f) => f.measure === 'loops' || f.measure === 'errors'), JSON.stringify(errors.findings))
    assert.ok(rage.findings.some((f) => f.measure === 'rage' || f.measure === 'dead'), JSON.stringify(rage.findings))
    assert.ok(scroll.findings.some((f) => f.measure === 'hunting'), JSON.stringify(scroll.measures))
    assert.ok(idle.findings.some((f) => f.measure === 'idle'), JSON.stringify(idle.measures))
    for (const x of [errors, rage]) {
        assert.ok(x.next_steps.length >= 1)
        assert.ok(x.findings[0].replays[0].url.includes('/replay/'), 'a replay link for the person to watch')
    }
    // Nothing planted in the replays comes out of any client's report.
    const all = JSON.stringify(sessions.map((s) => X.clientExperience(s.client_id))) + JSON.stringify(X.frictionHotspots())
    for (const c of canaryStrings) for (const v of [c, c.replace(/,/g, ''), c.toLowerCase()]) assert.ok(!all.includes(v), v)
})

test('screen vocabulary: only app-reported names, never generated ids, numbers or messages; PostHog down keeps the configured buttons', async () => {
    let sql = ''
    const names = await X.screenVocabulary({ hogql: async (q: string) => { sql = q; return [{ n: 'Trade Date' }, { n: 'gridfloatedit-3404-inputEl' }, { n: 'TRD-90210-77' }, { n: 'Counterparty' }] } } as never)
    assert.ok(names.includes('Trade Date') && names.includes('Counterparty') && names.includes('Save'))
    assert.ok(!names.includes('gridfloatedit-3404-inputEl') && !names.includes('TRD-90210-77'))
    assert.match(sql, /HAVING uniq\(c\) >= 3/); assert.match(sql, /NOT IN \('messagebox','toast','menuCmb'\)/); assert.match(sql, /'SEARCH', 'SEARCHTYPE'/)
})

test('too few replays: no findings, a clear note; a failed read is skipped once and not retried', async () => {
    const x = X.clientExperience('NOBODY')
    assert.equal(x.verdict, 'not enough replays'); assert.equal(x.findings.length, 0); assert.match(x.summary, /Only 0 replays/)
    const r1 = await X.processReplays(5, { candidates: async () => [{ session_id: 'broken', client: 'Z', user: 'u', start: today }], jsonl: async () => { throw new Error('bad blob') } })
    assert.deepEqual(r1, { read: 0, skipped: 1 })
    let asked = 0
    await X.processReplays(5, { candidates: async () => { asked++; return [] } })
    assert.equal(asked, 1)
    const r2 = await X.processReplays(5, { candidates: async () => [{ session_id: 'pending', client: 'Z', user: 'u', start: today }], jsonl: async () => { throw new Error('Recording pending has no stored snapshots yet') } })
    assert.equal(r2.skipped, 1)
    assert.equal(tasksDb.prepare("SELECT count(*) AS n FROM replay_skips WHERE session_id='pending'").get()!.n, 0, 'still being written: tried again later')
})

test('Copilot: client_experience answers in plain words with findings, next steps and links; friction_hotspots ranks places', async () => {
    const { registerDashboardTools } = await import('../src/mcp/dashboardtools.ts')
    const server = new McpServer({ name: 't', version: '1' })
    registerDashboardTools(server, { who: 'pm', email: 'pm@x', dashboardRole: 'view', surveyRole: 'none', admin: false, insights: true }, { rescueClients: (t: string) => sessions.filter((s) => s.client_id === t || s.client_name.toLowerCase() === t.toLowerCase()).slice(0, 1).map((s) => ({ id: s.client_id, name: s.client_name })) } as never)
    const client = new Client({ name: 't', version: '0' }); const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const name = sessions.find((s) => s.persona === 'error-looping')!.client_name
    const out = JSON.stringify(await client.callTool({ name: 'client_experience', arguments: { client: name } }))
    assert.match(out, /SOME FRICTION|STRUGGLING/); assert.match(out, /Next steps/); assert.match(out, /Usage:/); assert.match(out, /replay/)
    for (const c of canaryStrings) assert.ok(!out.includes(c), c)
    const hot = JSON.parse(((await client.callTool({ name: 'friction_hotspots', arguments: {} })) as any).content[0].text)
    assert.ok(hot.hotspots.length >= 1 && hot.replays_read >= 18, JSON.stringify(hot).slice(0, 300))
    await client.close(); await server.close()
})
