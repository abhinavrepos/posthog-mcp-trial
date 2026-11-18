import type { PosthogChartParams } from '../core/posthogchart.ts'
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
type Obj = Record<string, any>
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
const array = (v: unknown): any[] => Array.isArray(v) ? v : []
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const label = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '')).slice(0, 2000)
// PostHog's own placeholders and one-item arrays read as people expect: "Other", "(none)", "C01".
const SENTINELS: Record<string, string> = { '$$_posthog_breakdown_other_$$': 'Other', '$$_posthog_breakdown_null_$$': '(none)' }
const breakdownLabel = (v: unknown): string => Array.isArray(v) ? v.map(breakdownLabel).join(', ') : typeof v === 'string' && SENTINELS[v] ? SENTINELS[v] : label(v)
const hasBreakdown = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)
/** A funnel step in words from the query that made it: "PageView · dialog_id = DlgList, action = OPEN". */
function stepName(series: unknown): string | undefined {
    const st = obj(series)
    if (typeof st.custom_name === 'string' && st.custom_name.trim()) return st.custom_name
    const name = st.event ?? st.name ?? (st.kind === 'ActionsNode' ? `Action ${st.id}` : undefined)
    if (name === undefined) return undefined
    const filters = array(st.properties).map(obj).filter(f => typeof f.key === 'string').slice(0, 4)
        .map(f => `${f.key} ${['exact', undefined].includes(f.operator) ? '=' : String(f.operator).replace(/_/g, ' ')} ${Array.isArray(f.value) ? f.value.join(' or ') : label(f.value)}`)
    return [String(name), filters.join(', ')].filter(Boolean).join(' · ')
}
const percent = (n: number | null) => n === null ? '–' : `${Math.round(n * 1000) / 10}%`
const COLORS = ['#4263a6', '#b56538', '#41806a', '#9861a0', '#857333', '#447e91', '#a44c68', '#677a3e', '#7969a8', '#705947']
const ROW_CAP = 200

