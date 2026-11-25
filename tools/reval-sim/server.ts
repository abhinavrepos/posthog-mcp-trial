// Two local servers for the Reval simulation, on two origins as in production:
//   - Reval: the Ext JS page (page/), /Dialog with each screen's delay, the client-change POST, the vendor files.
//   - A stand-in PostHog: /static/array.js (posthog-js), /static/surveys.js BUILT by survey-engine/build.mjs (what
//     apply.sh serves), /flags, remote config, /api/surveys (public), capture (/e, /i/v0/e, /batch), the
//     project survey API Lens writes with (POST/PATCH/GET /api/projects/:id/surveys/) and HogQL (/query) for the
//     dialog names Lens checks steps against. Each project id has its own token, surveys, persons and events,
//     so every flow runs against a PostHog of its own.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { SCREENS } from './screens.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
export const VENDOR = process.env.REVAL_VENDOR || '/root/briefs/reval-vendor'

/** Why the simulation cannot run here, or '' when it can. */
export function missingVendor(): string {
    for (const f of ['extjs/ext-all.js', 'extjs/theme-classic-all.css', 'posthog-js/dist/array.js', 'posthog-js/dist/surveys.js'])
        if (!existsSync(join(VENDOR, f))) return `Reval simulation skipped: ${join(VENDOR, f)} is missing. Set REVAL_VENDOR to a folder with extjs/ (Ext JS classic, GPL, not in this repo) and posthog-js/ (the npm package).`
    return ''
}

export interface Captured { token: string; event: string; distinct_id: string; properties: Record<string, unknown>; at: number; $set?: Record<string, unknown> }
export interface StoredSurvey extends Record<string, unknown> { id: string; name: string; start_date: string | null; end_date: string | null; archived: boolean; created_at: string; schedule?: string; conditions?: Record<string, unknown> | null }
interface Project { surveys: StoredSurvey[]; events: Captured[]; persons: Map<string, Record<string, unknown>>; requests: string[] }

const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...extra })
    res.end(JSON.stringify(body))
}
const readBody = (req: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject)
})
const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)))

export class StandInPostHog {
    projects = new Map<string, Project>()
    port = 0
    url = ''
    server = createServer((req, res) => { this.handle(req, res).catch((e) => { console.error('stand-in PostHog:', e); json(res, 500, { detail: String(e) }) }) })
    surveysJs: string
    arrayJs: Buffer
    unknown: string[] = []
    versioned: 'lens' | 'original' | 'missing' = 'lens'
    constructor(buildDir: string) {
        this.surveysJs = readFileSync(join(buildDir, 'surveys.js'), 'utf8')
        this.arrayJs = readFileSync(join(buildDir, 'array.js'))
    }
    static build(outDir: string): string {
        mkdirSync(outDir, { recursive: true })
        execFileSync(process.execPath, [join(repo, 'deploy/posthog/survey-engine/build.mjs'), join(VENDOR, 'posthog-js/dist/surveys.js'), outDir, 'Survey by ION', join(VENDOR, 'posthog-js/dist/array.js')], { stdio: 'pipe' })
        if (!existsSync(join(outDir, 'array.js'))) throw new Error('The vendor posthog-js array.js has no verified Lens startup hook; early events cannot be tested.')
        return outDir
    }
    async start() { this.port = await listen(this.server); this.url = `http://127.0.0.1:${this.port}`; return this }
    stop() { this.server.closeAllConnections(); return new Promise<void>((r) => this.server.close(() => r())) }
    tokenFor(projectId: string) { return `phc_sim_${projectId}` }
    project(id: string): Project {
        let p = this.projects.get(id)
        if (!p) this.projects.set(id, (p = { surveys: [], events: [], persons: new Map(), requests: [] }))
        return p
    }
    byToken(token: string | null): Project | null {
        const m = /^phc_sim_(.+)$/.exec(token || '')
        return m ? this.project(m[1]) : null
    }
    events(projectId: string) { return this.project(projectId).events }

