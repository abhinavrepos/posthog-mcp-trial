# Five-minute demo

Before the demo: `scripts/demo-prep.sh --reset-board` (a few minutes). Open three tabs:
the mock Jira board (`:4000`), PostHog (`:80`), and Claude Code in this folder.

## 1. The problem (30 s)

"When client services raises a bug, engineering spends the first hour working out who, where and
when, then hunting for a replay. Everything needed is already in PostHog. It just isn't in the
ticket."

## 2. A client bug, end to end (90 s)

On the board, click **Client bug: PDF export stuck**. Point out how vague the ticket is: a name,
"this afternoon", and "Preparing PDF…". Within a few seconds the comment appears:

- It found **Ben's session** from an email and a London-time "this afternoon".
- The **clip** is attached. Play it: the export hangs and Ben clicks again and again. Search
  input is masked in the replay: PostHog does not record what users type.
- **Is it just them?** No. 4 clients, all on **2.14.0**. 2.13.2 has 0% failures on the same
  screen, so this is a regression in the release, not a client problem.
- **Usage**: how many clients depend on Invoices, and that Brightwater is the heaviest user.
- **Suggested P1**, with the reasons written out. A human still decides.

## 3. The hard cases (60 s)

- **Vague ticket: client name only**: "Nordlicht says invoices are broken." No user and no
  time. It still finds the session and says how it found it.
- **No error: report shows zero**: nothing crashed. It finds the session where Maya refreshed
  the report five times and attaches that clip. Silent bugs never reach error tracking.
- **MMT risk review**: a different layout with exposure, affected clients, the trend and the
  release comparison table.

## 4. Ask Claude (60 s)

In Claude Code (approve the `ticket-triage` MCP server once):

> When did Brightwater last hit an error on invoices, and show me what Ben saw.

Claude calls `find_client_incidents`, then `get_replay_clip`. Claude looks at the frames, so it
can describe the screen.

> Which other clients are affected, and is it getting worse?

## 5. Close (30 s)

"Same logic, two front doors: Jira automation for every ticket, and Claude for follow-up
questions. Moving to our real Jira is three settings. Nothing here changes how the product team
works. Tickets just arrive with the evidence attached."

## If something goes wrong

- No comment after 30 s: `scripts/stack.sh status`, then `tail logs/service.log`.
- "No session found": run `pnpm sessions --only brightwater --count 2`, wait a minute, file the
  ticket again.
- Clip fails: the comment still links the full replay in PostHog.
