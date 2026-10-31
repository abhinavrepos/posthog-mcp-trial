# ION Lens (ticket-triage)

ION Lens is a PostHog extension with three parts:

- **Ticket triage**: Jira tickets arrive with the evidence attached.
- **Release insights**: each Jira release's tickets, ranked by what they did for clients.
- **Replay clips**: replay clips with per-person access.

The site is at `http://<host>:8080`, and `APP_NAME` renames it.

When a ticket lands in Jira, this finds the client's session in PostHog and attaches a clip of
the moment it went wrong. The comment also covers how many other clients hit the same error, how
the screen is used, and a suggested priority with its reasons. The same logic is available to
Claude as MCP tools, so a PM can ask "when did Brightwater hit this?" and get the answer
with the video.

```
Jira ticket ──webhook──▶ triage service ──▶ core ──HogQL / replay API──▶ PostHog
                              │               │
Claude (MCP) ──stdio/HTTP─────┘               └──▶ PostHog's rasterizer ──▶ MP4 clip
```

## What it does

Two ticket types, set by the Jira issue type:

- **RCI** (raised by client services about a client): works out the client (by user email,
  email domain or fuzzy name), the screen and the time (in the reporter's timezone). It then
  searches for exceptions, rage clicks and dead clicks. When nothing matches, the search widens
  step by step: the ticket's time, then ± 12 hours, then 7 days, then any screen. When nothing
  crashed, it looks for sessions where the user struggled. The comment holds:
  - what happened, with a 30-second **MP4 clip** attached and a link into the full replay
  - **blast radius**: other clients and users, occurrences, first seen, releases, a 14-day
    trend, and the failure rate per release on that screen
  - **usage**: how many clients use the screen, busiest weekdays and days, where this client
    ranks
  - a **suggested priority** with its reasons, and a list of what it could not work out
- **MMT Risk** (a risk review of a screen): exposure, the main error, one replay per affected
  client, the trend and a release comparison.

MCP tools: `resolve_client`, `find_client_incidents`, `get_replay_link`, `screen_usage`, `error_blast_radius`,
`find_silent_issues`, `triage_ticket` and `release_insights`.

Claude never sees replay content. `get_replay_link` returns links for a person to open (the
PostHog replay, which needs a PostHog login, and a signed MP4 clip). No tool returns frames,
video or recording data, and the optional cause suggestion uses event and error data only.

Optional: with `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5`) reads messy tickets and
suggests a likely cause from the error and replay frames. Structured Jira fields always win over
Claude's reading, and Claude's reading wins over the keyword matching. When Claude fails, triage
still completes and the report notes it.

## Replay clip page

`http://<host>:8080/replays` turns any session replay into an MP4. PostHog's own "export to
video" needs a rasterizer worker that the self-hosted hobby install does not run, so this page
does the job with the same renderer.

1. Paste a PostHog replay link (or a session id). The page shows the client, user, date and
   length, and the key moments: errors, rage clicks and dead clicks. Click a moment to start the
   clip 5 seconds before it.
2. Pick a start time and a length (10 to 120 seconds) and make the clip. Jobs queue one at a
   time, and the page shows progress.
3. Watch it, download it (the file name says client, user, date and range), copy a share link
   that expires, or open the replay in PostHog at that second.

The page also lists your clips (made or saved by you) and has a "Get MP4" bookmark button: drag it to the bookmarks
bar, and while you watch a replay in PostHog, click it to open that replay here. Each Jira
triage comment links here too ("Make another clip").

Access: people sign in with their PostHog account, on the page itself or by being signed in to
PostHog on the same host. What they may do is set per person on `/replays/admin`:

| Role | Can |
| --- | --- |
| No access | Nothing (the default for PostHog users not listed) |
| Release insights only | The release dashboard, nothing else (for stakeholders) |
| Watch clips | Also make and watch clips, fix ticket links and make release groups |
| Watch, download and share | Also download MP4s and create share links |
| Admin | Also manage access, settings and clips, and see the activity log |

PostHog owners and admins of the organization that owns the project are always admins. Signing
out on the page also ends the PostHog session. Removing someone from PostHog locks them out within
a minute.

On PostHog's free plan, PostHog itself cannot limit replays per person: every member of the
project's organization can watch every replay in PostHog. To keep someone to clips only, give them
a PostHog account in a separate organization ("Clip viewers") with no access to the project, then
give them a role here. The admin page flags people who can see all replays in PostHog. Claude's
`get_replay_link` returns links into this page, so they need a sign-in and a role too.

### Storage

Roles, settings, clips and the activity log are kept in one SQLite file, `run/triage.db`
(`src/core/db.ts`). SQLite is built into Node, so there is no database server to run. Back it up
while the service runs with `sqlite3 run/triage.db ".backup backup.db"`. On first start, older
JSON files (`run/access.json`, `run/replay-clips.json`, `logs/audit.jsonl`) are imported and
renamed `*.imported`.

