// Signed, expiring links to clips. Replays show client data, so a clip URL is only valid with a
// signature from CLIP_LINK_SECRET and only until it expires.
import { createHmac, timingSafeEqual } from 'node:crypto'

import { config } from './config.ts'

function sign(name: string, exp: number, secret: string, comments: boolean): string {
    return createHmac('sha256', secret).update(`${name}.${exp}.${comments ? 1 : 0}`).digest('base64url')
}

export function clipUrl(name: string, now = Date.now(), comments = false): string {
    const exp = Math.floor(now / 1000) + Math.round(config.service.clipLinkTtlHours * 3600)
    const secret = config.service.clipLinkSecret
    const q = secret ? `?exp=${exp}&sig=${sign(name, exp, secret, comments)}` : ''
    return `${config.service.publicUrl}/clips/${encodeURIComponent(name)}${q}${comments ? (q ? '&' : '?') + 'c=1' : ''}`
}

export function verifyClipLink(name: string, exp: string | null, sig: string | null, secret = config.service.clipLinkSecret, now = Date.now(), comments = false): boolean {
    if (!secret) return false
    if (!exp || !sig || !/^\d+$/.test(exp)) return false
    if (Number(exp) * 1000 < now) return false
    const want = Buffer.from(sign(name, Number(exp), secret, comments))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
}
