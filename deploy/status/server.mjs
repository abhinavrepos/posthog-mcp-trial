// PostHog Lens status: one page that says whether everything is up.
//
// Every STATUS_INTERVAL_SECONDS (15) it checks, and the page shows the latest result:
//   - every container of the watched compose projects (STATUS_PROJECTS, default "posthog"): running,
//     healthy, restarts. Read from the Docker socket, GET requests only.
//   - PostHog's own health endpoints (app, capture, replay capture, flags, replay reader, ClickHouse), on
//     PostHog's Docker network
//   - this project's processes on the host: the triage service (and its MCP switches), mock Jira, demo app
//   - data flowing: events and replay metadata received in the last 5 minutes and hour, and when the
//     newest event arrived. Counts and times only, read-only (ClickHouse readonly=1); no event or
//     replay content is ever read.
//   - the machine: free disk, memory, load
//
//   GET /             the page (refreshes itself)
//   GET /api/status   the same as JSON
//   GET /healthz      200 "ok" or 503 "N problem(s)", no details and no password: for uptime monitors
// With STATUS_PASSWORD set, / and /api/status ask for it (any user name). No dependencies.
import { timingSafeEqual } from 'node:crypto'
import { readFileSync, statfsSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'

const env = (k, d = '') => (process.env[k] ?? '').trim() || d
const PORT = Number(env('STATUS_LISTEN_PORT', '8090'))
const EVERY = Math.max(5, Number(env('STATUS_INTERVAL_SECONDS', '15'))) * 1000
const PASSWORD = env('STATUS_PASSWORD')
const TITLE = env('STATUS_TITLE', 'PostHog Lens status')
const PROJECTS = env('STATUS_PROJECTS', 'posthog').split(',').map((s) => s.trim()).filter(Boolean)
const CLICKHOUSE = env('STATUS_CLICKHOUSE_URL', 'http://clickhouse:8123')
const DOCKER_SOCKET = env('STATUS_DOCKER_SOCKET', '/var/run/docker.sock')
const DISK = env('STATUS_DISK_PATH', '/host-disk')
const HOST = env('STATUS_HOST_URL', 'http://host.docker.internal')
// Optional: a problem when no event has arrived for this many minutes (quiet systems: leave empty).
const MAX_EVENT_AGE_MIN = Number(env('STATUS_MAX_EVENT_AGE_MINUTES', '0'))

// group | name | url | "any" when any HTTP answer counts as up (a login page answering 401, say)
const DEFAULT_HTTP = [
    `PostHog|App (through the proxy)|http://proxy:80/_health`,
    `PostHog|Web|http://web:8000/_health`,
    `PostHog|Event capture|http://capture:3000/_readiness`,
    `PostHog|Replay capture|http://replay-capture:3000/_readiness`,
    `PostHog|Feature flags|http://feature-flags:3001/_readiness`,
    `PostHog|Replay reader|http://recording-api:6738/_health`,
    `PostHog|ClickHouse|${CLICKHOUSE}/ping`,
    `Lens|Triage service|${HOST}:8080/health`,
    `Lens|Mock Jira|${HOST}:4000/|any`,
    `Lens|Demo app|${HOST}:3000/healthz|any`,
].join(',')
const HTTP_CHECKS = env('STATUS_HTTP', DEFAULT_HTTP)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
        const [group, name, url, mode] = s.split('|').map((x) => (x || '').trim())
        return { group, name, url, any: mode === 'any' }
    })
    .filter((c) => c.group && c.name && /^https?:\/\//.test(c.url))

// ------------------------------------------------------------------ helpers
const OK = 'ok', WARN = 'warn', DOWN = 'down', INFO = 'info'
const since = new Map() // check key -> when it last changed level
const restartsSeen = new Map() // container -> [{at, count}]

function track(key, level) {
    const prev = since.get(key)
    if (!prev || prev.level !== level) since.set(key, { level, at: Date.now() })
    return since.get(key).at
}

function docker(path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath: DOCKER_SOCKET, path, method: 'GET', timeout: 10_000 }, (res) => {
            let body = ''
            res.on('data', (c) => (body += c))
            res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`Docker answered ${res.statusCode}`))))
        })
        req.on('timeout', () => req.destroy(new Error('Docker did not answer in 10 s')))
        req.on('error', reject)
        req.end()
    })
}

