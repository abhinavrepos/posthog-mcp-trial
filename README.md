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
`find_silent_issues` and `triage_ticket`. For releases, see Release outcomes below; for Reval's own dialogs
and buttons, see "Your app's own events" below.

Claude never sees replay content. `get_replay_link` returns links for a person to open (the
PostHog replay, which needs a PostHog login, and a signed MP4 clip). No tool returns frames,
video or recording data, and the optional cause suggestion uses event and error data only.

Optional: with `ANTHROPIC_API_KEY` set, Claude (`claude-opus-5-5`) reads messy tickets and
suggests a likely cause from the event and error data (replay frames are never sent). Structured Jira fields always win over
Claude's reading, and Claude's reading wins over the keyword matching. When Claude fails, triage
still completes and the report notes it.

## Your app's own events (Reval)

Lens reads Reval's dialogs, buttons and messages alongside PostHog events. PMs ask questions
in plain language; Lens investigates and names workflows automatically, with no report setup.

| MCP tool | Answers |
|---|---|
| `reval_brief` | What should I worry about, how is a client doing, or what happened to a trade? A ready-to-read brief with comparisons, evidence and limits. Start here. |
| `describe_app_events` | What do events and properties mean? Coverage, example values, common dialogs and messages, clients and SQL guidance. |
| `top_pains` | What hurts most this week? Dialogs ranked by affected clients, main errors, changes from the previous week and example sessions. |
| `dialog_friction` | Where do clients fail? Button attempts and outcomes, errors, retries and stuck sessions, for all clients, one client or one dialog. |
| `message_doctor` | Which messages leave people stuck? Field labels touched, other dialogs opened, searches, recovery and repeated failures, with flags and examples. |
| `session_story` | What happened in this session? A timeline of dialogs, fields, buttons, outcomes and messages, with replay links for a person to open. |
| `attempt_timings` | Is a button slow or a server call failing? Waits after Save or Run, slow calls (method and path only) and HTTP errors from recent recordings. |
| `find_trade` | What happened to trade 4348? Sessions where it was searched for or named in a message, with clients, users, attempts and errors. |
| `client_signals` | Which clients need attention? Changes in sessions, days, dialogs, users and failed attempts. Warning signs, not a churn prediction. |
| `discover_workflows` | Which tasks do people do and finish? Frequent dialog chains with automatic names, stable ids, support, outcomes, times and errors. |
| `workflow_completion` | Do clients finish this task? Starts, ordered funnel steps, failures, retries, abandonment, times and previous-window comparisons, by discovered id/name or a list of dialogs. |

### Asking Lens (reval_brief)

Ask “what should I worry about?”, “how is ACME doing?”, “brief me”, “what happened to trade
4348?” or “is hedge designation a problem?”. The agent calls `reval_brief` and relays its answer.
Lens chooses trade first, then a confidently matched client, then a whole dialog name or code,
otherwise a general brief. It compares the last 14 days with the 14 before; trade lookups default
to 30 days. You can give a time in plain words.

Findings favour affected clients, repeated problems and blocked work, and flag when one user
contributes more than half the failures. Counts, session ids, replay links, limits and next
questions accompany the brief; a JSON block after `<!-- data -->` holds the same findings.
Queued reports are not finished, missing messages are not failures, and less use is not proof
of churn. A change after a release does not prove causation. The prompts `where_clients_struggle`,
`weekly_review`, `client_check` and `release_check` start with this tool; a release check flags
current concerns without isolating release effects.

### Message doctor

`message_doctor` groups errors by template and dialog; filter by `client`, `dialog`, `message`
text or `when`. It observes field labels, other dialogs and searches until the next submit or
five minutes, without showing search text or field values. Recovery means a later submit on
the same dialog/button completes or queues within 15 minutes. Repeated failure means another
submit shows the same error. Gave up means no later submit on that dialog in the observed
session; recovery and repeated failure can both count.

With at least three occurrences, **points elsewhere** means none of the top five touched field
labels shares a word with the message; **dead end** means at least half gave up; **fine** means
at least 80% recovered. Flags can overlap and are behavioural clues, not proof a field edit fixed
anything. Dead ends and messages pointing elsewhere come first, then clients hit. Examples have
session ids and replay links when recorded. Reads cover at most 1,000 error sessions in batches;
row counts and cuts are disclosed, and sessions still over the event cap are omitted.

### Workflows

