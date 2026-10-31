// Renders a TriageReport as markdown. The same text becomes the Jira comment (via ADF) and the
// MCP tool result, so people and Claude read the same thing.
import type { ErrorImpact } from './impact.ts'
import type { Incident } from './incidents.ts'
import type { TriageReport } from './triage.ts'
import type { ScreenUsage } from './usage.ts'

const pct = (x: number) => `${Math.round(x * 100)}%`
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ') + ' UTC'
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function sparkline(values: number[]): string {
    const bars = '▁▂▃▄▅▆▇█'
    const max = Math.max(...values, 1)
    return values.map((v) => (v === 0 ? '·' : bars[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}

function describeIncident(i: Incident): string {
    if (i.kind === 'exception') return `\`${i.error_type || 'Error'}: ${i.error_message || ''}\``.replace(': `', '`')
    if (i.kind === 'rageclick') return `Rage click on ${i.element || 'an element'}`
    return `Dead click on ${i.element || 'an element'}`
}

function usageSection(u: ScreenUsage, clientName?: string): string[] {
    const lines = [`### How ${u.pathname} is used (last ${u.days} days)`]
    lines.push(`- **${u.clients_using} of ${u.clients_total}** clients use it: ${u.users} users, ${u.sessions} sessions, ${u.pageviews} page views.`)
    if (u.client && clientName) {
        lines.push(
            u.client.pageviews
                ? `- ${clientName}: ${u.client.pageviews} page views by ${u.client.users} user${u.client.users === 1 ? '' : 's'}, rank **#${u.client.rank}** of ${u.clients_using}.`
                : `- ${clientName} has not opened this screen in the last ${u.days} days.`
        )
    }
    const top = [...u.by_weekday].sort((a, b) => b.pageviews - a.pageviews)
    if (top[0]?.pageviews) lines.push(`- Busiest weekdays: ${top.slice(0, 2).map((d) => d.weekday).join(' and ')}. Busiest day: ${u.busiest_days[0]?.day} (${u.busiest_days[0]?.pageviews} views).`)
    if (u.top_clients.length) lines.push(`- Heaviest users: ${u.top_clients.slice(0, 3).map((c) => `${c.client_name} (${c.pageviews})`).join(', ')}.`)
    return lines
}

function impactSection(im: ErrorImpact, title = '### Is it just them?'): string[] {
    const lines = [title]
    lines.push(
        `- **${im.clients.length} client${im.clients.length === 1 ? '' : 's'}**, ${im.users} users, ${im.occurrences} occurrences in the last ${im.days} days.` +
            (im.first_seen ? ` First seen ${when(im.first_seen)}.` : '')
    )
    if (im.by_version.length) {
        lines.push(`- Releases: ${im.by_version.map((v) => `${v.app_version || 'unknown'} (${v.occurrences})`).join(', ')}.` + (im.by_version.length === 1 ? ` **Only on ${im.by_version[0].app_version}.**` : ''))
    }
    if (im.failure_rate?.by_version.length) {
        lines.push(`- Sessions on ${im.failure_rate.pathname} that hit this error: ${im.failure_rate.by_version.map((v) => `${v.app_version || 'unknown'} **${pct(v.rate)}** (${v.failed}/${v.sessions})`).join(', ')}.`)
    }
    lines.push(`- Last 14 days: \`${sparkline(im.daily.map((d) => d.occurrences))}\` (${im.daily.at(-1)?.occurrences ?? 0} today)`)
    if (im.clients.length) {
        lines.push('', '| Client | Plan | Occurrences | Users | Last seen |', '|---|---|---|---|---|')
        for (const c of im.clients.slice(0, 8)) lines.push(`| ${c.client_name} | ${c.plan || '-'} | ${c.occurrences} | ${c.users} | ${when(c.last_seen)} |`)
    }
    if (im.issue_url) lines.push('', `[Open the issue in PostHog error tracking](${im.issue_url})`)
    return lines
}

function footer(r: TriageReport): string[] {
    const lines: string[] = []
    lines.push(`### Suggested priority: ${r.severity.priority}`)
    for (const reason of r.severity.reasons) lines.push(`- ${reason}`)
    if (!r.severity.reasons.length) lines.push('- Not enough evidence to raise it.')
    lines.push('_A suggestion only. Set the priority yourself._')
    if (r.hypothesis) lines.push('', '### Possible cause (from Claude)', r.hypothesis, '_A hypothesis from the stack trace and replay frames, not a confirmed cause._')
    if (r.notes.length) {
        lines.push('', '### What I could not work out')
        for (const n of r.notes) lines.push(`- ${n}`)
    }
    lines.push('', `_ticket-triage · ${r.elapsed_s.toFixed(1)} s${r.understood.ai_used ? ' · ticket read by Claude' : ''}_`)
    return lines
}

export function renderReport(r: TriageReport): string {
    return r.ticket.kind === 'risk' ? renderRisk(r) : renderRci(r)
}

function renderRci(r: TriageReport): string {
    const u = r.understood
    const lines: string[] = [`## Triage: suggested ${r.severity.priority}`]
    const facts = [
        u.client ? `**Client:** ${u.client.name} (matched by ${u.client.via.replace('-', ' ')})` : '**Client:** not identified',
        r.incident?.user || r.struggle?.user ? `**User:** ${r.incident?.user || r.struggle?.user}` : u.emails[0] ? `**User:** ${u.emails[0]}` : '',
        u.screen ? `**Screen:** ${u.screen.name} (${u.screen.path})` : '',
        `**Time:** ${u.window.label}`,
    ].filter(Boolean)
    lines.push(facts.join(' · '))

    if (r.incident) {
        const i = r.incident
        lines.push('', '### What happened')
        lines.push(`- **${when(i.timestamp)}**: ${describeIncident(i)} on \`${i.pathname}\` (v${i.app_version})`)
        for (const o of r.other_sessions.slice(0, 3)) lines.push(`- ${when(o.timestamp)}: ${describeIncident(o)} (${o.user}, another session)`)
        if (r.search) lines.push(`- Found by searching ${r.search.step}.`)
    } else if (r.struggle) {
        const s = r.struggle
        lines.push('', '### What happened', `- No error was recorded. The session at **${when(s.start)}** shows the user struggling: ${s.signals.join(', ')}.`)
    }

    if (r.clip) {
        lines.push('', `▶ **[Watch the ${Math.round(r.clip.video_duration_s)} s clip](${r.clip.url})** (attached) · [Full replay from ${mmss(r.clip.start_offset_s)}](${r.clip.replay_url})`)
    } else if (r.incident?.recording || r.struggle?.recording) {
        lines.push('', `▶ [Open the replay](${(r.incident?.recording || r.struggle?.recording)!.url})`)
    }

    if (r.impact) lines.push('', ...impactSection(r.impact))
    if (r.usage) lines.push('', ...usageSection(r.usage, u.client?.name))
    lines.push('', ...footer(r))
    return lines.join('\n')
}

function renderRisk(r: TriageReport): string {
    const lines: string[] = [`## Risk review: suggested ${r.severity.priority}`]
    const screen = r.understood.screen
    lines.push(`**Screen:** ${screen ? `${screen.name} (${screen.path})` : 'not identified'} · **Period:** last 30 days`)
    if (r.usage) {
        const u = r.usage
        lines.push('', '### Exposure', `- **${u.clients_using} of ${u.clients_total}** clients use this screen: ${u.users} users, ${u.sessions} sessions in ${u.days} days.`)
        if (u.top_clients.length) lines.push(`- Heaviest users: ${u.top_clients.slice(0, 3).map((c) => `${c.client_name} (${c.pageviews})`).join(', ')}.`)
    }
    if (r.impact) lines.push('', ...impactSection(r.impact, `### Main error: \`${r.impact.error_type}: ${r.impact.error_message}\``))
    if (r.risk?.sessions.length) {
        lines.push('', '### Replays')
        for (const s of r.risk.sessions) lines.push(`- ${s.client_name}, ${s.user}, ${when(s.timestamp)}: [replay](${s.recording?.url})`)
        if (r.clip) lines.push(`- ▶ **[Watch the ${Math.round(r.clip.video_duration_s)} s clip](${r.clip.url})** of the most recent one (attached)`)
    }
    if (r.impact?.failure_rate) {
        lines.push('', '### Release comparison')
        lines.push('| Release | Sessions | Hit the error | Rate |', '|---|---|---|---|')
        for (const v of r.impact.failure_rate.by_version) lines.push(`| ${v.app_version || 'unknown'} | ${v.sessions} | ${v.failed} | ${pct(v.rate)} |`)
    }
    lines.push('', ...footer(r))
    return lines.join('\n')
}
