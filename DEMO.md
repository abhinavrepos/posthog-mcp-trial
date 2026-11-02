# Five-minute demo

Before the demo: `scripts/demo-prep.sh` (a few minutes). Open two tabs: PostHog (`:80`) and
Claude Code in this folder. The tickets below are pasted into Claude, which runs the same triage
the Jira webhook runs (`triage_ticket`). With Jira connected, filing them in Jira posts the same
report as a comment.

## 1. The problem (30 s)

"When client services raises a bug, engineering spends the first hour working out who, where and
when, then hunting for a replay. Everything needed is already in PostHog. It just isn't in the
ticket."

## 2. A client bug, end to end (90 s)

Ask Claude:

> Triage this ticket (reporter in Europe/London). "Brightwater Logistics cannot export invoices to
> PDF. Ben Okafor (ben.okafor@brightwater.example) called this afternoon. When he exports the
> selected invoices to PDF the page sits on "Preparing PDF…" and nothing downloads. He tried several
> times."

Point out how vague the ticket is: a name, "this afternoon", and "Preparing PDF…". Within a few
seconds the report is back:

- It found **Ben's session** from an email and a London-time "this afternoon".
- The **clip** is attached. Play it: the export hangs and Ben clicks again and again. Search
  input is masked in the replay: PostHog does not record what users type.
- **Is it just them?** No. 10 clients, all on **26.10.0**. 26.9.0 has 0% failures on the same
  screen, so this is a regression in the release, not a client problem.
- **Usage**: how many clients depend on Invoices, and that Brightwater is the heaviest user.
- **Suggested P1**, with the reasons written out. A human still decides.

## 3. The hard cases (60 s)

- **Vague ticket, client name only** (Europe/Berlin): "Nordlicht says invoices are broken. Said
  downloading their invoices does not work this week." No user and no time. It still finds the
  session and says how it found it.
- **No error** (America/New_York): "Cobalt Health: revenue report shows $0 for the quarter. Maya
  refreshed it a few times and switched ranges. No error on screen." Nothing crashed. It finds the session where Maya refreshed
  the report five times and attaches that clip. Silent bugs never reach error tracking.
- **Risk review** (ask for a risk triage): "Risk review: invoice PDF export after the 26.10.0
  release. Which clients are affected, how often, and is it getting worse?" A different layout with exposure, affected clients, the trend and the
  release comparison table.

## 4. Ask Claude (60 s)

In Claude Code (approve the `ticket-triage` MCP server once):

> When did Brightwater last hit an error on invoices? Give me the replay link.

Claude calls `find_client_incidents`, then `get_replay_link`. It answers from event data and
hands back links. It never sees the replay itself: replays stay with people who have a login.

> Which other clients are affected, and is it getting worse?

## 5. Release review with Claude (90 s)

In Claude Code, run the prompt `/mcp__ticket-triage__review_release Q3 2026`, or just ask:

> Review Q3 2026. Which tickets were risky, and what went well?

Claude calls `release_outcomes`, `client_feedback` and `ticket_evidence`, then answers with a
verdict table:

- **ACP-200** (26.7.0, new client filters): risky. Rage clicks rose from 0 to 18 per 100
  sessions, four support tickets said "where did search go?", and the survey rating fell
  from 4.2 to 3.1.
- **ACP-211** (26.8.0): fixed it.
- **ACP-210** Bulk send: adopted by 77% of clients, with one small support ticket.

Say "save ACP-200 as risky, decided by me". `record_verdict` stores it, and the next review shows
it.

Point out that the numbers come from Jira and PostHog by fixed rules, and Claude only judges
them. Ask "why is ACP-230 grouped under errors?" and it quotes the rule and the counts.

## 6. Close (30 s)

"Same logic, two front doors: Jira automation for every ticket, and Claude for follow-up
questions. Connecting our real Jira is three settings. Nothing here changes how the product team
works. Tickets just arrive with the evidence attached."

## If something goes wrong

- No answer after 30 s: `scripts/stack.sh status`, then `tail logs/service.log`.
- "No session found": run `pnpm sessions --only brightwater --count 2`, wait a minute, ask
  again.
- Clip fails: the report still links the full replay in PostHog.
