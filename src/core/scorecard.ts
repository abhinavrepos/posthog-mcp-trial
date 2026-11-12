import { rescuePrivacy } from './rescueprivacy.ts'
import { cached, dataThrough } from './tasks.ts'
import { type ReasonKind } from './rescue.ts'
import { weekObservation } from './weekly.ts'
import { clientOutcomes } from './outcomes.ts'
import { median } from './peers.ts'
const shift = (s: string,n: number) => new Date(Date.parse(s)+n*86400000).toISOString().slice(0,10)
export const KIND_LABEL: Record<string, string> = { overall: 'Any warning sign', missing: 'Stopped a task', users_lost: 'Users stopped', failing: 'Failing',
    slower: 'Slower', dropped: 'Task use dropped', activity_drop: 'Less use overall', key_person_gap: 'Key person gone', work_moving_out: 'Exports up, work down',
    recurring_close_error: 'Same error at month-end', giving_up: 'Giving up after errors', peer_gap: 'Behind other clients', not_established: 'New task never settled' }
const KINDS: ReasonKind[] = ['missing','users_lost','failing','slower','dropped','activity_drop','key_person_gap','work_moving_out','recurring_close_error','giving_up','peer_gap','not_established']
export interface ScoreRow {
    kind: string; label: string; flagged_clients: number; hits: number; median_lead_days: number | null; misses: number; possible_false_alarms: number
    first_flags: { client: string; first_flag: string; lead_days: number }[]
}
export async function scorecard({ weeks = 52 }: { weeks?: number } = {}) {
    if (!Number.isInteger(weeks) || weeks<1 || weeks>52) throw new Error('Weeks must be an integer from 1 to 52')
    const to=dataThrough() || shift(new Date().toISOString().slice(0,10),-1)
    // Full UTC weeks ending Sunday. Never replay an unfinished calendar week.
    const end=shift(to,-new Date(to).getUTCDay())
    const history=await cached('scorecard-history',{ weeks,end },async()=>{
        const flags = new Map<string,Map<string,string>>(['overall',...KINDS].map(k=>[k,new Map()]))
        const processed: string[]=[], skipped: string[]=[], signal_incomplete: string[]=[]
        for(let i=weeks-1;i>=0;i--) {
            const w=shift(end,-i*7), obs=await weekObservation(w)
            if(!obs.complete) { skipped.push(w); continue }
            processed.push(w)
            if(!obs.signals_complete) signal_incomplete.push(w)
            for(const r of obs.rows) for(const key of [r.kind,'overall']) { const m=flags.get(key); if(m && !m.has(r.client)) m.set(r.client,w) }
            // Let the service answer other requests between weeks that had to be computed.
            await new Promise<void>(resolve=>setImmediate(resolve))
        }
        return {flags,processed,skipped,signal_incomplete}
    })
    // Outcomes are read afresh: editing one never requires replaying the year.
    const outcomes=clientOutcomes(), negative=outcomes.filter(o=>o.outcome==='left'||o.outcome==='contracted')
    const rows: ScoreRow[]=[...history.flags].map(([kind,flags])=>{
        const first_flags=outcomes.flatMap(o=>{const first_flag=flags.get(o.client); return first_flag && first_flag<o.decided_on ? [{client:o.client,first_flag,lead_days:(Date.parse(o.decided_on)-Date.parse(first_flag))/86400000}] : []})
        const hits=first_flags.filter(f=>negative.some(o=>o.client===f.client))
        return {kind,label:KIND_LABEL[kind]||kind.replaceAll('_',' '),flagged_clients:flags.size,hits:hits.length,median_lead_days:median(hits.map(f=>f.lead_days)),misses:negative.length-hits.length,
            possible_false_alarms:outcomes.filter(o=>(o.outcome==='renewed'||o.outcome==='stayed')&&flags.has(o.client)).length,first_flags}
    })
    return rescuePrivacy({ weeks,to,rows,outcome_clients:outcomes.length, explanation:!outcomes.length ? 'No client outcomes recorded yet, so nothing can be checked. An admin adds clients that left, shrank, renewed or stayed under Admin → Client outcomes; until then this page only counts warnings.'
        : `${outcomes.length} client${outcomes.length === 1 ? '' : 's'} with a recorded outcome${outcomes.length < 20 ? ': a small sample, so treat this as a sanity check, not accuracy' : ''}.`,
        coverage:{processed_weeks:history.processed.length,skipped_weeks:history.skipped,signal_incomplete_weeks:history.signal_incomplete,
            text:`${history.processed.length} of ${weeks} week ends replayed; ${history.skipped.length} skipped because rescue periods were incomplete. ${history.signal_incomplete.length} replayed weeks have incomplete signal capture history; individual signals require their own coverage. Misses mean no earlier flag in this replay, not proof of signal failure.`},
        note:'First flags are weekly observations, not exact onset. Hits require a flag strictly before the decision date; possible false alarms include any flag for renewed/stayed clients. No probabilities are calculated.' })
}
