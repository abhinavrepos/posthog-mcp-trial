import type { IncomingMessage, ServerResponse } from 'node:http'
import { listPinned, unpinGraph, type PinnedGraph } from '../core/pinned.ts'
import { audit, can, type Viewer } from './access.ts'
import { headerHtml, PAGE_CSS } from './replays.ts'
const esc=(s:unknown)=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
// Categorical colors in a fixed order (validated palette: distinct in light and dark and for colour-blind readers).
// Series 9-16 reuse the hues with dashed lines; more than 16 series reuse them again with dotted lines.
const SERIES=8
export const CHART_CSS=`:root{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#0ca30c;--s7:#9085e9;--s8:#e66767;--chart-surface:#1a1a19}
@media(prefers-color-scheme:light){:root:not([data-theme=dark]){--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--chart-surface:#fcfcfb}}
:root[data-theme=light]{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--chart-surface:#fcfcfb}
.chart-wrap{position:relative;margin:12px 0}.pinned-chart{display:block;width:100%;height:auto;max-height:380px;overflow:visible}
.pinned-chart text{fill:var(--ink-muted);font:12px var(--font-sans);font-variant-numeric:tabular-nums}
.pinned-chart .grid{stroke:var(--border);stroke-width:1}.pinned-chart .base{stroke:var(--border-strong);stroke-width:1}
.pinned-chart .pt{stroke:var(--chart-surface);stroke-width:2}.pinned-chart .hit{fill:transparent}
.pinned-chart g.mark:hover .pt,.pinned-chart g.mark:hover rect{filter:brightness(1.15)}
.chart-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:8px 0 0;padding:0;list-style:none;font-size:13px;color:var(--ink)}
.chart-legend li{display:flex;align-items:center;gap:6px}.chart-legend svg{flex:none}`
const color=(j:number)=>`var(--s${j%SERIES+1})`
const dash=(j:number)=>j<SERIES ? '' : j<SERIES*2 ? ' stroke-dasharray="6 4"' : ' stroke-dasharray="2 3"'
/** 4-6 round tick values covering [lo, hi]. */
function ticks(lo:number,hi:number):number[] {
    if(hi===lo) hi=lo+1
    const raw=(hi-lo)/4, mag=10**Math.floor(Math.log10(raw)), step=[1,2,2.5,5,10].map(m=>m*mag).find(s=>s>=raw)!
    const out:number[]=[]
    for(let v=Math.floor(lo/step)*step;v<=hi+step*1e-9;v+=step) out.push(Number(v.toFixed(10)))
    if(out.at(-1)!<hi) out.push(out.at(-1)!+step)
    return out
}
const fmt=(v:number)=>{const a=Math.abs(v);return a>=1e9?+(v/1e9).toFixed(1)+'B':a>=1e6?+(v/1e6).toFixed(1)+'M':a>=1e4?+(v/1e3).toFixed(1)+'k':String(+v.toFixed(2))}
export function renderGraph(g:PinnedGraph):string {
    const {x,series,type}=g.chart
    const table=`<div style="overflow:auto"><table><thead><tr><th>Point</th>${series.map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${x.map((v,i)=>`<tr><th>${esc(v)}</th>${series.map(s=>`<td>${esc(s.values[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    if(type==='table') return table
    const vals=series.flatMap(s=>s.values.filter((v):v is number=>typeof v==='number' && Number.isFinite(v)))
    const t=ticks(Math.min(0,...vals),Math.max(0,...vals,vals.length?-Infinity:1)), lo=t[0], hi=t.at(-1)!
    const W=760,H=300,L=56,R=16,T=12,B=40,pw=W-L-R,ph=H-T-B, n=Math.max(1,x.length)
    const y=(v:number)=>T+ph-(v-lo)/(hi-lo)*ph
    const grid=t.map(v=>`<line class="${v===0?'base':'grid'}" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L-8}" y="${y(v)+4}" text-anchor="end">${esc(fmt(v))}</text>`).join('')
    const band=pw/n, cx=(i:number)=>type==='line' ? L+(n===1?pw/2:i*pw/(n-1)) : L+band*i+band/2
    // At most about 8 x labels, evenly spaced, always the first and the last.
    const every=Math.max(1,Math.ceil(n/(type==='bar'?12:8))), xi=x.map((_,i)=>i).filter(i=>i%every===0 || i===n-1).filter((i,_k,a)=>!(i!==n-1 && a.includes(n-1) && n-1-i<every*0.6))
    const xlabels=xi.map(i=>{const anchor=type==='line' && i===0?'start':type==='line' && i===n-1?'end':'middle';return `<text x="${cx(i)}" y="${H-B+20}" text-anchor="${anchor}">${esc(String(x[i]).slice(0,16))}</text>`}).join('')
    const tip=(s:{name:string},i:number,v:unknown)=>`<title>${esc(s.name)} · ${esc(x[i])}: ${esc(v)}</title>`
    let marks=''
    if(type==='line') {
        const dots=n<=40
        marks=series.map((s,j)=>{
            const d=s.values.map((v,i)=>v===null||!Number.isFinite(Number(v)) ? '' : `${i===0 || s.values[i-1]===null ? 'M' : 'L'}${cx(i).toFixed(1)},${y(Number(v)).toFixed(1)}`).join(' ')
            const pts=s.values.map((v,i)=>v===null?'':`<g class="mark">${tip(s,i,v)}<circle class="hit" cx="${cx(i)}" cy="${y(Number(v))}" r="9"/>${dots?`<circle class="pt" cx="${cx(i)}" cy="${y(Number(v))}" r="4" fill="${color(j)}"/>`:''}</g>`).join('')
            return `<path d="${d}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${dash(j)}/>${pts}`
        }).join('')
    } else {
        const k=series.length, gap=2, inner=Math.min(band*0.8,k*48), bw=Math.max(2,(inner-gap*(k-1))/k), r=Math.min(4,bw/2)
        marks=series.map((s,j)=>s.values.map((v,i)=>{
            if(v===null || !Number.isFinite(Number(v))) return ''
            const x0=L+band*i+(band-inner)/2+j*(bw+gap), top=Math.min(y(Number(v)),y(0)), h=Math.max(1,Math.abs(y(Number(v))-y(0)))
            return `<g class="mark">${tip(s,i,v)}<rect x="${x0.toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${r}" fill="${color(j)}"${j>=SERIES?` fill-opacity="${j<SERIES*2?0.6:0.35}"`:''}/></g>`
        }).join('')).join('')
    }
    const swatch=(j:number)=>type==='line' ? `<svg width="18" height="10" aria-hidden="true"><line x1="1" x2="17" y1="5" y2="5" stroke="${color(j)}" stroke-width="2"${dash(j)}/></svg>` : `<svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="3" fill="${color(j)}"${j>=SERIES?` fill-opacity="${j<SERIES*2?0.6:0.35}"`:''}/></svg>`
    const legend=series.length>1 ? `<ul class="chart-legend">${series.map((s,j)=>`<li>${swatch(j)}${esc(s.name)}</li>`).join('')}</ul>` : ''
    return `<div class="chart-wrap">${legend}<svg role="img" class="pinned-chart" aria-label="${esc(g.title)}" viewBox="0 0 ${W} ${H}"><g>${grid}</g>${marks}${xlabels}</svg></div><details><summary>Data</summary>${table}</details>`
}
const savedTime=(iso:string)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?iso:d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}
export function pinnedHtml(v:Viewer):string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pinned</title><style>${PAGE_CSS()}${CHART_CSS}</style></head><body>${headerHtml(v,'Pinned')}<main id="main" tabindex="-1"><div class="page-head"><div><h1>Pinned graphs</h1><p>Saved snapshots. Data does not refresh automatically.</p></div></div>${listPinned().map(g=>`<article class="card" id="${g.id}"><h2>${esc(g.title)}</h2><p>${esc(g.note)}</p><p class="small">Saved by ${esc(g.saved_by)} · <time title="${esc(g.saved_at)}">${esc(savedTime(g.saved_at))}</time></p>${renderGraph(g)}${g.saved_by===v.email || can(v.role,'admin') ? `<button class="ghost danger" data-delete="${g.id}">Delete</button>` : ''}</article>`).join('') || '<p>No saved graphs.</p>'}</main><script>document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const r=await fetch('/replays/pinned/'+b.dataset.delete,{method:'DELETE',headers:{'x-clip-page':'1'}});if(r.ok)location.reload();else alert('Could not delete graph')})</script></body></html>`
}
export async function handlePinned(req:IncomingMessage,res:ServerResponse,url:URL,v:Viewer):Promise<boolean> {
    if(req.method==='GET' && /^\/replays\/pinned\/?$/.test(url.pathname)) {
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(pinnedHtml(v));return true
    }
    const id=/^\/replays\/pinned\/([\w-]+)$/.exec(url.pathname)?.[1]
    if(req.method==='DELETE' && id) {
        if(req.headers['x-clip-page']!=='1') {res.writeHead(403);res.end();return true}
        try {const deleted=unpinGraph(id,v.email,can(v.role,'admin'));audit(v.email,'graph.deleted',{id});res.writeHead(deleted?200:404);res.end()}
        catch {res.writeHead(403);res.end()}
        return true
    }
    res.writeHead(404);res.end();return true
}
