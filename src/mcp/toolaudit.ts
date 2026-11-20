import { errorDiagnostic } from '../core/errordiagnostics.ts'
import { all, run } from '../core/db.ts'
export interface ToolAudit {
    at: string; user_email: string; token_id: string; tool: string; argument_keys: string[]
    resolved_window?: {from:string;to:string}; client_ids: string[]; duration_ms: number; result_chars: number
    is_error: boolean; error_kind?: string; result_kind?: string; job_hash?: string; correlation_id: string
}
export function writeToolAudit(a: ToolAudit): void {
    run(`INSERT INTO tool_audit(at,user_email,token_id,tool,argument_keys,resolved_window,client_ids,duration_ms,result_chars,is_error,error_kind,correlation_id,result_kind,job_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,a.at,a.user_email,a.token_id,a.tool,JSON.stringify(a.argument_keys),a.resolved_window ? JSON.stringify(a.resolved_window) : null,JSON.stringify(a.client_ids),a.duration_ms,a.result_chars,a.is_error?1:0,a.error_kind||null,a.correlation_id,a.result_kind||null,a.job_hash||null)
}
export function pruneToolAudit(now = Date.now(), days = Number(process.env.LENS_MCP_AUDIT_RETENTION_DAYS || 90)): void {
    if(!Number.isFinite(days)||days<=0) days=90
    run('DELETE FROM tool_audit WHERE at < ?',new Date(now-days*86400000).toISOString())
}
export function readToolAudit(limit=100, offset=0) {
    const bounded=(n:number,fallback:number,max:number)=>Number.isFinite(n)?Math.min(max,Math.max(0,Math.floor(n))):fallback
    return all('SELECT * FROM tool_audit ORDER BY at DESC,id DESC LIMIT ? OFFSET ?',bounded(limit,100,1000),bounded(offset,0,1000000))
}
const prune = setInterval(()=>{try {pruneToolAudit()} catch(e) {errorDiagnostic(e,'audit_prune','audit')}},3600000);prune.unref()
