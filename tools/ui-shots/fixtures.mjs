// Deterministic, offline data shared by the stand-in and its tests. The shape of the
// query response is PostHog's /query/ shape, not a Lens-specific shortcut.
export const admin = { email: 'admin@example.test', password: 'lens-screens', session: 'lens_screen_session_123', name: 'Morgan Lee' }
export const clients = [
  { id: 'C01', name: 'Northstar Capital', user: 'alex@northstar.test' },
  { id: 'C02', name: 'Meridian Markets', user: 'jules@meridian.test' },
  { id: 'C03', name: 'Atlas Trading', user: 'riley@atlas.test' },
]
export const surveys = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Invoice export feedback', description: 'How was exporting your invoice?', type: 'api', start_date: '2026-11-20T09:00:00Z', end_date: null, archived: false, created_at: '2026-11-18T10:00:00Z', questions: [{ id: 'q1', type: 'rating', question: 'How easy was export?', display: 'number', scale: 5 }] },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Trading workflow pulse', description: 'Weekly product pulse', type: 'api', start_date: null, end_date: null, archived: false, created_at: '2026-11-19T10:00:00Z', questions: [{ id: 'q1', type: 'open', question: 'What could work better?' }] },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Onboarding follow-up', description: 'New team onboarding', type: 'api', start_date: '2026-11-01T09:00:00Z', end_date: '2026-11-15T09:00:00Z', archived: false, created_at: '2026-10-30T10:00:00Z', questions: [{ id: 'q1', type: 'rating', question: 'How was onboarding?', display: 'number', scale: 5 }] },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Legacy navigation', description: 'Archived research', type: 'api', start_date: '2026-10-01T09:00:00Z', end_date: '2026-10-20T09:00:00Z', archived: true, created_at: '2026-09-30T10:00:00Z', questions: [{ id: 'q1', type: 'open', question: 'What did you use?' }] },
]
for (let i = 0; i < 2; i++) for (let state = 0; state < 4; state++) {
  const source = surveys[state]
  surveys.push({ ...source, id: `${state + 5 + i * 4}`.repeat(8) + '-1111-4111-8111-111111111111', name: `${source.name} · ${i ? 'regional' : 'follow-up'}` })
}
const iso = (n) => new Date(Date.now() - n * 60_000).toISOString()
const today = () => new Date().toISOString().slice(0, 10)
export function queryRows(sql, values = {}) {
  const picked = clients.filter(c => !values.client || c.id === values.client)
  if (/countIf\(event = 'survey shown'\) AS shown/.test(sql) && /GROUP BY id/.test(sql)) return surveys.filter(s => !s.archived).map((s, i) => ({ id: s.id, shown: 174 - i * 32, answered: 82 - i * 19, dismissed: 22 - i * 4 }))
  if (/GROUP BY event LIMIT 10/.test(sql) && /survey shown/.test(sql)) return [{ event: 'survey shown', n: 174 }, { event: 'survey sent', n: 82 }, { event: 'survey dismissed', n: 22 }]
  if (/AS r0_answers/.test(sql)) return [{ r0_answers: 82, r0_numeric_answers: 82, r0_average: 4.1, r0_promoters: 0, r0_detractors: 0, r0_bin_1: 3, r0_bin_2: 6, r0_bin_3: 15, r0_bin_4: 25, r0_bin_5: 33 }]
  if (/last_at AS at, submission, total/.test(sql)) return [{ at: iso(12), submission: 'response-01', total: 2 }, { at: iso(84), submission: 'response-02', total: 2 }]
  if (/value AS text, client, last_at AS at, submission/.test(sql)) return [{ text: 'The workflow is much clearer now.', client: clients[0].name, at: iso(12), submission: 'response-01' }, { text: 'Faster export would help at month end.', client: clients[1].name, at: iso(84), submission: 'response-02' }]
  if (/GROUP BY client ORDER BY shown DESC/.test(sql)) return clients.map((c, i) => ({ client: c.name, shown: 85 - i * 17, answered: 39 - i * 8, dismissed: 10 - i * 2 }))
  if (/GROUP BY day ORDER BY day/.test(sql) && /survey shown/.test(sql)) return Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10), shown: 13 + i * 3, answered: 6 + i }))
  if (/count\(\) AS total/.test(sql) && /GROUP BY day/.test(sql)) return Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10), total: 21 + i * 4 }))
  if (/GROUP BY client, user ORDER BY last_seen/.test(sql)) return picked.map((c, i) => ({ client: c.id, client_name: c.name, user: c.user, sid: `session-${i + 1}`, last_seen: iso(1 + i) }))
  if (/GROUP BY sid LIMIT 1000/.test(sql)) return picked.map((c, i) => ({ sid: `session-${i + 1}`, start: iso(35 + i), client: c.id, user: c.user }))
  if (/GROUP BY client, user LIMIT 1000/.test(sql)) return picked.map((c, i) => ({ client: c.id, user: c.user, first: iso(35 + i), open_ms: 1_800_000, active_ms: 1_200_000 }))
  if (/GROUP BY client, user, sid, day, hour/.test(sql)) return picked.map((c, i) => ({ client: c.id, user: c.user, sid: `session-${i + 1}`, day: values.from || today(), hour: 10 + i, actions: 21 + i * 4, first: iso(35 + i), last: iso(2 + i), open_ms: 1_800_000, active_ms: 1_200_000 }))
  if (/GROUP BY sid ORDER BY start DESC/.test(sql)) return picked.map((c, i) => ({ sid: `session-${i + 1}`, user: c.user, client: c.id, start: iso(35 + i), end: iso(2 + i), actions: 21 + i * 4, open_ms: 1_800_000, active_ms: 1_200_000 }))
  if (/AS client_name/.test(sql) && /GROUP BY client/.test(sql)) return picked.map(c => ({ client: c.id, client_name: c.name }))
  return []
}
export function queryResponse(sql, values) {
  const rows = queryRows(sql, values)
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))]
  return { columns, results: rows.map(r => columns.map(k => r[k] ?? null)) }
}
