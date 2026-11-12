# Replay signals: design

Goal: a product manager asks "how is <client> doing?" and gets plain findings about how that client's
people actually experience Reval, from session replays, with no sensitive content (no trade values,
cash amounts, rates, counterparties, typed text, on-screen text). Events say *what* was done; replays
add *how*: hesitation, a cursor circling, hunting by scrolling, clicks that do nothing, rage clicks,
errors that keep coming back, long idle stretches.

## Privacy rule (the whole design follows from it)

The engine reads a recording as **structure only**, through an allowlist:
- rrweb event types and timestamps; mouse positions (only to compute distances and direction changes,
  never stored as positions over the page); scroll offsets (only deltas); viewport size;
- for an element: tag name and these attributes only: `id`, `name`, `role`, `type`, `data-testid`,
  `data-field`, `data-dialog`, `data-action`, `aria-label`; every kept string passes `safeName()`,
  which drops it (returns undefined) if it contains a run of 3+ digits, a currency sign or code
  (USD/EUR/GBP/CAD/CHF/JPY), an @, a decimal number, or is longer than 40 characters;
- whether an element with `role=alert` / `role=alertdialog` / class containing `error`, `alert`,
  `toast`, `invalid` appears (an "error shown" signal) - never its text;
- network calls through the existing `src/core/replaynet.ts` (method, path template, status, timing);
- console errors: a count only.
Never read: text node content, input values (rrweb input events' `text`), `value`/`title`/`placeholder`
or any other attribute, CSS, canvas, images, request/response bodies, console messages.

## Engine API (src/core/replaysignals.ts, pure, no network, no database)

```ts
export interface SessionSignals {
  version: 1
  duration_ms: number; active_ms: number; idle_ms: number // idle: gaps > 15 s without input/mouse/scroll
  clicks: number
  rage_clicks: { target: string; count: number; at_ms: number }[]   // >=3 clicks on the same target within 1 s
  dead_clicks: { target: string; at_ms: number }[]                   // click with no DOM mutation, no network call, no navigation within 1 s (ignore clicks on inputs/labels)
  errors_shown: { target?: string; at_ms: number }[]                 // an alert/error element appeared
  error_loops: { field?: string; count: number }[]                   // submit-like click -> error shown -> edit -> submit again, repeated
  fields: { field: string; edits: number; focus_count: number; ms: number }[] // per safe field name; edits = input events (no values)
  hesitations: { before: string; ms: number; at_ms: number }[]       // pause >= 8 s with mouse moving but no click/input, then a click on `before`
  cursor: { px_per_min: number; direction_changes_per_min: number; circling_bursts: number } // circling: >= 8 direction reversals within 3 s without a click
  scroll: { px: number; reversals: number; hunting_bursts: number }  // hunting: >= 4 up/down reversals within 10 s
  network_errors: number; slow_calls: number                         // from replaynet: status >= 400; ms >= 5000
  console_errors: number
}
export function safeName(s: unknown): string | undefined
export function signalsFromReplay(jsonl: string): SessionSignals   // jsonl = lines of [windowId, rrwebEvent] (posthog.ts normalizeSnapshotLines)
```
Targets and fields are named from the safe attributes (prefer data-field / data-action / name / id /
aria-label, then role, then tag), e.g. `button#save`, `field:notional`. Unknown -> `button`, `field`.

## Lab (scripts/replay-lab/)

A Reval-shaped page (dialogs IR Swap, FX Trade, Hedge Designation; fields Notional, Rate, Trade Date,
Counterparty; a trades grid; an error banner with role=alert; toasts) that sends Reval's own events
(config/app-events.reval.json: PageView with dialog_id/action OPEN|CLOSE, Event with action/control_type/
action_name, messagebox events) plus real posthog-js session recording with maskAllInputs **off**
(worst case). Every piece of sensitive-looking content is a **canary**: notional amounts like
`7,314,159.26`, cash `CAD 2,718,281`, rates `4.6692%`, counterparty `Zanthor Capital`, trade ids
`TRD-90210-77`, typed into inputs, shown in grid cells, alert texts, titles, data-* attributes, aria
labels and URLs. A puppeteer driver plays personas with known behaviour (smooth, hesitant, circling,
scroll-hunting, rage-clicking, error-looping, idle) for synthetic clients and writes
`ground-truth.json` (session id -> persona, expected signals). The canary list is exported for tests.
