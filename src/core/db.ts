// The replay clip page's database: one SQLite file (run/triage.db, or TRIAGE_DB).
//
//   settings      admin settings (default role, share links on or off)
//   people        the role each person has on the clip page
//   clips         one row per MP4 file in clips/. Two people asking for the same part of the same
//                 recording get the same file, so it is stored once.
//   clip_holders  who has which clip: made it, and whether they saved it
//   clip_comments comments pinned to a second of a clip, shown over the video and burned into downloads
//   system_viewers who may see the System page besides admins
//   replay_insight_people who may see replay insights besides admins
//   survey_people  each person's survey role (view, edit, launch), besides admins (always launch)
//   mcp_tokens     personal chat (MCP) tokens: who they belong to, stored as a hash, revocable
//   survey_launches every survey launch: who, the Jira ticket, the rules they acknowledged
//   dashboards, dashboard_shares, dashboard_people  pinned dashboards, who they are shared with, dashboard roles
//   audit         sign-ins, views, downloads, shares and access changes
//   releases, release_tickets, release_snapshots, release_verdicts
//                 release outcomes for the MCP tools: the last N Jira releases (default 12), their
//                 tickets and how each is linked to PostHog, the counted facts, and verdicts
//
// What gets deleted (see pruneOldClips in service/replays.ts):
//   a clip nobody saved, CLIP_RETENTION_DAYS (14) after it was last asked for;
//   activity older than AUDIT_RETENTION_DAYS (365).
// A saved clip stays until everyone who saved it unsaves it, or an admin deletes it.
// With session replay retention on (settings.replay_retention_days, service/replayretention.ts), unsaved
// clips of recordings older than its cutoff go too; saved ones still stay until unsaved.
//
// SQLite is built into Node, so there is no database server to run.
import { chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

import { config, ROOT } from './config.ts'

export const DB_FILE = process.env.TRIAGE_DB || join(ROOT, 'run/triage.db')
mkdirSync(dirname(DB_FILE), { recursive: true, mode: 0o700 })

export const db = new DatabaseSync(DB_FILE)
// auto_vacuum only takes effect on a new file; it lets deletes give the space back.
// busy_timeout first: switching to WAL needs a lock, and without it a process opening the file while
// another one writes fails at once ("database is locked") instead of waiting.
db.exec('PRAGMA busy_timeout = 30000; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')

// Each entry runs once, in order. PRAGMA user_version counts how many have run.
const MIGRATIONS: string[] = [
    `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE people (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('none', 'watch', 'download', 'admin')),
        note TEXT,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE clips (
        name TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        start_s REAL NOT NULL,
        end_s REAL NOT NULL,
        client TEXT,
        user TEXT,
        recording_start TEXT,
        download_name TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_requested_at TEXT NOT NULL
    );
    CREATE INDEX clips_last_requested ON clips (last_requested_at);
    CREATE TABLE clip_holders (
        clip_name TEXT NOT NULL REFERENCES clips (name) ON DELETE CASCADE,
        email TEXT NOT NULL,
        made_at TEXT NOT NULL,
        saved_at TEXT,
        PRIMARY KEY (clip_name, email)
    ) WITHOUT ROWID;
    CREATE INDEX clip_holders_email ON clip_holders (email);
    CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        t TEXT NOT NULL,
        who TEXT NOT NULL,
        action TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX audit_t ON audit (t);
    CREATE INDEX audit_who ON audit (who, t);`,

    // 2: the "Release insights only" role, and the release dashboard (core/releases.ts).
    `CREATE TABLE people_v2 (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('none', 'insights', 'watch', 'download', 'admin')),
        note TEXT,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    INSERT INTO people_v2 SELECT email, role, note, updated_by, updated_at FROM people;
    DROP TABLE people;
    ALTER TABLE people_v2 RENAME TO people;
    CREATE TABLE releases (
        name TEXT PRIMARY KEY,
        released_at TEXT NOT NULL,
        description TEXT,
        synced_at TEXT NOT NULL
    );
    CREATE TABLE release_tickets (
        key TEXT PRIMARY KEY,
        release TEXT NOT NULL REFERENCES releases (name) ON DELETE CASCADE,
        type TEXT NOT NULL,
        summary TEXT NOT NULL,
        description TEXT,
        status TEXT,
        components TEXT NOT NULL DEFAULT '[]',
        labels TEXT NOT NULL DEFAULT '[]',
        auto_link TEXT,
        link TEXT,
        link_by TEXT,
        link_at TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX release_tickets_release ON release_tickets (release);
    CREATE TABLE release_snapshots (
        release TEXT PRIMARY KEY REFERENCES releases (name) ON DELETE CASCADE,
        computed_at TEXT NOT NULL,
        data TEXT NOT NULL
    );
    CREATE TABLE release_groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        releases TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
    );`,

    // 3: the release dashboard became MCP tools: no more groups or insights role; verdicts instead.
    `UPDATE people SET role = 'none' WHERE role = 'insights';
    DROP TABLE release_groups;
    CREATE TABLE release_verdicts (
        id INTEGER PRIMARY KEY,
        ticket TEXT NOT NULL,
        release TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('risky', 'watch', 'fine')),
        reason TEXT NOT NULL,
        source TEXT NOT NULL,
        at TEXT NOT NULL
    );
    CREATE INDEX release_verdicts_ticket ON release_verdicts (ticket, id);`,

    // 4: comments pinned to moments of a clip, shown big over the video and burned into downloads.
    `CREATE TABLE clip_comments (
        id INTEGER PRIMARY KEY,
        clip_name TEXT NOT NULL REFERENCES clips (name) ON DELETE CASCADE,
        at_s REAL NOT NULL,
        duration_s REAL NOT NULL,
        text TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX clip_comments_clip ON clip_comments (clip_name, at_s);`,

    // People an admin let see the System page (machine and container status). Kept apart from the
    // clip roles, so a role change or reset never grants or removes it. Admins always see it.
    `CREATE TABLE system_viewers (
        email TEXT PRIMARY KEY,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,

    // People an admin let use the Surveys page (see answers, launch and stop surveys). Admins always can.
    `CREATE TABLE survey_people (
        email TEXT PRIMARY KEY,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,

    // Survey roles: rows ticked before roles existed had full use, so they become "launch".
    `ALTER TABLE survey_people ADD COLUMN role TEXT NOT NULL DEFAULT 'launch';`,

    // Personal chat tokens, so chat knows who is asking. Only a hash is kept; the token is shown once.
    `CREATE TABLE mcp_tokens (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        posthog_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT
    );
    CREATE INDEX mcp_tokens_email ON mcp_tokens (email);`,

    // Every launch of a survey: who, under which Jira ticket, after acknowledging which rules, from where.
    `CREATE TABLE survey_launches (
        id INTEGER PRIMARY KEY,
        survey_id TEXT NOT NULL,
        survey_name TEXT NOT NULL,
        ticket TEXT NOT NULL,
        ticket_summary TEXT,
        launched_by TEXT NOT NULL,
        via TEXT NOT NULL,
        rules TEXT NOT NULL,
        at TEXT NOT NULL
    );
    CREATE INDEX survey_launches_survey ON survey_launches (survey_id, at);`,

    // Dashboards: views pinned from chat or the page (task map, flow time), who they are shared with,
    // and each person's dashboard role. The task history behind them lives in run/tasks.db (core/tasks.ts).
    `CREATE TABLE dashboards (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        params TEXT NOT NULL,
        via TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX dashboards_owner ON dashboards (owner);
    CREATE TABLE dashboard_shares (
        dashboard_id TEXT NOT NULL REFERENCES dashboards (id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        shared_by TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (dashboard_id, email)
    );
    CREATE INDEX dashboard_shares_email ON dashboard_shares (email);
    CREATE TABLE dashboard_people (
        email TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,
    `CREATE TABLE rescue_actions (
        client TEXT PRIMARY KEY,
        owner TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','contacted','in_progress','resolved','expected')),
        note TEXT CHECK(length(note) <= 500),
        due TEXT,
        snooze_until TEXT,
        score_at_snooze REAL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,
    `ALTER TABLE rescue_actions ADD COLUMN reasons_at_action TEXT;
    ALTER TABLE rescue_actions ADD COLUMN acted_on TEXT;
    CREATE TABLE briefing_snapshots (id INTEGER PRIMARY KEY, "by" TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE UNIQUE INDEX briefing_person_day ON briefing_snapshots ("by", substr(created_at,1,10));`,
    `CREATE TABLE client_surveys (
        survey_id TEXT NOT NULL, client TEXT NOT NULL, name TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(survey_id,client)
    );
    CREATE INDEX client_surveys_client ON client_surveys(client,created_at);
    ALTER TABLE survey_launches ADD COLUMN clients TEXT NOT NULL DEFAULT '[]';`,
    `CREATE TABLE client_outcomes (
        client TEXT PRIMARY KEY NOT NULL CHECK(length(client) BETWEEN 1 AND 256),
        outcome TEXT NOT NULL CHECK(outcome IN ('left','contracted','renewed','stayed')),
        decided_on TEXT NOT NULL CHECK(decided_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(decided_on,'+0 days') IS NOT NULL AND date(decided_on,'+0 days') = decided_on),
        note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
        recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL
    );`,
    // Retired migration slot (keeps installed database version numbers stable).
    `SELECT 1;`,
    // People an admin let see replay insights (how clients' people work, read from session replays: the
    // Client story section and the client_experience / friction_hotspots chat tools). Admins always can;
    // nobody else unless ticked here. Kept apart from every role, so no role change grants it.
    `CREATE TABLE replay_insight_people (
        email TEXT PRIMARY KEY,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );`,
    // When a personal token's PostHog-admin flag was last confirmed by its owner signing in to Signal.
    // A key cannot ask PostHog itself, so an unconfirmed flag stops counting after a while (access.ts).
    `ALTER TABLE mcp_tokens ADD COLUMN posthog_admin_seen_at TEXT;`,
    `SELECT 1;`,
    `SELECT 1;`,
    `CREATE TABLE client_outcome_episodes (
        client TEXT NOT NULL, outcome TEXT NOT NULL, decided_on TEXT NOT NULL,
        note TEXT NOT NULL, recorded_by TEXT NOT NULL, recorded_at TEXT NOT NULL,
        PRIMARY KEY(client,decided_on)
    ) WITHOUT ROWID;
    INSERT INTO client_outcome_episodes SELECT * FROM client_outcomes;`,
    `CREATE TABLE tool_audit (
        id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_email TEXT NOT NULL, token_id TEXT NOT NULL,
        tool TEXT NOT NULL, argument_keys TEXT NOT NULL, resolved_window TEXT, client_ids TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, result_chars INTEGER NOT NULL, is_error INTEGER NOT NULL,
        error_kind TEXT, correlation_id TEXT NOT NULL
    );
    CREATE INDEX tool_audit_at ON tool_audit(at);
    CREATE INDEX tool_audit_user ON tool_audit(user_email,at);`,

    `ALTER TABLE tool_audit ADD COLUMN result_kind TEXT;
     ALTER TABLE tool_audit ADD COLUMN job_hash TEXT;`,
    `CREATE TABLE rv_watch (id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('client','distinct_id')), value TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, max_sessions_per_day INTEGER NOT NULL DEFAULT 200, UNIQUE(kind,value));
     CREATE TABLE rv_client_policy (client_id TEXT PRIMARY KEY, vision_opt_in INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE rv_run (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, recording_end TEXT NOT NULL, analysis_version TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'deterministic', client_id TEXT, distinct_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, started_at TEXT, completed_at TEXT, coverage_json TEXT NOT NULL DEFAULT '{}', metrics_json TEXT NOT NULL DEFAULT '{}', provider TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_micros INTEGER, error_code TEXT, UNIQUE(project_id,session_id,recording_end,analysis_version,mode));
     CREATE INDEX rv_run_state ON rv_run(state,next_attempt_at,lease_until);
     CREATE INDEX rv_run_identity ON rv_run(client_id,distinct_id,session_id);
     CREATE TABLE rv_run_watch (run_id INTEGER NOT NULL REFERENCES rv_run(id) ON DELETE CASCADE, watch_id INTEGER NOT NULL REFERENCES rv_watch(id) ON DELETE CASCADE, PRIMARY KEY(run_id,watch_id));
     CREATE TABLE rv_finding (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES rv_run(id) ON DELETE CASCADE, fingerprint TEXT NOT NULL, detector_codes_json TEXT NOT NULL, strength TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('High','Medium','Low')), severity_reason_json TEXT NOT NULL, screen_key TEXT NOT NULL, element_key TEXT NOT NULL, step_key TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, evidence_json TEXT NOT NULL, coverage_json TEXT NOT NULL, confidence TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,fingerprint));
     CREATE INDEX rv_finding_group ON rv_finding(screen_key,element_key,step_key);
     CREATE TABLE rv_baseline (detector TEXT NOT NULL, screen_key TEXT NOT NULL, window_end TEXT NOT NULL, n_sessions INTEGER NOT NULL, n_users INTEGER NOT NULL, median REAL, mad REAL, p90 REAL, p95 REAL, rate REAL, version TEXT NOT NULL, aux_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(detector,screen_key,window_end,version));
     CREATE TABLE rv_insight (id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, screen_key TEXT NOT NULL, element_key TEXT NOT NULL, step_key TEXT NOT NULL, root_cause_key TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, users_affected INTEGER NOT NULL, users_reached INTEGER, sessions_affected INTEGER NOT NULL, sessions_reached INTEGER, severity TEXT NOT NULL CHECK(severity IN ('High','Medium','Low')), severity_reason_json TEXT NOT NULL, time_lost_ms INTEGER NOT NULL DEFAULT 0, abandoned_users INTEGER NOT NULL DEFAULT 0, calibrated INTEGER NOT NULL DEFAULT 0, baseline_version TEXT, baseline_sample_json TEXT NOT NULL DEFAULT '{}', reach_source TEXT, behaviour_json TEXT NOT NULL, outcome_json TEXT NOT NULL, cause TEXT NOT NULL, fix TEXT NOT NULL, impact TEXT NOT NULL, confidence TEXT NOT NULL, rubric_json TEXT NOT NULL, analysis_version TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dismissed_at TEXT, dismissed_by TEXT);
     CREATE TABLE rv_insight_member (insight_id TEXT NOT NULL REFERENCES rv_insight(id) ON DELETE CASCADE, finding_id INTEGER NOT NULL REFERENCES rv_finding(id) ON DELETE CASCADE, PRIMARY KEY(insight_id,finding_id));
     CREATE TABLE rv_budget (day_utc TEXT NOT NULL, scope TEXT NOT NULL, used_sessions INTEGER NOT NULL DEFAULT 0, used_download_bytes INTEGER NOT NULL DEFAULT 0, reserved_llm_calls INTEGER NOT NULL DEFAULT 0, used_llm_calls INTEGER NOT NULL DEFAULT 0, reserved_cost_micros INTEGER NOT NULL DEFAULT 0, estimated_cost_micros INTEGER NOT NULL DEFAULT 0, used_input_tokens INTEGER NOT NULL DEFAULT 0, used_output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day_utc,scope));
     CREATE TABLE rv_reservation (custom_id TEXT PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES rv_run(id) ON DELETE CASCADE, day_utc TEXT NOT NULL, scope TEXT NOT NULL, cost_micros INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
     CREATE TABLE rv_provider_job (run_id INTEGER NOT NULL REFERENCES rv_run(id) ON DELETE CASCADE, provider TEXT NOT NULL, batch_id TEXT, custom_id TEXT NOT NULL, state TEXT NOT NULL, submitted_at TEXT, next_poll_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error_code TEXT, UNIQUE(provider,custom_id));
     CREATE TABLE rv_cursor (project_id TEXT NOT NULL, scope TEXT NOT NULL, keyset_json TEXT NOT NULL DEFAULT '{}', last_success_at TEXT, last_error_code TEXT, PRIMARY KEY(project_id,scope));
     CREATE TABLE rv_vision_approval (run_id INTEGER PRIMARY KEY REFERENCES rv_run(id) ON DELETE CASCADE, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, redaction_digest TEXT NOT NULL, expires_at TEXT NOT NULL);`,
    `CREATE TABLE rv_secret (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `ALTER TABLE rv_run ADD COLUMN requested_by TEXT;
     CREATE INDEX rv_finding_run ON rv_finding(run_id);`,
    `CREATE TABLE rv_llm_explanation (custom_id TEXT PRIMARY KEY, insight_id TEXT NOT NULL, scope_key TEXT NOT NULL, run_id INTEGER, provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
       state TEXT NOT NULL, decision TEXT, cause TEXT, fix TEXT, cited_json TEXT NOT NULL DEFAULT '[]', confidence TEXT, rubric_score INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_micros INTEGER, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX rv_llm_explanation_insight ON rv_llm_explanation(insight_id, state);`,
]

/** Runs fn in one transaction: all of its writes land, or none do. */
export function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
        const out = fn()
        db.exec('COMMIT')
        return out
    } catch (e) {
        db.exec('ROLLBACK')
        throw e
    }
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as T[]
export const one = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as T | undefined
export const run = (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params)

export function getSetting<T>(key: string, fallback: T): T {
    const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)
    return row ? (JSON.parse(row.value) as T) : fallback
}
export function setSetting(key: string, value: unknown): void {
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

function migrate() {
    const version = one<{ user_version: number }>('PRAGMA user_version')!.user_version
    for (let v = version; v < MIGRATIONS.length; v++) {
        tx(() => {
            // Another process (the service, a script, a parallel test) may have run it meanwhile:
            // check again now that this transaction holds the write lock.
            if (one<{ user_version: number }>('PRAGMA user_version')!.user_version > v) return
            db.exec(MIGRATIONS[v])
            db.exec(`PRAGMA user_version = ${v + 1}`)
        })
    }
}

/** Moves the JSON files older versions used into the database, once, and renames them. */
function importLegacyFiles() {
    const take = (rel: string, fn: (text: string) => void) => {
        const file = join(ROOT, rel)
        if (!existsSync(file)) return
        tx(() => fn(readFileSync(file, 'utf8')))
        renameSync(file, `${file}.imported`)
    }
    take('run/access.json', (text) => {
        const a = JSON.parse(text) as { default_role?: string; allow_share_links?: boolean; people?: Record<string, { role: string; note?: string; updated_by: string; updated_at: string }> }
        if (a.default_role) setSetting('default_role', a.default_role)
        if (a.allow_share_links !== undefined) setSetting('allow_share_links', a.allow_share_links)
        for (const [email, p] of Object.entries(a.people || {})) {
            run('INSERT OR REPLACE INTO people VALUES (?, ?, ?, ?, ?)', email.toLowerCase(), p.role, p.note ?? null, p.updated_by, p.updated_at)
        }
    })
    take('run/replay-clips.json', (text) => {
        for (const c of JSON.parse(text) as Record<string, string | number | undefined>[]) {
            const file = join(config.clip.outDir, String(c.name))
            if (!existsSync(file)) continue
            run(
                `INSERT OR IGNORE INTO clips (name, session_id, start_s, end_s, client, user, recording_start, download_name, bytes, created_by, created_at, last_requested_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                String(c.name), String(c.session_id), Number(c.start_s), Number(c.end_s), (c.client as string) ?? null, (c.user as string) ?? null, (c.recording_start as string) ?? null,
                String(c.download_name), statSync(file).size, String(c.created_by), String(c.created_at), String(c.created_at)
            )
            run('INSERT OR IGNORE INTO clip_holders (clip_name, email, made_at) VALUES (?, ?, ?)', String(c.name), String(c.created_by), String(c.created_at))
        }
    })
    take('logs/audit.jsonl', (text) => {
        for (const line of text.split('\n')) {
            if (!line.trim()) continue
            const { t, who, action, ...details } = JSON.parse(line) as Record<string, unknown>
            run('INSERT INTO audit (t, who, action, details) VALUES (?, ?, ?, ?)', String(t), String(who), String(action), JSON.stringify(details))
        }
    })
}

/** If something runs as root (say, the MCP server started by Claude Code), keeps the database files
 * owned by whoever owns run/, so the service, which runs unprivileged, can still write them. */
function keepOwner() {
    if (process.getuid?.() !== 0) return
    const { uid, gid } = statSync(dirname(DB_FILE))
    if (uid === 0) return
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (existsSync(f)) chownSync(f, uid, gid)
}

migrate()
// Only the default database takes over the old files; a test database must not.
if (DB_FILE === join(ROOT, 'run/triage.db')) importLegacyFiles()
keepOwner()

// Upgrade existing audit databases; masking metadata is no longer collected.
if (db.prepare('PRAGMA table_info(tool_audit)').all().some(c => c.name === 'privacy_mode')) db.exec('ALTER TABLE tool_audit DROP COLUMN privacy_mode')
