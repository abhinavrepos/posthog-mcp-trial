export const HEAVY_TOOLS = new Set(['find_sessions'])
export class RateLimitError extends Error {
    constructor(message:string, readonly retry_after_seconds=1, readonly limit:'minute'|'hour'|'concurrent'='minute') { super(message) }
}
type Bucket = { minute: number; hour: number; at: number; active: number }
const positive = (value: string|undefined, fallback: number) => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : fallback
export class ToolLimiter {
    private buckets = new Map<string, Bucket>()
    constructor(readonly minute = positive(process.env.LENS_MCP_CALLS_PER_MINUTE,120), readonly hour = positive(process.env.LENS_MCP_CALLS_PER_HOUR,2400), readonly concurrent = positive(process.env.LENS_MCP_CONCURRENT_CALLS,8), private clock = Date.now) {}
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
        // Say which limit refused the call: an agent told "calls in the last minute" when it actually ran too
        // many calls at once retries the wrong way (and so did the people reading the audit log).
        const busy = buckets.find(b=>b.active>=this.concurrent)
        if(busy) throw new RateLimitError(`Too many calls at once: ${busy.active} of your Lens calls are still running (limit ${this.concurrent}). Wait for one to finish, then retry; try again in 1 seconds.`,1,'concurrent')
        const budget = (b: Bucket) => Math.max((weight-b.minute)*60000/this.minute,(weight-b.hour)*3600000/this.hour)
        const wait = Math.max(...buckets.map(budget))
        if(wait>0) {
            const hourly = buckets.some(b=>b.hour<weight)
            throw new RateLimitError(hourly
                ? `Rate limit: the hourly budget (${this.hour} units; heavy tools cost 5) is used up; try again in ${Math.max(1,Math.ceil(wait/1000))} seconds.`
                : `Rate limit: the per-minute budget (${this.minute} units; heavy tools cost 5) is used up; try again in ${Math.max(1,Math.ceil(wait/1000))} seconds.`,Math.max(1,Math.ceil(wait/1000)),hourly ? 'hour' : 'minute')
        }
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
