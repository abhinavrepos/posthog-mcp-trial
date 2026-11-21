import { config } from './config.ts'
import { appEvents } from './appevents.ts'
export const normalise = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '')
export function userExpr(): string {
    const index = appEvents()?.distinctIdParts?.indexOf('{user}') ?? -1
    return index >= 0 ? `splitByChar('${config.properties.distinctIdSeparator}', toString(distinct_id))[${index+1}]` : 'toString(distinct_id)'
}

/** The same configured user part used by live queries, for recording metadata too. */
export function userLabel(distinctId: string): string {
    const index = appEvents()?.distinctIdParts?.indexOf('{user}') ?? -1
    return index >= 0 ? distinctId.split(config.properties.distinctIdSeparator)[index] || distinctId : distinctId
}
