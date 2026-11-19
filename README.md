# PostHog Lens

PostHog Lens is an internal tool for ION product managers and account teams. It sits next to a
self-hosted PostHog that records how clients use Reval, and turns those events and session replays into
answers: which clients need attention, where people struggle, what changed after a release. Everything
runs on one machine, which can be fully offline.

People use it in two ways:

- **In the browser**, at `http://<server>:8080/`, signed in with their PostHog account.
- **In chat**, from GitHub Copilot, through Lens's MCP server. Each person creates their own key on the
  Chat page.

Installing and upgrading are covered step by step in [SETUP.md](SETUP.md).

## What it does

| Page | What it answers |
|---|---|
| Replay clips | Turn a replay into a short MP4 clip to share, with expiring signed links |
| Watchlist | For chosen clients, every new replay as steps: hovering, pauses, back-and-forth, failed submits, slow answers, with links to the moment |
| Live | Who is in Reval now, and each client's active and idle time per day and hour |
| Dashboards | Monday briefing, Rescue Queue, Client Task Map, Flow time, Scorecard, Client story, pinned charts |
| Surveys | Short in-app surveys for chosen users, with launch safeguards |
| Chat | Personal keys for Copilot |
| System | Health of PostHog, Lens and the machine |
| Admin | Who may see what, client outcomes, clips, activity, and client privacy (codenames) |

Copilot gets the same answers through about 40 MCP tools, for example `client_experience`, `rescue_queue`,
`client_story`, `task_map`, `watch_highlights` and `session_moments`. Access follows the same roles as the
pages: an admin grants replay insights, dashboards and surveys per person.

## Privacy

- Replays never leave the machine. Lens reads their structure only: which control was used and when,
  never typed values, screen text or pointer positions. Copilot gets rounded timings, counts and links,
  and a person opens the replay in Lens.
- Clients can be shown to AI by numbered codename only (Admin → Client privacy).
- Every sign-in, clip, change of access and chat tool call is written to the audit log.

## How it is built

```
src/core      what Lens knows: PostHog queries, task history, replay reading, rescue queue, surveys
src/mcp       the MCP server and its tools
src/service   the web pages and their APIs (server-rendered HTML, no framework, no outside assets)
deploy        install and upgrade scripts: PostHog (pinned), Lens, Kafka tuning, offline kit
test          the test suite (node:test)
config        Reval's event dictionary (app-events.reval.json)
```

- **Runtime:** Node 24, TypeScript run directly by `tsx`, SQLite for Lens's own data (`run/`), and
  PostHog's API and HogQL for everything else.
- **Deployment:** Docker. `deploy/offline/build-images.sh` builds every image on a machine with internet
  and runs the full test suite inside the Lens image; `save-images.sh` packs them into one file;
  `upgrade.sh` or `fresh-install.sh` installs them on the offline machine.
- The build works from a git checkout or from a plain copy of the folder (a downloaded zip, or a clone
  whose `.git` was removed).

## Developing

```bash
pnpm install                 # once
pnpm typecheck
pnpm test                    # the whole suite
pnpm service                 # the web service on SERVICE_PORT, settings from .secrets.env
```

Settings come from the environment, with `.secrets.env` filling anything unset. `.env.example` lists
every setting with a comment. The ones most often changed:

| Setting | Default | Meaning |
|---|---|---|
| `POSTHOG_HOST`, `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` | | where PostHog is and how Lens reads it |
| `APP_EVENTS_FILE` | | the app's event dictionary (`config/app-events.reval.json`) |
| `FEATURE_LENS_MCP`, `FEATURE_SURVEYS`, `FEATURE_JIRA` | | turn chat, surveys and Jira on or off |
| `TASKS_HISTORY_DAYS` | 1500 | how far back task history goes |
| `TASKS_BACKFILL_DAYS_PER_RUN` | 20 | days of history rebuilt every 10 minutes |
| `WATCHLIST_DAYS` | 14 | how far back the Watchlist reads replays (at most 90) |
| `WATCHLIST_PER_RUN` | 30 | replays read every 10 minutes |
| `WATCHLIST`, `REPLAY_SIGNALS` | on | `off` stops the background replay reading |
| `TEST_TIME_SLACK` | 1 | widens the speed limits in tests (the image build uses 3) |

On an installed machine, settings are changed as described in SETUP.md (“Changing a setting”).

## Upgrading an older PostHog

`upgrade.sh` upgrades a self-hosted PostHog in place, including installs from 2025. It backs everything
up first, moves Postgres 12 to 15, runs the extra migration older databases need, moves stored files
from MinIO to SeaweedFS, and copies 2025 replays so they still play. Then it checks every count against
the backup and prints `RESULT: PASS`.

- PostHog is down for 2 to 3 hours, longer with many replays.
- Apps can keep sending events. Events sent while PostHog is down are lost unless the sender retries.
- `sudo posthog-lens rollback` returns to the backup. It refuses to start if the backup did not finish.
- `sudo posthog-lens cleanup` deletes the backups once you are satisfied.
