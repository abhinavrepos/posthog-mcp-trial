// Reads the releases from Jira and recounts the release outcomes now (the service also does this
// every 6 hours, and Claude can with the refresh_releases tool).
//
//   pnpm releases:sync [--print]
import { outcomesMarkdown, resolveScope, syncReleases } from '../src/core/releases.ts'

const r = await syncReleases()
console.log(`Synced ${r.releases.length} releases (${r.releases[0]} to ${r.releases.at(-1)}), ${r.tickets} tickets in ${r.seconds} s.${r.dropped.length ? ` Dropped: ${r.dropped.join(', ')}.` : ''}`)
if (process.argv.includes('--print')) console.log('\n' + outcomesMarkdown(resolveScope(process.argv[process.argv.indexOf('--print') + 1] || 'last 1')!))