`discover_workflows` finds chains of 2–4 ordered dialog opens ending in a submit, in at least
two distinct sessions. Lens names each chain from dialog titles, the most common successful
submit button and its success-message template, for example
“Hedge Designation → Save → 'Link Id … Added'”. Without an observed success, the name uses
the dialog titles alone. Each chain has a stable id derived only from its ordered dialog codes,
so title or message changes do not change its identity. PMs name and save nothing.

`workflow_completion` accepts a discovered id or exact name, or an ordered list of dialog
codes/names. Names resolve within the requested window; ids remain usable across windows,
even when the chain is no longer frequent. Discovered workflows count completed or queued as
done, reporting both separately; explicit dialog lists require completed. It reports starts,
funnel steps, failures, retries, abandonment, times, dropout errors and example replay links,
per client and overall, against the previous equal window. Other dialogs may appear between
steps. A retry repeats the same dialog/button within five minutes after an error.

Search/menu navigation or 10 minutes idle starts a new episode. Consecutive opens of the same
dialog collapse; menu and message dialogs stay out. Chains rank by sessions × clients; a shorter
chain drops out when a containing chain has at least 80% of its session support. Completion
counts one start per episode in the window and requires all steps and an answering outcome
message in that episode. Durations end at that message. No observed done before the episode ends
means abandoned; active sessions can change. Reads cover at most 2,000 relevant sessions and
50,000 events per batch of 50; limits and partial results are disclosed.

### Reading the events

Reval sends `PageView` when a dialog opens, gets focus or closes, and `Event` for fields,
buttons, searches and messages. Properties include `dialog_id`, `dialog_name`, `tab_name`,
`action`, `control_type` and `action_name` (button or message text). The client is part 3 of
`ENV|SITE|CLIENT|USER`. Operators enable this vocabulary with:

```
APP_EVENTS_FILE=config/app-events.reval.json
CLIENT_FROM_DISTINCT_ID=3
PROP_CLIENT_NAME=none
```

The vocabulary file handles new dialogs and buttons without code changes. An attempt is a
submit press (Save, Run, Apply, Export...). Its outcome is the message within 20 seconds:
`messagebox` is an error unless nothing was found; `toast` is completed or queued when a job is
scheduled. No message means “none”, which need not be a problem. Messages with no dialog are
tied to the preceding attempt or action. Trade/link ids remain in individual messages for support;
templates remove ids for grouping. Typed search text and field values are never shown; field labels
are retained and generated control ids appear as “an unlabelled field”.

These questions belong to `lens`. Generic analytics and PostHog objects belong to `posthog`,
including generic funnels about trades or surveys about Reval screens. Both servers repeat the
routing rules through the proxy. To try made-up events without Reval, operators can run
`pnpm tsx scripts/seed-reval.ts` (four clients, two weeks) against PostHog in `.secrets.env`.

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

**Comments on the video.** Under a clip, anyone who can watch it can pin comments to moments:
click into the comment box (the video pauses and its moment is taken, or type one like `1:05.5`),
write what to notice and pick how long it shows (3 to 20 seconds, 5 by default). While the clip
plays, each comment shows big over the picture at its moment, like a subtitle, also in full screen.
**Download** and **share links** carry them burned into the video, so they work in any player
(**Download without the comments** gives the plain clip). A comment shows until its time runs out
or the next comment starts. Whoever wrote a comment, or an admin, can edit or delete it; each
change is in the activity log. The burned copy is made once per version of the comments (about a
second for a 30-second clip) and is deleted with the clip.

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

## Live page

`http://<host>:8080/replays/live` (the **Live** tab) shows who is in the app right now and how
long each client spent in it. Anyone with the "Watch clips" role can open it.

- **In the app now**: everyone with an action in the last `LIVE_NOW_MINUTES` (5), with their
  client, when their session started and their time today. It refreshes every 30 seconds.
- **Time in the app**, for today, yesterday, the last 7, 30 or 90 days, or any dates (at most 92
  days), for every client or one:
  - totals: time in the app, active, idle, clients, people and sessions;
  - a column per hour (one day) or per day, split into active and idle;
  - a grid of active time by hour of each day;
  - clients, or the people of one client, sortable, each with its active share;
  - every session of a client or a person, with **Make a clip** to open it on the clip page.
