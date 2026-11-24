import test from 'node:test'
import assert from 'node:assert/strict'
import { admin, clients, surveys, queryResponse } from './fixtures.mjs'
import { shots, tabs, surveyStates, shotName } from './routes.mjs'
import { statusSnapshot } from './status.mjs'

test('shot inventory covers every page and each named state', () => {
  const names = new Set(shots.map(s => s.name))
  for (const name of ['signin', 'replay-clips', 'watchlist', 'live', 'surveys', 'chat', 'system', 'admin', 'privacy', 'dashboards-briefing', 'dashboards-rescue', 'dashboards-scorecard', 'dashboards-pinned']) assert.ok(names.has(name), name)
  assert.equal(names.size, shots.length)
  assert.ok(shots.every(s => s.path.startsWith('/replays')))
  assert.equal(shotName('system', 'Service checks', 'light', 375), 'system-service-checks-light-375.png')
  assert.equal(tabs.admin.length, 5)
  assert.deepEqual(surveyStates, ['running', 'draft', 'stopped'])
})
test('seed data has multiple clients and each survey lifecycle state', () => {
  assert.match(admin.session, /^[A-Za-z0-9:._-]{8,200}$/)
  assert.equal(new Set(clients.map(c => c.id)).size, clients.length)
  assert.ok(surveys.some(s => s.start_date && !s.end_date && !s.archived))
  assert.ok(surveys.some(s => !s.start_date && !s.archived))
  assert.ok(surveys.some(s => s.end_date && !s.archived))
  assert.ok(surveys.some(s => s.archived))
  const r = queryResponse('SELECT client, user, sid, toString(day) AS day, hour FROM events GROUP BY client, user, sid, day, hour', { from: '2026-11-24' })
  assert.equal(r.results.length, clients.length)
  assert.ok(r.columns.includes('open_ms'))
})
test('system fixture includes healthy and failing checks', () => {
  const s = statusSnapshot()
  assert.ok(s.checks.some(c => c.level === 'ok'))
  assert.ok(s.checks.some(c => c.level === 'down'))
  assert.ok(s.checks.some(c => c.level === 'warn'))
  assert.ok(s.metrics.events_by_hour.length >= 24)
})