    // posthog-js reads a survey's internal targeting flag: on until the person answered or dismissed it (schedule once).
    private flagsFor(p: Project, distinctId: string) {
        const person = p.persons.get(distinctId) || {}
        const flags: Record<string, boolean> = {}
        for (const s of p.surveys) {
            if (!s.start_date || s.end_date || s.archived) continue
            const key = `survey-targeting-${s.id.slice(0, 8)}-custom`
            const done = person[`$survey_dismissed/${s.id}`] || person[`$survey_responded/${s.id}`]
            flags[key] = s.schedule === 'always' ? true : !done
        }
        return flags
    }
    private publicSurvey(s: StoredSurvey) {
        const { conditions, ...rest } = s
        return { ...rest, conditions, type: 'popover', internal_targeting_flag_key: `survey-targeting-${s.id.slice(0, 8)}-custom`, targeting_flag_key: null, linked_flag_key: null, current_iteration: null, current_iteration_start_date: null, feature_flag_keys: [] }
    }
    // Like PostHog's remote config: surveys lists the running surveys, or false when none runs (or surveys are off).
    private remoteConfig(token: string) {
        const running = (this.byToken(token)?.surveys || []).filter((s) => s.start_date && !s.end_date && !s.archived)
        return { token, supportedCompression: ['gzip', 'gzip-js'], hasFeatureFlags: true, captureDeadClicks: false, capturePerformance: false, autocapture_opt_out: true,
            autocaptureExceptions: false, analytics: { endpoint: '/i/v0/e/' }, elementsChainAsString: true, errorTracking: { autocaptureExceptions: false, suppressionRules: [] },
            sessionRecording: false, heatmaps: false, surveys: running.length ? running.map((s) => this.publicSurvey(s)) : false, defaultIdentifiedOnly: true, siteApps: [] }
    }

    private record(p: Project, token: string, raw: Record<string, unknown>) {
        const props = (raw.properties || {}) as Record<string, unknown>
        const distinct = String(raw.distinct_id ?? props.distinct_id ?? '')
        const ev: Captured = { token, event: String(raw.event), distinct_id: distinct, properties: props, at: Date.now() }
        const set = { ...(raw.$set as object || {}), ...(props.$set as object || {}) } as Record<string, unknown>
        if (Object.keys(set).length) ev.$set = set
        p.events.push(ev)
        const person = p.persons.get(distinct) || {}
        Object.assign(person, set)
        if (ev.event === '$identify' && typeof props.$anon_distinct_id === 'string') Object.assign(person, p.persons.get(props.$anon_distinct_id) || {})
        p.persons.set(distinct, person)
    }

