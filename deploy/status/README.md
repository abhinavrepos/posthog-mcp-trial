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

- `GET /api/status`: the same as JSON
- `GET /healthz`: `200 ok` or `503 N problem(s)`, no details and no password, for an uptime monitor

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
