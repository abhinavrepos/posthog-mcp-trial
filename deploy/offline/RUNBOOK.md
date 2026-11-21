# Two runbooks

Both start on the **build machine** (the one with the `localhost:5000` registry that built the kits).
Kit tags look like `003ec4457509-7ce8a944`; `build-images.sh` prints the new one and writes it to
`deploy/offline/last-kit.txt`.

## A. Patch dqposthog01 (PostHog already upgraded; Lens only, a few MB)

dqposthog01 runs kit `4df1d5102819-e66ccf61`. The patch carries only what changed since then: the
new Lens code layer and the project files. PostHog's source, GeoIP and Compose (about 550 MB) and every
unchanged image layer stay out; the machine already has them.

**Build machine**
```bash
cd ~/lens && git fetch origin && git checkout thin-lens && git pull --ff-only
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh
TAG=$(cat deploy/offline/last-kit.txt); TAG=${TAG##*:}; echo "KIT: $TAG"
SINCE=4df1d5102819-e66ccf61 deploy/offline/save-images.sh "$TAG"
ls -lh deploy/offline/out/posthog-lens-images-$TAG-since-4df1d5102819-e66ccf61.tar
```
Expect `Same PostHog as kit 4df1d5102819-e66ccf61` and a file of a few MB. If it says the PostHog
version differs, stop: that is a full upgrade (B), not a patch.

Copy that one `.tar` to dqposthog01.

**dqposthog01**
```bash
sudo docker image ls | grep -c 4df1d5102819          # the old kit is still loaded (must be 1 or more)
sudo docker load -i posthog-lens-images-<KIT>-since-4df1d5102819-e66ccf61.tar
sudo posthog-lens update <KIT>                        # minutes; PostHog keeps running
sudo posthog-lens check                               # every line PASS
```
- If `docker load` reports missing content, the old images were removed: build the full file instead,
  `deploy/offline/save-images.sh <KIT>` (no SINCE), and load that.
- Your settings stay (`/etc/posthog-lens/posthog-lens.env`, `.secrets.env`, pins, clips, keys).
- Afterwards, in VS Code: Copilot Chat, MCP servers, Lens, Restart, so Copilot loads the new tool list.
- Back out: `sudo posthog-lens update 4df1d5102819-e66ccf61` (its images are still on the machine).

## B. Full upgrade of another machine (PostHog from Sept 2025, plus Lens)

**Once per machine, before building: its addresses.** On the build machine, add a site file named after
the machine's short hostname (`hostname -s` on it), with every address people use, http and https:
```bash
mkdir -p deploy/offline/sites/<host>
cat > deploy/offline/sites/<host>/site.env <<'EOF'
CLIENT_FROM_DISTINCT_ID=3
DISTINCT_ID_SEPARATOR=|
APP_EVENTS_FILE=config/app-events.reval.json
POSTHOG_ADDRESS=https://<name1>,https://<name2>,http://<ip>
EOF
git add deploy/offline/sites/<host> && git commit -m "site: <host>"
```
Then build and write the full file (several GB):
```bash
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh
TAG=$(cat deploy/offline/last-kit.txt); TAG=${TAG##*:}
deploy/offline/save-images.sh "$TAG"
```
Copy `out/posthog-lens-images-<KIT>.tar` and `out/upgrade.sh` to the machine.

**The machine** (check free disk first: about the size of the old replay storage plus 20 GB)
```bash
df -h /var/lib/docker
sudo docker load -i posthog-lens-images-<KIT>.tar
cd <folder with upgrade.sh>
sudo POSTHOG_DIR=<old PostHog folder> bash upgrade.sh <KIT>
sudo posthog-lens progress -f                       # from any session; a dropped SSH does not stop it
sudo posthog-lens check                             # every line PASS
```
It backs PostHog up in full first, upgrades it (2-3 hours, longer with many replays), copies the old
session replays and verifies they play, then installs and starts Lens. If it stops, fix what it says and
run the same `upgrade.sh` command again: it continues where it stopped. `sudo posthog-lens rollback`
goes back to the backup.

What it already handles (each was a failure on dqposthog01):
- the replay copier is readable inside the plugins container (no EACCES)
- replays whose blocks were already missing before the upgrade are skipped and listed, not fatal
- old replays are copied and checked by default (MIGRATE_REPLAYS=yes)
- `config.js` 404 after the upgrade (remote config is rebuilt)
- CSRF "Origin checking failed": every address in the site file is trusted, in both schemes
- http on the IP and https on the names both work; names over http redirect to https
- Lens talks to PostHog internally (`http://web:8000`), so company certificates do not matter
- Lens is started at the end (it was left stopped before)
- the settings precedence (CONF over site file over answers over `.secrets.env`)

Then: Lens on `http://<ip>:8080` (open port 8080 in the firewall, or use a load-balancer name),
PostHog on the addresses above. Keep the backup and the old storage until replays play.

Addresses behind a load balancer: configure every name/IP people use in POSTHOG_ADDRESS.
Names serve HTTP directly and HTTPS with Caddy local certificates; the balancer must trust the local certificate (or disable backend certificate verification). No public ACME access is required.
Set SERVICE_PUBLIC_URL to the Lens browser address and POSTHOG_LINK_URL to the PostHog browser address; run posthog-lens check after updating.
