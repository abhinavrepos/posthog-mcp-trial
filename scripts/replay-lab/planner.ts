export const PROFILES = [
    ['smooth', 'Lab Smooth Co'],
    ['hesitant-circling', 'Lab Hesitant Co'],
    ['scroll-hunting', 'Lab Scroll Co'],
    ['rage-dead', 'Lab Rage Co'],
    ['error-looping', 'Lab Error Co'],
    ['idle', 'Lab Idle Co'],
] as const
export type Persona = typeof PROFILES[number][0]
export type Action =
    | { kind: 'click'; selector: string; count: number; gapMs: number }
    | { kind: 'type'; selector: string; value: string }
    | { kind: 'wait'; ms: number }
    | { kind: 'circle'; ms: number }
    | { kind: 'wheel'; deltaY: number }
export interface Plan {
    clientId: string
    clientName: string
    persona: Persona
    durationMs: number
    actions: Action[]
    expected: { rage_click_bursts: number; rage_clicks: number; dead_target_clicks: number; error_submissions: number; error_retries: number; hesitations: number; circling_bursts_min: number; scroll_reversals: number; hunting_bursts_min: number; idle_ms_min: number }
}
import { CANARIES } from './canaries.ts'
const click = (selector: string, count = 1, gapMs = 140): Action => ({ kind: 'click', selector, count, gapMs })
export function planSessions(sessions: number, clients: string[]): Plan[] {
    if (!Number.isSafeInteger(sessions) || sessions < 1) throw new Error('sessions must be a positive integer')
    if (!clients.length || clients.length > PROFILES.length || new Set(clients).size !== clients.length || clients.some(c => !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(c))) {
        throw new Error('Provide 1–6 unique client IDs (letters, digits, underscore or dash)')
    }
    return Array.from({ length: sessions }, (_, i) => {
        const index = i % clients.length
        const [persona, clientName] = PROFILES[index]
        const actions: Action[] = [click('#open-ir'), { kind: 'type', selector: '#notional', value: CANARIES.notional }]
        const expected = { rage_click_bursts: 0, rage_clicks: 0, dead_target_clicks: 0, error_submissions: 0, error_retries: 0, hesitations: 0, circling_bursts_min: 0, scroll_reversals: 0, hunting_bursts_min: 0, idle_ms_min: 0 }
        if (persona === 'hesitant-circling') {
            actions.push({ kind: 'circle', ms: 10_000 }, click('#save'))
            Object.assign(expected, { hesitations: 1, circling_bursts_min: 1 })
        } else if (persona === 'scroll-hunting') {
            for (let n = 0; n < 10; n++) actions.push({ kind: 'wheel', deltaY: n % 2 ? -550 : 650 }, { kind: 'wait', ms: 450 })
            Object.assign(expected, { scroll_reversals: 9, hunting_bursts_min: 1 })
        } else if (persona === 'rage-dead') {
            actions.push(click('#save', 4), { kind: 'wait', ms: 6500 }, click('#dead'), { kind: 'wait', ms: 1600 })
            Object.assign(expected, { rage_click_bursts: 1, rage_clicks: 4, dead_target_clicks: 1 })
        } else if (persona === 'error-looping') {
            for (let n = 0; n < 4; n++) actions.push({ kind: 'type', selector: '#counterparty', value: CANARIES.counterparty + '!'.repeat(n) }, click('#save'), { kind: 'wait', ms: 1300 })
            Object.assign(expected, { error_submissions: 4, error_retries: 3 })
        } else if (persona === 'idle') {
            actions.push({ kind: 'wait', ms: 50_000 })
            expected.idle_ms_min = 50_000
        } else {
            actions.push(click('#save'), { kind: 'wait', ms: 1500 }, click('#close'), click('#open-fx'), click('#close'), click('#open-hedge'))
        }
        return { clientId: clients[index], clientName, persona, durationMs: 70_000, actions, expected }
    })
}
