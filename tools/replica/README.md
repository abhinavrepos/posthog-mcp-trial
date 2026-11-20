These tools populate the existing self-hosted PostHog at `/opt/posthog` with a Reval-shaped year and 60 playable rrweb recordings. Run on the Docker host, from the repository root. Nothing is installed. Requires existing Python 3, curl, Docker Compose, and the repository's Node/tsx/TypeScript tools. No commits are made.

## Operator commands, in order

1. Create or reuse the project. The script prints `REPLICA_PROJECT {"team_id":...,"api_token":...}`. It enables session recording and fails if the organisation/project is ambiguous.

   ```bash
   tools/replica/project.sh
   # If there are multiple organisations:
   # REPLICA_ORGANIZATION_ID=<existing-organisation-uuid> tools/replica/project.sh
   ```

2. Use the printed values below. The token is a project capture token; API readback additionally requires a personal API key with access to this project, or the admin credentials.

   ```bash
   export TEAM_ID=123                         # replace with printed team_id
   export POSTHOG_PROJECT_API_TOKEN=phc_...    # replace with printed api_token
   export POSTHOG_PERSONAL_API_KEY=phx_...     # existing personal API key
   # Alternative to the personal API key:
   # export POSTHOG_ADMIN_EMAIL=admin@example.com
   # export POSTHOG_ADMIN_PASSWORD='...'
   ```

3. Copy the year, then verify. Expect approximately 97 million rows; runtime depends on host capacity. These commands only write to the selected team in PostHog. The source receives SELECT queries only.

   ```bash
   tools/replica/load-year.sh "$TEAM_ID"
   tools/replica/verify-load.sh "$TEAM_ID"
   ```

4. Record the sessions, then read every recording back through the API. Allow up to 20 minutes for replay storage to drain. All sessions must pass completeness checks; otherwise the command exits nonzero.

   ```bash
   node_modules/.bin/tsx tools/replica/record-replays.ts --team "$TEAM_ID"
   # It is safe to repeat either verification:
   tools/replica/verify-load.sh "$TEAM_ID"
   node_modules/.bin/tsx tools/replica/record-replays.ts --team "$TEAM_ID"
   ```

   The recorder prints a TSV table with session ID, client, user, screens, outcome, and replay URL. It writes `tools/replica/replays-manifest.json` at runtime, containing the exact events, expected rrweb events, send receipts, and verification results. This is an operator/grader artifact, never product/agent content. It contains no API keys or passwords. Keep it for safe reruns; do not delete it to retry.

## Loading and recovery

The first load freezes 365 UTC calendar dates ending with the source's maximum event date (inclusive), saved in `.state/team-<id>.json`. This includes the latest day's available rows, even if that day is partial. Subsequent invocations use this same window. Stop source writers while loading/verifying if the lab is changing; exact equality requires a stable source. Earlier titles are REVAL 26.1.0 / 26.2.0; the final 60 calendar days use REVAL 27.0.0.

Three worker lanes stream one day each directly from HTTP Native output into `docker compose exec -T clickhouse clickhouse-client`. Both processes' exit statuses are checked. Target insertion uses a 1,500,000,000-byte memory cap and `max_insert_block_size=20000`; source blocks also use `max_block_size=20000`. Each day gets at most three attempts. Every attempt first deletes that team's day with `mutations_sync=2`, so a failed/partial insert is removed before retry. A day enters the atomic resume file only after its exact count matches. The target's actual column types are read first and used as explicit Native-output casts.

The loader fills missing active `person_distinct_id2` and `person` keys with one INSERT SELECT per table, grouped by distinct ID. Copied events and their mappings share a deterministic UUID derived from the rewritten distinct ID. Existing active person keys are excluded on reruns. One team lock prevents concurrent loads/verifications. A disk watchdog runs during streaming: under 25 GiB available on the PostHog filesystem stops the pipeline and leaves the day pending. Initial checks also guard project creation and replay capture. Active ClickHouse operations can briefly continue while being cancelled.

