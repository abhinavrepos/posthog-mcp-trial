import { cached, tasksDb, validDay } from './tasks.ts'
import { rescuePrivacy } from './rescueprivacy.ts'
export interface NewClient {
    client: string; client_name: string; first_seen: string; days: number
    tasks: { task_id: string; task_name: string; attempts: number; done: number; done_weeks: number; established: boolean }[]
    text: string
}
export function newClientValues(to: string): Promise<NewClient[]> {
    validDay(to)
    return cached('new-client-values', { to }, async () => {
        // First processed activity is independent of the review date. A later first date is
        // simply excluded below; backfills invalidate this shared read with the other answers.
        const earliest = await cached('client-first-activity', {}, async () => tasksDb.prepare(`SELECT client,min(day) AS first_seen FROM (
            SELECT c.client,(SELECT d.day FROM task_daily d JOIN task_ingest i USING(day)
                WHERE d.client=c.client AND i.truncated=0 AND d.attempts>0 ORDER BY d.day LIMIT 1) AS day
                FROM (SELECT DISTINCT client FROM task_daily) c
            UNION ALL SELECT d.client,min(d.day) AS day FROM user_daily d JOIN task_ingest i USING(day) WHERE i.truncated=0 AND d.events>0 GROUP BY d.client
            UNION ALL SELECT d.client,min(d.day) AS day FROM client_daily d JOIN task_ingest i USING(day) WHERE i.truncated=0 AND d.sessions>0 GROUP BY d.client
        ) GROUP BY client HAVING first_seen IS NOT NULL ORDER BY first_seen,client`).all() as { client: string; first_seen: string }[])
        const from = new Date(Date.parse(to)-89*86400000).toISOString().slice(0,10)
        const first = earliest.filter(c=>c.first_seen>=from && c.first_seen<=to)
        const candidates = new Set(first.map(c=>c.client))
        const grouped = new Map<string, Omit<NewClient['tasks'][number], 'established'>[]>()
        if (first.length) {
            const rows = tasksDb.prepare(`SELECT d.client,d.task_id,coalesce(c.name,d.task_id) AS task_name,sum(d.attempts) AS attempts,sum(d.done) AS done,
                count(DISTINCT CASE WHEN d.done>0 THEN strftime('%G-%V',d.day) END) AS done_weeks FROM task_daily d
                JOIN task_ingest i USING(day) LEFT JOIN task_catalog c USING(task_id) WHERE d.day BETWEEN ? AND ? AND i.truncated=0
                GROUP BY d.client,d.task_id ORDER BY d.client,attempts DESC,d.task_id`).all(from,to) as (Omit<NewClient['tasks'][number], 'established'> & {client:string})[]
            for (const {client,...r} of rows) if (candidates.has(client)) {
                const list=grouped.get(client)||[]; if(list.length<3)list.push(r);grouped.set(client,list)
            }
        }
        const names = new Map((tasksDb.prepare('SELECT client,name FROM client_names').all() as {client:string;name:string}[]).map(r=>[r.client,r.name]))
        return rescuePrivacy(first.map(c => {
            const tasks = (grouped.get(c.client)||[]).map(t=>({...t, established:t.done_weeks>=2}))
            const days = Math.floor((Date.parse(to)-Date.parse(c.first_seen))/86400000), client_name=names.get(c.client)||c.client
            // Short on purpose: established tasks are counted, only the ones still struggling are named.
            const ok = tasks.filter(t=>t.established).length, open = tasks.filter(t=>!t.established)
            const text = `${client_name} (first seen ${days} days ago): ${!tasks.length ? 'no tasks completed yet' : ok === tasks.length ? `all ${ok} main tasks established` : `${ok} of ${tasks.length} main tasks established; ${open.map(t=>t.done ? `${t.task_name} done in only ${t.done_weeks} week` : `${t.task_name} tried ${t.attempts} times, never completed`).join('; ')}`}.`
            return {...c,client_name,days,tasks,text}
        }))
    })
}
