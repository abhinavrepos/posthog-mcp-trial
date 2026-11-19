# Installing and upgrading PostHog Lens

For a self-hosted Ubuntu 24.04 machine without internet access. PostHog and PostHog Lens run in Docker;
all images are carried to the machine in one file.

## Requirements

| | |
|---|---|
| Build machine | Ubuntu x86_64 with internet, Docker with buildx, git, python3, curl, about 30 GB free |
| Target machine | Ubuntu 24.04 x86_64, 4 CPUs, 16 GB memory (8 GB works), about 120 GB free disk, Docker (`apt install docker.io`), root access, ports 80, 443 and 8080 free |
| Network | users and Reval reach the target on 80 (PostHog) and 8080 (PostHog Lens) |
| Details to hand | the email for the first PostHog login, and the address(es) people will use (IP or `http://name`) |

Without internet there is no HTTPS certificate; use the IP address or `http://<name>`.

## 1. Build the images (build machine)

Images are built from committed code, so commit first. A copy without git works too (a downloaded zip, or a clone
whose `.git` folder was removed): the build then takes the folder as it is, leaving out what `.gitignore` lists.

```bash
git clone https://github.com/abhinavrepos/posthog-mcp-trial lens && cd lens
git checkout <commit or branch to deploy>
docker run -d --restart=always -p 127.0.0.1:5000:5000 --name registry registry:2   # once
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh
deploy/offline/save-images.sh
```

The build runs the test suite inside the image and stops if a test fails. Copy these to the target:

- `deploy/offline/out/posthog-lens-images-<kit>.tar`
- `deploy/offline/out/fresh-install.sh` (new machine) or `deploy/offline/out/upgrade.sh` (PostHog already there)

## 2. Install (target machine)

```bash
sudo docker load -i posthog-lens-images-<kit>.tar     # delete the .tar afterwards
sudo bash fresh-install.sh                             # asks for the address and the first login's email
```

The script checks the machine first and lists anything missing. A fresh install takes 1 to 2 hours. If a
step fails, fix the cause and run the same command again; finished steps are skipped. The summary at the end
(`sudo posthog-lens status` shows it again) lists the addresses, where passwords and keys are kept, and the
snippet for Reval.

To set more options up front, fill in a copy of `deploy/install.env.example` and pass it with `SETTINGS=my.env`.

## 3. Check

```bash
sudo posthog-lens status      # PostHog and PostHog Lens answer
sudo posthog-lens doctor      # no errors (warnings are fine)
sudo posthog-lens check       # READY
```

Open `http://<address>:8080/` and sign in with the PostHog login.

## 4. Upgrade

On the build machine:

```bash
git pull
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh
SINCE=<kit tag on the target> deploy/offline/save-images.sh     # only what changed, often a few hundred MB
```

On the target:

```bash
sudo docker load -i posthog-lens-images-<kit>.tar
sudo bash upgrade.sh          # shows what will change and asks first; YES=1 to skip the question
```

All data is kept. When the PostHog version changes, PostHog is backed up in full first and is down for
2 to 3 hours. `sudo posthog-lens rollback` returns to the previous PostHog; `sudo posthog-lens cleanup`
deletes the backup once you are satisfied.

A machine whose PostHog was installed another way: run `upgrade.sh` the same way; it finds the running
PostHog (or takes `POSTHOG_DIR=<folder>`).

## Changing a setting

Settings are in `/etc/posthog-lens/posthog-lens.env`. After editing:

```bash
cd /opt/posthog-lens
sudo POSTHOG_DIR=/opt/posthog bash deploy/install.sh --config /etc/posthog-lens/posthog-lens.env --yes
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `fresh-install.sh` lists missing images | the `.tar` is from another kit or `docker load` did not finish; load the matching file |
| PostHog does not answer for 10 to 15 minutes after a reboot | normal on 4 CPUs; `posthog-lens check` waits up to 25 minutes |
| The installer stops at a port check | something else is using port 80, 443, 8080 or 8090; stop it and run again |
| Jira webhook answers 503 | Jira is off (`FEATURE_JIRA=off`); set `FEATURE_JIRA=on`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` in `.secrets.env`, then `sudo posthog-lens restart` |
