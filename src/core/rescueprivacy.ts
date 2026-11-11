// Defense in depth for free text copied from task titles and team notes.
import { cached, tasksDb } from './tasks.ts'
import { config } from './config.ts'
export async function rescuePrivacy<T>(value: T): Promise<T> {
    const tokens = await cached('rescue-identity-tokens', {}, async () => {
        const rows = tasksDb.prepare('SELECT DISTINCT user FROM task_users_daily UNION SELECT DISTINCT user FROM user_daily').all() as { user: string }[]
        return [...new Set(rows.flatMap(({ user }) => {
            const person = user.split(config.properties.distinctIdSeparator).at(-1) || ''
            return [user, person, person.includes('@') ? person.split('@')[0] : ''].filter(Boolean)
        }))].sort((a,b) => b.length - a.length)
    })
    const safe = (v: unknown): unknown => {
        if (typeof v === 'string') {
            if (tokens.includes(v)) return '[person]'
            v = v.replace(/[^\s<>"']+@[^\s<>"']+/g, match => tokens.some(t => match.includes(t)) ? '[person]' : match)
            for (const token of tokens) if (token.length >= 3) v = (v as string).split(token).join('[person]')
            return v
        }
        if (Array.isArray(v)) return v.map(safe)
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,safe(x)]))
        return v
    }
    return safe(value) as T
}
