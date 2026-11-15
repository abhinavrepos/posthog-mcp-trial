// The MCP date adapter shares weekly observations with the scorecard. Kept outside scorecard.ts
// so the independent performance work there remains isolated.
import { scorecard, KIND_LABEL, type ScoreRow } from '../core/scorecard.ts'
import { weekObservation } from '../core/weekly.ts'
import { clientOutcomes } from '../core/outcomes.ts'
import { median } from '../core/peers.ts'
import { rescuePrivacy } from '../core/rescueprivacy.ts'
import { requestedToolWindow } from '../core/toolcontext.ts'
import { inclusiveWindow } from './timeinput.ts'
const kinds = ['overall',...Object.keys(KIND_LABEL).filter(k=>k!=='overall')]
export async function windowedScorecard(input: {weeks?:number} = {}) {
    const requested=requestedToolWindow()
    if(!requested) return scorecard(input)
    const window=inclusiveWindow(requested)
    const flags=new Map<string,Map<string,string>>(kinds.map(k=>[k,new Map()]))
    const processed:string[]=[],skipped:string[]=[],signal_incomplete:string[]=[]
    const end=new Date(+requested.to-1);end.setUTCHours(0,0,0,0);end.setUTCDate(end.getUTCDate()-end.getUTCDay())
    // Only full weeks whose Sunday is within the requested dates are sampled.
    for(let at=+end;at>=+requested.from;at-=604800000) {
        const day=new Date(at).toISOString().slice(0,10),obs=await weekObservation(day)
        if(!obs.complete) {skipped.push(day);continue}
        processed.push(day);if(!obs.signals_complete)signal_incomplete.push(day)
        for(const row of obs.rows) for(const key of [row.kind,'overall']) {
            const map=flags.get(key),first=map?.get(row.client)
            if(map && (!first || day<first))map.set(row.client,day)
        }
        await new Promise<void>(resolve=>setImmediate(resolve))
    }
    const outcomes=clientOutcomes(),negative=outcomes.filter(o=>o.outcome==='left'||o.outcome==='contracted')
    const rows:ScoreRow[]=[...flags].map(([kind,clients])=>{
        const first_flags=outcomes.flatMap(o=>{const first_flag=clients.get(o.client);return first_flag && first_flag<o.decided_on ? [{client:o.client,first_flag,lead_days:(Date.parse(o.decided_on)-Date.parse(first_flag))/86400000}]:[]})
        const hits=first_flags.filter(f=>negative.some(o=>o.client===f.client))
        return {kind,label:KIND_LABEL[kind]||kind,flagged_clients:clients.size,hits:hits.length,median_lead_days:median(hits.map(f=>f.lead_days)),misses:negative.length-hits.length,possible_false_alarms:outcomes.filter(o=>['renewed','stayed'].includes(o.outcome)&&clients.has(o.client)).length,first_flags}
    })
    return rescuePrivacy({window,weeks:processed.length+skipped.length,to:window.to,rows,outcome_clients:outcomes.length,explanation:outcomes.length ? `${outcomes.length} clients with recorded outcomes; this is a historical sanity check, never a probability.` : 'No client outcomes recorded yet. An admin adds outcomes under Admin → Client outcomes.',coverage:{processed_weeks:processed.length,skipped_weeks:skipped,signal_incomplete_weeks:signal_incomplete,text:`${processed.length} complete weekly observations; ${skipped.length} skipped. Only Sunday observations inside the requested window are sampled; each uses its preceding history.`},note:'First flags are weekly observations, not exact onset. Hits require a flag before the decision date; possible false alarms include renewed/stayed clients. No probabilities are calculated.'})
}