- **No duplicates.** The same part of the same recording always gets the same file name, so it
  is rendered and stored once. A second person who asks for it is added to the same clip.
  Clips that only overlap are separate files.
- **Two weeks unless saved.** A clip nobody saved is deleted `CLIP_RETENTION_DAYS` (default 14)
  after it was last asked for. **Save this** keeps it until everyone who saved it unsaves it,
  and unsaving gives it another 14 days.
- **The admin page shows who has what**:
  - each person's clips, how many they saved, and the space they use;
  - each clip's holders, with stars for saved ones, its size and its delete date;
  - the total space.

  Admins can unsave a clip for someone or delete it for everyone.
- **Activity log.** Every sign-in, inspection, clip, view, download, save and share is logged.
  Entries older than `AUDIT_RETENTION_DAYS` (default 365) are deleted.

Each person can make `CLIPS_PER_HOUR` clips (default 20).

## Release insights

`/releases` matches each Jira release (a version of the `ACP` project) with how clients used the
product before and after it shipped. It keeps the last 12 releases.

**Sync.** Every 6 hours, or on "Sync now", the service:

1. reads the released versions and their tickets from Jira;
2. links each ticket to the screen it changed, and to a PostHog event when one fits;
3. counts the following from PostHog, from the release date to the next release (at most 30
   days), and over the same number of days before:
   - use of that screen or event;
   - clients and users;
   - errors and rage clicks on the screen;
   - new error types;
   - support tickets (RCI and MMT Risk) about the screen.

The numbers are stored per release in `run/triage.db`. Releases older than the kept number are
deleted, with their tickets.

**Linking a ticket.** The first match wins:

1. a link someone set on the page;
2. its Jira component, through the component map (or a screen of that name);
3. words in the ticket that name a screen.

On top of the screen, an event is linked when its name shares a word with the ticket title and
it first appeared within three weeks of the release. That is what a new feature looks like.
Bugs and tasks never take a new event. Every ticket shows why it was linked, and anyone with
"Watch clips" can change the link or leave the ticket out of the ranking.

**Scores**, each from 0 to 100:

- **Value**: reach (share of active clients), adoption (use of its event), and fixes (errors or
  rage clicks that went away on its screen).
- **Risk**: new or more errors, more rage clicks, and support tickets.
- **Impact**: the larger of value and risk.

Who carries a screen's problems:

- By default, the tickets that changed how the screen already worked, meaning those with no
  event of their own.
- If every ticket on the screen added an event, they share it.
- Anyone can switch this per ticket.

The scores show activity where a ticket changed the product, not proof that the ticket caused
it, and the page says so.

**On the page:**

- headline numbers, plain-language findings, an impact map (value against risk) and errors
  before and after each release;
- the ranked tickets, with week-by-week use, before/after numbers, support tickets and new
  errors;
