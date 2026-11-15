// Administrative facts are separate from cached historical evidence.
import { all, run, tx } from './db.ts'
import { validDay } from './tasks.ts'
import { audit, can, type Viewer } from '../service/access.ts'
export const OUTCOMES = ['left','contracted','renewed','stayed'] as const
export interface ClientOutcome { client: string; outcome: typeof OUTCOMES[number]; decided_on: string; note: string; recorded_by: string; recorded_at: string }
export const outcomeEpisodes = () => all<ClientOutcome>('SELECT * FROM client_outcome_episodes ORDER BY client,decided_on')
export const clientOutcomes = () => all<ClientOutcome>('SELECT * FROM client_outcomes ORDER BY client')
export function recordOutcome(v: Viewer, p: Record<string, unknown>, remove = false): void {
    if (!can(v.role,'admin')) throw new Error('Admins only')
    if (typeof p.client !== 'string' || !p.client.trim() || p.client.length > 256) throw new Error('Give a client id of 1–256 characters')
    if (!remove) {
        if (!OUTCOMES.includes(p.outcome as ClientOutcome['outcome'])) throw new Error('Choose left, contracted, renewed or stayed')
        validDay(p.decided_on as string)
        if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 500)) throw new Error('Note must be at most 500 characters')
    }
    tx(() => {
        if (remove) {
            if (p.decided_on) { validDay(p.decided_on as string); run('DELETE FROM client_outcome_episodes WHERE client=? AND decided_on=?',p.client as string,p.decided_on as string) }
            else run('DELETE FROM client_outcome_episodes WHERE client=?',p.client as string)
            run('DELETE FROM client_outcomes WHERE client=?',p.client as string)
            run('INSERT INTO client_outcomes SELECT * FROM client_outcome_episodes WHERE client=? ORDER BY decided_on DESC LIMIT 1',p.client as string)
        }
        else {
            run('INSERT OR REPLACE INTO client_outcome_episodes VALUES (?,?,?,?,?,?)',p.client as string,p.outcome as string,p.decided_on as string,p.note as string || '',v.email,new Date().toISOString())
            run('INSERT OR REPLACE INTO client_outcomes SELECT * FROM client_outcome_episodes WHERE client=? ORDER BY decided_on DESC LIMIT 1',p.client as string)
        }
        audit(v.email,'outcome.recorded',{ client:p.client, ...(remove ? { removed:true } : { outcome:p.outcome,decided_on:p.decided_on }) })
    })
}
