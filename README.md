# ticket-triage

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
`find_silent_issues` and `triage_ticket`.

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

The page also lists recent clips and has a "Get MP4" bookmark button: drag it to the bookmarks
bar, and while you watch a replay in PostHog, click it to open that replay here. Each Jira
triage comment links here too ("Make another clip").

Access: people sign in with their PostHog account, on the page itself or by being signed in to
PostHog on the same host. What they may do is set per person on `/replays/admin`:

| Role | Can |
| --- | --- |
| No access | Nothing (the default for PostHog users not listed) |
| Watch clips | Make and watch clips on this site |
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

Every inspection, clip, view, download and share link goes to `logs/audit.jsonl`. Clips are
deleted after `CLIP_RETENTION_DAYS` (default 30), and each person can make `CLIPS_PER_HOUR`
clips (default 20).

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Shared logic: resolution, incidents, usage, impact, silent issues, clips, severity, report |
| `src/jira/` | Jira Cloud REST v3 client, webhook signatures, Markdown ↔ ADF |
| `src/service/` | Triage service: webhooks, signed clip links, MCP over HTTP |
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

Then open the mock Jira at `http://<host>:4000` (user `demo`, password `DEMO_UI_PASSWORD` in
`.secrets.env`) and file an example ticket.

For Claude Code, `.mcp.json` registers the stdio server. Claude Code asks once to approve a
project MCP server. Remote MCP clients use `http://<host>:8080/mcp` with
`Authorization: Bearer <MCP_TOKEN>`.

Commands: `pnpm test`, `pnpm typecheck`, `scripts/stack.sh start|stop|restart|status`.

## The demo data

Acme Portal has 20 clients. Release 2.14.0 rolls out to half of them on a fixed date. On 2.14.0,
exporting a PDF of invoices in more than one currency throws
`TypeError: Cannot read properties of undefined (reading 'toFixed')`, and the UI stays on
"Preparing PDF…". So only the four EU multi-currency clients on 2.14.0 are affected. Two EU
multi-currency clients on 2.13.2 are not, and that is what pins the bug on the release. Cobalt
Health's revenue report shows zero for the quarter with no error: that is the silent-issue case.
All names, companies and email domains are invented.

## Moving to a real Jira and PostHog

- **Jira Cloud**: set `JIRA_BASE_URL=https://<site>.atlassian.net`, `JIRA_EMAIL` and
  `JIRA_API_TOKEN` (an API token for a bot user). Add a webhook for "Issue created" pointing at
  `https://<service>/webhooks/jira`, with a secret equal to `JIRA_WEBHOOK_SECRET`. Set
  `JIRA_RCI_ISSUE_TYPE` and `JIRA_RISK_ISSUE_TYPE` to your issue type names. Custom fields are
  optional: `JIRA_FIELD_CLIENT`, `JIRA_FIELD_USER_EMAIL`, `JIRA_FIELD_SCREEN` and
  `JIRA_FIELD_OCCURRED_AT` (for example `customfield_10042`).
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
