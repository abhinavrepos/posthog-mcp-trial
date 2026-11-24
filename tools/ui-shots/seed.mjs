import { DatabaseSync } from 'node:sqlite'
import { admin, clients } from './fixtures.mjs'

// Called after Lens has created its schema. Use its own public tables; no production
// data or project files are touched because the runner sets TRIAGE_DB to a temp file.
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
    db.prepare('INSERT OR REPLACE INTO client_codenames (client, name, codename, aliases, set_by, set_at, rank) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(client.id, client.name, `Client ${100 + index}`, '[]', admin.email, now, index)
  }
  db.prepare('INSERT OR REPLACE INTO dashboards (id, owner, kind, title, params, via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('aaaabbbbcccc', admin.email, 'posthog_chart', 'Weekly activity', JSON.stringify({ query: { kind: 'HogQLQuery', query: "SELECT toDate(timestamp) AS day, count() AS total FROM events WHERE timestamp > now() - INTERVAL 7 DAY GROUP BY day ORDER BY day" }, chart: 'bar' }), 'chat', now, now)
  db.prepare('INSERT OR REPLACE INTO mcp_tokens (id, email, hash, label, posthog_admin, created_at, last_used_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('screen-key-01', admin.email, 'screen-hash-01', 'Work Copilot', 1, now, now, null, null)
  db.prepare('INSERT OR REPLACE INTO mcp_tokens (id, email, hash, label, posthog_admin, created_at, last_used_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('screen-key-02', admin.email, 'screen-hash-02', 'Previous laptop', 1, now, now, now, admin.email)
  db.prepare('INSERT INTO survey_launches (survey_id, survey_name, ticket, launched_by, at, via, rules) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('11111111-1111-4111-8111-111111111111', 'Invoice export feedback', 'UX-142', admin.email, now, 'page', '{}')
  db.close()
}

export function seedTasks(file) {
  const db = new DatabaseSync(file)
  const now = new Date().toISOString()
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
  const tasks = [{ id: 't_InvoiceExport', dialog: 'InvoiceExport', name: 'Export invoice' }, { id: 't_TradeSave', dialog: 'TradeSave', name: 'Save trade' }]
  for (const task of tasks) {
    db.prepare('INSERT OR REPLACE INTO task_catalog (task_id, dialog, name, finish, first_day, last_day) VALUES (?, ?, ?, ?, ?, ?)').run(task.id, task.dialog, task.name, 'Done', day(60), day(1))
    db.prepare('INSERT OR REPLACE INTO dialog_names (dialog, name) VALUES (?, ?)').run(task.dialog, task.name)
  }
  for (let d = 1; d <= 60; d++) {
    const date = day(d)
    db.prepare('INSERT OR REPLACE INTO task_ingest (day, sessions, events, attempts, truncated, seconds, done_at, finalized) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(date, 21, 340, 37, 0, 1.2, now, 1)
    for (const [i, client] of clients.entries()) for (const [j, task] of tasks.entries()) {
      const attempts = 4 + ((d + i + j) % 5), done = attempts - (i === 1 && j === 0 && d < 15 ? 2 : 1)
      const hist = Array(21).fill(0); hist[5 + i + j] = done
      const path = JSON.stringify([task.dialog, 'Done'])
      db.prepare('INSERT OR REPLACE INTO task_daily (day, client, task_id, attempts, done, failed, abandoned, users, dur_hist) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(date, client.id, task.id, attempts, done, attempts - done, 0, 3, JSON.stringify(hist))
      db.prepare('INSERT OR REPLACE INTO task_paths_daily (day, client, task_id, path_key, path, attempts, done, dur_hist) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(date, client.id, task.id, path, path, attempts, done, JSON.stringify(hist))
      for (let u = 0; u < 3; u++) db.prepare('INSERT OR REPLACE INTO task_users_daily (day, client, task_id, user) VALUES (?, ?, ?, ?)').run(date, client.id, task.id, `${client.id}-person-${u}`)
      if (d <= 5) db.prepare('INSERT INTO task_attempts (day, client, user, session_id, task_id, path, path_key, started_at, ended_at, duration_s, outcome, errors, first_error, offset_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(date, client.id, client.user, `task-session-${d}-${i}-${j}`, task.id, path, path, new Date(Date.now() - d * 86400000).toISOString(), new Date(Date.now() - d * 86400000 + 80000).toISOString(), 80, done ? 'done' : 'failed', 0, null, 6)
    }
  }
  for (const [i, client] of clients.entries()) {
    db.prepare('INSERT OR REPLACE INTO client_names (client, name) VALUES (?, ?)').run(client.id, client.name)
    db.prepare('INSERT OR REPLACE INTO watch_clients (client, added_by, added_at, paused, found, checked_at, last_read_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(client.id, admin.email, now, i === 2 ? 1 : 0, 4, now, now, null)
    for (let j = 0; j < 3; j++) {
      const mark = j === 0 ? 'failed_submit' : j === 1 ? 'repeated_clicks' : 'slow_response'
      const step = { n: 1, at_ms: 54000, from_ms: 25000, kind: 'submit', target: 'button#save', clicks: j === 1 ? 4 : 1,
        lead: { ms: 25000, dwell_ms: 2100, returns: 2, path_efficiency: 0.4, pauses: 1, longest_pause_ms: 4000, fields: ['field:amount'], field_returns: 1, scroll_reversals: 0, pointer_turns: 2, hovered: [] },
        after: { page: 'no change', request_ms: j === 2 ? 8400 : 300, status: j === 0 ? '5xx' : '2xx', error_shown: j === 0 }, marks: [mark] }
      const moments = { version: 2, duration_ms: 145000, active_ms: 98000, steps: [step], pointer: { samples: 48, coverage: 'good' } }
      const started = new Date(Date.now() - (i * 3 + j + 1) * 3600000).toISOString()
      db.prepare('INSERT OR REPLACE INTO watch_sessions (session_id, client, user_hash, started_at, duration_ms, active_ms, score, marks, moments, version, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`watched-${i}-${j}`, client.id, `person-${j}`, started, 145000, 98000, 9, JSON.stringify([mark]), JSON.stringify(moments), 2, now)
    }
  }
  db.close()
}
