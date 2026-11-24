# Offline thin Lens screenshots

From the repository root, run `npm run ui-shots -- /absolute/output/directory`. The runner starts isolated Lens, PostHog, and status services; signs in as an admin; and captures all thin Lens pages at 1440 and 375 pixels in dark and light themes. It also captures tabs, survey states, and empty or error states where the page has them. Images are named `<page>[-<tab-or-state>]-<theme>-<width>.png`.

The runner uses Puppeteer's bundled headless shell and local fixtures only. It leaves the checkout and production data untouched. It works unchanged in a plain thin-lens checkout if this `tools/ui-shots` directory and the `ui-shots` script are copied there. Socket and Chrome access are required, so it must run outside restricted sandboxes.
