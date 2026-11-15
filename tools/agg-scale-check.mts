// SELECT-only scale check. Uses the lab bridge translator, avoiding installClickhouseBridge's
// SYSTEM FLUSH LOGS so the lab is never mutated. Run: node --import tsx tools/agg-scale-check.mts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const lab = process.env.LENS_LAB_BRIDGE || '/tmp/claude-0/-root/2bc783d3-062c-48de-ba03-65e0907eb948/scratchpad/chlab/bridge.mts'
const { translate } = await import(lab)
const nativeFetch = globalThis.fetch.bind(globalThis)
const dir = mkdtempSync(join(tmpdir(), 'lens-agg-scale-'))
Object.assign(process.env, { TRIAGE_DB: join(dir,'main.db'), TASKS_DB: join(dir,'tasks.db'), APP_EVENTS_FILE: 'config/app-events.reval.json', POSTHOG_HOST: 'http://posthog.fake', POSTHOG_PROJECT_ID: '1', POSTHOG_PERSONAL_API_KEY: 'phx_fake' })
async function sql(query: string) {
    if (!/^\s*SELECT\b/i.test(query)) throw Error('SELECT only')
    const u = new URL('http://127.0.0.1:18123')
    Object.entries({database:'lab', max_threads:'2', max_memory_usage:'1800000000', output_format_json_quote_64bit_integers:'0', date_time_output_format:'iso', date_time_input_format:'best_effort'}).forEach(([k,v])=>u.searchParams.set(k,v))
    const r = await nativeFetch(u,{method:'POST', body:query + ' SETTINGS function_json_value_return_type_allow_nullable=1 FORMAT JSON',signal:AbortSignal.timeout(120000)})
    if (!r.ok) throw Error(await r.text())
    return r.json() as Promise<{data:Record<string,unknown>[];meta:{name:string}[]}>
}
globalThis.fetch = (async (input, init) => {
    if (!String(input).startsWith('http://posthog.fake')) return nativeFetch(input,init)
    const q = JSON.parse(String(init?.body)).query
    const result = await sql(translate(q.query,q.values))
    return new Response(JSON.stringify({columns:result.meta.map(c=>c.name),results:result.data.map(r=>result.meta.map(c=>r[c.name]))}))
}) as typeof fetch
const { aggregateEvents } = await import('../src/core/aggregate.ts')
const { required } = await import('../src/core/appevents.ts')
const { DIMENSIONS } = await import('../src/core/aggregate.ts')
const cases = [
    {months:12,bucket:'month',group_by:['app_version']},
    {months:36,bucket:'month',group_by:['client']},
    {months:12,bucket:'week',group_by:['app_version']},
    {months:48,bucket:'month',group_by:[]},
    {months:48,bucket:'week',group_by:['client','app_version']},
] as const
try {
    for (const c of cases) {
        const to = new Date('2026-11-15'), from = new Date(to); from.setUTCMonth(from.getUTCMonth()-c.months)
        const start = performance.now()
        const result = await aggregateEvents({from,to,bucket:c.bucket,group_by:[...c.group_by],metrics:['events','sessions','clients']})
        const seconds = (performance.now()-start)/1000
        // Spot-check an event count and a distinct session count against direct source queries.
        const selected = [result.rows.find(r=>!r.is_other), result.rows.find(r=>r.is_other) || result.rows.at(-1)]
        const checks = []
        for (const [i,row] of selected.entries()) {
            if (!row) throw Error('No rows')
            const period = String(row.period)
            const func = c.bucket==='month'?'toStartOfMonth':'toMonday'
            const values: Record<string,unknown> = {from:from.toISOString(),to:to.toISOString(),events:[required().events.screen,required().events.interaction],period}
            let where = `${func}(timestamp) = toDate({period})`
            if (row.is_other) {
                const kept = result.rows.filter(r=>r.period===row.period&&!r.is_other)
                where += ' AND NOT (' + kept.map((r,k)=>'(' + c.group_by.map((g,j)=>{values[`v${k}_${j}`]=r[g];return `(ifNull(${DIMENSIONS[g].expr(required())} = {v${k}_${j}}, 0) OR (${DIMENSIONS[g].expr(required())} IS NULL AND {v${k}_${j}} IS NULL))`}).join(' AND ')+')').join(' OR ')+')'
            } else for (const g of c.group_by) {values[g]=row[g];where+=` AND (ifNull(${DIMENSIONS[g].expr(required())} = {${g}}, 0) OR (${DIMENSIONS[g].expr(required())} IS NULL AND {${g}} IS NULL))`}
            const metric = i ? 'sessions' : 'events'
            const expr = i ? 'uniqExact(toString(properties.$session_id))' : 'count()'
            const direct = (await sql(translate(`SELECT ${expr} AS n FROM events WHERE timestamp >= {from} AND timestamp < {to} AND event IN {events} AND ${where}`,values))).data[0].n
            if (Number(direct)!==Number(row[metric])) throw Error(`Mismatch: ${metric} ${direct} != ${row[metric]}`)
            checks.push({period,metric,value:direct,other:!!row.is_other})
        }
        console.log(JSON.stringify({months:c.months,bucket:c.bucket,groups:c.group_by,seconds:Math.round(seconds*10)/10,rows:result.rows.length,truncated:!!result.limits?.truncated,queries:result.queries,checks}))
    }
} finally {globalThis.fetch=nativeFetch;rmSync(dir,{recursive:true,force:true})}
