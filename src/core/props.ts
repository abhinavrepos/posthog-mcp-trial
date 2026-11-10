// The HogQL expressions for the event and person properties named in the settings (PROP_*).
// The names are checked to be plain identifiers when the settings load, and the distinct id
// separator to be one safe character, so these are safe to put into queries.
import { config } from './config.ts'

const p = config.properties

/** The client: an event property, or one part of the distinct id (CLIENT_FROM_DISTINCT_ID). */
export function clientExpr(prop: typeof p = p): string {
    if (prop.clientFromDistinctId) return `splitByChar('${prop.distinctIdSeparator}', toString(distinct_id))[${prop.clientFromDistinctId}]`
    return `properties.${prop.client}`
}

const client = clientExpr()

export const P = {
    client,
    // The display name when events carry one, else the client id itself.
    clientName: p.clientName ? `coalesce(nullIf(toString(properties.${p.clientName}), ''), toString(${client}))` : `toString(${client})`,
    // Without a release property, queries see an empty release.
    version: p.version ? `properties.${p.version}` : `''`,
    email: `person.properties.${p.personEmail}`,
}

/** How the client is found, in words, for the MCP instructions and the doctor. */
export function clientSource(prop: typeof p = p): string {
    return prop.clientFromDistinctId
        ? `part ${prop.clientFromDistinctId} of the distinct id split on "${prop.distinctIdSeparator}" (HogQL: ${clientExpr(prop)})`
        : `the event property "${prop.client}"`
}
