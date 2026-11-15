import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
const dir = mkdtempSync(join(tmpdir(), 'privacy-scope-'))
process.env.TRIAGE_DB = join(dir, 'm.db'); process.env.TASKS_DB = join(dir, 't.db')
const A = await import('../src/core/anonymise.ts')
after(() => rmSync(dir, { recursive: true, force: true }))
test('a new client codename invalidates in-flight answers only in private mode', () => {
    // Found by the agent evaluation: the first call after start-up synced the roster and was refused as
    // "Privacy settings changed" in standard mode, where codenames are not used.
    A.setAnonymise({ mode: 'standard' })
    assert.equal(A.withPrivacy(() => { A.syncClients([{ id: 'NEW1', name: 'Quorvane Ltd' }]); return A.privacyCurrent() }), true)
    A.setAnonymise({ mode: 'private' })
    assert.equal(A.withPrivacy(() => { A.syncClients([{ id: 'NEW2', name: 'Velquist Group' }]); return A.privacyCurrent() }), false)
    A.setAnonymise({ mode: 'standard' })
})
