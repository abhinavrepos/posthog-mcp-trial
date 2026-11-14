# Setting up PostHog Lens

Step by step, for the supported deployment: a self-hosted **Ubuntu 24.04** machine **without internet**,
plain HTTP inside your network, desktop browsers. PostHog and PostHog Lens run in Docker on that machine;
every image is carried to it in one file. Details: [deploy/offline/README.md](deploy/offline/README.md)
(both routes, all `posthog-lens` commands) and [README.md](README.md) (what each part does).

```
PMs' browsers ──HTTP 80──▶ PostHog            Reval ──events + recordings──▶ PostHog
PMs' browsers ──HTTP 8080─▶ PostHog Lens ──HogQL / replay API──▶ PostHog
GitHub Copilot ──HTTP 8080 /mcp (personal key)──▶ PostHog Lens
```

## 1. What you need first

| | |
|---|---|
| Build machine | Ubuntu x86_64 **with internet**, Docker with buildx, git, python3, curl; about 30 GB free. AWS CLI only for the ECR route. |
| Target machine | Ubuntu 24.04 x86_64, 4 CPUs, 16 GB memory (8 GB works), **about 120 GB free disk**, Docker installed from your package mirror or `.deb` files (`apt install docker.io`), root access. Ports 80, 443 and 8080 free. |
| Network | your users and Reval can reach the target on 80 (PostHog) and 8080 (PostHog Lens). Nothing else inbound. |
| People | the email of the first PostHog login (the installer creates it); the PostHog address(es) people will use (IP or `http://name`) |

A domain name with HTTPS needs Let's Encrypt, which needs the internet: without it, use the IP address
or `http://<name>`.

## 2. Build the images (build machine, with internet)

The images are built from the **committed** code (`git archive HEAD`): commit your changes first.

```bash
git clone https://github.com/abhinavrepos/posthog-mcp-trial lens && cd lens
git checkout <the commit or branch to deploy>
docker run -d --restart=always -p 127.0.0.1:5000:5000 --name registry registry:2   # once: a local registry
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh                 # PostHog's images + ours + the kit
deploy/offline/save-images.sh                                                      # out/posthog-lens-images-<kit>.tar (+ .sha256)
```

`build-images.sh` runs PostHog Lens's test suite inside its image and pushes nothing if a test fails.
Carry three files to the target: `deploy/offline/out/posthog-lens-images-<kit>.tar`, its `.sha256`, and
`deploy/offline/out/fresh-install.sh` (or `upgrade.sh` for a machine that already runs PostHog).

## 3. Install (target machine, no internet)

```bash
sha256sum -c posthog-lens-images-<kit>.tar.sha256
sudo docker load -i posthog-lens-images-<kit>.tar           # about 37 GB once loaded; delete the .tar afterwards
sudo bash fresh-install.sh                                   # no PostHog yet: asks the address and the first login's email
# or, where PostHog already runs (keeps all data, full backup first, shows what changes and asks):
sudo bash upgrade.sh
```

It checks the machine first (CPU, memory, disk, ports, Docker, that every image is loaded) and says what
is missing. It installs PostHog at the pinned version, makes the first login and a read-only API key,
writes `.secrets.env` (mode 600), runs PostHog Lens under systemd (`ticket-triage.service`), refuses every
outside call PostHog would make (no-internet mode), and ends with `posthog-lens check`, which prints
**READY** when everything answers. A fresh install takes 1 to 2 hours (PostHog's migrations). If a step
fails, fix it and run the same command again: finished steps are skipped.

The closing summary (`sudo posthog-lens status` shows it again) lists the addresses, where each password
and key is, and the snippet for Reval.

## 4. Check it works

```bash
sudo posthog-lens status      # PostHog and PostHog Lens answer
sudo posthog-lens doctor      # no ✘ (warnings are fine): settings checked against the running services
sudo posthog-lens check       # READY
```

Open `http://<address>:8080/`, sign in with the PostHog login. Reval must send its events and recordings
to `http://<address>` (the snippet from the summary).

## 5. People and access (Admin page)

Sign-in is the PostHog account. PostHog owners and admins are Lens admins; everyone else starts with the
default role (Admin → Access defaults). On **Admin → People**, per person:

- **Clip role**: none, watch clips, download, admin
- **Extra access**: System page, Replay insights
- **Surveys** (no access, view, edit, launch) and **Dashboards** (no access, see dashboards, also pin and share)

Removing someone's access also stops their personal Copilot key at once (a key needs the same access as
the Connect page). Someone who leaves: deactivate them in PostHog, set their roles to none here, and
revoke their keys under Admin → Chat keys.