async function clickhouse(sql) {
    const res = await fetch(`${CLICKHOUSE}/?readonly=1&default_format=JSONCompact&output_format_json_quote_64bit_integers=0`, {
        method: 'POST',
        body: sql,
        signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`ClickHouse answered ${res.status}`)
    return (await res.json()).data
}

const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 90) return `${s} s`
    if (s < 5400) return `${Math.round(s / 60)} min`
    if (s < 172800) return `${Math.round(s / 3600)} h`
    return `${Math.round(s / 86400)} days`
}
const num = (n) => Number(n).toLocaleString('en-US')
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`

// ------------------------------------------------------------------ checks
async function checkContainers() {
    const rows = []
    let list
    try {
        list = await docker('/containers/json?all=1')
    } catch (e) {
        return [{ group: 'Containers', name: 'Docker', level: DOWN, detail: `cannot read the container list: ${e.message}` }]
    }
    for (const project of PROJECTS) {
        const mine = list.filter((c) => c.Labels?.['com.docker.compose.project'] === project && c.Labels?.['com.docker.compose.oneoff'] !== 'True')
        if (!mine.length) {
            rows.push({ group: `Containers: ${project}`, name: project, level: DOWN, detail: 'no containers of this compose project' })
            continue
        }
        for (const c of mine) {
            const name = (c.Names?.[0] || c.Id).replace(/^\//, '').replace(new RegExp(`^${project}[-_]`), '')
            let info
            try {
                info = await docker(`/containers/${c.Id}/json`)
            } catch (e) {
                rows.push({ group: `Containers: ${project}`, name, level: WARN, detail: e.message })
                continue
            }
            const st = info.State || {}
            const health = st.Health?.Status
            const policy = info.HostConfig?.RestartPolicy?.Name || 'no'
            const restarts = info.RestartCount || 0
            // Restarts in the last 15 minutes, from what this page has seen.
            const seen = (restartsSeen.get(c.Id) || []).filter((x) => Date.now() - x.at < 15 * 60_000)
            seen.push({ at: Date.now(), count: restarts })
            restartsSeen.set(c.Id, seen)
            const recent = restarts - seen[0].count
            let level = OK
            let detail
            if (st.Status === 'running') {
                const up = Date.now() - Date.parse(st.StartedAt)
                detail = `up ${ago(up)}${health ? `, ${health}` : ''}`
                if (health === 'unhealthy') level = DOWN
                else if (health === 'starting') level = WARN
                if (recent > 0) {
                    level = level === DOWN ? DOWN : WARN
                    detail += `, restarted ${recent} time${recent > 1 ? 's' : ''} in the last 15 min`
                }
            } else if (st.Status === 'restarting') {
                level = DOWN
                detail = `restarting (${restarts} restarts)`
            } else if (st.Status === 'exited' && st.ExitCode === 0 && policy === 'no') {
                level = INFO
                detail = 'finished (a one-time job)'
            } else {
                level = DOWN
                detail = `${st.Status}${st.Status === 'exited' ? `, exit code ${st.ExitCode}` : ''} since ${ago(Date.now() - Date.parse(st.FinishedAt || st.StartedAt))}`
            }
            rows.push({ group: `Containers: ${project}`, name, level, detail })
        }
    }
    return rows
}

async function checkHttp() {
    return Promise.all(
        HTTP_CHECKS.map(async (c) => {
            const t = Date.now()
            try {
                const res = await fetch(c.url, { signal: AbortSignal.timeout(8000), redirect: 'manual' })
                const ms = Date.now() - t
                const body = await res.text()
                const up = c.any ? res.status < 500 : res.status >= 200 && res.status < 400
                const row = { group: c.group, name: c.name, level: up ? (ms > 3000 ? WARN : OK) : DOWN, detail: `${res.status}, ${ms} ms${up && ms > 3000 ? ' (slow)' : ''}` }
                // The triage service also says which of its switches are on.
                if (up && c.url.endsWith('/health')) {
                    try {
                        const f = JSON.parse(body).features
                        if (f) row.switches = { 'Lens MCP': f.lens_mcp, 'PostHog MCP': f.posthog_mcp, 'Claude reads tickets': f.ai }
                    } catch {}
                }
                return row
            } catch (e) {
                return { group: c.group, name: c.name, level: DOWN, detail: e.name === 'TimeoutError' ? 'no answer in 8 s' : 'not answering' }
            }
        }),
    )
}

async function checkData() {
    const G = 'Data arriving'
    try {
        const [[e5, e60, newest]] = await clickhouse(
            `SELECT countIf(_timestamp > now() - INTERVAL 5 MINUTE), count(), toUnixTimestamp(max(_timestamp)) FROM posthog.events WHERE _timestamp > now() - INTERVAL 1 HOUR`,
        )
        let newestAt = Number(newest) * 1000
        if (!e60) {
            const [[n]] = await clickhouse(`SELECT toUnixTimestamp(max(_timestamp)) FROM posthog.events WHERE _timestamp > now() - INTERVAL 30 DAY`)
            newestAt = Number(n) * 1000
        }
        const age = newestAt ? Date.now() - newestAt : Infinity
        const stale = MAX_EVENT_AGE_MIN > 0 && age > MAX_EVENT_AGE_MIN * 60_000
        const [[r60]] = await clickhouse(`SELECT count() FROM posthog.session_replay_events WHERE _timestamp > now() - INTERVAL 1 HOUR`)
        return [
            {
                group: G,
                name: 'Events',
                level: stale ? DOWN : INFO,
                detail: `${num(e5)} in the last 5 min, ${num(e60)} in the last hour; newest ${newestAt ? `${ago(age)} ago` : 'more than 30 days ago'}${stale ? ` (more than ${MAX_EVENT_AGE_MIN} min)` : ''}`,
            },
            { group: G, name: 'Session replays', level: INFO, detail: `${num(r60)} replay updates in the last hour (counted, never opened)` },
        ]
    } catch (e) {
        return [{ group: G, name: 'ClickHouse', level: DOWN, detail: `cannot count: ${e.message}` }]
    }
}

function checkMachine() {
    const G = 'Machine'
    const rows = []
    try {
        const s = statfsSync(DISK)
        const total = s.blocks * s.bsize
        const free = s.bavail * s.bsize
        const pct = (free / total) * 100
        rows.push({ group: G, name: 'Disk', level: pct < 10 ? DOWN : pct < 20 ? WARN : OK, detail: `${gb(free)} free of ${gb(total)} (${pct.toFixed(0)}%)` })
    } catch {
        rows.push({ group: G, name: 'Disk', level: WARN, detail: `cannot read (mount a host folder at ${DISK})` })
    }
    try {
        const m = Object.fromEntries(
            readFileSync('/proc/meminfo', 'utf8')
                .split('\n')
                .map((l) => l.split(/:\s+/))
                .filter((x) => x.length === 2)
                .map(([k, v]) => [k, parseInt(v, 10) * 1024]),
        )
        const pct = (m.MemAvailable / m.MemTotal) * 100
        rows.push({ group: G, name: 'Memory', level: pct < 5 ? DOWN : pct < 10 ? WARN : OK, detail: `${gb(m.MemAvailable)} available of ${gb(m.MemTotal)} (${pct.toFixed(0)}%)` })
    } catch {}
    const [l1, l5] = os.loadavg()
    const cpus = os.cpus().length || 1
    rows.push({ group: G, name: 'Load', level: l5 > cpus * 2 ? WARN : OK, detail: `${l1.toFixed(1)} now, ${l5.toFixed(1)} over 5 min, ${cpus} cores` })
    rows.push({ group: G, name: 'Uptime', level: INFO, detail: ago(os.uptime() * 1000) })
    return rows
}

// ------------------------------------------------------------------ the loop
let latest = { at: null, rows: [], took_ms: 0 }
async function runChecks() {
    const t = Date.now()
    const parts = await Promise.allSettled([checkHttp(), checkData(), checkContainers(), Promise.resolve(checkMachine())])
    const rows = parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : [{ group: 'Status page', name: 'a check', level: WARN, detail: String(p.reason) }]))
    for (const r of rows) r.since = track(`${r.group}/${r.name}`, r.level)
    latest = { at: Date.now(), rows, took_ms: Date.now() - t }
}
async function loop() {
    try {
        await runChecks()
    } catch (e) {
        console.error('checks failed', e)
    }
    setTimeout(loop, EVERY)
}

function summary() {
    const down = latest.rows.filter((r) => r.level === DOWN)
    const warn = latest.rows.filter((r) => r.level === WARN)
    return { down: down.length, warn: warn.length, level: !latest.at ? WARN : down.length ? DOWN : warn.length ? WARN : OK }
}

// ------------------------------------------------------------------ page
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const LABEL = { ok: 'Up', warn: 'Warning', down: 'Down', info: 'Info' }
const ICON = { ok: '✓', warn: '!', down: '✕', info: 'i' }

function fragment() {
    const s = summary()
    const head = !latest.at
        ? 'Checking…'
        : s.down
          ? `${s.down} problem${s.down > 1 ? 's' : ''}${s.warn ? `, ${s.warn} warning${s.warn > 1 ? 's' : ''}` : ''}`
          : s.warn
            ? `Everything is up, ${s.warn} warning${s.warn > 1 ? 's' : ''}`
            : 'Everything is up'
    const groups = new Map()
    for (const r of latest.rows) {
        if (!groups.has(r.group)) groups.set(r.group, [])
        groups.get(r.group).push(r)
    }
    const order = (g) => (g === 'PostHog' ? 0 : g === 'Lens' ? 1 : g === 'Data arriving' ? 2 : g.startsWith('Containers') ? 3 : 4)
    const cards = [...groups.entries()]
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([g, rows]) => {
            const bad = rows.filter((r) => r.level === DOWN).length
            const warn = rows.filter((r) => r.level === WARN).length
            const big = rows.length > 12
            // Long lists (containers) show their problems first and fold the rest.
            const sorted = big ? [...rows].sort((a, b) => rank(b.level) - rank(a.level) || a.name.localeCompare(b.name)) : rows
            const shown = big ? sorted.filter((r) => r.level === DOWN || r.level === WARN) : sorted
            const rest = big ? sorted.filter((r) => r.level !== DOWN && r.level !== WARN) : []
            const li = (r) => `<li class="row ${r.level}"><span class="dot" aria-hidden="true">${ICON[r.level]}</span><span class="name">${esc(r.name)}</span><span class="state">${LABEL[r.level]}</span><span class="detail">${esc(r.detail || '')}${r.level === DOWN || r.level === WARN ? ` · for ${ago(Date.now() - r.since)}` : ''}</span>${r.switches ? `<span class="switches">${Object.entries(r.switches).map(([k, v]) => `<span class="chip ${v ? 'on' : 'off'}">${esc(k)}: ${v ? 'on' : 'off'}</span>`).join('')}</span>` : ''}</li>`
            return `<section class="card"><h2>${esc(g)} <span class="count">${bad ? `<b class="down">${bad} down</b> · ` : ''}${warn ? `<b class="warn">${warn} warning</b> · ` : ''}${rows.length} checked</span></h2><ul>${shown.map(li).join('')}</ul>${rest.length ? `<details><summary>${rest.length} without problems</summary><ul>${rest.map(li).join('')}</ul></details>` : ''}</section>`
        })
        .join('')
    return `<div class="banner ${s.level}" role="status"><span class="big" aria-hidden="true">${ICON[s.level]}</span><div><h1>${esc(head)}</h1><p>Checked ${latest.at ? `${new Date(latest.at).toISOString().replace('T', ' ').slice(0, 19)} UTC, in ${latest.took_ms} ms` : 'just now'} · every ${EVERY / 1000} s</p></div></div><div class="grid">${cards}</div>`
}
const rank = (l) => ({ down: 3, warn: 2, ok: 1, info: 0 })[l]

const CSS = `:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#5b6170;--line:#e3e6eb;--ok:#1a7f45;--ok-bg:#e7f5ec;--warn:#9a5b00;--warn-bg:#fff4dd;--down:#b42318;--down-bg:#fde9e7;--info:#3d5a99;--info-bg:#eaf0fb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--ink:#e8eaee;--muted:#9aa1ae;--line:#2a2f38;--ok:#4cc483;--ok-bg:#132a1d;--warn:#f0b54a;--warn-bg:#2d2412;--down:#ff7b6e;--down-bg:#331614;--info:#8fb0ee;--info-bg:#17213a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 40px}
.banner{display:flex;gap:14px;align-items:center;padding:16px 18px;border-radius:12px;margin-bottom:16px;border:1px solid var(--line)}
.banner h1{margin:0;font-size:20px}.banner p{margin:2px 0 0;color:var(--muted);font-size:13px}
.banner .big{font-size:22px;font-weight:700;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;flex:none}
.banner.ok{background:var(--ok-bg)}.banner.ok .big{background:var(--ok);color:var(--bg)}
.banner.warn{background:var(--warn-bg)}.banner.warn .big{background:var(--warn);color:var(--bg)}
.banner.down{background:var(--down-bg)}.banner.down .big{background:var(--down);color:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
@media (max-width:420px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card h2{font-size:14px;margin:0 0 8px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
.count{font-weight:400;color:var(--muted);font-size:12px}.count b.down{color:var(--down)}.count b.warn{color:var(--warn)}
ul{list-style:none;margin:0;padding:0}
.row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:2px 8px;padding:7px 0;border-top:1px solid var(--line);align-items:baseline}
.row:first-child{border-top:0}
.dot{width:18px;height:18px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;color:var(--bg);align-self:center}
.ok .dot{background:var(--ok)}.warn .dot{background:var(--warn)}.down .dot{background:var(--down)}.info .dot{background:var(--info)}
.name{font-weight:600;overflow-wrap:anywhere}.state{font-size:12px;font-weight:600}
.ok .state{color:var(--ok)}.warn .state{color:var(--warn)}.down .state{color:var(--down)}.info .state{color:var(--info)}
.detail{grid-column:2/4;color:var(--muted);font-size:12.5px;overflow-wrap:anywhere}
.switches{grid-column:2/4;display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.chip{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line)}.chip.on{background:var(--ok-bg);color:var(--ok)}.chip.off{color:var(--muted)}
details summary{cursor:pointer;color:var(--muted);padding:7px 0;border-top:1px solid var(--line);font-size:13px}
footer{color:var(--muted);font-size:12px;margin-top:18px}`

function page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(TITLE)}</title><style>${CSS}</style></head>
<body><main><div id="live">${fragment()}</div><footer>${esc(TITLE)} · JSON at <a href="api/status">api/status</a> · for uptime monitors: <code>/healthz</code></footer></main>
<script>
const keep = new Set()
setInterval(async () => {
  try {
    document.querySelectorAll('details[open]').forEach((d) => keep.add(d.parentElement.querySelector('h2').textContent.split(' ')[0]))
    const r = await fetch('fragment', { cache: 'no-store' })
    if (!r.ok) return
    document.getElementById('live').innerHTML = await r.text()
    document.querySelectorAll('details').forEach((d) => { if (keep.has(d.parentElement.querySelector('h2').textContent.split(' ')[0])) d.open = true })
    keep.clear()
  } catch {}
}, ${EVERY})
</script></body></html>`
}

// ------------------------------------------------------------------ server
function authorized(req) {
    if (!PASSWORD) return true
    const m = /^Basic (.+)$/.exec(req.headers.authorization || '')
    if (!m) return false
    const pass = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':')
    const a = Buffer.from(pass)
    const b = Buffer.from(PASSWORD)
    return a.length === b.length && timingSafeEqual(a, b)
}