- **Timeline**: the Timeline button on a person (in "In the app now", the people of a client, or
  a session) opens their day as a timeline: each session as a bar, active and idle stretches, a
  tick for every action and a taller one when they opened a screen, with the totals, first and
  last action and the longest pause. Point at it to see what happened at that second; click (or
  use the arrow keys) to pick a moment and **Make a clip** from 10 seconds before it. Sessions at
  the same time (two browsers) get their own lanes. ‹ › move a day; every action is listed below,
  each with its own clip link. Today's timeline refreshes every 30 seconds.
- **CSV**: the client or people list and the session log download as CSV.
- The view is kept in the address (period, client, person, active time), so a link opens the same
  view for someone else. Times are in the viewer's timezone.

Action names on the timeline come from the events: "Opened /invoices", "Clicked "Approve"" (the
button text PostHog's autocapture recorded), or your own event names in plain words. The clip
links use each recording's start time from PostHog's replay index (timestamps only).

**How time is counted** (`src/core/presence.ts`). Within each PostHog session, the time from one
action to the next is **in the app**. Of that, up to `LIVE_ACTIVE_GAP_S` (60) seconds after each
action is **active**, and the rest is **idle**. The page can switch the limit between 15 seconds and
10 minutes. PostHog ends a session after 30 minutes without an action, so longer breaks are not
counted, and neither is the time after a person's last action. Each stretch counts in the hour it
started. Automatic events (`LIVE_IGNORE_EVENTS`) do not count as actions. The page reads events
only, never recordings.

To try it with demo data: `pnpm live-demo` sends today's sessions so far (with pauses) and keeps
four people active for 10 minutes (`--minutes 30` for longer). `pnpm live-demo --selftest` sends
one session with known timings to check the counting: with the default limit, the "Lens
self-test" client on 2025-10-01 shows 410 s in the app, 160 s active and 250 s idle.

## Dashboards: client task map and flow time

`/replays/dashboards` (the **Dashboards** tab), and the same answers in chat. PMs ask in chat; the
dashboards are where they and their team come back to.

- **Client task map** (Dashboard A): for each client and task, attempts, done rate and time now
  against an earlier period, with flags: **Missing** (did it before, not at all now), **Dropped**
  (half or less), **Slower** (median up 30% and 10 s or more), **Failing** (done rate down 15 points),
  **New**. Clients that need attention come first; the rest fold away. Clicking a task opens its flow time.
- **Flow time** (Dashboard B): for one task, one client or all: median and p90 per day or week against
  all clients, the paths of dialogs people take (share, done rate, time), the slowest attempts with replay
  links, and the most common errors. For "how long does ACME take to book a hedge, and which path?".
- Every view's filters are in its link. **Pin** keeps a view (fixed dates, or "always the last N days")
  at its own link; **Share** picks people from Lens's people or by email. Owners and admins can rename,
  change filters, reshare and delete.
- **Chat** (MCP): `find_task`, `task_map`, `flow_time`, `list_dashboards`, `pin_dashboard`,
  `share_dashboard`. Clients and tasks in plain words ("Treasury 2", "ir swap"); unclear ones come back as
  choices. Each answer has a link to the live view; pinning needs the person's own chat token.
- **Access**, per person on the admin page: *See dashboards* (views and dashboards shared with them) or
  *Also pin and share*. Admins always have both and see every pinned dashboard. A default applies to
  everyone else (*No access* unless changed); the shared chat token gets at most *See dashboards*.

**What a task is.** The dialog where a user submits and gets a good outcome (completed or accepted),
named after the dialog and its most common finish ("IR Swap → Save → 'Trade Id … Updated'"). An attempt
runs from the start of a work episode (episodes split on search/menu navigation or 10 idle minutes) to
that good outcome (done), or to the episode's end (failed when an error was shown, else abandoned). Its
path is the dialogs opened on the way.

**How it scales.** Lens builds a task history in the background (`src/core/tasks.ts`, its own SQLite
file `run/tasks.db`): every 10 minutes it re-reads today and yesterday and catches up older days (20 a
run, newest first, up to 400 days). A day is read in about 4 PostHog queries (one for its sessions, then
50,000-event pages), retried with growing waits when PostHog is busy or rate-limited, and stored in one
transaction, so a re-run replaces it. The dashboards read daily summaries (per client, task and path,
with duration histograms for the median and p90), never raw events, and keep each answer until the
next stored day. Measured on the test machine: a full Reval-size day (111,808 events, 2,750 sessions)
in 4.9 s; a 20,000-event day in about 1.5 s; the task map over a year of summaries for 50 clients and
40 tasks in about 200 to 250 ms, flow time in about 100 ms, a repeat in under 1 ms.

**Honest numbers.** Flags appear only when both periods are fully processed: a day not processed yet
is never shown as work that stopped (the page says which dates are not ready). Each answer says how far
the history goes; days cut short by a safety cap are marked. To try it: `scripts/seed-reval-scale.ts`
sends Reval-shaped events at volume, with a client that stops a task and one that gets slower.

## Surveys

In-app surveys for the app's users, made in chat and watched on the **Surveys** page. They are
PostHog surveys shown by the survey script PostHog already serves, so nothing is added to the app.

**In chat** (MCP tools; the PM never opens PostHog):

| Tool | What it does |
|---|---|
| `design_survey` | Checks a survey described in the app's words and counts the sessions in the last 14 days that went through its steps. Saves nothing. |
| `save_survey` | Saves it as a draft, or changes one Lens made (`survey_id`). |
| `launch_survey` | Starts showing it. Needs `confirm: true`, which Claude passes only after the person says yes. |
| `stop_survey` | Stops it (`archive: true` also hides it). Answers stay. |
| `list_surveys` | Every survey, with its steps, clients and counts. |
| `survey_results` | Shown, answered, dismissed, each question's answers, per client and per day, and the survey's current fields for a change. |

A survey is described in the app's own words:

```json
{
  "name": "Hedge booking ease",
  "steps": [{ "opens": "DlgHedgeDesignation" }, { "button": "Save", "dialog": "DlgHedgeDesignation" }, { "message": "has been saved" }],
  "reset_on": [{ "closes": "DlgHedgeDesignation" }],
  "within_minutes": 15,
  "clients": ["ACME"],
  "questions": [{ "type": "rating", "text": "How easy was booking this hedge?" }, { "type": "open", "text": "What slowed you down?", "optional": true }],
  "show": "once",
  "look": { "background": "#0b2a4a", "text": "#ffffff", "button": "#f5a623", "button_text": "#0b2a4a", "position": "right" }
}
```

- **Steps** happen in order; other events in between are fine. A step is `opens` or `closes` a
  dialog, a `button` or `field` (optionally in a `dialog`), a `message` the app shows (text it
  contains) or `message_pattern` (a simple regular expression), or any `event` with property
  filters. `reset_on` starts the chain over; `within_minutes` limits the whole chain.
- **When**: as soon as the last step happens and the page has loaded (no ExtJS loading mask), with
  no fixed delay. `wait_for_page: false` skips the wait; `max_wait_seconds` (30) gives up on a page
  that stays busy.
- **Who**: `clients` (names or ids; unclear names stop the save), `sample_percent` (a fixed share
  of their users), `url_contains`. `show` is `once` per user or `every_time`;
  `days_between_surveys` (14) keeps a user from seeing two surveys close together; `max_responses`
  stops it.
- **Protecting users from survey fatigue** (enforced per user in the browser):
  - at least **24 hours** between any two surveys (`SURVEYS_MIN_GAP_HOURS`, never less;
    `days_between_surveys` is at least 1), and only one survey per visit;
  - the **×** closes a survey at once; that survey never returns, and the user gets no survey for
    **7 days** (`SURVEYS_QUIET_DAYS_AFTER_CLOSE`);
  - a survey shown **twice with no answer or close** stops coming back;
  - a survey the user already answered never takes another survey's turn.
- **At most two running surveys per user** (`SURVEYS_PER_USER`, 2). A user already in two
  earlier-launched running surveys they have not answered or dismissed is **queued** for a new
  one: not dropped, they get it later, the next time they do its steps after finishing one of
  those. The browser engine enforces it per user (clients and sample included). The person making
  the survey gets a ⚠ alert first in the `design_survey`, `save_survey` and `launch_survey` replies
  and on the Surveys page: which clients are queued, behind which surveys, and that stopping one of
  those frees them sooner. Whenever a survey's users are already in another running survey, even
  under the limit, the person setting it up gets a formal survey-fatigue notice with advice
  (narrow the clients, use a sample, or launch after the other one ends).
- **Questions**: `rating` (3, 5, 7 or 10 numbers, or emoji with 3 or 5), `nps` (0-10), `yes_no`
  (labels can change), `thumbs` (up or down), `open`, `single`, `multiple` (optional "Other").
- **Look**: `theme` `light` (white, ION blue) or `dark` (navy, amber), then any part: background,
  text, subtle text, button and its text, rating buttons and the chosen one, text boxes, border,
  `corner_radius`, `shadow`, `padding`, `font` (Reval's own or the system's), `position` (bottom
  right by default; also bottom left or centre, top or middle), `max_width`, submit label,
  thank-you heading and line, placeholder. Colours are solid (#rrggbb): PostHog derives text
  contrast from them. The footer reads `SURVEY_BRAND` ("Survey by ION"), 13px.
- Mistakes (a step with two kinds, an unsafe pattern, a colour that is not a colour) stop the save.
  Warnings (every client, more than 3 questions, poor colour contrast, a step that will fire very
  often) are shown to the person.

**Who may do what (Lens only).** Surveys are made, launched and read only in Lens:

- **PostHog's own survey screens and API are closed** (`SURVEY_UI_LOCK`, on). PostHog's proxy
  answers survey API calls only when they carry Lens's secret header (`POSTHOG_SURVEY_GATE`), so
  PostHog users, their personal API keys and PostHog's MCP server get "Surveys are managed in Lens";
  PostHog's Surveys screen sends people to the Lens Surveys page. PostHog's MCP key has no survey
  scopes, and the Lens proxy in front of it refuses survey commands. Reval's browsers are unaffected
  (they use PostHog's public survey endpoint). The installer checks the new proxy config with Caddy
  first and undoes it if the proxy does not answer with it.
- **Survey roles**, per person on the admin page, separate from the clip role: *See surveys and
  results*, *Also make and change surveys*, *Also launch and stop surveys*. Admins always have the
  last; a default applies to everyone else (*No access* unless changed). They apply on the Surveys
  page and in chat: a person sees only the survey tools their role allows.
- **Chat knows who asks** with a personal token from the **Connect chat** page (`/replays/connect`,
  shown once, stored as a hash, revocable there and on the admin page). The shared team token
  (`MCP_TOKEN`) cannot tell who asks, so it gets the survey role an admin picks (default *See
  surveys and results*).
- Not covered: survey answers are also PostHog events, so someone who can write SQL or browse events
  in PostHog can still read them. Only PostHog's Enterprise permissions could close that.

**Before a launch** (page and chat alike), the person sees the four rules of how this survey will
behave (who sees it and when; the fatigue limits and any overlap; × and ignored surveys; where the
answers go and how to stop it), gives the **Jira ticket** the launch is for (checked in Jira when Jira
is connected, else by its form), and ticks **"I acknowledge that this launches a survey that Reval
users will see, and that I have read the rules above."** The page's Launch button stays off
until both are done, and the server refuses a launch without them. In chat, `launch_survey` first
returns the rules and asks for the ticket and the acknowledgement, and only launches on a second
call with both. Each launch is recorded with who, the ticket, where (page or chat) and the rules
shown, and the page shows "Launched under REVAL-1234".

**The Surveys page** (`/replays/surveys`): every survey, made in Lens or in PostHog, with its status;
for each, the steps as a diagram, who sees it and how often, a likeness of how it looks, and the
results: steps completed, shown, answered, dismissed, answer rate, a chart per day, each question's
answers (rating spread, NPS, choices, recent written answers) and a table per client. **Launch**,
**Stop** and **Archive** are on the page, and **How many would have seen it?** counts past sessions.
Who sees it and who may press Launch and Stop follows the survey roles above. Every save, launch,
stop, role change and chat token is in the activity log.

**How it works.** Lens saves a PostHog survey whose `conditions.lensChain` holds the steps, the
clients, sample, one-at-a-time rule and the readiness rule, and whose trigger is the event `lens_chain:<id>`. The installer's
`surveys` step (`deploy/posthog/survey-engine/apply.sh`) serves PostHog's own `surveys.js` with two
changes: the footer reads `SURVEY_BRAND` instead of linking to PostHog, and the Lens chain engine
(`engine.js`) is appended. In the browser, the engine follows each running survey's chain from the
events the app already sends; when the last step happens and the page is ready it sends
`lens_chain:<id>`, and PostHog shows the survey at once. Clients are read from the user id
(`CLIENT_FROM_DISTINCT_ID`) or the client property. The engine keeps no storage, adds no requests,
refuses risky regular expressions and never stops PostHog's own surveys from working. It only reads
the browser storage posthog-js keeps (`seenSurvey_<id>`) to know a user has finished a survey.
Chains are version 3; a renderer from before client limits, samples or one-at-a-time refuses them
rather than show them to everyone.

- **Keys.** `POSTHOG_SURVEY_API_KEY` (made by `deploy/posthog/survey-engine/key.sh`, label
  `lens-surveys`) has survey read and write only, for the Lens project. Answers and counts are read
  with the normal read-only key.
- **Switches.** `SURVEY_ENGINE=off` at install serves PostHog's original renderer and turns
  `FEATURE_SURVEYS` off. `FEATURE_SURVEYS=off` removes the tools and the page.
- **Upgrades.** The step rebuilds from the new PostHog's original file every install. If the footer
  has changed shape, the build refuses, the original renderer is served and surveys keep working
  without Lens chains. It recreates PostHog's web container only when the served file changed.
- **The app's posthog-js** should be 1.268 or later. Older versions (Reval's 1.261.6) can abort
  their first `/flags` request and then never load surveys on that page.
- **Licence.** `surveys.js` is from posthog-js (Apache 2.0). The served file starts with the
  licence notice, says it was modified, and records the original's hash. PostHog's white-label
  setting needs an Enterprise licence and is not used.

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
anything is saved. In Claude Code it is `/mcp__lens__review_release 26.10.0`.

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

The client sees `lens` for this project's tools and `posthog` for PostHog's own server.
`LENS_MCP_NAME` changes the Lens name in `.mcp.json`, server metadata and routing text. It accepts
1–64 lowercase letters, digits or hyphens; `posthog` is reserved. The old `ticket-triage` entry is
outdated. Run `pnpm mcp:config` to replace it.

Two switches in `.secrets.env`, each `on` or `off` (both `on` by default):

| Switch | What it controls | When off |
| --- | --- | --- |
| `FEATURE_LENS_MCP` | this service's tools for Claude: replay links, tickets, clients, screens, releases | `/mcp` answers 503, the stdio server exits, `.mcp.json` leaves it out |
| `FEATURE_POSTHOG_MCP` | PostHog's own MCP server (needs `POSTHOG_MCP_URL` and `POSTHOG_MCP_API_KEY`) | `.mcp.json` leaves it out; the instructions stop sending Claude there |

After changing either:

```bash
pnpm mcp:config                      # rewrites .mcp.json (git-ignored: it can hold PostHog's key)
scripts/stack.sh restart service     # for /mcp and /posthog-mcp over HTTP
pnpm doctor                          # shows both switches and whether .mcp.json matches them
```

The rule that Claude never opens replays is in the instructions with either switch. The replay clip
page (`/replays`) is not an MCP server and is not affected. If someone connects PostHog's MCP server
to their own Claude by hand, these switches cannot stop that; use a PostHog key without replay scopes.

To connect Claude Code over HTTP:

```bash
claude mcp add --transport http lens http://<host>:8080/mcp --header "Authorization: Bearer <MCP_TOKEN>"
```

The local `.mcp.json` server has the same tools. It uses HTTP when Lens runs as a container
(`LENS_CONTAINER=1`), and stdio otherwise. Restart the client after changing the config.

## Layout

| Path | What |
| --- | --- |
| `src/core/` | Shared logic: resolution, incidents, usage, impact, silent issues, clips, clip comments, severity, report; `releases.ts` (release outcomes), `presence.ts` (time in the app), `db.ts` (SQLite) |
| `src/jira/` | Jira Cloud REST v3 client, webhook signatures, Markdown ↔ ADF |
| `src/service/` | The web service: webhooks, signed clip links, MCP over HTTP, `/replays`, the Live page, admin |
| `src/mcp/` | MCP tools and the stdio entry point |
| `demo-app/` | Acme Portal, the demo B2B app with a planted bug |
| `scripts/` | Setup, stack control, session generator, history seeder, Live page demo, rasterizer build |
| `vendor/` | PostHog's replay rasterizer and player page, prebuilt (`pnpm build:rasterizer` rebuilds them) |
| `deploy/install.sh` | Fresh install: PostHog, this service, the status page (answers: `deploy/install.env.example`) |
| `deploy/migrate/` | Upgrading an existing PostHog to the tested version, with backups |
| `deploy/posthog/` | PostHog's installer (pinned), scaling, load tests |
| `deploy/status/` | The status page |
| `deploy/offline/` | the three scripts for a machine without internet: `build-images.sh` (every image into your ECR), `fresh-install.sh`, `upgrade.sh`; `ecr.sh`: the machine takes images from there; `no-internet.sh`: outside calls fail at once ([README](deploy/offline/README.md)) |
| `deploy/lens/` | PostHog Lens as a container: `Dockerfile`, `lens.sh` (serve, doctor, mcp-config, test), Chrome's seccomp profile |

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

Nothing else: the script installs Docker and PostHog, and runs PostHog Lens as a container (built on
the machine, or taken from your ECR). **Without internet**, use the three scripts in
[deploy/offline/README.md](deploy/offline/README.md): `build-images.sh` on a machine with internet, then
`fresh-install.sh` or `upgrade.sh` on the machine itself (no `git clone` there).
With internet, log in as `ec2-user`, then:

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
`app_version` and `email`, Jira not connected, Claude reading off, both MCP servers on (PostHog's
runs on this machine, with a key that cannot reach replays), and the status page on
this machine only. Session recording works on every site that sends events. To set APP_URLS (which
limits recording to your app's addresses) or change any other default, fill in a copy of
`deploy/install.env.example` and run `sudo deploy/install.sh --config my-install.env`. Add `--yes`
to ask nothing. To add an address later, run the installer again with the longer list: only the
addresses change, and the data is kept.

**A machine that already runs a self-hosted PostHog** (for example production on the 2025 version):
stop the apps that send events, then run the same `sudo deploy/install.sh`. It finds that PostHog and
upgrades it in place, on top of its own data, instead of installing a new one (`deploy/migrate/`, full
backup first, about 2 hours). The questions are the same two, preset from that PostHog (its address,
its first admin), plus one: whether to copy the session replays now. Lens then uses the current project
of that login. The upgrade's backup stays until you delete it with `deploy/migrate/posthog-upgrade.sh
cleanup` (see [deploy/migrate/README.md](deploy/migrate/README.md)).

It installs PostHog at the exact version tested here (every image pinned by digest), tunes it for
load, creates the login and a read-only API key, writes `.secrets.env`, runs the service under
systemd (`ticket-triage.service`, starts at boot; the `posthog-lens:current` container through
`deploy/lens/lens.sh`), starts the status page, writes `.mcp.json` and ends with
`sudo deploy/lens/lens.sh doctor`. Every step checks its result. If one fails, fix it and run the same command
again: finished steps are skipped. The closing summary (`sudo deploy/install.sh status` shows it again)
has everything you need next: addresses, where each password and token is, the snippet for your app,
and how to connect Jira and Claude.

### A machine without internet

Where the machine cannot reach the internet, every call PostHog, its MCP server or this service would
make to it is refused at once, instead of hanging on DNS or on a connection that never answers.
`deploy/install.sh` sets this up by itself when it cannot reach the internet (`NO_INTERNET=auto`), on a
fresh install and on an upgrade; `NO_INTERNET=yes` or `no` forces it. By hand:

```bash
sudo deploy/offline/no-internet.sh apply    # set it up (again)
sudo deploy/offline/no-internet.sh check    # outside calls refused in milliseconds, inside ones working
sudo deploy/offline/no-internet.sh remove   # undo it
```

1. **Names.** The hosts PostHog and these tools call by themselves point to `0.0.0.0` in `/etc/hosts`
   and inside every PostHog container. Examples: PostHog's usage reporting (`us.i.posthog.com`, seen
   every few minutes on a running install), billing, the GeoIP download, GitHub and npm. No DNS lookup
   happens, and the connection is refused at once.
2. **PostHog's switches.** Usage reporting is off (`OPT_OUT_CAPTURE`), and billing points at a closed
   port.
3. **A firewall for everything else.** Containers and this service's user get an immediate refusal
   for any public address. Private networks stay open, and so does `NO_INTERNET_ALLOW` (e.g. an
   in-house Jira on a public IP). The machine's own traffic (docker pulling from ECR, dnf through the
   S3 endpoint) is not touched. `posthog-no-internet.service` puts the rules back after a reboot or a
   docker restart.

`deploy/migrate/posthog-upgrade.sh` keeps all of it and extends it to the new version's services.
Downloads the install scripts make (GeoIP, buildx) give up within seconds. With the kit
([deploy/offline/README.md](deploy/offline/README.md)) there are none: images come from your ECR,
and PostHog's source, the GeoIP database and Docker Compose come from the kit.

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

### Connecting GitHub Copilot (for PMs)

Each person opens **Chat** in Lens and clicks **Connect Copilot**. Lens makes their personal key and
shows two buttons, **Add Lens to VS Code** and **Add PostHog to VS Code**. Each opens VS Code, which
asks to install the server. One key serves both (`/mcp` and `/posthog-mcp`), and Copilot gets that
person's access. Then: Copilot Chat → Agent mode → ask. On Copilot Business or Enterprise, the
organisation must allow the "MCP servers in Copilot" policy. The page also gives a hand-made
`mcp.json` (key kept in VS Code's secret storage) and the Claude Code commands.

### Using PostHog's MCP server next to this one

Claude Code and GitHub Copilot can connect both servers at once. Routing rules lead the Lens
instructions and each tool description starts with the business question it answers.

Use `lens` for a named Reval client, trade or link id, dialog, screen, button, error message,
one session, Jira ticket, release outcome, where clients struggle or who is at risk. Use
`posthog` for generic product analytics and PostHog objects: trends, funnels, retention,
insights, dashboards, flags, experiments, surveys, cohorts, annotations, actions and event
definitions, error issue management, warehouse and batch exports, docs, SDK help and raw SQL.
Lens tools take JSON arguments directly. PostHog has one tool, `exec`, taking a command string.

`POSTHOG_MCP_VIA_LENS=on` is the default. When the Lens service runs (`LENS_CONTAINER=1` or
`MCP_TOKEN` set), `pnpm mcp:config` points `posthog` at
`http://127.0.0.1:<SERVICE_PORT>/posthog-mcp` with `Bearer MCP_TOKEN`. The service forwards to
`POSTHOG_MCP_URL` using `POSTHOG_MCP_API_KEY`; the client does not receive PostHog's key.
The proxy prepends Lens routing rules to PostHog's instructions and `exec` description, and
refuses `exec` commands that would open replays (`session-recording-*`, `vision-*`). It
supports JSON, SSE, batches and MCP sessions, limits bodies to 5 MB and times out after 30 seconds.
It refuses replay and Vision commands. Replay links always come from Lens's `get_replay_link`;
the agent never sees replay content. `pnpm doctor` checks that the proxy answers with these rules.

With `POSTHOG_MCP_VIA_LENS=off`, or with local stdio and no HTTP token, the client connects to
PostHog directly with its key. PostHog then has no Lens routing additions or proxy refusal.
Give PostHog its own personal key without `session_recording` scopes (`POSTHOG_MCP_API_KEY`);
`pnpm doctor` fails if that key can read replays. Keep that restriction in either mode.

To inspect the text an LLM sees from both servers:

```bash
pnpm tsx scripts/routing-catalog.ts /tmp/routing-catalog.json
```

The script lists server names, instructions and tool names/descriptions. It uses an in-memory
Lens client and applies the proxy rewrite to PostHog's captured fixture. If `POSTHOG_MCP_URL`
is set, it reads PostHog live instead. Set `APP_EVENTS_FILE=config/app-events.reval.json` to
include the Reval tools. Omit the output path to print JSON.

`deploy/install.sh` sets this up on its own: `deploy/posthog-mcp/up.sh` runs PostHog's MCP server
(PostHog's image, pinned by digest) on `127.0.0.1:8787` and makes its key. The key is read-only and
limited to the Lens project. It has no scope for recordings, playlists, Replay Vision, signals,
exports (they can hold recording videos) or sharing links (they can open recordings). PostHog's
server then offers no replay tools at all. Its SQL tool can still read replay metadata (the
`session_replay_events` table: counts, durations, first URL), as the Lens key can. Replay content is
never reachable.

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
  7 days). `/mcp`, `/posthog-mcp` and `/status` need `MCP_TOKEN`.
- Recordings are untrusted content. The renderer's Chrome can only resolve the hosts in
  `CLIP_ALLOWED_HOSTS`, and every other hostname fails to resolve. This replaces PostHog's
  production egress proxy. Two gaps remain: it does not stop a URL with a literal IP, and
  stylesheets are fetched by the rasterizer's Node process. For production, run the renderer
  behind an egress proxy (`HTTPS_PROXY`) or in its own network namespace.
- The PostHog API key is read-only and scoped to one project.
- Everything here runs over plain HTTP on a public IP, which is fine for a demo of invented data.
  Put it behind HTTPS (a domain, so the hobby installer gets a certificate) before it touches
  real client data.