    private decode(url: URL, req: IncomingMessage, body: Buffer): unknown[] {
        let buf = body
        const compression = url.searchParams.get('compression') || ''
        if (/gzip/.test(compression) || req.headers['content-encoding'] === 'gzip' || (buf[0] === 0x1f && buf[1] === 0x8b)) buf = gunzipSync(buf)
        let text = buf.toString('utf8')
        if (/^data=/.test(text)) text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8')
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) return parsed
        if (Array.isArray(parsed.batch)) return parsed.batch
        return [parsed]
    }

    private async handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url || '/', this.url)
        let path = url.pathname
        // api_host "<url>/slow<ms>": a slow network for posthog-js's script, config and survey loads.
        const slow = /^\/slow(\d+)(\/.*)$/.exec(path)
        if (slow) {
            path = slow[2]
            if (/^\/(static|array|flags|decide|api\/surveys)/.test(path) && req.method !== 'OPTIONS') await new Promise((r) => setTimeout(r, Math.min(Number(slow[1]), 20_000)))
        }
        const cors = { 'access-control-allow-origin': String(req.headers.origin || '*'), 'access-control-allow-credentials': 'true',
            'access-control-allow-headers': String(req.headers['access-control-request-headers'] || 'content-type'), 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' }
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v)
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
        const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req)

        if (path === '/static/surveys.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(this.surveysJs); return }
        if (path === '/static/array.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(this.arrayJs); return }
        // posthog-js asks for /static/<its version>/surveys.js first, then falls back to /static/surveys.js.
        // versioned: what a PostHog serves there (apply.sh mounts the Lens build over every copy it finds).
        if (/^\/static\/\d+\.\d+\.\d+\/surveys\.js$/.test(path)) {
            if (this.versioned === 'missing') { res.writeHead(404); res.end(); return }
            res.writeHead(200, { 'content-type': 'application/javascript' })
            res.end(this.versioned === 'original' ? readFileSync(join(VENDOR, 'posthog-js/dist/surveys.js')) : this.surveysJs)
            return
        }
        if (path.startsWith('/static/')) {
            const file = normalize(path.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '')
            const full = join(VENDOR, 'posthog-js/dist', file)
            if (/\.js$/.test(file) && existsSync(full)) { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(readFileSync(full)); return }
            this.unknown.push(`${req.method} ${path}`); res.writeHead(404); res.end(); return
        }
        // Remote config: /array/<token>/config (JSON) and /array/<token>/config.js (a script).
        const rc = /^\/array\/([^/]+)\/config(\.js)?$/.exec(path)
        if (rc) {
            this.byToken(rc[1])?.requests.push(path)
            const config = this.remoteConfig(rc[1])
            if (rc[2]) { res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(`(function(){window._POSTHOG_REMOTE_CONFIG=window._POSTHOG_REMOTE_CONFIG||{};window._POSTHOG_REMOTE_CONFIG[${JSON.stringify(rc[1])}]={config:${JSON.stringify(config)},siteApps:[]}})();`); return }
            return json(res, 200, config)
        }
        if (path === '/flags/' || path === '/flags' || path === '/decide/' ) {
            let payload: Record<string, unknown> = {}
            try { payload = this.decode(url, req, body)[0] as Record<string, unknown> } catch { /* empty */ }
            const token = String(payload.token || url.searchParams.get('token') || '')
            const p = this.byToken(token)
            p?.requests.push(`flags ${payload.distinct_id}`)
            const flags = p ? this.flagsFor(p, String(payload.distinct_id || '')) : {}
            return json(res, 200, { ...this.remoteConfig(token), featureFlags: flags, featureFlagPayloads: {}, errorsWhileComputingFlags: false, quotaLimited: [],
                flags: Object.fromEntries(Object.entries(flags).map(([key, enabled]) => [key, { key, enabled, variant: undefined, reason: { code: enabled ? 'condition_match' : 'no_condition_match' }, metadata: { id: 1, version: 1 } }])), requestId: randomUUID() })
        }
        if (path === '/api/surveys/' || path === '/api/surveys') {
            const p = this.byToken(url.searchParams.get('token'))
            p?.requests.push('surveys')
            return json(res, 200, { surveys: (p?.surveys || []).filter((s) => !s.archived).map((s) => this.publicSurvey(s)) })
        }
        if (/^\/(e|i\/v0\/e|batch|capture|track)\/?$/.test(path)) {
            let items: unknown[] = []
            try { items = this.decode(url, req, body) } catch (e) { this.unknown.push(`undecodable ${path}: ${(e as Error).message}`) }
            for (const raw of items as Record<string, unknown>[]) {
                const token = String((raw.properties as Record<string, unknown> | undefined)?.token || raw.api_key || raw.token || '')
                const p = this.byToken(token)
                if (p) this.record(p, token, raw)
            }
            return json(res, 200, { status: 1 })
        }
        if (/^\/(s|i\/v0\/s)\/?$/.test(path)) return json(res, 200, { status: 1 })

        // ---- the project API Lens uses
        const api = /^\/api\/(?:projects|environments)\/([^/]+)\/(surveys|query)\/(?:([^/]+)\/)?$/.exec(path)
        if (api) {
            if (!/^Bearer /.test(String(req.headers.authorization || ''))) return json(res, 401, { detail: 'no key' })
            const p = this.project(api[1])
            const data = body.length ? JSON.parse(body.toString('utf8')) : {}
            if (api[2] === 'query') return json(res, 200, this.hogql(String(data.query?.query || ''), data.query?.values || {}, p))
            const id = api[3]
            if (!id && req.method === 'GET') {
                const q = url.searchParams.get('search')
                const list = p.surveys.filter((s) => !q || s.name.toLowerCase().includes(q.toLowerCase()))
                return json(res, 200, { results: list, next: null })
            }
            if (!id && req.method === 'POST') {
                if (p.surveys.some((s) => s.name === data.name && !s.archived)) return json(res, 400, { type: 'validation_error', attr: 'name', detail: 'There is already a survey with this name.' })
                const s: StoredSurvey = { archived: false, start_date: null, end_date: null, ...data, id: randomUUID(), created_at: new Date().toISOString(), created_by: { email: 'pm@ion.example' } }
                s.questions = ((s.questions as Record<string, unknown>[]) || []).map((q) => ({ id: q.id || randomUUID(), ...q }))
                p.surveys.push(s)
                return json(res, 201, s)
            }
            const s = p.surveys.find((x) => x.id === id)
            if (!s) return json(res, 404, { detail: 'Not found.' })
            if (req.method === 'GET') return json(res, 200, s)
            if (req.method === 'PATCH') { Object.assign(s, data); return json(res, 200, s) }
        }
        this.unknown.push(`${req.method} ${path}`)
        json(res, 404, { detail: 'unknown to the stand-in' })
    }

    // Answer the bounded evidence queries from events the browser actually sent. Keep the older
    // dialogNames fixture for the catalog, which is independent of this visit's event history.
    private hogql(query: string, values: Record<string, unknown>, p: Project) {
        if (/AS dialog, topK\(3\)/.test(query)) {
            const seen = new Map<string, string>()
            for (const s of SCREENS) if (!seen.has(s.event)) seen.set(s.event, s.name)
            if (values.cursor) return { columns: ['dialog', 'names', 'opens', 'sessions', 'clients'], results: [] }
            return { columns: ['dialog', 'names', 'opens', 'sessions', 'clients'], results: [...seen].sort().map(([d, n]) => [d, [n], 40, 30, 5]) }
        }
        const rows = p.events.filter((e) => {
            if (typeof values.days === 'number' && e.at < Date.now() - values.days * 86400000) return false
            if (values.history_from && e.at < Date.parse(String(values.history_from))) return false
            if (values.history_to && e.at >= Date.parse(String(values.history_to))) return false
            return true
        })
        const events = (values.events as string[] | undefined)
        const app = rows.filter((e) => events?.includes(e.event))
        const result = (columns: string[], objects: Record<string, unknown>[]) => ({ columns, results: objects.map((r) => columns.map((c) => r[c] ?? null)) })
        if (/SELECT count\(\) AS n, .* AS carried, countIf\(/s.test(query)) {
            const property = /toString\(properties\.([A-Za-z_$][\w$]*)\)/.exec(query)?.[1]
            const part = /splitByChar\('[^']+', toString\(distinct_id\)\)\[(\d+)\]/.exec(query)?.[1]
            const separator = /splitByChar\('([^']+)'/.exec(query)?.[1] || '|'
            const client = (e: Captured) => property ? String(e.properties[property] ?? '') : part ? e.distinct_id.split(separator)[Number(part) - 1] || '' : ''
            const chosen = (values.clients as string[] || []).map((x) => x.toLowerCase())
            return result(['n', 'carried', 'chosen'], [{ n: app.length, carried: app.filter((e) => property ? client(e) !== '' : e.distinct_id.split(separator).length >= Number(part)).length,
                chosen: app.filter((e) => chosen.includes(client(e).toLowerCase())).length }])
        }
        if (/SELECT count\(\) AS n FROM events/.test(query)) return result(['n'], [{ n: app.length }])
        const grouped = (items: Captured[], key: (e: Captured) => string) => {
            const counts = new Map<string, number>()
            for (const e of items) counts.set(key(e), (counts.get(key(e)) || 0) + 1)
            return [...counts].map(([v, n]) => ({ v, n })).sort((a, b) => b.n - a.n)
        }
        if (/AS id, .* AS name,/.test(query) && /GROUP BY id, name/.test(query)) {
            const groups = new Map<string, { id: string; name: string; opens: number; closes: number; n: number }>()
            for (const e of rows.filter((x) => x.event === values.screen)) {
                const id = String(e.properties.dialog_id ?? ''), name = String(e.properties.dialog_name ?? ''), key = `${id}\0${name}`
                const r = groups.get(key) || { id, name, opens: 0, closes: 0, n: 0 }
                r.n++; if ((values.open as string[] || []).includes(String(e.properties.action))) r.opens++
                if ((values.close as string[] || []).includes(String(e.properties.action))) r.closes++
                groups.set(key, r)
            }
            return result(['id', 'name', 'opens', 'closes', 'n'], [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 10000))
        }
        if (/AS id, count\(\) AS n/.test(query) && /event = \{interaction\}/.test(query))
            return result(['id', 'n'], grouped(rows.filter((e) => e.event === values.interaction && (values.ids as string[] || []).includes(String(e.properties.dialog_id))), (e) => String(e.properties.dialog_id)).map((r) => ({ id: r.v, n: r.n })))
        if (/toString\(properties\.[\w$]+\) AS v, count\(\) AS n/.test(query) && /event = \{interaction\}/.test(query)) {
            const property = /toString\(properties\.([\w$]+)\) AS v/.exec(query)![1]
            const skip = new Set(values.msg as string[] || [])
            const filtered = rows.filter((e) => e.event === values.interaction && !skip.has(String(e.properties.dialog_id)))
            return result(['v', 'n'], grouped(filtered, (e) => String(e.properties[property] ?? '')).slice(0, 5000))
        }
        if (/\bAS v, count\(\) AS n/.test(query) && /\{list\}/.test(query)) {
            const property = /toString\(properties\.([\w$]+)\)/.exec(query)?.[1]
            const filtered = rows.filter((e) => (!property || e.event === values.interaction) && (values.list as string[] || []).includes(String(property ? e.properties[property] ?? '' : e.event).toLowerCase()))
            return result(['v', 'n'], grouped(filtered, (e) => String(property ? e.properties[property] ?? '' : e.event)).slice(0, 200))
        }
        throw new Error(`Unexpected simulation HogQL: ${query.slice(0, 180)}`)
    }
}

