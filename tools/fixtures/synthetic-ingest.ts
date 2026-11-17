// Offline source shared by the responsiveness measurement and worker integration test.
import { existsSync, unlinkSync } from 'node:fs'
import { setTaskQuery } from '../../src/core/tasks.ts'
export default function bootstrap() {
    const count = Number(process.env.LENS_SYNTHETIC_EVENTS || 300000)
    setTaskQuery(async (sql, values = {}) => {
        const crash = process.env.LENS_SYNTHETIC_CRASH_FILE
        if (crash && existsSync(crash)) { unlinkSync(crash); process.exit(17) }
        if (sql.includes('raw_session_replay_events')) return []
        if (sql.includes('min(timestamp) AS first_event')) return [{ first_event: new Date().toISOString() }]
        const day = String(values.from)
        const sid = (i: number) => `s${String(Math.floor(i / 30)).padStart(6, '0')}`
        const ts = (i: number) => `${day}T10:00:${String(i % 30).padStart(2, '0')}.000Z`
        const uuid = (i: number) => String(i).padStart(8, '0')
        if (sql.includes('GROUP BY sid')) return Array.from({ length: Math.ceil(count / 30) }, (_, i) => ({ sid: sid(i * 30), first_ts: ts(i * 30), first_ctime: 0 }))
        const start = values.uuid ? Number(values.uuid) + 1 : 0
        const end = Math.min(count, start + 50000)
        if (!sql.includes('{end_sid}')) return Array.from({ length: end - start }, (_, j) => { const i = start + j; return { sid: sid(i), ts: ts(i), event_uuid: uuid(i) } })
        return Array.from({ length: end - start }, (_, j) => {
            const i = start + j, kind = i % 3
            return { sid: sid(i), ts: ts(i), event_uuid: uuid(i), ctime: 0, client: 'synthetic', user: 'synthetic-user',
                event: kind === 0 ? 'PageView' : 'Event', dialog: kind === 2 ? 'toast' : 'DlgSave',
                action: kind === 0 ? 'OPEN' : '', button: kind === 1 ? 'Save' : kind === 2 ? 'Trade Id 1234 Updated' : '', client_name: 'Synthetic' }
        })
    })
}
