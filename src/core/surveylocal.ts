// Local targeting metadata; story reads never call the survey API or expose answers.
import { run } from './db.ts'
export function rememberClientSurvey(id: string, name: string, clients: string[], status: string, at = new Date().toISOString()): void {
    for (const client of clients) run(`INSERT INTO client_surveys VALUES (?,?,?,?,?,?)
        ON CONFLICT(survey_id,client) DO UPDATE SET name=excluded.name,status=excluded.status,updated_at=excluded.updated_at`, id, client, name, at, at, status)
}
