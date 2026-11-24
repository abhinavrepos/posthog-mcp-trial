import { createServer } from 'node:http'
import { admin, queryResponse, surveys } from './fixtures.mjs'

export function posthogServer() {
  let mode = 'data'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
    const authed = String(req.headers.cookie || '').includes(`sessionid=${admin.session}`) || String(req.headers.authorization || '').startsWith('Bearer ')
    const readBody = async () => { let raw = ''; for await (const part of req) raw += part; try { return JSON.parse(raw) } catch { return {} } }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody()
      if (body.email !== admin.email || body.password !== admin.password) return send(401, { detail: 'Incorrect email or password' })
      return send(200, { ok: true }, { 'set-cookie': [`sessionid=${admin.session}; Path=/; HttpOnly`, 'posthog_csrftoken=screen-csrf; Path=/'] })
    }
    if (url.pathname === '/api/users/@me/') return authed ? send(200, { email: admin.email, first_name: admin.name, is_active: true, organizations: [{ id: 'screen-org', membership_level: 15 }] }) : send(401, {})
    if (/^\/api\/projects\/1\/$/.test(url.pathname)) return authed ? send(200, { id: 1, organization: 'screen-org' }) : send(401, {})
    if (/^\/api\/projects\/1\/surveys\/?$/.test(url.pathname)) return mode === 'error' ? send(503, { detail: 'PostHog unavailable' }) : send(200, { results: mode === 'empty' ? [] : surveys, count: mode === 'empty' ? 0 : surveys.length, next: null })
    const survey = /^\/api\/projects\/1\/surveys\/([^/]+)\/?$/.exec(url.pathname)
    if (survey) return send(200, surveys.find(s => s.id === survey[1]) || {})
    if (url.pathname === '/api/projects/1/query/' && req.method === 'POST') {
      const body = await readBody()
      const q = body.query || {}
      return mode === 'error' ? send(503, { detail: 'PostHog unavailable' }) : mode === 'empty' ? send(200, { columns: [], results: [] }) : send(200, queryResponse(String(q.query || ''), q.values || {}))
    }
    if (url.pathname === '/logout') return send(200, {})
    return send(200, { results: [], count: 0, next: null })
  })
  server.setMode = value => { mode = value }
  return server
}