- a release table;
- **views**:
  - the last 12 releases;
  - automatic quarters (calendar or fiscal, set by the year's start month);
  - custom groups;
  - any single release;
  - **Compare with** for any two of these.
- **Customise**: weights for the six signals. They apply at once for the viewer, and admins can
  save them as the default.
- **Copy summary**: Markdown for an email or Confluence.
- **Settings** (admins):
  - the Jira project and support JQL;
  - releases kept and days measured;
  - the year start;
  - ranked ticket types;
  - the client and version properties;
  - the component map;
  - reach for whole-screen links.

Claude gets the same through the `release_insights` MCP tool (for example, "which ticket in
Q3 2026 had the most impact?"). It uses event counts only, never replay content.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Shared logic: resolution, incidents, usage, impact, silent issues, clips, severity, report; `releases.ts` (release insights), `db.ts` (SQLite) |
| `src/jira/` | Jira Cloud REST v3 client, webhook signatures, Markdown ↔ ADF |
| `src/service/` | The web service: webhooks, signed clip links, MCP over HTTP, `/releases`, `/replays`, admin |
| `src/mcp/` | MCP tools and the stdio entry point |
| `src/mock-jira/` | Stand-in Jira with the same REST calls and an issue UI |
| `demo-app/` | Acme Portal, the demo B2B app with a planted bug |
| `scripts/` | Setup, stack control, session generator, history seeder, rasterizer build |

## Setup (self-hosted PostHog on one machine)

Needs: Ubuntu, 16 GB+ RAM, Node 24, pnpm 10, and a PostHog checkout for building the rasterizer.

```bash
# 1. PostHog (hobby install, about 30 minutes the first time)
sudo bash install-posthog-hobby.sh <public-ip-or-domain>

# 2. This project
pnpm install                               # also downloads Chrome and ffmpeg
POSTHOG_SRC=/path/to/posthog pnpm build:rasterizer
PUBLIC_HOST=<public-ip> ADMIN_EMAIL=you@example.com scripts/setup-posthog.sh

# 3. Data and processes
scripts/demo-prep.sh --reset-board          # starts everything, records sessions, seeds history
```

Then open the mock Jira at `http://<host>:4000` (no login) and file an example ticket. Its
**Releases** page lists the ACP releases the dashboard reads.

For Claude Code, `.mcp.json` registers the stdio server. Claude Code asks once to approve a
project MCP server. Remote MCP clients use `http://<host>:8080/mcp` with
`Authorization: Bearer <MCP_TOKEN>`.

Commands: `pnpm test`, `pnpm typecheck`, `scripts/stack.sh start|stop|restart|status`.

## The demo data

Acme Portal has 20 clients. It ships a release every month, named like `26.1.0`. The plan in
`src/core/release-plan.ts` is the single source for both the mock Jira's ACP releases (with 50
tickets) and the year of PostHog history the seeder generates (`pnpm seed`, from 2025-09-01).
Clients take each release 0 to 12 days after it ships, then use the features it added, and hit
its rage clicks and errors until the fix ships:

| Release | Story |
| --- | --- |
| 26.1.0 | A new date picker draws rage clicks on the revenue report. 26.2.0 fixes it. |
| 26.5.0 | A new chart engine crashes the revenue report for 17 clients. 26.6.0 fixes it. |
| 26.7.0 | New client list filters hide the search box. Rage clicks and four support tickets follow until 26.8.0. |
| 26.8.0 | Bulk send reaches every client: the most valuable ticket of the year. |
| 26.10.0 | The export bug described below. |

The demo lives in PostHog project 2 ("Acme Portal"). Project 1 is the older 2.x demo, kept
unchanged. Release 26.10.0 rolls out to half of them on a fixed date. On 26.10.0,
exporting a PDF of invoices in more than one currency throws
`TypeError: Cannot read properties of undefined (reading 'toFixed')`, and the UI stays on
"Preparing PDF…". So only the four EU multi-currency clients on 26.10.0 are affected. Two EU
multi-currency clients on 26.9.0 are not, and that is what pins the bug on the release. Cobalt
Health's revenue report shows zero for the quarter with no error: that is the silent-issue case.
All names, companies and email domains are invented.

## Moving to a real Jira and PostHog

- **Jira Cloud**: set `JIRA_BASE_URL=https://<site>.atlassian.net`, `JIRA_EMAIL` and
  `JIRA_API_TOKEN` (an API token for a bot user). Add a webhook for "Issue created" pointing at
  `https://<service>/webhooks/jira`, with a secret equal to `JIRA_WEBHOOK_SECRET`. Set
  `JIRA_RCI_ISSUE_TYPE` and `JIRA_RISK_ISSUE_TYPE` to your issue type names. Custom fields are
  optional: `JIRA_FIELD_CLIENT`, `JIRA_FIELD_USER_EMAIL`, `JIRA_FIELD_SCREEN` and
  `JIRA_FIELD_OCCURRED_AT` (for example `customfield_10042`).
- **Release insights**: on `/releases`, Settings, set the Jira project that holds your releases,
  the support JQL, and the PostHog properties that name the client and the release. Leave the
  release property empty if your events don't carry one; matching then uses release dates only.
  Map your Jira components to screens. `JIRA_PUBLIC_URL` sets where ticket links open.
- **PostHog**: point `POSTHOG_HOST` at your instance and create a personal API key with the
  scopes `query:read`, `session_recording:read`, `error_tracking:read`, `person:read`,
  `group:read` and `project:read`. Your app must register `client_id` and `client_name` as super
  properties (or adapt `src/core/resolve.ts` to your group type). Replace the screen map in
  `src/core/catalog.ts` with your own screens.

## Security notes

- Ticket text is untrusted. HogQL queries bind every value as a placeholder, and nothing from a
  ticket is concatenated into a query. Claude only sees ticket text as data, and its answer is
  limited to a schema with enums of known clients and screens.
- Webhooks must carry a valid `X-Hub-Signature` HMAC. Without a secret, every webhook is
  rejected. Jira redelivers webhooks, so each triage comment carries a marker. A second delivery
  for the same issue does nothing.
- Clip links are signed with `CLIP_LINK_SECRET` and expire after `CLIP_LINK_TTL_HOURS` (default
  7 days). `/mcp` and `/status` need `MCP_TOKEN`. The mock Jira UI needs `DEMO_UI_PASSWORD`.
- Recordings are untrusted content. The renderer's Chrome can only resolve the hosts in
  `CLIP_ALLOWED_HOSTS`, and every other hostname fails to resolve. This replaces PostHog's
  production egress proxy. Two gaps remain: it does not stop a URL with a literal IP, and
  stylesheets are fetched by the rasterizer's Node process. For production, run the renderer
  behind an egress proxy (`HTTPS_PROXY`) or in its own network namespace.
- The PostHog API key is read-only and scoped to one project.
- Everything here runs over plain HTTP on a public IP, which is fine for a demo of invented data.
  Put it behind HTTPS (a domain, so the hobby installer gets a certificate) before it touches
  real client data.