## 6. GitHub Copilot (PMs)

Each PM opens **Chat → Connect Copilot**, which makes their personal key (shown once) and shows the fields
to paste into Copilot → MCP Servers → Add Custom server. The key carries that person's access. Admins set
the address Copilot uses under Admin → Chat keys. Only the ION-approved GitHub Copilot may be used.

Surveys are launched only on the Surveys page (four rules, an acknowledgement and a ticket ID), never from
chat. Jira is switched off (`FEATURE_JIRA=off`): the release-outcome tools are hidden and the Jira webhook
answers 503. To turn it on later, set `FEATURE_JIRA=on` plus `JIRA_BASE_URL`, `JIRA_EMAIL` and
`JIRA_API_TOKEN` in `.secrets.env` and `sudo posthog-lens restart`.

## 7. Security notes

- **Plain HTTP**: PostHog passwords, session cookies and Copilot keys cross the network unencrypted.
  Acceptable only inside a trusted network: limit ports 80 and 8080 to your users' ranges on the
  firewall, and revoke keys people no longer use (Admin → Chat keys).
- Data folders (`run/`, `clips/`, `logs/`, `.cache/`) are readable by the service user only; `.secrets.env`
  is mode 600.
- Copilot never receives replay content. Every Lens tool answer passes one privacy filter, whatever the
  Client privacy settings: amounts and long numbers (Trade IDs stay), client users' emails and PostHog ids,
  and known user names are masked; app messages keep their wording. Rescue notes are not sent to AI. Admin → Client privacy can also replace client names
  with codenames.
- The clip renderer can reach only `CLIP_ALLOWED_HOSTS` (default `localhost`) on ports 80 and 443
  (write `host:port` for another port), through a built-in allowlist proxy; recordings that point at
  other addresses or ports are refused.
- A Copilot key's PostHog-admin rights count only while its owner has signed in to Lens within the
  last 14 days; after that the key works with their normal Lens role until they open Lens again.

## 8. Updates

On the build machine: `git pull`, commit, `SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh`,
then `SINCE=<kit tag on the machine> deploy/offline/save-images.sh` for a small file (often a few hundred
MB). On the machine: `docker load` the new file, then `sudo bash upgrade.sh` (or
`sudo posthog-lens update <kit tag>`). `sudo posthog-lens rollback` returns to the PostHog from before an
upgrade; `sudo posthog-lens cleanup` deletes that backup once you are happy.

## 9. Running the tests (developers)

```bash
pnpm install                  # also downloads Chrome and ffmpeg
npx tsc --noEmit              # typecheck
npm test                      # the unit and integration suite (node:test)
```

Against a deployed Lens and its PostHog, with a real browser: `scripts/e2e/run.sh` (see
[scripts/e2e/README.md](scripts/e2e/README.md); needs two test PostHog accounts).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `fresh-install.sh` lists missing images | the `.tar` is from another kit, or `docker load` did not finish: load the file that matches the script |
| PostHog does not answer for 10 to 15 minutes after a boot | normal on 4 CPUs; `posthog-lens check` waits up to 25 minutes in the first half hour |
| "Too many attempts. Wait 10 minutes." | 10 wrong passwords for that email, or 20 from one address, in 10 minutes |
| A clip says "No MP4 clip" from Copilot | 3 clips already rendering, or the hourly limit (`CLIPS_PER_HOUR`, 20) reached: the replay link still works |
| Copilot: unauthorized | the key was revoked, or its owner has no Lens access any more |
| Jira webhook answers 503 | Jira is switched off on purpose (`FEATURE_JIRA=off`) |
