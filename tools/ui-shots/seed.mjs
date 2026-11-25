import { DatabaseSync } from 'node:sqlite'
import { admin, clients } from './fixtures.mjs'

export function seedDb(file) {
  const db = new DatabaseSync(file)
  const now = new Date().toISOString()
  db.prepare('INSERT OR REPLACE INTO people (email, role, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').run('analyst@example.test', 'watch', 'Product analyst', admin.email, now)
  db.prepare('INSERT OR REPLACE INTO people (email, role, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)').run('owner@example.test', 'download', 'Client lead', admin.email, now)
  for (const [index, client] of clients.entries()) {
    const name = `session-${index + 1}_10-32.mp4`
    db.prepare('INSERT OR REPLACE INTO clips (name, session_id, start_s, end_s, client, user, recording_start, download_name, bytes, created_by, created_at, last_requested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, `session-${index + 1}`, 10, 32, client.name, client.user, now, `${client.name} clip.mp4`, 7340032, admin.email, now, now)
    db.prepare('INSERT OR REPLACE INTO clip_holders (clip_name, email, made_at, saved_at) VALUES (?, ?, ?, ?)').run(name, admin.email, now, index === 0 ? now : null)
    db.prepare('INSERT INTO audit (t, who, action, details) VALUES (?, ?, ?, ?)').run(now, admin.email, index ? 'clip.viewed' : 'clip.created', JSON.stringify({ client: client.name, clip: name }))
  }
  db.prepare('INSERT OR REPLACE INTO mcp_tokens (id, email, hash, label, posthog_admin, created_at, last_used_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('screen-key-01', admin.email, 'screen-hash-01', 'Work Copilot', 1, now, now, null, null)
  db.prepare('INSERT OR REPLACE INTO mcp_tokens (id, email, hash, label, posthog_admin, created_at, last_used_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('screen-key-02', admin.email, 'screen-hash-02', 'Previous laptop', 1, now, now, now, admin.email)
  db.prepare('INSERT OR REPLACE INTO pinned_graphs (id, saved_by, saved_at, snapshot) VALUES (?, ?, ?, ?)')
    .run('screen-graph-1', admin.email, now, JSON.stringify({ title: 'Weekly activity', note: 'Saved from Copilot', chart: { type: 'bar', x: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], series: [{ name: 'Actions', values: [24, 31, 29, 40, 36] }] } }))
  const weeks = Array.from({ length: 26 }, (_, i) => `W${i + 22}`)
  const wau = (start, slope, wob) => weeks.map((_, i) => Math.max(0, Math.round(start + slope * i + wob * Math.sin(i / 2))))
  db.prepare('INSERT OR REPLACE INTO pinned_graphs (id, saved_by, saved_at, snapshot) VALUES (?, ?, ?, ?)')
    .run('screen-graph-2', admin.email, now, JSON.stringify({ title: 'Weekly active users, top 5 at-risk clients', note: 'Churn review, 26 weeks', chart: { type: 'line', x: weeks, series: [
      { name: 'SEM', values: wau(48, -1.2, 3) }, { name: 'C12', values: wau(40, -0.9, 4) }, { name: 'C31', values: wau(35, -0.4, 6) }, { name: 'C44', values: wau(30, -1.0, 2) }, { name: 'C05', values: wau(26, 0.1, 5) }] } }))
  db.prepare('INSERT OR REPLACE INTO pinned_graphs (id, saved_by, saved_at, snapshot) VALUES (?, ?, ?, ?)')
    .run('screen-graph-3', admin.email, now, JSON.stringify({ title: 'Exports by quarter', note: 'Hedge Designation exports', chart: { type: 'bar', x: ['Q4 2025', 'Q1 2026', 'Q2 2026', 'Q3 2026'], series: [
      { name: 'Export', values: [1240, 1385, 1102, 980] }, { name: 'XLSX Export', values: [860, 910, 1030, 1150] }, { name: 'CSV Export', values: [310, 295, 340, 362] }] } }))
  db.prepare('INSERT OR REPLACE INTO pinned_graphs (id, saved_by, saved_at, snapshot) VALUES (?, ?, ?, ?)')
    .run('screen-graph-4', admin.email, now, JSON.stringify({ title: 'Churn risk score', note: 'Top 10 clients, 0-100', chart: { type: 'bar', x: ['SEM', 'C12', 'C44', 'C31', 'C05', 'C27', 'C19', 'C50', 'C08', 'C33'], series: [{ name: 'Risk score', values: [82, 77, 71, 64, 58, 52, 47, 41, 36, 30] }] } }))
  db.prepare('INSERT INTO survey_launches (survey_id, survey_name, ticket, launched_by, at, via, rules) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('11111111-1111-4111-8111-111111111111', 'Invoice export feedback', 'UX-142', admin.email, now, 'page', '{}')
  db.close()
}
