// Phase 6: C′ frame gate. No frame leaves without opt-in, an unexpired approval of the exact frames and a
// verified image-capable model; a refused or failed frame step leaves findings untouched.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rv-frames-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
test.after(() => rmSync(dir, { recursive: true, force: true }))
const F = await import('../src/core/replay-vision-frames.ts')
const { run, one } = await import('../src/core/db.ts')
const { storeFindings } = await import('../src/core/replay-vision-insights.ts')

const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, n)])

test('frames need opt-in, an unexpired approval of the exact bytes and verified image input; findings are untouched', () => {
    run(`INSERT INTO rv_run(project_id, session_id, recording_end, analysis_version, mode, client_id, state) VALUES('1','frame-session-1','e','v','deterministic','C1','complete')`)
    const runId = one<{ id: number }>("SELECT id FROM rv_run WHERE session_id = 'frame-session-1'")!.id
    storeFindings(runId, 'frame-session-1', [{ kind: 'D10', start_ms: 1000, end_ms: 9000, score: 2, screen: 'x:new', element: 'Save', step: 'Save', event_ids: ['1'], facts: { wait_ms: 8000 }, limitations: [], strength: 'medium' }])
    const frames = [png(1), png(2)]
    const T0 = Date.parse('2026-11-26T12:00:00Z')
    const base = { runId, frames, prompt: 'Describe the visible overlay.', externalAllowed: true, imageInputVerified: true, now: T0 }
    assert.deepEqual(F.buildFrameRequest({ ...base, externalAllowed: false }), { ok: false, reason: 'external_analysis_off' })
    assert.deepEqual(F.buildFrameRequest({ ...base, imageInputVerified: false }), { ok: false, reason: 'image_input_not_verified' })
    assert.deepEqual(F.buildFrameRequest(base), { ok: false, reason: 'client_not_opted_in' })
    F.setClientVisionOptIn('C1', true, 'admin@x.test')
    assert.deepEqual(F.buildFrameRequest(base), { ok: false, reason: 'no_session_approval' })
    F.approveFrames(runId, frames, 'admin@x.test', T0)
    assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM rv_vision_approval WHERE redaction_digest = ?", F.framesDigest(frames))!.n, 1, 'digest only, no image bytes')
    assert.deepEqual(F.buildFrameRequest({ ...base, frames: [png(1), png(3)] }), { ok: false, reason: 'frames_differ_from_approved' })
    assert.deepEqual(F.buildFrameRequest({ ...base, frames: [png(1), png(2), png(3), png(4)] }), { ok: false, reason: 'frame_count' })
    assert.deepEqual(F.buildFrameRequest({ ...base, now: T0 + F.FRAME_LIMITS.approvalTtlMs + 1 }), { ok: false, reason: 'approval_expired' })
    const ok = F.buildFrameRequest(base)
    assert.equal(ok.ok, true)
    if (ok.ok) { const content = ok.params.messages[0]!.content as { type: string }[]; assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'text']) }
    F.setClientVisionOptIn('C1', false, 'admin@x.test')
    assert.deepEqual(F.buildFrameRequest(base), { ok: false, reason: 'client_not_opted_in' }, 'opt-out takes effect immediately')
    assert.equal(one<{ n: number }>('SELECT count(*) AS n FROM rv_finding WHERE run_id = ?', runId)!.n, 1, 'frame refusals never erase findings')
    assert.deepEqual(F.buildFrameRequest({ ...base, frames: [Buffer.from('GIF89a')] }).ok, false)
})
