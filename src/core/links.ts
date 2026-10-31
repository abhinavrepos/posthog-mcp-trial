// Signed, expiring links to clips. Replays show client data, so a clip URL is only valid with a
// signature from CLIP_LINK_SECRET and only until it expires.
import { createHmac, timingSafeEqual } from 'node:crypto'

import { config } from './config.ts'

function sign(name: string, exp: number, secret: string): string {
    return createHmac('sha256', secret).update(`${name}.${exp}`).digest('base64url')
}

export function clipUrl(name: string, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + Math.round(config.service.clipLinkTtlHours * 3600)
    const secret = config.service.clipLinkSecret
    const q = secret ? `?exp=${exp}&sig=${sign(name, exp, secret)}` : ''
    return `${config.service.publicUrl}/clips/${encodeURIComponent(name)}${q}`
}

export function verifyClipLink(name: string, exp: string | null, sig: string | null, secret = config.service.clipLinkSecret, now = Date.now()): boolean {
    if (!secret) return false
    if (!exp || !sig || !/^\d+$/.test(exp)) return false
    if (Number(exp) * 1000 < now) return false
    const want = Buffer.from(sign(name, Number(exp), secret))
    const got = Buffer.from(sig)
    return want.length === got.length && timingSafeEqual(want, got)
}
