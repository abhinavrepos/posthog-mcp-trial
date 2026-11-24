# Offline Lens screenshots

From the repository root:

```sh
pnpm ui-shots -- /absolute/output/directory
```

The command starts temporary local PostHog and status stand-ins, starts Lens with an isolated SQLite database, signs in as a PostHog organization admin, and uses Puppeteer's `chrome-headless-shell` to save full-page PNGs at 1440px and 375px in dark and light themes. It captures every route in `routes.mjs` and available tabs. The runner closes all three services and removes its temporary database on exit. It never uses the network or writes to the checkout except the requested output directory.

Fixture and route checks that do not need Chrome or sockets:

```sh
node --test tools/ui-shots/fixtures.test.mjs
```

The stand-ins deliberately return deterministic PostHog query results and mixed system health. The original UI and the restyled UI can use the same runner; unavailable tabs in the original UI are skipped. The screenshots are visual review fixtures, not an end-to-end correctness test.

If copying only `tools/ui-shots/` into an original-UI checkout, invoke the same runner directly with `node tools/ui-shots/run.mjs <outDir>`; the `pnpm ui-shots` shortcut is defined in this worktree's `package.json`.
