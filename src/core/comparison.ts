export interface ComparisonOptions { compare?:'previous'|'none'; compare_with?:{from:Date;to:Date} }
export function comparisonWindow(q:{from:Date;to:Date}&ComparisonOptions) {
    if(q.compare === 'none') return null
    const w=q.compare_with || {from:new Date(+q.from-(+q.to-+q.from)),to:q.from}
    if(!Number.isFinite(+w.from)||!Number.isFinite(+w.to)||+w.to<=+w.from||+w.to-+w.from>1500*86400000) throw new Error('Invalid comparison window; use at most 1500 days')
    return w
}
