# Company server upgrades and repair

Run commands from the unpacked kit's Lens folder. Do not patch files under `LENS_DIR`: the next kit replaces tracked files there. Keep the upgrade backup and old MinIO until replay verification succeeds.

## Persistent settings

- `/etc/posthog-lens/posthog-lens.env` (root, mode 0600): operator settings. These override kit site defaults, explicit installer config, previous installer answers, and `.secrets.env`. Set `CLIENT_FROM_DISTINCT_ID=3`, `DISTINCT_ID_SEPARATOR=|`, and `APP_EVENTS_FILE=config/app-events.reval.json` for Reval. Run `sudo posthog-lens update <kit>` after changing settings; editing CONF alone does not change a running container.
- `deploy/offline/sites/<hostname>/site.env`: defaults shipped inside a kit. `dqposthog01/site.env` contains the four addresses and Reval settings. They apply on updates even if an older setup did not record `SITE=`. CONF takes precedence.
- `$POSTHOG_DIR/docker-compose.site.yml`: preserved PostHog environment, trusted origins, redirect/cookie settings and Caddy addresses. It is added to both `COMPOSE_FILE` and `EXTRA_COMPOSE_FILES`. The helper uses JSON, which Docker Compose accepts as YAML. An existing hand-written YAML site file is retained as `docker-compose.site.saved.yml`, an earlier Compose layer. Files may contain secrets and remain mode 0600; they are Compose inputs, not container mounts.
- `/etc/posthog-lens/posthog-mcp.override.yml`: optional persistent MCP Compose override. `up.sh` automatically loads it after the kit's MCP Compose file. Updates rescue an existing kit-local MCP override to this path before unpacking (without replacing an existing persistent override). `docker-compose.api.yml` applies the explicitly selected API address last, so an old override cannot silently restore the public HTTPS upstream. Do not put manual changes in `deploy/posthog-mcp/docker-compose.override.yml`. Keep the upstream API on `http://web:8000`; public HTTPS is for links. The CA mount remains available for other HTTPS traffic.
- Custom event/screen files can live outside the kit, e.g. `/etc/posthog-lens/app-events.json`. Set the corresponding absolute `APP_EVENTS_FILE`/`SCREENS_FILE` in CONF. Lens mounts these files read-only, with access restricted to its service uid. Kit-owned `config/app-events.reval.json` remains the supported Reval default.

Do not source `site.env` as shell code: `DISTINCT_ID_SEPARATOR=|` is a dotenv value. The installer parses it as data.

## Normal update

```bash
sudo posthog-lens update <kit>
sudo posthog-lens status
sudo posthog-lens check 20
sudo posthog-lens doctor
```

A standalone `posthog-upgrade.sh` only upgrades PostHog. Its completion message tells the operator to run `sudo posthog-lens update <kit>` to install/start Lens. Rerun the same update command after interruption; completed migration phases are retained.

## Repair an already upgraded server

With the new kit unpacked, point at the actual PostHog folder (not the Lens folder):

```bash
sudo POSTHOG_DIR=/path/to/posthog bash deploy/offline/post-upgrade-repair.sh
# Same changes without interactive questions (including replay copy if unfinished):
sudo POSTHOG_DIR=/path/to/posthog bash deploy/offline/post-upgrade-repair.sh --yes
```

The script asks before preserving/restoring addresses (including those in the old install archive), rebuilding every team's RemoteConfig, applying persistent Lens settings, restarting MCP on internal HTTP, and copying unfinished replays. It waits for PostHog after a restart and finishes with the server checks, including if a repair action fails. A failed action remains a failing exit status. Repair uses installed images; it does not install packages or pull an MCP image. If Lens was never installed, repair reports this and `sudo posthog-lens update <kit>` is still necessary.

`dqposthog01` gets HTTPS on `c1devposthogadmin.reval.com`, `c1devposthog.reval.com`, `c1devph.reval.com` and HTTP on `10.10.128.206`. Both schemes for every address are trusted CSRF origins. Any configured HTTP address disables secure-only login cookies. An HTTP Caddy catch-all also permits local health and internal config.js checks. Lens binds port 8080 on all interfaces; host/load-balancer firewall access must permit it.

PostHog's documented `DISABLE_SECURE_SSL_REDIRECT=true` allows MCP's internal HTTP requests even when public links use HTTPS. See [PostHog proxy configuration](https://github.com/PostHog/posthog.com/blob/master/contents/docs/self-host/configure/running-behind-proxy.md). `up.sh` discovers the running web container's network and probes health and the API from that container; an HTTPS redirect repairs this setting and waits for web to restart. It fails with an actionable message if internal HTTP remains unavailable.

## Checks and local verification

`check` waits for service readiness, then runs the same checks as `doctor`. Each reports PASS/FAIL and a one-line fix: 8080 binding, Lens health, sampled clients, events config, MCP node fetch, MCP initialize and `posthog_exec tools` through Lens, every team's config.js, all CSRF origins, nonzero session recordings with a replay block fetch, an authenticated live endpoint request, and direct HTTP health with cookie settings checked in Django. It never prints API tokens or sampled event contents. The live check signs in using the stored admin credentials and signs out afterward; two-factor-only accounts require operator investigation.

```bash
python3 -m unittest discover -s deploy/offline -p 'test_*.py'
node --import tsx --test test/install-permissions.test.ts test/offline-upgrade.test.ts
```

The Python suite uses fake folders/Compose responses and no running services. `site-config.py <folder> --fixture` is only for simple test YAML, not production recovery. Real-server checks require Docker, the installed PostHog/Lens images, existing API/admin credentials, data, and network access. A local listening socket cannot prove that a remote firewall allows access.

## Permission audit

`public-mount-permissions.py` repairs the public Compose scripts, GeoIP/share files, PostHog Docker configuration, ClickHouse IDL/user scripts, and tuning assets before they are mounted. It handles directories and executable files under `umask 077`. The patched storage copier stays 0644; copied Python maintenance scripts are made 0644 inside web. Import maintenance containers use uid 0 to read private bundles and write migration state. Lens owns its private settings and writable data; its config directory and external event/screen mounts are explicitly readable by the service uid. The survey renderer's three individual file mounts are 0644. Compose input files are read on the host and remain private; they are not bind-mounted into application containers.

## Verification in the development environment

The 14 Python tests include fake old Compose/`.env` recovery, repeated edits, precedence, Reval detection, private-umask permissions, mixed addresses, baked Caddy site headers, RemoteConfig module fallback and per-team delivery, and real Compose CLI merges (no daemon or image pulls). The MCP test applies a legacy public HTTPS override and confirms the final API remains internal HTTP. Bash syntax, Python parsing, ShellCheck errors, and `git diff --check` pass.

The requested Node tests were attempted with `node --import tsx --test`. This environment reports `spawnSync ... EPERM` for child processes. A diagnostic run with `--test-isolation=none` passed 25 tests; 8 encountered that restriction. Docker daemon access is denied here, so live Caddy/TLS/cookies, team config delivery, event/client queries, MCP execution, replay reads and live-page requests must be verified with `sudo posthog-lens doctor` on the server. No packages or images were installed for verification.
