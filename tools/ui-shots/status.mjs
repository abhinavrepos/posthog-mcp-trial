import { createServer } from 'node:http'

export function statusSnapshot() {
  const now = Date.now(), at = new Date(now).toISOString()
  const check = (group, name, level, detail, more = {}) => ({ group, name, level, detail, since: at, ...more })
  return {
    level: 'down', checked_at: at,
    checks: [
      check('Containers: posthog', 'posthog-web', 'ok', 'Running', { state: 'running', health: 'healthy', cpu_pct: 12.4, mem_bytes: 827000000, restarts: 0, history: [[now - 60000, 8, 760000000], [now, 12.4, 827000000]] }),
      check('Containers: posthog', 'clickhouse', 'down', 'Health check failed', { state: 'running', health: 'unhealthy', cpu_pct: 78.2, mem_bytes: 1780000000, restarts: 2, history: [[now - 60000, 42, 1600000000], [now, 78.2, 1780000000]], health_output: 'Query took longer than 10 seconds' }),
      check('Containers: lens', 'lens-service', 'ok', 'Running', { state: 'running', health: 'healthy', cpu_pct: 3.1, mem_bytes: 198000000, restarts: 0 }),
      check('PostHog', 'Web', 'ok', 'Responding in 28 ms'),
      check('PostHog', 'ClickHouse', 'down', 'Query health check timed out'),
      check('Lens', 'Triage service', 'ok', 'Responding in 12 ms'),
      check('Lens jobs', 'Queue', 'ok', 'No jobs delayed'),
      check('Data arriving', 'Events', 'warn', 'Event volume is below the recent baseline'),
      check('Machine', 'Memory', 'ok', '4.2 GB available'),
      check('Machine', 'Disk', 'warn', '78% used'),
    ],
    changes: [{ at, group: 'PostHog', name: 'ClickHouse', from: 'ok', to: 'down' }],
    metrics: {
      machine: { cpu_pct: 32.8, cores: 8, load_5: 2.4, mem_total: 16000000000, mem_available: 4200000000, disk_total: 250000000000, disk_free: 55000000000, swap_used: 0, swap_total: 2000000000 },
      people_24h: 312, recordings_24h: 82, ingestion_warnings_24h: 2, clickhouse_bytes: 77000000000,
      events_by_hour: Array.from({ length: 24 }, (_, i) => [Math.floor(now / 3600000) * 3600000 - (23 - i) * 3600000, 250 + i * 13]),
      events_by_minute: [], history: [[now - 60000, 22, 58, 62, 120], [now, 33, 61, 64, 130]],
      clickhouse: { version: '24.8', uptime_s: 345600, running_queries: 2, merges: 1, pending_mutations: 0, max_partition_parts: 47, tables: [{ database: 'posthog', table: 'events', bytes: 31000000000, rows: 48000000 }] },
    },
    about: { posthog_image: 'posthog/posthog:stable', clickhouse_version: '24.8', docker_version: '27.5', uptime_s: 864000, interval_s: 15, took_ms: 830, alerts: 'off' },
  }
}
export function statusServer() {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(statusSnapshot()))
  })
}
