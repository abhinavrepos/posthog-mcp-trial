// Upgrade retained history gradually. Each day is atomic; failures preserve the existing task evidence.
import { tasksDb } from './tasks.ts'
import { indexWorkflowDay, backfillGlobalFriction } from './analysishistory.ts'
import { ingestAggregateDaily } from './aggregatedaily.ts'
export async function backfillPerformanceHistory(limit: number, query: (sql: string, values: Record<string,unknown>) => Promise<Record<string,unknown>[]>) {
    const days = tasksDb.prepare(`SELECT day FROM task_ingest WHERE finalized=1 AND truncated=0
        AND 'analysis_unavailable:' || day NOT IN (SELECT key FROM task_state)
        AND 'query_failed:' || day NOT IN (SELECT key FROM task_state) AND day IN (SELECT day FROM analysis_days)
        AND (day NOT IN (SELECT day FROM friction_daily WHERE client='*') OR day NOT IN (SELECT day FROM workflow_episode_index_days) OR day NOT IN (SELECT day FROM task_active_users_days)
        OR (day NOT IN (SELECT day FROM aggregate_dimension_daily) AND day NOT IN (SELECT day FROM aggregate_dimension_skipped)))
        ORDER BY day DESC LIMIT ?`).all(Math.max(0,limit))
    for (const {day} of days) {
        try {
            indexWorkflowDay(String(day))
            backfillGlobalFriction(String(day))
            if (!tasksDb.prepare('SELECT 1 FROM task_active_users_days WHERE day=?').get(day)) {
                tasksDb.exec('BEGIN IMMEDIATE')
                try {
                    tasksDb.prepare('INSERT OR IGNORE INTO task_active_users_daily SELECT DISTINCT day,client,user FROM task_users_daily WHERE day=?').run(day)
                    tasksDb.prepare('INSERT INTO task_active_users_days VALUES (?)').run(day)
                    tasksDb.exec('COMMIT')
                } catch(e) { tasksDb.exec('ROLLBACK'); throw e }
            }
            if (!tasksDb.prepare('SELECT 1 FROM aggregate_dimension_daily WHERE day=?').get(day) && !tasksDb.prepare('SELECT 1 FROM aggregate_dimension_skipped WHERE day=?').get(day)) await ingestAggregateDaily(tasksDb,String(day),query)
        } catch(e) { console.error(JSON.stringify({event:'performance.backfill_error',day,error:String((e as Error).message)})) }
        await new Promise<void>(resolve=>setImmediate(resolve))
    }
}
