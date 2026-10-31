// Suggested priority with the reasons shown to people. A suggestion only: a human sets the priority.

export type Priority = 'P1' | 'P2' | 'P3' | 'P4'

export interface SeverityInput {
    hasError: boolean // an exception lines up with the ticket
    clientsAffected: number
    usersAffected: number
    occurrences: number
    clientsUsingScreen: number // how many clients use the screen at all
    versionSpecific?: string // the error only happens on this release
    blocksTask: boolean // the user could not finish (stuck UI, rage clicks after the error)
    rising: boolean // the last 3 days are worse than the 3 before
    enterpriseAffected: boolean
    silent: boolean // no error, only struggle signals
}

export interface Severity {
    priority: Priority
    score: number
    reasons: string[]
}

export function suggestSeverity(s: SeverityInput): Severity {
    const reasons: string[] = []
    let score = 0

    if (s.silent) {
        reasons.push('No error was recorded; the user struggled without anything crashing')
        score += 1
    }
    if (s.hasError) {
        score += 2
        reasons.push('An error lines up with the ticket')
    }
    if (s.blocksTask) {
        score += 2
        reasons.push('The user could not finish the task')
    }
    if (s.clientsAffected >= 3) {
        score += 3
        reasons.push(`${s.clientsAffected} clients are affected, not just this one`)
    } else if (s.clientsAffected === 2) {
        score += 1
        reasons.push('Another client is affected too')
    }
    if (s.usersAffected >= 5) {
        score += 1
        reasons.push(`${s.usersAffected} users hit it`)
    }
    if (s.versionSpecific) {
        score += 1
        reasons.push(`It only happens on ${s.versionSpecific}, so it looks like a regression in that release`)
    }
    if (s.rising) {
        score += 1
        reasons.push('Occurrences are rising')
    }
    if (s.enterpriseAffected) {
        score += 1
        reasons.push('An enterprise client is affected')
    }
    if (s.clientsUsingScreen > 0 && s.clientsAffected > 0 && s.clientsAffected / s.clientsUsingScreen >= 0.15) {
        score += 1
        reasons.push(`${Math.round((100 * s.clientsAffected) / s.clientsUsingScreen)}% of the clients who use this screen are affected`)
    }

    const priority: Priority = score >= 8 ? 'P1' : score >= 5 ? 'P2' : score >= 3 ? 'P3' : 'P4'
    return { priority, score, reasons }
}

/** Compares the last 3 days with the 3 before them. */
export function isRising(daily: { day: string; occurrences: number }[]): boolean {
    if (daily.length < 6) return false
    const last = daily.slice(-3).reduce((a, d) => a + d.occurrences, 0)
    const before = daily.slice(-6, -3).reduce((a, d) => a + d.occurrences, 0)
    return last > before && last >= 3
}
