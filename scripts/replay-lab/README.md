# Replay lab

Requires the existing Puppeteer Chrome headless shell and a reachable PostHog instance with session recording enabled. No extra dependencies.

```sh
export POSTHOG_HOST=https://your-posthog-host
export POSTHOG_PROJECT_TOKEN=phc_your_project_token
npx tsx scripts/replay-lab/run.ts --sessions 6 --concurrency 2 --clients LAB1,LAB2,LAB3,LAB4,LAB5,LAB6
```

The runner starts its own loopback server on a free port. To browse the page manually, run `npx tsx scripts/replay-lab/serve.ts` and open the printed URL.

Profiles are assigned by the order of the client list: smooth, hesitant with circling, scroll hunting, rage with dead clicks, error looping, mostly idle. Use up to six unique client IDs; repeated sessions retain the client's profile. Default sessions last approximately 70 seconds each, plus SDK loading and teardown. Every session has a fresh browser context and identity.

`out/ground-truth.json` contains sessions keyed by the real `posthog.get_session_id()`, client names, personas, observed duration, expected scripted counts/minima, and failures. Failed sessions make the CLI exit unsuccessfully. Counts describe deliberate actions; replay sampling and signal-detector thresholds can affect extracted counts. The error profile submits four times, editing Counterparty between submissions; rage clicks Save four times within a second while saving takes six seconds. Preview intentionally has no handler.

All sensitive-looking values are synthetic canaries exported by `canaries.ts`. They are intentionally unmasked in inputs and repeated in table cells, alerts, attributes and URL query parameters. Only use a project intended for this lab.

Offline checks:

```sh
node --import tsx --test test/replay-lab.test.ts
npx tsc --noEmit -p .
```
