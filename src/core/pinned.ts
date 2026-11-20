import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { all, one, run, db } from './db.ts'
import { config } from './config.ts'
import { ToolInputError } from './toolinputerror.ts'
export const graphSchema = z.object({
    title:z.string().trim().min(1).max(200), note:z.string().max(4000).optional(),
    chart:z.object({type:z.enum(['line','bar','table']), x:z.array(z.union([z.string().max(500),z.number().finite()])).min(1).max(500),
        series:z.array(z.object({name:z.string().max(200),values:z.array(z.number().finite().nullable()).max(500)})).min(1).max(20)})
}).superRefine((v,ctx)=>{if(v.chart.series.some(s=>s.values.length!==v.chart.x.length))ctx.addIssue({code:'custom',message:'Each series must have one value per x point.'})})
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
