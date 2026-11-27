// Worker thread for refreshInsights (code review M5): aggregation and its SQLite writes run here, on their own
// connection (WAL, busy_timeout), never on the HTTP/MCP event loop.
import { parentPort, workerData } from 'node:worker_threads'
import { refreshInsights } from './replay-vision-insights.ts'

try {
    const r = refreshInsights(workerData.scope, { now: new Date(workerData.now), reach: workerData.reach ? new Map(workerData.reach) : undefined })
    parentPort?.postMessage({ ok: true, scope_key: r.scope_key, runs: r.runs, moments: r.moments, insights: r.insights.length })
} catch (e) {
    parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'refresh_failed' })
}
