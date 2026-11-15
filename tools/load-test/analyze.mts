/** Rebuild report tables from durable JSONL, including censored operations. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const dir=resolve(process.argv[2] ?? 'tools/load-test/results')
const q=(a:number[],p:number)=>a.length?[...a].sort((x,y)=>x-y)[Math.ceil(a.length*p)-1]:null
const pct=(n:number,d:number)=>d?(100*n/d).toFixed(2)+'%':'—'
const latency=(a:number[])=>[.5,.95,.99].map(p=>{const v=q(a,p);return v===null?'—':(v/1000).toFixed(3)}).join(' / ')
const sections:string[]=[]
const summary:any[]=[]
for(const filename of readdirSync(dir).filter(f=>/^n\d+\.jsonl$/.test(f)).sort((a,b)=>parseInt(a.slice(1))-parseInt(b.slice(1)))) {
    if(!existsSync(`${dir}/${filename.replace('.jsonl','-summary.json')}`))continue
    const rows=readFileSync(`${dir}/${filename}`,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
    const calls=rows.filter(r=>r.type==='call' && r.phase!=='probe'),completions=rows.filter(r=>r.type==='completion'),samples=rows.filter(r=>r.type==='sample')
    const n=Number(filename.match(/^n(\d+)/)![1])
    const stored=JSON.parse(readFileSync(`${dir}/n${n}-summary.json`,'utf8'))
    const errors:Record<string,number>={}
    for(const c of calls)if(c.error)errors[c.error]=(errors[c.error] ?? 0)+1
    const toolRows:string[]=[]
    for(const tool of [...new Set(['resolve_client','client_story','task_map','dialog_friction','top_pains','rescue_queue','aggregate_events','workflow_completion','discover_workflows','compare_client_patterns','client_signals','get_job_result',...calls.map(c=>c.tool)])].sort()) {
        const c=calls.filter(c=>c.tool===tool),done=completions.filter(c=>c.tool===tool),byId=new Map(done.map(r=>[r.requestId,r]))
        const final=tool==='get_job_result'?c.filter(r=>!r.error && !r.handle).map(r=>r.firstMs):done.filter(r=>!r.error && r.finalMs!==null).map(r=>r.finalMs)
        const successfulFirst=c.filter(r=>!r.error).map(r=>r.firstMs)
        const e:Record<string,number>={};for(const r of c)if(r.error)e[r.error]=(e[r.error]??0)+1
        const censored=tool==='get_job_result'?0:c.filter(r=>!byId.has(r.requestId) || byId.get(r.requestId)?.finalMs===null).length
        toolRows.push(`| ${tool} | ${c.length} | ${latency(c.map(r=>r.firstMs))} | ${latency(successfulFirst)} | ${latency(final)} | ${pct(c.filter(r=>r.handle).length,c.length)} | ${Object.entries(e).map(([k,v])=>`${k}: ${v} (${pct(v,c.length)})`).join('; ') || '0'} | ${censored} |`)
    }
    const estimates=samples.map(s=>Math.max(0,Number(s.activeJobs?.total ?? 0)-2))
    const heavy=new Set(['aggregate_events','workflow_completion','discover_workflows','top_pains','rescue_queue','dialog_friction','client_signals','compare_client_patterns'])
    let maxRollingMinuteCredits=0
    const userCredits:Record<string,number>={}
    for(const user of new Set(calls.map(c=>c.user))) {
        const own=calls.filter(c=>c.user===user && !c.error).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))
        let left=0,credits=0,total=0
        for(let right=0;right<own.length;right++) {
            const cost=heavy.has(own[right].tool)?5:1;credits+=cost;total+=cost
            while(Date.parse(own[right].at)-Date.parse(own[left].at)>=60000)credits-=heavy.has(own[left++].tool)?5:1
            maxRollingMinuteCredits=Math.max(maxRollingMinuteCredits,credits)
        }
        userCredits[String(user)]=total
    }
    const metric={n,...stored,maxRollingMinuteCredits,userCredits,errors,errorRate:pct(Object.values(errors).reduce((a,b)=>a+b,0),calls.length),handles:calls.filter(r=>r.handle).length,probeCount:samples.length,queueProxyMax:Math.max(0,...estimates),samplesWithMoreThan2Jobs:samples.filter(s=>Number(s.activeJobs?.total ?? 0)>2).length,successfulBusiness:completions.filter(c=>!c.error && c.finalMs!==null).length}
    summary.push(metric)
    sections.push(`### ${n} PM users\n\n${stored.started} to ${stored.ended}; ${(stored.elapsedSeconds/60).toFixed(2)} minutes; stop: ${stored.reason}. ${calls.length} physical calls, ${completions.length} business operations (${metric.successfulBusiness} successful), ${metric.handles} handle responses (${pct(metric.handles,calls.length)} of physical calls); ${calls.filter(c=>c.phase==='initial' && c.handle).length}/${calls.filter(c=>c.phase==='initial').length} initial calls returned handles. Errors ${metric.errorRate}. Highest observed successful per-user rolling-minute consumption: ${metric.maxRollingMinuteCredits} weighted credits. Max RSS: ${stored.maxRssMiB===null?'unavailable (sandbox PID namespace)':stored.maxRssMiB.toFixed(1)+' MiB'}. Responsiveness p95: ${((stored.responsivenessMs.p95 ?? 0)/1000).toFixed(3)} s; ${stored.probeErrors}/${samples.length} probe errors. Sampled active jobs max ${stored.maxWorkingJobs} (${stored.maxTestWorkingJobs} test-owned); pending-work proxy max ${metric.queueProxyMax}; ${metric.samplesWithMoreThan2Jobs}/${samples.length} samples above two active jobs.\n\n| Tool | Calls | First p50/p95/p99, all (s) | First p50/p95/p99, non-error (s) | Final p50/p95/p99, successful (s) | Handles | Errors / physical calls | Censored |\n|---|---:|---|---|---|---:|---|---:|\n${toolRows.join('\n')}`)
}
writeFileSync(`${dir}/analysis.json`,JSON.stringify(summary,null,2))
writeFileSync(`${dir}/tables.md`,sections.join('\n\n'))
console.log(JSON.stringify(summary.map(({n,physicalCalls,errors,maxRssMiB,responsivenessMs,maxWorkingJobs,successfulBusiness})=>({n,physicalCalls,errors,maxRssMiB,responsivenessMs,maxWorkingJobs,successfulBusiness})),null,2))
