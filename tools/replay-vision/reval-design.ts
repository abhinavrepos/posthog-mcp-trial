// Run R design (Reval simulator). Same rigour as ERPNext: calibration on one seed set (clean), freeze, then a fresh
// held-out set (clean controls + injected cohorts dosed by distinct affected users). Seeds are the resume key.
import type { Persona, Severity } from './personas.ts'
import type { RevalFriction, RevalPlan, RevalWorkflow } from './reval-personas.ts'
import { appScreenKey } from '../../src/core/replay-timeline.ts'

export const R_PERSONAS: Persona[] = ['Expert', 'Novice', 'Hurried', 'Careful', 'Explorer', 'Returning']
export const R_WORKFLOWS: RevalWorkflow[] = ['deal', 'hedge', 'amortisation']
export const R_CALIBRATION_REPEATS = 4
export interface RevalCohort { id: string; injection: RevalFriction; workflow: RevalWorkflow; users: number; dose: number; planned: Severity | null; screen: string }
// Planned severity: architecture planning rule + orchestrator decision 1 (strong D4 >= 2 cycles in U >= 3 -> High).
const IRS = appScreenKey('DlgDetailIRSwap', 'IR Swap'), CAP = appScreenKey('DlgDetailCap', 'Cap / Floor'), LIST = appScreenKey('DlgTradeList', 'Trade List'), HEDGE = appScreenKey('DlgHedgeRel', 'Hedge Relationship')
export const R_COHORTS: RevalCohort[] = [
    { id: 'R-I2-cap-validation-u1', injection: 'validation_loop', workflow: 'deal', users: 1, dose: 2, planned: 'Low', screen: CAP },
    { id: 'R-I2-cap-validation-u3', injection: 'validation_loop', workflow: 'deal', users: 3, dose: 2, planned: 'High', screen: CAP },
    { id: 'R-I2-cap-validation-u6', injection: 'validation_loop', workflow: 'deal', users: 6, dose: 2, planned: 'High', screen: CAP },
    { id: 'R-I5-dead-apply-u1', injection: 'dead_button', workflow: 'deal', users: 1, dose: 5, planned: 'Low', screen: IRS },
    { id: 'R-I5-dead-apply-u3', injection: 'dead_button', workflow: 'deal', users: 3, dose: 5, planned: 'Medium', screen: IRS },
    { id: 'R-I5-dead-apply-u6', injection: 'dead_button', workflow: 'deal', users: 6, dose: 5, planned: 'Medium', screen: IRS },
    { id: 'R-I6-trade-list-hunt-u1', injection: 'scroll_hunt', workflow: 'amortisation', users: 1, dose: 40, planned: 'Low', screen: LIST },
    { id: 'R-I6-trade-list-hunt-u3', injection: 'scroll_hunt', workflow: 'amortisation', users: 3, dose: 40, planned: 'Medium', screen: LIST },
    { id: 'R-I6-trade-list-hunt-u6', injection: 'scroll_hunt', workflow: 'amortisation', users: 6, dose: 40, planned: 'Medium', screen: LIST },
    { id: 'R-I7-counterparty-lookup-u1', injection: 'revisit', workflow: 'deal', users: 1, dose: 2, planned: 'Low', screen: IRS },
    { id: 'R-I7-counterparty-lookup-u3', injection: 'revisit', workflow: 'deal', users: 3, dose: 2, planned: 'Medium', screen: IRS },
    { id: 'R-I7-counterparty-lookup-u6', injection: 'revisit', workflow: 'deal', users: 6, dose: 2, planned: 'Medium', screen: IRS },
    { id: 'R-I3-hedge-open-2s-u3', injection: 'slow_wait', workflow: 'hedge', users: 3, dose: 2000, planned: null, screen: HEDGE },
    { id: 'R-I3-hedge-open-6s-u3', injection: 'slow_wait', workflow: 'hedge', users: 3, dose: 6000, planned: 'Medium', screen: HEDGE },
    { id: 'R-I3-hedge-open-15s-u3', injection: 'slow_wait', workflow: 'hedge', users: 3, dose: 15000, planned: 'Medium', screen: HEDGE },
    { id: 'R-I1-notional-relabel-u3', injection: 'hesitation', workflow: 'deal', users: 3, dose: 6, planned: 'Medium', screen: IRS },
]
/** Elements a correct Reval insight may name (fixed before results; '*' = element not required, detector must match). */
export const R_ACCEPTED: Record<string, string[]> = { validation_loop: ['save'], dead_button: ['apply'], hesitation: ['principal amount', 'notional'], revisit: ['*'], scroll_hunt: ['*'], slow_wait: ['*'] }
/** Calibration seeds 400000+, held-out controls 500000+, held-out cohorts 520000+ (disjoint from every ERPNext seed). */
export function revalPlans(smoke = false): { calibration: RevalPlan[]; heldout: RevalPlan[] } {
    if (smoke) return { calibration: [], heldout: [{ seed: 771201, phase: 'heldout', user: 'RVSMOKE0', persona: 'Careful', workflow: 'deal', injection: 'validation_loop', dose: 2, planned_severity: 'High', cohort: 'smoke' }] }
    const calibration: RevalPlan[] = [], heldout: RevalPlan[] = []
    for (let r = 0; r < R_CALIBRATION_REPEATS; r++) for (let u = 0; u < 6; u++) for (let w = 0; w < 3; w++) calibration.push({ seed: 400000 + r * 100 + u * 10 + w, phase: 'calibration', user: `RVCAL${u}`, persona: R_PERSONAS[u]!, workflow: R_WORKFLOWS[w]! })
    for (let u = 0; u < 6; u++) for (let w = 0; w < 3; w++) heldout.push({ seed: 500000 + u * 10 + w, phase: 'heldout', user: `RVEVAL${u}`, persona: R_PERSONAS[u]!, workflow: R_WORKFLOWS[w]! })
    R_COHORTS.forEach((k, i) => { for (let j = 0; j < k.users; j++) { const u = (i + j) % 6; heldout.push({ seed: 520000 + i * 10 + j, phase: 'heldout', user: `RVEVAL${u}`, persona: R_PERSONAS[u]!, workflow: k.workflow, injection: k.injection, dose: k.dose, planned_severity: k.planned ?? 'Low', cohort: k.id, cohort_users: k.users }) } })
    return { calibration, heldout }
}
export const R_CONTROL_SEEDS = Array.from({ length: 18 }, (_, i) => 500000 + Math.floor(i / 3) * 10 + i % 3)
export const rCohortSeed = (i: number, j: number) => 520000 + i * 10 + j
