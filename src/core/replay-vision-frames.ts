/**
 * C′ keyframe gate (architecture "C′ keyframe vision"). Frames can show personal data even when rrweb
 * masked inputs, so a frame request is built only when ALL of these hold:
 *   - the feature and external analysis are on;
 *   - the session's client has vision_opt_in (rv_client_policy, admin-set);
 *   - an admin approved THIS run's frames (rv_vision_approval) after reviewing and redacting them, the
 *     approval has not expired, and the SHA-256 digest of the exact PNG bytes offered now equals the
 *     digest recorded at approval (any change after review → refused);
 *   - the model's image input capability was verified through the Models API;
 *   - at most 3 frames, each a PNG of at most 2 MiB.
 * Automated Monitor runs never call this. A refusal or a frame failure never touches findings: this
 * module only reads policy rows and returns params or a reason.
 */
import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import { one, run } from './db.ts'
import { DEFAULT_MODEL, LIMITS } from './replay-vision-provider.ts'

export const FRAME_LIMITS = Object.freeze({ maxFrames: 3, maxBytes: 2 * 1024 * 1024, approvalTtlMs: 24 * 3600_000 })
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function framesDigest(frames: Buffer[]): string {
    const h = createHash('sha256')
    for (const f of frames) h.update(createHash('sha256').update(f).digest())
    return h.digest('hex')
}
export function setClientVisionOptIn(clientId: string, on: boolean, by: string): void {
    run(`INSERT INTO rv_client_policy(client_id, vision_opt_in, updated_by, updated_at) VALUES(?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET vision_opt_in = excluded.vision_opt_in, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        clientId.slice(0, 120), on ? 1 : 0, by.slice(0, 200), new Date().toISOString())
}
/** Record an admin's approval of the reviewed, redacted frames of one run (digest only, never image bytes). */
export function approveFrames(runId: number, frames: Buffer[], by: string, now = Date.now()): string {
    const digest = framesDigest(frames)
    run(`INSERT INTO rv_vision_approval(run_id, approved_by, approved_at, redaction_digest, expires_at) VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET approved_by = excluded.approved_by, approved_at = excluded.approved_at, redaction_digest = excluded.redaction_digest, expires_at = excluded.expires_at`,
        runId, by.slice(0, 200), new Date(now).toISOString(), digest, new Date(now + FRAME_LIMITS.approvalTtlMs).toISOString())
    return digest
}

export type FrameGate = { ok: true; params: Anthropic.MessageCreateParamsNonStreaming } | { ok: false; reason: string }
export function buildFrameRequest(input: { runId: number; frames: Buffer[]; prompt: string; externalAllowed: boolean; imageInputVerified: boolean; model?: string; now?: number }): FrameGate {
    const now = input.now ?? Date.now()
    if (!input.externalAllowed) return { ok: false, reason: 'external_analysis_off' }
    if (!input.imageInputVerified) return { ok: false, reason: 'image_input_not_verified' }
    const r = one<{ client_id: string | null }>('SELECT client_id FROM rv_run WHERE id = ?', input.runId)
    if (!r?.client_id) return { ok: false, reason: 'no_client' }
    if (!one(`SELECT 1 FROM rv_client_policy WHERE client_id = ? AND vision_opt_in = 1`, r.client_id)) return { ok: false, reason: 'client_not_opted_in' }
    const a = one<{ redaction_digest: string; expires_at: string }>('SELECT redaction_digest, expires_at FROM rv_vision_approval WHERE run_id = ?', input.runId)
    if (!a) return { ok: false, reason: 'no_session_approval' }
    if (Date.parse(a.expires_at) <= now) return { ok: false, reason: 'approval_expired' }
    if (!input.frames.length || input.frames.length > FRAME_LIMITS.maxFrames) return { ok: false, reason: 'frame_count' }
    if (input.frames.some((f) => f.length > FRAME_LIMITS.maxBytes || !f.subarray(0, 8).equals(PNG))) return { ok: false, reason: 'frame_format' }
    if (framesDigest(input.frames) !== a.redaction_digest) return { ok: false, reason: 'frames_differ_from_approved' }
    return {
        ok: true,
        params: {
            model: input.model ?? DEFAULT_MODEL, max_tokens: LIMITS.maxTokens,
            messages: [{ role: 'user', content: [...input.frames.map((f) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: f.toString('base64') } })), { type: 'text' as const, text: input.prompt.slice(0, 4000) }] }],
        },
    }
}