If interrupted or unsuccessful, rerun `load-year.sh` with the same team ID. A failed verification prints every day mismatch, marks those days pending, and exits nonzero; rerun loading to repair them. Existing completed days are skipped, then all 365 counts are checked again. Known replay normal-event UUIDs from the matching manifest are excluded from historical count comparisons and preserved during day repairs. Thus verification still requires **exact equality** after recording; it never uses tolerances or estimated counts. Keep the manifest alongside the resume state. Do not run replay capture concurrently with loading/repair.

Maps, SQL, and source URL are fingerprinted. If they change, restore the originals to resume, or use a fresh project and separate state directory. Do not discard the state to silently shift the year. Person rows are reconciled after all days are loaded, including on an otherwise completed rerun.

Configuration: `POSTHOG_DIR` (default `/opt/posthog`), `REPLICA_SOURCE` (default `http://127.0.0.1:18123/`), `REPLICA_STATE_DIR` (default `tools/replica/.state`), and `POSTHOG_HOST` (default `http://localhost`, for replay/API access). Run where `POSTHOG_DIR` is on the filesystem storing PostHog data. If Docker data uses another filesystem, monitor its free space separately.

## Replay semantics and safe reruns

The fixed seed (`--seed 270001`) picks behaviours and interactions, without prescribed questions. Ten clients include SEM/SEMOPS, RIB, TR01; 16 screens include Cash Positions and Amortization Report. Sessions vary across success, retry, error, and abandonment. Screen titles are visible in full DOM snapshots; valid DOM references support mutations, mouse movements, and clicks. Matching PageView OPEN/CLOSE, Event button clicks, toast successes, and messagebox errors use the same session and distinct ID. The serialized rrweb recordings are generated browser-like DOM activity, following `deploy/posthog/replaytest.ts`; no browser automation or rrweb package is needed.

Times are a few minutes before the first invocation (within the last seven days). Session/window/event UUIDs and payloads persist in the manifest. Accepted batches are never resent. On rerun, all 60 recordings are checked again through recording metadata and the same blob_v2 snapshots API used by the player. Completeness compares the exact multiset of rrweb types/timestamps and event count, including full snapshots; duplicated events cannot substitute for missing ones.

An HTTP failure or a crash during a send leaves `sending` in the manifest because delivery may have occurred. Snapshot delivery can be recovered automatically when the complete recording is visible. An uncertain normal-event batch requires checking its saved event UUIDs against PostHog before setting `eventsStatus` to `sent` (all present) or `pending` (all absent). For partial delivery, recover only absent events; do not resend the whole batch. This deliberate stop prevents duplicate capture on ambiguous failures. Explicitly rejected requests also use this conservative recovery path. An expired manifest is not retimestamped on rerun. A killed process may leave `replays-manifest.json.lock`; confirm no recorder is running before removing only that lock file. API availability/read permissions and ingestion settings must permit session recordings; the script fails rather than claiming success without readback.

## Pure checks (no Docker or network)

```bash
for script in tools/replica/*.sh; do bash -n "$script"; done
python3 -m unittest discover -s tools/replica -p 'test_*.py'
node_modules/.bin/tsx --test tools/replica/record-replays.test.ts
node_modules/.bin/tsc --noEmit --strict --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --target es2023 --module nodenext --moduleResolution nodenext \
  --allowImportingTsExtensions --types node \
  tools/replica/record-replays.ts tools/replica/record-replays.test.ts
```

`clients.tsv` has 150 unique source/client pairs, `users.tsv` has six unique uppercase handles per client, and `screens.tsv` has Deal List plus 40 distinct treasury screen names. Tests cover map constraints, SQL boundary/projection/rewrite safety, person-key reconciliation, deterministic replay coverage, valid DOM IDs, and readback completeness.
