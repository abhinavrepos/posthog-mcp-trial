// Shared, ten-minute cached project coverage and configured SQL vocabulary.
import { hogql } from './posthog.ts'
import { required, prop } from './appevents.ts'
import { config } from './config.ts'
import { userExpr } from './identity.ts'
import { P } from './props.ts'
export async function dataCoverage() {
    const [row] = await hogql('SELECT min(timestamp) AS data_starts, max(timestamp) AS data_ends FROM events', {}, {cache:true,ttlMs:600000})
    return {data_starts:row?.data_starts ?? null,data_ends:row?.data_ends ?? null}
}
export async function dataGuide() {
    const reg=required()
    const [coverage,rows]=await Promise.all([
        dataCoverage(),
        hogql('SELECT toString(distinct_id) AS distinct_id FROM events LIMIT 1',{}, {cache:true,ttlMs:600000}),
    ])
    const example=String(rows[0]?.distinct_id || ''), separator=config.properties.distinctIdSeparator
    const clientPart=config.properties.clientFromDistinctId, userPart=(reg.distinctIdParts?.indexOf('{user}') ?? -1)+1
    const literal=(s:string)=>`'${s.replaceAll("'","''")}'`
    const screen=prop(reg,'dialogName'), action=prop(reg,'action'), version=prop(reg,'version')
    return {
        app:reg.app,events:{...reg.events,messages:{event:reg.events.interaction,dialog_ids:reg.dialogs.messages},notices:{event:reg.events.interaction,dialog_ids:reg.dialogs.notices}},
        properties:reg.properties,
        identity:{CLIENT_FROM_DISTINCT_ID:clientPart,separator,parts:reg.distinctIdParts,example_distinct_id:example || null,
            client:{part:clientPart || null,property:clientPart ? null : config.properties.client,value:clientPart ? example.split(separator)[clientPart-1] ?? null : null,expression:`toString(${P.client})`},
            user:{part:userPart || null,value:userPart ? example.split(separator)[userPart-1] ?? null : example || null,expression:userExpr()}},
        coverage,
        run_sql:'posthog_exec command: call execute-sql {"query":"<HogQL>"}',
        sql_notes:['windowFunnel needs toDateTime(timestamp), not the DateTime64 timestamp'],
        examples:[
            `SELECT ${screen} AS screen, uniq(properties.$session_id) AS sessions FROM events WHERE event = ${literal(reg.events.screen)} GROUP BY screen LIMIT 20`,
            `SELECT ${screen} AS screen, count() AS opens FROM events WHERE event = ${literal(reg.events.screen)} AND ${action} = ${literal(reg.screenActions.open[0] || 'OPEN')} GROUP BY screen LIMIT 20`,
            `SELECT ${version} AS version, uniq(distinct_id) AS users FROM events WHERE notEmpty(${version}) GROUP BY version LIMIT 20`,
        ],
    }
}
