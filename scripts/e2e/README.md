# End-to-end checks

Run against a deployed Lens (and its PostHog), with a real browser (puppeteer).

```bash
LENS_URL=http://127.0.0.1:8080 POSTHOG_URL=http://127.0.0.1 E2E_PASSWORD_FILE=/root/e2e-pw.txt scripts/e2e/run.sh
```

| Script | What it checks |
|---|---|
| `check-all.ts` | Every page as admin and viewer: no browser errors, every control labelled, no overlap or broken words at 1280/1024/390 px, no sideways scroll on phones. Copilot address setting; personal chat keys for Lens and PostHog-through-Lens; viewer keys read-only; revoked keys stop. Live (day, 30 days, sessions, one person). Surveys (results, written-answer paging, launch safeguard: rules, ticket, acknowledgement, viewer refused). PostHog's survey API locked, its survey screens sent to Lens, Reval's surveys.js with "Survey by ION". Dashboards (clients, 100 slowest attempts, pin, share, permissions). Pagination, System. |
| `check-rescue.ts` | Rescue queue: results, page as admin/viewer (desktop and phone), owner/status through the form, activity log, snooze and unsnooze, validation, viewer refused, the period choice on the page, chat tools with real keys, timing. `E2E_EXPECT_PLANTED=1` also expects the demo data's planted problems. |
| `bench.ts` | Speed of every chat tool, PostHog through Lens, PostHog's API and static files: first and repeat times, saved as JSON for before/after comparisons. |
| `../stress-rescue.ts` | Load: a 60-day history build at Reval volume inside the server while waves of 100 concurrent chat calls, status changes and page loads run; latency, errors, event-loop blocking, memory, lost writes. Local, no PostHog needed: `npx tsx scripts/stress-rescue.ts 60 50 55`. |

**Accounts.** Two PostHog accounts that can sign in (`E2E_ADMIN`, `E2E_VIEWER`; defaults `lens-check-admin@example.invalid` and `lens-check-viewer@example.invalid`, same password from `E2E_PASSWORD` or `E2E_PASSWORD_FILE`). Give them Lens roles once:

```bash
sudo deploy/lens/lens.sh run node --import tsx -e "const a=await import('./src/service/access.ts');a.setPerson('lens-check-admin@example.invalid','admin','e2e');a.setPerson('lens-check-viewer@example.invalid','watch','e2e');a.setSurveyRole('lens-check-viewer@example.invalid','view','e2e');a.setDashboardRole('lens-check-viewer@example.invalid','view','e2e')"
```

The checks make and revoke their own chat keys, set and reset statuses, and pin and delete a dashboard; they leave no data behind except activity-log entries. Results and screenshots go to `E2E_OUT` (default `e2e-out/`).
