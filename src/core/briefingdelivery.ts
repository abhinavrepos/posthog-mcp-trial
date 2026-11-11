// Opt-in delivery. The persisted slot also acts as a cross-process claim.
import { config } from './config.ts'
import { getSetting, setSetting, tx } from './db.ts'
import { mondayBrief, type MondayBrief } from './briefing.ts'
import { rescuePrivacy } from './rescueprivacy.ts'

const LAST = 'briefing_last_sent', CLAIM = 'briefing_delivery_claim'
const DAYS = ['sun','mon','tue','wed','thu','fri','sat']
export const briefingDeliveryStatus = () => ({ enabled: !!config.briefing.webhook, day: config.briefing.day, hour: config.briefing.hour, last_sent: getSetting<string | null>(LAST, null) })
export function briefingMessage(b: MondayBrief, publicUrl: string): string {
    const lines = [b.headline]
    const labels = { new_or_worse: 'New or worse', close_soon: 'Close soon', overdue: 'Overdue' }
    for (const k of ['new_or_worse','close_soon','overdue'] as const) {
        const items = b.sections[k].slice(0,5)
        lines.push(`${labels[k]}: ${b.counts[k] ?? b.sections[k].length}`)
        for (const i of items) lines.push(`• ${i.client_name}: ${i.text}`)
    }
    const quiet = b.sections.quiet_review
    lines.push(quiet ? `Quiet review: ${quiet.client_name}: ${quiet.text}` : 'Quiet review: none')
    lines.push(`${publicUrl.replace(/\/$/,'')}/replays/dashboards?view=briefing`)
    // Slack/Teams interpret markup in text; neutralize names/notes before adding the controlled URL.
    return lines.join('\n')
}
export function deliveryPayload(kind: string, text: string) {
    return kind === 'slack' ? { text } : { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: 'Client briefing', text }
}
const defaults = { brief: mondayBrief, fetch: globalThis.fetch, log: (message: string) => console.error(message) }
export function createBriefingScheduler(options = config.briefing, injected: Partial<typeof defaults> = {}) {
    const d = { ...defaults, ...injected }
    let busy = false
    return async function tick(now = new Date()): Promise<void> {
        if (!options.webhook || busy) return
        const day = now.toISOString().slice(0,10)
        if (!DAYS.includes(options.day) || !['teams','slack'].includes(options.kind) || !Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) {
            d.log('Briefing delivery configuration is invalid'); return
        }
        if (DAYS[now.getUTCDay()] !== options.day || now.getUTCHours() !== options.hour) return
        busy = true
        let claimed = false
        try {
            claimed = tx(() => {
                if (getSetting<string | null>(LAST,null)?.slice(0,10) === day) return false
                const claim = getSetting<{ day: string; at: number } | null>(CLAIM,null)
                if (claim?.day === day && now.getTime() - claim.at < 120_000) return false
                setSetting(CLAIM,{day,at:now.getTime()}); return true
            })
            if (!claimed) return
            const b = await d.brief({ by: 'briefing-delivery', now })
            // Keep payloads short, disable mention syntax and sanitize identities even in injected briefs.
            const message = await rescuePrivacy(briefingMessage(b, config.service.publicUrl))
            const body = JSON.stringify(deliveryPayload(options.kind, message.replace(/[<>]/g,'').replace(/@/g,'＠')))
            let sent = false
            for (let attempt=0; attempt<2; attempt++) {
                try {
                    const response = await d.fetch(options.webhook, { method:'POST', headers:{'content-type':'application/json'}, body, signal:AbortSignal.timeout(10_000) })
                    await response.body?.cancel()
                    if (!response.ok) throw new Error('Webhook rejected')
                    sent = true; break
                } catch { d.log(`Briefing delivery failed (attempt ${attempt+1} of 2)` ) }
            }
            if (sent) setSetting(LAST,now.toISOString())
            // Keep the claim for this slot after failure, preventing a retry storm on every tick/restart.
            else setSetting(CLAIM,{day,at:Date.parse(day+'T23:59:59Z')})
        } catch { d.log('Briefing delivery failed; scheduler will continue') }
        finally { busy = false }
    }
}
export function startBriefingDelivery(): () => void {
    if (!config.briefing.webhook) return () => {}
    const tick = createBriefingScheduler()
    void tick()
    const timer = setInterval(() => { void tick() },60_000)
    timer.unref()
    return () => clearInterval(timer)
}