function table(headers: string[], rows: unknown[][], caption: string): string {
    const numeric = headers.map((_, i) => rows.some(row => typeof row[i] === 'number') && rows.every(row => typeof row[i] === 'number' || row[i] === '–' || row[i] == null))
    return `<div class="table-wrap" role="region" aria-label="${esc(caption)}" tabindex="0"><table><caption>${esc(caption)} (chart alternative)</caption><thead><tr>${headers.map((h, i) => `<th scope="col"${numeric[i] ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, ROW_CAP).map(row => `<tr>${headers.map((_, i) => `<td${numeric[i] ? ' class="num"' : ''}>${esc(label(row[i]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${Math.max(1, headers.length)}">No results in this period.</td></tr>`}</tbody></table></div>${rows.length > ROW_CAP ? `<p class="muted">Showing the first ${ROW_CAP} rows.</p>` : ''}`
}

/** Only receives results after the server's privacy pass; all labels are still HTML escaped. */
export function posthogChartHtml(params: PosthogChartParams, raw: unknown, updatedAt: string): string {
    const root = obj(raw), results = Array.isArray(raw) ? raw : root.results ?? root.result ?? []
    let body = ''
    const kind = params.query.kind
    if (['TrendsQuery', 'LifecycleQuery', 'StickinessQuery'].includes(kind)) {
        const source = array(results).slice(0, 2000)
        const sets = source.map((s, i) => {
            const r = obj(s), data = array(r.data).slice(0, 365).map(number)
            const series = r.action?.custom_name ?? r.action?.name ?? r.label ?? r.name ?? `Series ${i + 1}`
            const several = array(params.query.series).length > 1
            const name = hasBreakdown(r.breakdown_value) ? (several ? `${label(series)} · ${breakdownLabel(r.breakdown_value)}` : breakdownLabel(r.breakdown_value)) : label(series)
            return { name, data, dates: array(r.days).length ? array(r.days) : array(r.labels), total: data.reduce<number>((n, v) => n + Math.abs(v ?? 0), 0) }
        }).sort((a, b) => b.total - a.total).slice(0, 10)
        const rows = sets.flatMap(s => s.data.map((v, i) => [label(s.dates[i] ?? i + 1), s.name, v ?? '–']))
        if (source.length > 10) body += '<p class="muted">Showing the top 10 series by total. Additional series are omitted.</p>'
        if (source.some(s => array(obj(s).data).length > 365)) body += '<p class="muted">Showing the first 365 points per series.</p>'
        const values = sets.flatMap(s => s.data.filter((v): v is number => v !== null))
        if (values.length && params.chart !== 'table') {
            const min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min
            const count = Math.max(1, ...sets.map(s => s.data.length))
            const x = (i: number) => 70 + i * 610 / Math.max(1, count - 1), y = (v: number) => 195 - (v - min) / span * 170
            const marks = sets.map((s, si) => {
                const color = COLORS[si]
                if (params.chart === 'bar') return s.data.map((v, i) => v === null ? '' : `<rect x="${70 + i * 610 / count + si * 610 / count / sets.length}" y="${Math.min(y(v), y(0))}" width="${Math.max(.2, 610 / count / sets.length - 1)}" height="${Math.abs(y(v) - y(0))}" fill="${color}"><title>${esc(`${s.name} · ${s.dates[i] ?? i + 1}: ${v}`)}</title></rect>`).join('')
                let pen = false
                const path = s.data.map((v, i) => { if (v === null) { pen = false; return '' } const part = `${pen ? 'L' : 'M'}${x(i)} ${y(v)}`; pen = true; return part }).join(' ')
                return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>` + s.data.map((v, i) => v === null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${color}"><title>${esc(`${s.name} · ${s.dates[i] ?? i + 1}: ${v}`)}</title></circle>`).join('')
            }).join('')
            body += `<svg class="story-chart" viewBox="0 0 710 230" role="img" aria-label="PostHog ${params.chart === 'bar' ? 'bar' : 'line'} chart; values in the table below"><line x1="70" x2="680" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)"/><text x="5" y="25">${esc(max)}</text><text x="5" y="195">${esc(min)}</text>${marks}<text x="70" y="222">${esc(sets[0]?.dates[0] ?? 'Start')}</text><text x="680" y="222" text-anchor="end">${esc(sets[0]?.dates.at(-1) ?? 'End')}</text></svg><p class="muted chart-legend">${sets.map((s, i) => `<span><i aria-hidden="true" style="background:${COLORS[i]}"></i>${esc(s.name)}</span>`).join('')}</p>`
        }
        body += table(['Period', 'Series', 'Count'], rows, 'PostHog series')
    } else if (kind === 'FunnelsQuery') {
        const groups = array(results).some(Array.isArray) ? array(results).slice(0, 10).map(array) : [array(results)]
        const rows = groups.flatMap(group => {
            const base = number(obj(group[0]).count) || 0
            return group.slice(0, 100).map((s, i) => { const r = obj(s), n = number(r.count); return [hasBreakdown(r.breakdown_value) ? breakdownLabel(r.breakdown_value) : 'All', r.custom_name || stepName(array(params.query.series)[r.order ?? i]) || label(r.name ?? r.action?.name ?? `Step ${i + 1}`), n ?? '–', percent(n === null || !base ? null : n / base)] })
        })
        const broken = rows.some(r => r[0] !== 'All')
        if (array(results).length > 10 && array(results).some(Array.isArray)) body += '<p class="muted">Showing the first 10 funnel breakdowns.</p>'
        if (params.chart !== 'table') body += rows.slice(0, 100).map(r => {
            const conversion = parseFloat(String(r[3])), width = Number.isFinite(conversion) ? Math.min(100, Math.max(0, conversion)) : 0
            return `<div class="path"><b>${broken ? `${esc(r[0])} · ` : ''}${esc(r[1])}</b><div class="share-bar" role="meter" aria-label="Conversion from first step" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${width}"><i style="width:${width}%"></i></div><span>${esc(r[2])} · ${esc(r[3])} conversion</span></div>`
        }).join('')
        body += table(['Breakdown', 'Step', 'Count', 'Conversion from first step'], rows, 'Funnel conversion')
    } else if (kind === 'RetentionQuery') {
        const cohorts = array(results).slice(0, ROW_CAP + 1)
        const periods = Math.min(60, Math.max(0, ...cohorts.map(r => array(obj(r).values).length)))
        const rows = cohorts.map(r => {
            const cohort = obj(r), values = array(cohort.values), base = number(obj(values[0]).count) ?? number(values[0]) ?? 0
            return [label(cohort.label ?? cohort.date ?? 'Cohort'), ...Array.from({ length: periods }, (_, i) => {
                const count = number(obj(values[i]).count) ?? number(values[i])
                return count === null ? '–' : `${count} (${percent(base ? count / base : null)})`
            })]
        })
        body += table(['Cohort', ...Array.from({ length: periods }, (_, i) => `Period ${i}`)], rows, 'Retention counts and rates')
        if (cohorts.some(r => array(obj(r).values).length > 60)) body += '<p class="muted">Showing the first 60 retention periods.</p>'
    } else if (kind === 'PathsQuery') {
        const paths = array(results).slice(0, 5000).map(obj).sort((a, b) => (number(b.count ?? b.value) ?? 0) - (number(a.count ?? a.value) ?? 0))
        body += table(['From', 'To', 'Count'], paths.map(r => [label(r.source ?? r.from), label(r.target ?? r.to), r.count ?? r.value ?? '–']), 'Top routes')
    } else {
        const columns = array(root.columns).slice(0, 50).map(c => label(typeof c === 'object' ? obj(c).name : c))
        const rows = array(results).slice(0, ROW_CAP + 1).map(row => Array.isArray(row) ? row.slice(0, 50) : columns.map(c => obj(row)[c]))
        body += table(columns.length ? columns : ['Result'], rows, 'HogQL results')
        if (array(root.columns).length > 50) body += '<p class="muted">Showing the first 50 columns.</p>'
    }
    return `${body}<p class="muted small">Updated <time datetime="${esc(updatedAt)}">${esc(updatedAt)}</time> · refreshes every 5 minutes</p>`
}

// Refresh replaces markup only on success. Failed reads leave the existing chart and timestamp intact.
// Starts with ';': it is appended to the dashboards script, which may end without one (an IIFE after it was
// then called as a function and broke every Dashboards page).
export const POSTHOG_CHART_CLIENT = `
;(()=>{
 const box=document.getElementById('posthog-chart'),notice=document.getElementById('chart-refresh-status');
 if(!box)return;
 let pending=false,last=Date.now();
 const refresh=async()=>{
  if(document.hidden||pending)return;
  pending=true;last=Date.now();
  try{
   const response=await fetch('/replays/dashboards/api/'+box.dataset.id+'/data',{headers:{accept:'application/json'}});
   const data=await response.json();
   if(!response.ok||typeof data.html!=='string')throw new Error('refresh');
   box.innerHTML=data.html;notice.textContent='';
   (box.querySelectorAll?.('time[datetime]')||[]).forEach(t=>{const d=new Date(t.dateTime);if(!isNaN(+d))t.textContent=d.toLocaleString()});
  }catch{notice.textContent='Could not refresh just now. Showing the last update; we will try again in 5 minutes.'}
  finally{pending=false}
 };
 setInterval(refresh,300000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-last>=300000)void refresh()});
})()
`
