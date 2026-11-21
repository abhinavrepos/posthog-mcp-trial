import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { all, one, run, db } from './db.ts'
import { config } from './config.ts'
import { ToolInputError } from './toolinputerror.ts'
const cell = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()])
const seriesChart = z.object({type:z.enum(['line','bar','table']), x:z.array(z.union([z.string().max(500),z.number().finite()])).min(1).max(500),
    series:z.array(z.object({name:z.string().max(200),values:z.array(cell).max(500)})).min(1).max(20)})
// Normalize row tables to the stored series format; text cells stay intact for rendering.
// Agents also send a table as columns plus rows of values: accept it and turn it into rows of {column:value}.
const columnsChart = z.object({type:z.literal('table'), columns:z.array(z.string().max(200)).min(1).max(20), rows:z.array(z.array(cell)).min(1).max(500)})
    .refine(({columns,rows})=>rows.every(r=>r.length===columns.length), {message:'Each row needs one value per column.'})
    .transform(({columns,rows})=>({type:'table' as const, x:rows.map((_,i)=>i+1), series:columns.map((name,c)=>({name,values:rows.map(r=>r[c] ?? null)}))}))
const rowsChart = z.object({type:z.literal('table'), rows:z.array(z.record(z.string().max(200),cell)).min(1).max(500)}).transform(({rows})=>{
    const columns = [...new Set(rows.flatMap(row=>Object.keys(row)))]
    return {type:'table' as const, x:rows.map((_,i)=>i+1), series:columns.map(name=>({name,values:rows.map(row=>row[name] ?? null)}))}
})
export const graphSchema = z.object({
    title:z.string().trim().min(1).max(200), note:z.string().max(4000).optional(),
    chart:z.union([seriesChart,columnsChart,rowsChart], {error:'Use chart with type, x and series, or a table with type:"table" and rows:[{column:value}] (or columns:[...] with rows of values).'})
}).superRefine((v,ctx)=>{
    if(v.chart.series.length<1 || v.chart.series.length>20)ctx.addIssue({code:'custom',message:'Use between 1 and 20 table columns or series.'})
    if(v.chart.series.some(s=>s.values.length!==v.chart.x.length))ctx.addIssue({code:'custom',message:'Each series must have one value per x point.'})
    if(v.chart.type!=='table' && v.chart.series.some(s=>s.values.some(value=>value!==null && typeof value!=='number')))ctx.addIssue({code:'custom',message:'Line and bar series values must be numbers or null; use type:"table" for text.'})
})
export type GraphInput = z.infer<typeof graphSchema>
export interface PinnedGraph extends GraphInput {id:string; saved_by:string; saved_at:string}
db.exec('CREATE TABLE IF NOT EXISTS pinned_graphs (id TEXT PRIMARY KEY, saved_by TEXT NOT NULL, saved_at TEXT NOT NULL, snapshot TEXT NOT NULL)')
export const pinnedUrl = (id:string) => `${config.service.publicUrl}/replays/pinned#${id}`
export function pinGraph(input:unknown, owner:string): PinnedGraph {
    const snapshot=graphSchema.parse(input), id=randomUUID(), saved_at=new Date().toISOString()
    run('INSERT INTO pinned_graphs VALUES (?,?,?,?)',id,owner,saved_at,JSON.stringify(snapshot))
    return {...snapshot,id,saved_by:owner,saved_at}
}
export function listPinned(limit=100, offset=0): PinnedGraph[] {
    return all<{id:string;saved_by:string;saved_at:string;snapshot:string}>('SELECT * FROM pinned_graphs ORDER BY saved_at DESC,id DESC LIMIT ? OFFSET ?',Math.max(1,Math.min(100,limit)),Math.max(0,offset)).map(r=>({...JSON.parse(r.snapshot),id:r.id,saved_by:r.saved_by,saved_at:r.saved_at}))
}
export function unpinGraph(id:string, owner:string, admin=false): boolean {
    const row=one<{saved_by:string}>('SELECT saved_by FROM pinned_graphs WHERE id=?',id)
    if(!row) return false
    if(!admin && row.saved_by!==owner) throw new ToolInputError('Only the owner or an admin may delete this graph.')
    run('DELETE FROM pinned_graphs WHERE id=?',id); return true
}
