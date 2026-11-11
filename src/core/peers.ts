// Equal weight per client, using retained daily histograms rather than individual attempts.
import { aggregates, cached, coverage, metrics, tasksDb, validWindow } from './tasks.ts'
import { rescuePrivacy } from './rescueprivacy.ts'
import type { Window } from './taskstypes.ts'
export const median = (xs: number[]): number | null => {
    const a = [...xs].sort((a,b) => a-b), n = a.length
    return n ? (a[Math.floor((n-1)/2)] + a[Math.floor(n/2)]) / 2 : null
}
export interface PeerTask {
    task_id: string; task_name: string; client_median_s: number; peer_median_s: number; ratio: number
    done_rate: number; peer_done_rate: number; peer_clients: number; text: string
}
export function peerComparisons(window: Window, rows?: ReturnType<typeof aggregates>): Promise<Map<string, PeerTask[]>> {
    validWindow(window)
    return cached('peer-comparisons', { window }, async () => {
        const result = new Map<string, PeerTask[]>()
        if (!coverage(window).complete) return result
        const names = new Map((tasksDb.prepare('SELECT task_id,name FROM task_catalog').all() as { task_id: string; name: string }[]).map(r => [r.task_id,r.name]))
        const groups = new Map<string, ReturnType<typeof aggregates>>()
        for (const r of rows || aggregates(window)) if (r.done >= 5) { const g = groups.get(r.task_id) || []; g.push(r); groups.set(r.task_id,g) }
        for (const [task_id, group] of groups) {
            if (group.length < 6) continue
            const points = group.map(r => ({ client: r.client, ...metrics(r) })).filter(r => r.median_s !== null)
            if (points.length < 6) continue
            // Sort each peer distribution once. Removing this client shifts a median index
            // by at most one; rebuilding and sorting the other clients for every row is wasteful.
            const durations = [...points].sort((a,b)=>a.median_s!-b.median_s! || a.client.localeCompare(b.client))
            const rates = [...points].sort((a,b)=>a.done/a.attempts-b.done/b.attempts || a.client.localeCompare(b.client))
            const durationIndex = new Map(durations.map((r,i)=>[r.client,i])), rateIndex = new Map(rates.map((r,i)=>[r.client,i]))
            const excluding = (sorted: typeof points, removed: number, value: (r: typeof points[number])=>number) => {
                const n=sorted.length-1, at=(i:number)=>value(sorted[i>=removed ? i+1 : i])
                return (at(Math.floor((n-1)/2))+at(Math.floor(n/2)))/2
            }
            for (const c of points) {
                const peer_median_s = excluding(durations,durationIndex.get(c.client)!,r=>r.median_s!), peer_done_rate = excluding(rates,rateIndex.get(c.client)!,r=>r.done/r.attempts)
                if (peer_median_s <= 0) continue
                const ratio = c.median_s! / peer_median_s, done_rate = c.done / c.attempts, task_name = names.get(task_id) || task_id
                const text = ratio >= 1.5 ? `${task_name} takes ${ratio.toFixed(1)}x the usual time across clients (${Math.round(c.median_s!)} s vs ${Math.round(peer_median_s)} s)` : `${task_name} done rate is ${Math.round(done_rate*100)}% vs ${Math.round(peer_done_rate*100)}% across clients`
                const list = result.get(c.client) || []
                list.push({ task_id, task_name, client_median_s: c.median_s!, peer_median_s, ratio, done_rate, peer_done_rate, peer_clients: points.length-1, text }); result.set(c.client,list)
            }
        }
        return result
    })
}
export async function peerBenchmark({ client, window }: { client: string; window: Window }) {
    if (typeof client !== 'string' || !client.trim() || client.length > 256) throw new Error('Choose a client id')
    return rescuePrivacy({ client, window, coverage: coverage(window), tasks: (await peerComparisons(window)).get(client) || [], note: `${window.from} to ${window.to}. Peers are the median of other clients’ medians and done rates, with at least five done per client and five other clients. Durations use interpolated daily buckets.` })
}
