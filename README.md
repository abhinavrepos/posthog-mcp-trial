# PostHog Lens for ION (ticket-triage)

PostHog Lens is a PostHog extension with three parts:

- **Ticket triage**: Jira tickets arrive with the evidence attached.
- **Release outcomes** (MCP tools for Claude): what each Jira release's tickets did in PostHog,
  sorted into groups, with client feedback. Claude judges the risk; people's verdicts are saved.
- **Replay clips**: replay clips with per-person access.

The site is at `http://<host>:8080`. `APP_NAME` and `APP_TAG` rename it.

**Install** on a fresh machine: `sudo deploy/install.sh` (see [Install](#install-on-a-fresh-machine)).
**Upgrade** an existing PostHog to the tested version: `sudo deploy/migrate/posthog-upgrade.sh`
(see [deploy/migrate/README.md](deploy/migrate/README.md)).

Jira is optional until you connect it: without `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`,
the Jira webhook answers 503 and release outcomes keep the numbers they last had. Everything else
(replay links, clips, the MCP tools, `triage_ticket`) works.

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
`find_silent_issues` and `triage_ticket`. For releases, see Release outcomes below.

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

## Release outcomes

Claude reads these through MCP tools; there is no web page. The service gathers facts, and the
model judges them:

```
Jira releases + tickets ──┐
Support tickets (RCI, MMT)─┼──▶ sync every 6 h ──▶ facts per ticket, sorted into groups ──▶ MCP ──▶ Claude
PostHog events + surveys ──┘     (src/core/releases.ts, stored in run/triage.db)                 │
                                                                     verdicts (risky/watch/fine) ◀┘
```

**1. Jira.** It reads the last 12 released versions of the `ACP` project with their tickets,
plus the support tickets.

**2. Linking.** Each ticket is linked to the screen it changed. The first rule that matches
wins:

1. a link someone set;
2. its Jira component;
3. words in the ticket.

On top of the screen, an event is linked when its name shares a feature word with the ticket
title and it first appeared within three weeks of the release. That is what a new feature looks
like.

**3. Counting.** From the release date to the next release (at most 30 days), and the same
number of days before, it counts in PostHog:

- use of the screen or event, and the clients and people behind it;
- errors and rage clicks per 100 sessions on the screen, and new error types;
- in-product survey answers (`survey sent` events);
- support tickets about the screen.

**4. Groups.** Plain thresholds sort each ticket into groups; they are listed in `OUTCOMES` and
`THRESHOLDS`, and a ticket can be in several.

| Group | Rule |
| --- | --- |
| More errors after the release | Errors on its screen rose by 1+ per 100 sessions, or a new error type hit 2+ clients |
| More rage clicks | Rage clicks rose by 2+ per 100 sessions |
| Clients complained | Support tickets about its screen, or the survey rating fell by 0.8+ |
| Fixed something | Errors or rage clicks on its screen halved (bug fixes and changes to existing screens) |
| Adopted | Its new event was used by 30%+ of active clients |
| Low uptake | Its new event was used by under 10% of active clients |
| Too new to tell | Released under 14 days ago, nothing stands out yet |
| No clear change | Linked, but none of the above |
| Can't measure | No screen or event (often tasks) |

**Who carries a screen's problems.** By default, the tickets that changed how the screen already
worked, meaning those with no event of their own. If every ticket on the screen added an event,
they share it.

**5. Judging.** Claude decides what is risky, from these facts, what clients said, and earlier
verdicts. Once a person agrees, `record_verdict` saves the verdict (and can post it to Jira), so
the next review builds on it. No score or formula judges risk. Claude only uses numbers the tools
returned.

**Tools:**

| Tool | What it does |
| --- | --- |
| `list_releases` | Kept releases with headline facts, and the quarters |
| `release_outcomes` | Tickets of a release, quarter or range, sorted into the groups, each with its facts and verdict. Start here. |
| `ticket_evidence` | One ticket in full: link and why, week by week, errors, support tickets and survey comments in the clients' words, verdict history |
| `client_feedback` | Support tickets and survey answers after each release, by screen |
| `record_verdict` | Saves risky, watch or fine with the reason (optionally as a Jira comment) |
| `correct_ticket_link` | Fixes a wrong link and recounts |
| `refresh_releases` | Reads Jira and PostHog again now |

**Prompt `review_release`:** it walks Claude through a review (outcomes, feedback, then the
evidence for anything that looks wrong) and ends with a verdict table that you confirm before
anything is saved. In Claude Code it is `/mcp__ticket-triage__review_release 26.10.0`.

**Scopes** are a release (`26.10.0`), a quarter (`Q3 2026`, or `FY27 Q1` with a fiscal year),
`last 3`, a range (`26.5.0..26.8.0`) or `all`.

**Settings** are environment variables:

| Variable | What |
| --- | --- |
| `RELEASES_JIRA_PROJECT` | The Jira project (default `ACP`) |
| `RELEASES_SUPPORT_JQL` | Which support tickets count |
| `RELEASES_KEEP` | Releases kept (12) |
| `RELEASES_WINDOW_DAYS` | Days measured (30) |
| `RELEASES_FISCAL_START_MONTH` | Month the year starts (1) |
| `RELEASES_CLIENT_PROPERTY` | Event property that names the client (`client_id`) |
| `RELEASES_VERSION_PROPERTY` | Event property with the release name (`app_version`; empty to match by date only) |
| `RELEASES_COMPONENT_SCREENS` | JSON map from Jira component to screen, e.g. `{"Billing":"/invoices"}` |

### Switching the MCP servers on and off

Two switches in `.secrets.env`, each `on` or `off` (both `on` by default):

| Switch | What it controls | When off |
| --- | --- | --- |
| `FEATURE_LENS_MCP` | this service's tools for Claude: replay links, tickets, clients, screens, releases | `/mcp` answers 503, the stdio server exits, `.mcp.json` leaves it out |
| `FEATURE_POSTHOG_MCP` | PostHog's own MCP server (needs `POSTHOG_MCP_URL` and `POSTHOG_MCP_API_KEY`) | `.mcp.json` leaves it out; the instructions stop sending Claude there |

After changing either:

```bash
pnpm mcp:config                      # rewrites .mcp.json (git-ignored: it can hold PostHog's key)
scripts/stack.sh restart service     # for /mcp over HTTP
pnpm doctor                          # shows both switches and whether .mcp.json matches them
```

The rule that Claude never opens replays is in the instructions with either switch. The replay clip
page (`/replays`) is not an MCP server and is not affected. If someone connects PostHog's MCP server
to their own Claude by hand, these switches cannot stop that; use a PostHog key without replay scopes.

To connect Claude Code over HTTP:

```bash
claude mcp add --transport http posthog-lens http://<host>:8080/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

The local `.mcp.json` server has the same tools.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Shared logic: resolution, incidents, usage, impact, silent issues, clips, severity, report; `releases.ts` (release outcomes), `db.ts` (SQLite) |
| `src/jira/` | Jira Cloud REST v3 client, webhook signatures, Markdown ↔ ADF |
| `src/service/` | The web service: webhooks, signed clip links, MCP over HTTP, `/replays`, admin |
| `src/mcp/` | MCP tools and the stdio entry point |
| `demo-app/` | Acme Portal, the demo B2B app with a planted bug |
| `scripts/` | Setup, stack control, session generator, history seeder, rasterizer build |
| `vendor/` | PostHog's replay rasterizer and player page, prebuilt (`pnpm build:rasterizer` rebuilds them) |
| `deploy/install.sh` | Fresh install: PostHog, this service, the status page (answers: `deploy/install.env.example`) |
| `deploy/migrate/` | Upgrading an existing PostHog to the tested version, with backups |
| `deploy/posthog/` | PostHog's installer (pinned), scaling, load tests |
| `deploy/status/` | The status page |

## Install on a fresh machine

This branch is for **Amazon Linux 2023** (the `ticket-triage` branch is the same project for Ubuntu
and Debian). The EC2 instance needs:

- **Amazon Linux 2023 AMI, x86_64.** Not Graviton (arm64): the Chrome that renders clips has no Linux
  arm64 build.
- **16 GB+ memory:** m7i.xlarge, m6i.xlarge or m6a.xlarge (4 CPUs, 16 GB) or larger.
- **A 60 GB+ root volume** (gp3). The default 8 GB is far too small.
- **Security group, inbound:** 22 from your address; 80 (and 443 with a domain) from your users and
  your app; 8080 from where people open clip links. 8090 only if the status page is public.
- With a domain: an A record pointing at the instance's Elastic IP, so the address does not change
  when the instance stops.

Nothing else: the script installs Docker, PostHog, Node and pnpm. Log in as `ec2-user`, then:

```bash
sudo dnf install -y git
sudo git clone --branch ticket-triage-amazon-linux --single-branch https://github.com/abhinavrepos/posthog-mcp-trial /srv/ticket-triage
cd /srv/ticket-triage
sudo deploy/install.sh                      # asks two things, shows the plan, then installs (about 1 hour)
```

It asks two things:

- **The address(es) of PostHog**, comma-separated, for example `10.0.1.25,52.1.2.3`. The first one is
  the main one (links in emails and exports use it). PostHog answers on all of them, and each one is a
  trusted origin for logins (CSRF). Domains get HTTPS, while IPs and `http://` names are plain HTTP.
  Don't mix the two kinds.
- **The email of the first PostHog login.**

Everything else has a default: organization `ION`, event names `client_id`, `client_name`,
`app_version` and `email`, Jira not connected, Claude reading off, Lens MCP on, and the status page on
this machine only. Session recording works on every site that sends events. To set APP_URLS (which
limits recording to your app's addresses) or change any other default, fill in a copy of
`deploy/install.env.example` and run `sudo deploy/install.sh --config my-install.env`. Add `--yes`
to ask nothing. To add an address later, run the installer again with the longer list: only the
addresses change, and the data is kept.

It installs PostHog at the exact version tested here (every image pinned by digest), tunes it for
load, creates the login and a read-only API key, writes `.secrets.env`, runs the service under
systemd (`ticket-triage.service`, starts at boot), starts the status page, writes `.mcp.json` and
ends with `pnpm doctor`. Every step checks its result. If one fails, fix it and run the same command
again: finished steps are skipped. The closing summary (`sudo deploy/install.sh status` shows it again)
has everything you need next: addresses, where each password and token is, the snippet for your app,
and how to connect Jira and Claude.

## Upgrade PostHog

`sudo deploy/migrate/posthog-upgrade.sh` takes an existing PostHog (for example the 3 Sep 2025 one)
to the tested version on top of its own data: it backs everything up and checks the backup first,
asks whether to copy the session replays, shows progress, can be resumed or rolled back, and deletes
nothing until you confirm. Details: [deploy/migrate/README.md](deploy/migrate/README.md).

## Demo machine

The demo (Acme Portal, recorded sessions, a year of history) on a machine with PostHog installed:

```bash
pnpm install                               # also downloads Chrome and ffmpeg
PUBLIC_HOST=<public-ip> ADMIN_EMAIL=you@example.com scripts/setup-posthog.sh
scripts/demo-prep.sh                        # starts everything, records sessions, seeds history
```

For Claude Code, run `pnpm mcp:config`: it writes `.mcp.json` with the servers that are switched on.
Claude Code asks once to approve a project MCP server. Remote MCP clients use `http://<host>:8080/mcp` with
`Authorization: Bearer <MCP_TOKEN>`.

Commands: `pnpm test`, `pnpm typecheck`, `scripts/stack.sh start|stop|restart|status`.

Status page: `deploy/status/up.sh` starts one small container with a page that says whether PostHog,
these processes, data flow, every container and the machine are up (see `deploy/status/README.md`).

## The demo data

Acme Portal has 120 clients and about 840 users. The 20 named clients in
`src/core/catalog.ts` are the ones the demo app, the recorded sessions and the example tickets
use. The other 100 are generated the same way every time, so the history has a realistic size
(about 290,000 events over 14 months), plus about 2,800 in-product survey answers
(`pnpm seed:feedback`), which turn sour while a screen is broken for that client.

Acme Portal ships a release every month, named like `26.1.0`. The plan in
`src/core/release-plan.ts` plans those releases (ACP, with 50 tickets) and the year of PostHog
history the seeder generates from them (`pnpm seed`, from 2025-09-01). The release tools read the
releases from Jira, so with a real Jira they show your project's releases instead.
Clients take each release 0 to 12 days after it ships, then use the features it added, and hit
its rage clicks and errors until the fix ships:

| Release | Story |
| --- | --- |
| 26.1.0 | A new date picker draws rage clicks on the revenue report. 26.2.0 fixes it. |
| 26.5.0 | A new chart engine crashes the revenue report for 74 clients. 26.6.0 fixes it. |
| 26.7.0 | New client list filters hide the search box. Rage clicks and four support tickets follow until 26.8.0. |
| 26.8.0 | Bulk send reaches 86 of 99 active clients in a month: the most valuable ticket of the year. |
| 26.10.0 | The export bug described below. |

Release 26.10.0 went to half the clients on its release day. On 26.10.0, exporting a PDF of
invoices in more than one currency throws
`TypeError: Cannot read properties of undefined (reading 'toFixed')`, and the UI stays on
"Preparing PDF…". So only multi-currency clients on 26.10.0 are affected: ten of them, four of
them named. Multi-currency clients still on 26.9.0 are not, and that is what pins the bug on
the release. Cobalt
Health's revenue report shows zero for the quarter with no error: that is the silent-issue case.
All names, companies and email domains are invented.

The demo lives in PostHog project 3 ("Acme Portal"). Projects 1 and 2 are older, smaller demos,
kept unchanged.

## Connecting Jira and your own PostHog

`deploy/install.sh` takes all of this from a `--config` file. To change it later, edit `.secrets.env` and run
`sudo systemctl restart ticket-triage` (or `scripts/stack.sh restart service`).

- **Jira Cloud**: set `JIRA_BASE_URL=https://<site>.atlassian.net`, `JIRA_EMAIL` and
  `JIRA_API_TOKEN` (an API token for a bot user). Add a webhook for "Issue created" pointing at
  `https://<service>/webhooks/jira`, with a secret equal to `JIRA_WEBHOOK_SECRET`. Set
  `JIRA_RCI_ISSUE_TYPE` and `JIRA_RISK_ISSUE_TYPE` to your issue type names. Custom fields are
  optional: `JIRA_FIELD_CLIENT`, `JIRA_FIELD_USER_EMAIL`, `JIRA_FIELD_SCREEN` and
  `JIRA_FIELD_OCCURRED_AT` (for example `customfield_10042`).
- **Release outcomes**: set the `RELEASES_*` variables above. Leave `RELEASES_VERSION_PROPERTY`
  empty if your events don't carry the release; matching then uses release dates only. If you
  use PostHog surveys, their answers are read automatically. `JIRA_PUBLIC_URL` sets where ticket
  links open.
- **PostHog**: point `POSTHOG_HOST` at your instance and create a personal API key with the
  scopes `query:read`, `session_recording:read`, `error_tracking:read`, `person:read`,
  `group:read` and `project:read`. Your app must register `client_id` and `client_name` as super
  properties (or adapt `src/core/resolve.ts` to your group type). Replace the screen map in
  `src/core/catalog.ts` with your own screens.

## Deploying somewhere else

1. Copy `.env.example` to `.secrets.env` (or anywhere, with `TRIAGE_ENV_FILE=/path`) and fill it
   in. Every key, URL, property name and limit is a setting. Your screens go in a JSON file
   (`SCREENS_FILE`, see `config/screens.example.json`).
2. `pnpm doctor` checks it against the real services: PostHog reachable, the key's scopes and
   project, that your events carry the client and release properties, Jira login, secrets, HTTPS.
3. `scripts/stack.sh start service`.

### Using PostHog's MCP server next to this one

Both can be connected at once. This server tells Claude, when it connects, which questions belong
to which server: tickets, clients, releases and screens here; ad-hoc SQL, insights, flags,
experiments and survey setup in PostHog's. It also tells Claude never to use PostHog's replay or
Replay Vision tools. Give PostHog's server its own personal key without `session_recording`
scopes (`POSTHOG_MCP_API_KEY`); `pnpm doctor` fails if that key can read replays. The key is
what actually keeps replays private.

### Scaling PostHog (self-hosted)

`sudo deploy/posthog/scale.sh` makes the hobby install take 200 events a second (bursts of 500+)
without losing any. It is safe to re-run, keeps all data, and `--undo` reverts it. What it changes
and why is written at the top of `deploy/posthog/docker-compose.scale.yml`. In short:

- the current Node image (Docker Hub's `posthog/posthog-node:latest` stopped updating in March), plus the settings and job-queue database that image needs;
- Kafka partitions, so ingestion runs as several processes, and retention capped at 24 h and 2 GB per partition (it was 7 days with no cap);
- a health check that restarts a stalled plugin or ingestion process, as Kubernetes would;
- Postgres, Redis and Celery sized for the load; restart policies on every service.

Check it with `pnpm loadtest --rate 200 --minutes 10`. It sends browser-like traffic to a separate
"Load test" project, with a webhook destination, and fails if any event or webhook is lost, any
plugin fails or any container restarts.

## Security notes

- Ticket text is untrusted. HogQL queries bind every value as a placeholder, and nothing from a
  ticket is concatenated into a query. Claude only sees ticket text as data, and its answer is
  limited to a schema with enums of known clients and screens.
- Webhooks must carry a valid `X-Hub-Signature` HMAC. Without a secret, every webhook is
  rejected. Jira redelivers webhooks, so each triage comment carries a marker. A second delivery
  for the same issue does nothing.
- Clip links are signed with `CLIP_LINK_SECRET` and expire after `CLIP_LINK_TTL_HOURS` (default
  7 days). `/mcp` and `/status` need `MCP_TOKEN`.
- Recordings are untrusted content. The renderer's Chrome can only resolve the hosts in
  `CLIP_ALLOWED_HOSTS`, and every other hostname fails to resolve. This replaces PostHog's
  production egress proxy. Two gaps remain: it does not stop a URL with a literal IP, and
  stylesheets are fetched by the rasterizer's Node process. For production, run the renderer
  behind an egress proxy (`HTTPS_PROXY`) or in its own network namespace.
- The PostHog API key is read-only and scoped to one project.
- Everything here runs over plain HTTP on a public IP, which is fine for a demo of invented data.
  Put it behind HTTPS (a domain, so the hobby installer gets a certificate) before it touches
  real client data.
