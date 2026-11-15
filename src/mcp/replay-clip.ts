import type { Clip, ClipRequest, renderClip } from '../core/clip.ts'
import { clipInteger } from '../core/clip-queue.ts'

/** Keep recording after the response deadline; observe every background failure. */
export async function waitForReplayClip(req: ClipRequest, owner: string | undefined, deps: {
    render: typeof renderClip
    record: (clip: Clip) => Promise<void>
    backgroundError: (error: unknown) => void
}): Promise<Clip | undefined> {
    const waitMs = clipInteger(process.env.LENS_CLIP_MCP_WAIT_MS, 25000, 55000)
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const rendering = Promise.resolve().then(() => deps.render(req, owner)).then(async clip => {
        await deps.record(clip)
        return { clip }
    }).catch(error => {
        if (timedOut) deps.backgroundError(error)
        return { error }
    })
    try {
        const result = await Promise.race([
            rendering,
            new Promise<undefined>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(undefined) }, waitMs) }),
        ])
        if (!result) return undefined
        if ('error' in result) throw result.error
        return result.clip
    } finally { clearTimeout(timer) }
}
