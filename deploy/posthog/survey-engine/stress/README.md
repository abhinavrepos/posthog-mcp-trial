# Survey chain stress test

Opens many browser pages at once, each a stand-in for the app (`page.html`: posthog-js, an ExtJS-style
loading mask), runs one of 15 journeys and checks the outcome: the expected survey shown exactly once
(or none), never while the loading mask is up, the footer reading "Survey by ION" with no posthog.com
link, and no browser error of any kind (console errors and warnings, page exceptions, failed requests,
HTTP 400+).

```bash
# 1. Serve page.html (any static server), e.g. on 127.0.0.1:18555
python3 -m http.server 18555 --bind 127.0.0.1 &
# 2. Four test surveys (S1-S4) on the PostHog under test, with a survey read/write key
python3 make-surveys.py http://posthog-host key.txt survey-ids.json
# 3. config.json: {"host": "http://posthog-host", "token": "phc_…", "pageBase": "http://127.0.0.1:18555/page.html",
#                  "surveys": <contents of survey-ids.json>}
# 4. 1000 pages, 100 at a time (needs puppeteer; ~0.25 GB of memory per open page)
CORE=new npx tsx stress.mts config.json 1000 100 result.json
```

`CORE=old` loads `/array-1.261.6.js` from the page server (put Reval's posthog-js build there) to
test the older library; unset, pages alternate. Stop the test surveys afterwards.

Last run (2026-11-10, PostHog c08ecdbe, posthog-js 1.443.0): 1000 of 1000 pages correct, 0 browser
errors, 100 at a time. With posthog-js 1.261.6, 6-21% of pages never loaded surveys at all: that
version aborts its first `/flags` request when the user is identified, then skips surveys.
