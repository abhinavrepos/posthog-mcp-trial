These are unmodified, synthetic-only rrweb JSONL recordings from
`/root/chlab/replayfix/`, captured by `scripts/replay-lab` on 2026-11-17.

- `idle.jsonl`: `01a1eb05-cdd6-7079-8ea6-2ebb2f2fa25d_1794944390090.jsonl`
- `error-looping.jsonl`: `01a1eb05-cda8-7125-a42c-6a7e2becf458_1794944450113.jsonl`
- `clips.json`: the two matching entries from `ground-truth.json`.

The idle recording's sparse event span is much shorter than its scripted session.
Tests use the real events with an independent recording end, mock the rasterizer,
and execute the player clock without Chrome. The files stay inside the tests;
replay text and frames are never sent to MCP clients.

Real PostHog snapshot JSONL captured by `scripts/replay-lab` on 2026-11-17; synthetic page content only. These are unmodified copies of three small recordings in `/root/chlab/replayfix/`.

| File | Session | Observed duration (ms) |
| --- | --- | ---: |
| rage-dead.jsonl | 01a1eb05-cda6-7bc7-9e37-47ae27245aff | 70005 |
| error-looping.jsonl | 01a1eb05-cda8-7125-a42c-6a7e2becf458 | 70003 |
| idle.jsonl | 01a1eb05-cdd6-7079-8ea6-2ebb2f2fa25d | 70003 |

Preview has DOM id `dead` (48). At offset 9009 ms it is clicked without a handler; at 9914 ms the previous Save toast (577) expires. Its removal must not cancel Preview's dead-click signal. Save's four clicks at 1707–2168 ms form a rage burst; its response arrives at 7718 ms.
