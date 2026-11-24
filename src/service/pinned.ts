import type { IncomingMessage, ServerResponse } from 'node:http'
import { listPinned, unpinGraph, type PinnedGraph } from '../core/pinned.ts'
import { audit, can, type Viewer } from './access.ts'
import { headerHtml, PAGE_CSS } from './replays.ts'
const esc=(s:unknown)=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))
export function renderGraph(g:PinnedGraph):string {
    const {x,series,type}=g.chart
    const table=`<div style="overflow:auto"><table><thead><tr><th>Point</th>${series.map(s=>`<th>${esc(s.name)}</th>`).join('')}</tr></thead><tbody>${x.map((v,i)=>`<tr><th>${esc(v)}</th>${series.map(s=>`<td>${esc(s.values[i])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    if(type==='table') return table
    const vals=series.flatMap(s=>s.values.filter((v):v is number=>typeof v==='number')), min=Math.min(0,...vals), max=Math.max(1,...vals), height=240
    const y=(v:number)=>height-(v-min)/(max-min)*height, colors=['var(--ink)','var(--border-strong)','var(--ink-muted)','var(--border)','var(--surface-2)']
    const grid=[0,1,2,3,4].map(i=>`<line x1="36" x2="736" y1="${12+i*60}" y2="${12+i*60}" stroke="var(--border)"/>`).join('')
    const marks=series.map((s,j)=>{
        const color=colors[j%colors.length]
        const draw=type==='line' ? s.values.map((v,i)=>v===null ? '' : `${i===0 || s.values[i-1]===null ? 'M' : 'L'}${36+i*680/Math.max(1,x.length-1)},${y(Number(v))+10}`).join(' ') : ''
        return type==='line' ? `<path d="${draw}" fill="none" stroke="${color}" stroke-width="2"/>` : s.values.map((v,i)=>v===null?'':`<rect x="${36+i*680/x.length+j*600/x.length/series.length+5}" y="${10+Math.min(y(Number(v)),y(0))}" width="${Math.max(2,Math.min(54,570/x.length/series.length))}" height="${Math.abs(y(Number(v))-y(0))}" fill="${color}"/>`).join('')
    }).join('')
    return `<p>${series.map((s,j)=>`<span style="color:${colors[j%colors.length]}">${esc(s.name)}</span>`).join(' · ')}</p><svg role="img" class="pinned-chart" aria-label="${esc(g.title)}" viewBox="0 0 760 280"><g>${grid}</g><text x="8" y="18">${esc(max)}</text>${marks}<text x="36" y="275">${esc(x[0])}</text><text x="736" y="275" text-anchor="end">${esc(x.at(-1))}</text></svg><details><summary>Data</summary>${table}</details>`
}
const savedTime=(iso:string)=>{const d=new Date(iso);return Number.isNaN(d.getTime())?iso:d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}
export function pinnedHtml(v:Viewer):string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pinned</title><style>${PAGE_CSS()} .pinned-chart{display:block;width:100%;height:auto;max-height:360px}.pinned-chart text{fill:var(--ink-muted);font:13px var(--font-sans)}.pinned-chart rect{rx:3}</style></head><body>${headerHtml(v,'Pinned')}<main id="main" tabindex="-1"><div class="page-head"><div><h1>Pinned graphs</h1><p>Saved snapshots. Data does not refresh automatically.</p></div></div>${listPinned().map(g=>`<article class="card" id="${g.id}"><h2>${esc(g.title)}</h2><p>${esc(g.note)}</p><p class="small">Saved by ${esc(g.saved_by)} · <time title="${esc(g.saved_at)}">${esc(savedTime(g.saved_at))}</time></p>${renderGraph(g)}${g.saved_by===v.email || can(v.role,'admin') ? `<button class="ghost danger" data-delete="${g.id}">Delete</button>` : ''}</article>`).join('') || '<p>No saved graphs.</p>'}</main><script>document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{const r=await fetch('/replays/pinned/'+b.dataset.delete,{method:'DELETE',headers:{'x-clip-page':'1'}});if(r.ok)location.reload();else alert('Could not delete graph')})</script></body></html>`
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
