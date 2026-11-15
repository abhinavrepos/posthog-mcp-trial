export const HEAVY_TOOLS = new Set(['aggregate_events','workflow_completion','discover_workflows','signal_scorecard','describe_app_events','message_doctor','find_trade','top_pains','rescue_queue','dialog_friction','client_signals','client_activity_changes','compare_client_patterns'])
export class RateLimitError extends Error {}
type Bucket = { minute: number; hour: number; at: number; active: number }
const positive = (value: string|undefined, fallback: number) => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : fallback
export class ToolLimiter {
    private buckets = new Map<string, Bucket>()
    constructor(readonly minute = positive(process.env.LENS_MCP_CALLS_PER_MINUTE,120), readonly hour = positive(process.env.LENS_MCP_CALLS_PER_HOUR,600), readonly concurrent = positive(process.env.LENS_MCP_CONCURRENT_CALLS,4), private clock = Date.now) {}
    acquire(user: string, token: string, tool: string, cost?: number): () => void {
        const now = this.clock(), weight = cost ?? (HEAVY_TOOLS.has(tool) ? 5 : 1)
        const keys = [`user:${user.toLowerCase()}`,`token:${token}`]
        const buckets = keys.map(key => {
            let b = this.buckets.get(key)
            if(!b) { b={minute:this.minute,hour:this.hour,at:now,active:0};this.buckets.set(key,b) }
            const elapsed = Math.max(0,now-b.at)
            b.minute=Math.min(this.minute,b.minute+elapsed*this.minute/60000)
            b.hour=Math.min(this.hour,b.hour+elapsed*this.hour/3600000);b.at=now
            return b
        })
        const wait = Math.max(...buckets.map(b=>Math.max((weight-b.minute)*60000/this.minute,(weight-b.hour)*3600000/this.hour)),buckets[0].active>=this.concurrent ? 1000 : 0)
        if(wait>0) throw new RateLimitError(`Rate limit: ${Math.ceil(this.minute-buckets[0].minute)} calls in the last minute; try again in ${Math.max(1,Math.ceil(wait/1000))} seconds.`)
        for(const b of buckets) {b.minute-=weight;b.hour-=weight;b.active++}
        let released=false
        return () => {if(!released) {released=true;for(const b of buckets)b.active--}}
    }
    prune(): void {
        const now=this.clock()
        for(const [key,b] of this.buckets) if(!b.active && now-b.at>=3600000) this.buckets.delete(key)
    }
}
export const toolLimiter = new ToolLimiter()
const cleanup = setInterval(()=>toolLimiter.prune(),60000);cleanup.unref()
