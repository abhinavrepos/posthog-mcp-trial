# Lens surveys: start here

In-app surveys for Reval users, made in chat (Lens MCP) and watched on the Lens **Surveys** page.
They are ordinary PostHog surveys; nothing new is injected into Reval.

## How it fits together

```
PM in chat ──design/save/launch_survey──▶ Lens (src/core/surveys.ts) ──survey API──▶ PostHog survey
                                                                                     conditions.lensChain = steps, clients, wait-for-page
Reval page ──loads PostHog's /static/surveys.js (patched here)──▶ engine.js follows the chain on Reval's own events
           ──last step + page loaded──▶ captures lens_chain:<id> ──▶ PostHog shows the survey (bottom right)
```

| Piece | File |
|---|---|
| Chain engine (runs in the browser) | `engine.js` |
| Patch PostHog's renderer: "Survey by ION" footer + engine | `build.mjs` |
| Serve the patched file from PostHog's web container (installer step `surveys`) | `apply.sh` |
| Lens's survey-only PostHog key (`POSTHOG_SURVEY_API_KEY`) | `key.sh` |
| Spec in Reval words → PostHog survey, reach, results | `src/core/surveys.ts` |
| MCP tools | `src/mcp/surveytools.ts` |
| Surveys page `/replays/surveys` | `src/service/surveyspage.ts` |
| Tests | `test/survey-engine.test.ts`, `test/surveys.test.ts` |
| 1000-page browser stress test | `stress/` |

## Run and check

```bash
pnpm test                                   # unit tests (engine, build, compiler, page)
sudo deploy/posthog/survey-engine/apply.sh  # (re)serve the renderer; idempotent
sudo deploy/posthog/survey-engine/key.sh    # survey key into .secrets.env if missing
curl -s http://<posthog>/static/surveys.js | grep -c "Lens survey chains"   # 1 = patched file served
```

Settings: `SURVEY_ENGINE` (on), `SURVEY_BRAND` ("Survey by ION"), `FEATURE_SURVEYS` (on).

## Rules worth knowing first

- **Lens only**: PostHog's own survey screens and API are closed by a rule in PostHog's proxy
  (`apply.sh`, `SURVEY_UI_LOCK`); only calls with Lens's `POSTHOG_SURVEY_GATE` header get through.
  Access is per person in Lens: survey roles on the admin page, personal chat tokens on Connect chat.

- **Users are protected**: 24 hours at least between surveys, one per visit; × closes it at once and
  gives 7 quiet days; a survey ignored twice stops; the engine keeps one key (`lensSurveyQuiet`).
- **At most two running surveys per user** (`SURVEYS_PER_USER`): a user already in two unfinished
  ones is queued for a newer survey and gets it later, after answering or dismissing one. The person
  making the survey gets a ⚠ alert (design, save, launch, Surveys page) naming who is queued and why.
- Question types: rating, nps, yes_no, thumbs, open, single, multiple. Look: theme light/dark plus
  every colour, corners, shadow, padding, font, position (bottom right by default), width.

## Things to know

- Reval should move to posthog-js 1.268 or later; 1.261.6 sometimes never loads surveys.
- After a PostHog upgrade, `apply.sh` rebuilds from the new original. If the footer markup changed,
  the build refuses and PostHog's original renderer is served (surveys work, chains do not).
- `surveys.js` is Apache 2.0 (posthog-js); the served file keeps the notice and says it was modified.
  PostHog's own white-label option needs an Enterprise licence and is not used.
- Changing the served file recreates PostHog's web container (a few minutes, longer on a busy box).

Full description: the **Surveys** section of the main README.
