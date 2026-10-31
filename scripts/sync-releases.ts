// Reads the releases from Jira and recomputes the release dashboard now (the service also does
// this every 6 hours and on "Sync now").
//
//   pnpm releases:sync
import { syncReleases, view, viewMarkdown } from '../src/core/releases.ts'

const r = await syncReleases()
console.log(`Synced ${r.releases.length} releases (${r.releases[0]} to ${r.releases.at(-1)}), ${r.tickets} tickets in ${r.seconds} s.${r.dropped.length ? ` Dropped: ${r.dropped.join(', ')}.` : ''}`)
if (process.argv.includes('--print')) console.log('\n' + viewMarkdown(view('all'), 5))
