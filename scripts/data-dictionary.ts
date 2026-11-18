// Deterministic reference deployment; never load a credential file.
process.env.TRIAGE_ENV_FILE = '/dev/null'
process.env.APP_EVENTS_FILE = 'config/app-events.reval.json'
process.env.CLIENT_FROM_DISTINCT_ID = '3'
process.env.DISTINCT_ID_SEPARATOR = '|'
process.env.PROP_CLIENT_ID = 'client_id'
process.env.PROP_CLIENT_NAME = 'client_name'
process.env.PROP_APP_VERSION = 'app_version'
process.env.PROP_PERSON_EMAIL = 'email'
const { dataDictionary } = await import('../src/core/datadictionary.ts')
// Prints the data dictionary for the Reval reference configuration (client part 3).
export const document = '# Data dictionary\n\n' + dataDictionary({ format: 'full', private: false }) + '\n'
if (process.argv[1]?.endsWith('/data-dictionary.ts')) process.stdout.write(document)
