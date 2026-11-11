Lens tuning for the hobby stack
==============================

Run `POSTHOG_DIR=/opt/posthog deploy/posthog/tune.sh` on the host. The installer
runs this after the survey engine/lock, with `TUNE=on` by default. `TUNE=off`
skips the step and leaves existing tuning in place. Use `tune.sh --undo` to
remove it, `--status` to inspect it, and `--dry-run` to preview calculated values
without Docker. Settings are documented in `deploy/install.env.example` and can
come from the install config, environment, or PostHog's `.env`.

The override is registered in both COMPOSE_FILE and EXTRA_COMPOSE_FILES, so the
existing scale/upgrade scripts retain it. Applying/undoing recreates web,
clickhouse, and proxy; plan a maintenance window. Unchanged reapplication does
not restart services. A lock prevents concurrent tuning operations. Existing
files and .env are saved before mutation and restored if validation, recreation,
or the health deadline fails. The default health deadline is 1500 seconds.

The changes and their limits
---------------------------

* Static assets: upstream /static responses currently have short cache lifetimes.
  Fingerprinted filenames (8–64 hex characters separated by a dot or hyphen)
  receive `public, max-age=31536000, immutable`, including compressed variants and
  source maps. Non-fingerprinted assets, notably surveys.js, keep their original
  policy. No route, encode directive, or file_server configuration is replaced.
  Conservative matching deliberately misses unfamiliar fingerprint formats.
* Survey compatibility: a proxy command overlay transforms the EFFECTIVE
  CADDYFILE at startup, then appends CADDY_EXTRA_CONFIG, exactly like the hobby
  entrypoint. It does not override CADDYFILE. The survey lock's 403 matcher/gate
  and /project/*/surveys redirect survive reapplication in either order. The
  existing survey script can still validate and regenerate its own environment
  override. A missing recognizable site block is a preflight error.
* Web memory: PostHog's docker-server delegates GRANIAN_* variables to the
  Granian CLI. Defaults are two workers below 32 GiB total RAM, three at/above
  it, with worker lifetime recycling every hour. Fewer ~1.6 GB workers should
  reduce memory pressure, at the cost of maximum simultaneous request capacity.
  Recycling costs startup CPU. Current Granian has lifetime/RSS controls, not a
  max-requests control; the installed image must advertise --workers-lifetime.
* ClickHouse: separate config.d/users.d files merge with the upstream hobby
  files, preserving Kafka, storage, access, cluster, and ingestion settings.
  Default per-query tracked memory is 128 MiB (134,217,728 bytes), threads two,
  block rows 8192, sort/group spill 24 MiB. Independent spill ratios are derived
  from spill/server budgets: HogQL explicitly sets the absolute group-by setting
  to zero on some versions, so an absolute profile default alone is insufficient.
  Mark cache is 64 MiB; uncompressed cache 16 MiB. The total tracked server budget
  is RAM/8, bounded to 768–1536 MiB, and also limited by a RAM ratio of 0.25.
  These are tracked-memory limits, not hard RSS/cgroup limits. Some allocations
  are untracked and a block can overshoot: live measurement is still required.
  Hard profile constraints prevent requests raising query memory/threads or
  disabling those limits with zero. Explicit SETTINGS outside these constraints
  fail rather than silently bypassing the budget. Large joins, huge single
  aggregate states, and ingestion/migrations may need higher overrides; spill
  only helps algorithms that support it, and consumes disk I/O/space. No partial
  result overflow modes are enabled.
* Lens HTTP: complete HTML/JSON bodies from 1 KiB through 4 MiB use asynchronous
  Brotli/gzip quality 4 according to Accept-Encoding weights. Identity fallback,
  Vary, lengths, and weak ETags are handled. SSE headers/writes/flushes, streaming
  responses, ranges, media, precompressed content, HEAD, and no-transform bypass
  compression. Keep-alive is 65 seconds with a 70 second header timeout. Lens has
  no static bundle to give an immutable asset policy; the favicon keeps its day
  cache. Authenticated pages/results retain their existing cache policy. No
  HTTP answer cache or prewarming is added in this scope.

Validation
----------

Before recreation the script checks Compose configuration, validates the actual
merged Caddyfile using the installed proxy image, checks installed Granian's
CLI, and parses merged server/users XML with the installed ClickHouse binary.
These parsers are not a substitute for runtime compatibility checks: afterward,
ClickHouse must execute SELECT 1, web must answer its internal /_health endpoint,
and the running proxy must validate its effective Caddyfile. Failure restores
previous files/compose state and recreates the previous services.

Offline checks: `python3 deploy/posthog/test-tuning.py` exercises dry-run scaling,
XML/argument validation, lock preservation, idempotence, undo, preflight refusal,
failed recreation rollback and failed health rollback with a fake Docker runner.
`test/perf-http.test.ts` exercises HTTP compression and native Node framing
without listening sockets. Live query memory, response timings, real Caddy
validation, and ingestion behavior must be measured on the target host.

Public source references (no ee/ sources used)
----------------------------------------------

* [PostHog docker-server](https://github.com/PostHog/posthog/blob/master/bin/docker-server)
* [Hobby Compose ClickHouse mounts](https://github.com/PostHog/posthog/blob/master/docker-compose.hobby.yml)
* [Base Compose proxy command](https://github.com/PostHog/posthog/blob/master/docker-compose.base.yml)
* [ClickHouse server config](https://github.com/PostHog/posthog/blob/master/docker/clickhouse/config.xml)
* [ClickHouse user profiles](https://github.com/PostHog/posthog/blob/master/docker/clickhouse/users.xml)
* [HogQL settings defaults](https://github.com/PostHog/posthog/blob/master/posthog/hogql/constants.py)
* [Granian CLI recycling settings](https://github.com/emmett-framework/granian/blob/master/granian/cli.py)
* [ClickHouse external aggregation thresholds](https://github.com/ClickHouse/ClickHouse/blob/master/src/Interpreters/Aggregator.cpp)