http
    .createServer((req, res) => {
        const path = new URL(req.url || '/', 'http://x').pathname
        const send = (code, type, body, extra = {}) => {
            res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra })
            res.end(body)
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'GET only')
        if (path === '/healthz') {
            const s = summary()
            return send(s.down ? 503 : 200, 'text/plain', s.down ? `${s.down} problem(s)\n` : 'ok\n')
        }
        if (path === '/self') return send(200, 'text/plain', 'ok\n')
        if (!authorized(req)) return send(401, 'text/plain', 'password needed\n', { 'www-authenticate': `Basic realm="${TITLE}", charset="UTF-8"` })
        if (path === '/') return send(200, 'text/html; charset=utf-8', page(), { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" })
        if (path === '/fragment') return send(200, 'text/html; charset=utf-8', fragment())
        if (path === '/api/status') return send(200, 'application/json', JSON.stringify({ ...summary(), checked_at: latest.at && new Date(latest.at).toISOString(), checks: latest.rows }, null, 2))
        send(404, 'text/plain', 'not found\n')
    })
    .listen(PORT, '0.0.0.0', () => {
        console.log(`${TITLE} on port ${PORT}: ${HTTP_CHECKS.length} endpoints, projects ${PROJECTS.join(', ')}, every ${EVERY / 1000} s${PASSWORD ? ', password on' : ', NO password'}`)
        void loop()
    })