/** The simulated Reval's own server. */
export class RevalServer {
    port = 0
    url = ''
    server = createServer((req, res) => { this.handle(req, res).catch((e) => { console.error('Reval server:', e); res.writeHead(500); res.end() }) })
    dialogRequests = 0
    async start() { this.port = await listen(this.server); this.url = `http://127.0.0.1:${this.port}`; return this }
    stop() { this.server.closeAllConnections(); return new Promise<void>((r) => this.server.close(() => r())) }
    private async handle(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url || '/', this.url)
        const path = url.pathname
        if (path === '/' || path === '/reval') {
            // GET: the query string sets the session. POST: the client-change form (a full reload).
            const q = Object.fromEntries(url.searchParams)
            if (req.method === 'POST') Object.assign(q, Object.fromEntries(new URLSearchParams((await readBody(req)).toString('utf8'))))
            const cfg = {
                token: q.token, posthogHost: q.ph, env: q.env || 'C1DEV', site: q.site || '01', client: q.client || 'SEM', user: q.user || 'SEMOPS',
                initDelayMs: q.init !== undefined ? Number(q.init) : 300, speed: Number(q.speed || 1), screens: SCREENS,
            }
            const html = readFileSync(join(here, 'page/index.html'), 'utf8').replace('__REVAL_CFG__', () => JSON.stringify(cfg).replace(/</g, '\\u003c'))
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
            res.end(html)
            return
        }
        if (path === '/Dialog') {
            this.dialogRequests++
            const ms = Math.min(10_000, Number(url.searchParams.get('ms') || 200))
            await new Promise((r) => setTimeout(r, ms))
            res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"success":true}')
            return
        }
        const statics: Record<string, [string, string]> = {
            '/reval.js': [join(here, 'page/reval.js'), 'application/javascript'],
            '/iframe.html': [join(here, 'page/iframe.html'), 'text/html; charset=utf-8'],
            '/ext/ext-all.js': [join(VENDOR, 'extjs/ext-all.js'), 'application/javascript'],
            '/ext/theme-classic-all.css': [join(VENDOR, 'extjs/theme-classic-all.css'), 'text/css'],
            '/ext/theme-classic-all_1.css': [join(VENDOR, 'extjs/theme-classic-all_1.css'), 'text/css'],
            '/ext/theme-classic-all_2.css': [join(VENDOR, 'extjs/theme-classic-all_2.css'), 'text/css'],
        }
        const hit = statics[path]
        if (hit) { res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'max-age=3600' }); res.end(readFileSync(hit[0])); return }
        // The theme's images were not fetched: an empty GIF keeps the console clean.
        if (path.startsWith('/ext/images/')) { res.writeHead(200, { 'content-type': 'image/gif' }); res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')); return }
        res.writeHead(404); res.end()
    }
}
