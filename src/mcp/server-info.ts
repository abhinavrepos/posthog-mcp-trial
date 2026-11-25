import { appEvents } from '../core/appevents.ts'
import { config } from '../core/config.ts'

// SDK 1.32 supports title and description in serverInfo.
export const lensServerInfo = {
    name: config.mcp.name,
    version: '0.1.0',
    title: 'Signal',
    description: `Signal: ${appEvents()?.app || 'your app'} live PostHog queries, replay clips, surveys and pinned graph snapshots`,
}
