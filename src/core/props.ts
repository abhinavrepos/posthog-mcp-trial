// The HogQL expressions for the event and person properties named in the settings (PROP_*).
// The names are checked to be plain identifiers when the settings load, so these are safe to
// put into queries.
import { config } from './config.ts'

const p = config.properties
export const P = {
    client: `properties.${p.client}`,
    clientName: `properties.${p.clientName}`,
    // Without a release property, queries see an empty release.
    version: p.version ? `properties.${p.version}` : `''`,
    email: `person.properties.${p.personEmail}`,
}
