# Status page

One small image (`posthog-lens-status`) with one page that says whether everything is up: PostHog,
this project's processes, data arriving, every container, and the machine.

```bash
deploy/status/up.sh          # build and start; the page is at http://127.0.0.1:8090/
deploy/status/up.sh down     # stop it
```

| Section | What is checked | Down when |
| --- | --- | --- |
| PostHog | the app through the proxy, web, event capture, replay capture, feature flags, the replay reader, ClickHouse (their health endpoints) | no answer in 8 s, or an error |
| Lens | the triage service (and which of its switches are on: Lens MCP, PostHog MCP, Claude reading tickets), demo app | no answer |
| Data arriving | events in the last 5 minutes and hour, and when the newest arrived; replay metadata updates in the last hour | only with `STATUS_MAX_EVENT_AGE_MINUTES` set and no event for that long |
| Containers | every container of the PostHog compose project: running, health, restarts in the last 15 minutes | stopped, crashed, restarting or unhealthy (warning: starting, or restarted recently) |
| Machine | free disk, memory, load | disk under 10% free (warning under 20%), memory under 5% (warning under 10%) |

Checks run every 15 seconds. The page refreshes itself. Problems show first, with how long they have
lasted; long lists fold what is fine.

- `GET /api/status`: the same as JSON, plus the numbers behind PostHog Lens's System page (below)
- `GET /healthz`: `200 ok` or `503 N problem(s)`, no details and no password, for an uptime monitor

## The System page in PostHog Lens

Admins, and anyone an admin ticks **System page** for on Lens's admin page, can see all of this, with
more numbers, without a tunnel: the **System** tab in PostHog Lens
(`http://<server>:8080/replays/system`, signed in with PostHog). The tick is separate from the clip
role, so someone can see the System page with no access to clips. It adds CPU and memory for the
machine and each container, events per hour for 24 hours, people, recordings, ingestion warnings and
ClickHouse's size. Lens reads this page's `/api/status` from `STATUS_URL` (`http://127.0.0.1:8090`).
Everything on it is a count or a time; no event or replay content is read.

## Seeing it from your computer

It listens on 127.0.0.1 only. Either use an SSH tunnel:

```bash
ssh -L 8090:127.0.0.1:8090 root@<server>      # then open http://localhost:8090/
```

or open it to the network with a password:

```bash
cp deploy/status/status.env.example deploy/status/status.env    # set STATUS_PASSWORD in it
STATUS_BIND=0.0.0.0 deploy/status/up.sh                         # http://<server>:8090/
```

`up.sh` refuses a public address without a password: once the port is published, only the EC2
security group decides who reaches it. Open 8090 there only for the addresses that need the page.

## What it can see

- **Containers:** through the Docker socket, GET requests only. Whoever controls this container could
  use the socket for more, so it runs as an unprivileged user, with no capabilities, on a read-only
  file system.
- **ClickHouse:** counts and times only, in read-only mode (`readonly=1`: any write is refused). It
  never reads an event's or a replay's content.
- **The disk:** only the free space of the folder it is given (`/var/lib/lens-status`).

Settings are in `status.env` (see `status.env.example`): password, title, the compose projects to watch,
the interval, the list of endpoints, and an optional alarm when events stop arriving.

## System page numbers

The Lens System page puts problems first, then resource tiles and charts, services, ClickHouse,
searchable expandable containers, recent changes and server information. It warns when the last
check is over 60 seconds old; the age ticks even if refreshes fail.

| Area | Numbers and detail |
| --- | --- |
| Containers | Running / expected (finished one-time jobs excluded), unhealthy/restarting/stopped counts; image, start time, OOM, stopped exit code, memory limit and usage %, network rx/tx, block reads/writes, PIDs, last unhealthy check output (300 characters); CPU/memory hour sparklines and top five views |
| Machine | CPU, memory, swap used/total, disk used/free, load, cores and uptime; hour history of CPU, memory, disk-used % and load |
| ClickHouse | Version, uptime, running queries (excluding the monitoring query), merges, pending mutations, largest active partition part count (warning >300, problem >1000), eight largest tables with bytes and rows |
| Data arriving | Events per minute for 60 minutes and per hour for 24 hours; existing recent counts, people, recordings, ingestion warnings and total ClickHouse bytes |
| Recent changes | Last 100 observed check-level transitions with time, newest first; held in memory |
| About / Docker disk | PostHog web image, ClickHouse and Docker versions, status-service uptime, interval and last check duration; image layer, container writable layer, volume and build cache bytes |
| Lens activity | Last 24 hours of sign-ins, failed sign-ins, clips created/viewed/downloaded and share links; clip count/bytes and saved clip count/bytes, read locally by Lens |

Docker inspect/stats calls run concurrently with a three-second deadline per call. ClickHouse
queries have a 2.5-second deadline and independent failures; unavailable numbers show as “–”.
Large counts, table/partition sizes and the quiet-system 30-day newest-event lookup are cached for
five minutes; Docker disk usage is cached for ten minutes. Event charts show the window at their
last collection, rather than turning uncollected minutes into zeroes. Versions and small ClickHouse
health queries refresh each cycle. CPU is a share of the entire machine; memory excludes reclaimable
file cache, and limits come from Docker's configured hard limit (zero means unlimited). Histories
cover an hour at the configured check cadence and reset on restart. Checks do not overlap; the
configured interval is the pause between cycles.

The status JSON adds `changes`, `about`, container detail/history fields, and `metrics.clickhouse`,
`metrics.docker_disk`, `metrics.events_by_minute`, `metrics.extras_at` and swap/disk fields in
`metrics.machine`. Machine history tuples retain their first three entries and append disk-used %
and one-minute load: `[time_ms, cpu_pct, mem_pct, disk_used_pct, load_1]`. Container history tuples
are `[time_ms, cpu_pct, mem_bytes]`. Docker disk and extras timestamps are Unix milliseconds.
`/replays/system/api` additionally supplies `lens`; `/api/status` on port 8090 never reads Lens's
database. Lens activity uses up to 100,000 audit rows in the last day and explicitly marks counts
as lower bounds if this limit is reached. Audit identities/details and per-person storage are never
included in the response. A database failure leaves the other status data available.

## Alerts

Set `STATUS_ALERT_WEBHOOK` in `status.env` to a Teams Workflows webhook ("When a Teams webhook request is
received"), a Slack incoming webhook, or any URL taking `{"text": "..."}`, then run
`sudo posthog-lens alert-test`. A check that stays at a warning or down for `STATUS_ALERT_AFTER_MINUTES` (5)
sends one message, again if it gets worse, and once more when it is fixed. Low memory or disk, restart loops,
endpoints not answering and (with `STATUS_MAX_EVENT_AGE_MINUTES`) events no longer arriving all alert. The
machine must be able to reach the webhook's address. The System page in Lens shows whether alerts are on and
when the last one went out.

