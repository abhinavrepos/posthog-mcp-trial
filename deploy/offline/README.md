# PostHog + PostHog Lens from your ECR: three scripts

Everything a machine needs comes from your ECR as images. The machine itself downloads nothing from the
internet and needs no copy of this project: one script file is enough.

| # | Script | Where you run it | What it does |
|---|---|---|---|
| 1 | `build-images.sh` | a build machine **with internet**, in a clone of this branch | puts every image in ECR, and writes scripts 2 and 3 ready to copy |
| 2 | `fresh-install.sh` | a machine with **no PostHog yet** | installs PostHog and PostHog Lens from those images |
| 3 | `upgrade.sh` | a machine that **already runs PostHog** | upgrades it to those images, keeping all data |

```
build machine (internet)                 ECR (ca-central-1)                    EC2 (no internet)
1. build-images.sh  ───── images ─────▶  posthog/*  ──────── images ───────▶  2. fresh-install.sh
       └── writes out/fresh-install.sh, out/upgrade.sh ── copy one file ──▶  or 3. upgrade.sh
```

## 1. `build-images.sh`: make the images

**Needs:** Ubuntu x86_64 with Docker (and buildx), git, python3, curl and the AWS CLI v2, signed in to an
identity that can push to the `posthog/*` repositories (list below). About 10 GB of free disk.

```bash
git clone --branch ticket-triage-amazon-linux --single-branch https://github.com/abhinavrepos/posthog-mcp-trial lens
cd lens
deploy/offline/build-images.sh --plan     # what goes where; nothing is pushed
deploy/offline/build-images.sh            # about 25 GB the first time, much less after
```

Later runs: `git pull`, then `deploy/offline/build-images.sh` again.

What it does:

1. **Copies PostHog's 26 images** (every service of the pinned PostHog version, the older version an
   upgrade passes through, PostHog's MCP server, alpine) straight from their registries into ECR, 4 at a
   time (`COPY_JOBS`), linux/amd64 only, byte for byte, checked by digest. Nothing of PostHog's is rebuilt,
   and nothing is stored on the build machine.
2. **Builds 3 images** from the checked-out commit (uncommitted changes are left out):
   - `posthog/node`: PostHog's Node image with one setting added
   - `posthog/lens`: PostHog Lens (service, MCP tools, Chrome, ffmpeg) and the status page. Its tests run
     inside it first, and nothing is pushed if they fail.
   - `posthog/minio`: used only when upgrading an older PostHog's stored files
3. **Builds the kit** (`posthog/kit`): this project, PostHog's source at the pinned version, the GeoIP
   database and Docker Compose. It is the only thing scripts 2 and 3 download before they start.
4. **Writes `deploy/offline/out/fresh-install.sh` and `out/upgrade.sh`** with your registry and this kit
   filled in, and prints the kit's tag, for example `685049943753-92fb46e1`.

**Only what changed goes up.** Every tag comes from the content (a digest, or a hash of the files it was
built from), so a run skips whatever ECR already has. A change to PostHog Lens rebuilds `posthog/lens` and
the kit; PostHog's images are not copied again. Tags never change meaning, which fits ECR's immutable tags.

**ECR repositories** (the admin creates them once; immutable tags, AES-256): `posthog/posthog`,
`posthog/node`, `posthog/services`, `posthog/lens`, `posthog/kit`, `posthog/mcp`, `posthog/minio`,
`posthog/caddy`, `posthog/capture`, `posthog/clickhouse-server`, `posthog/elasticsearch`,
`posthog/feature-flags`, `posthog/livestream`, `posthog/postgres`, `posthog/property-defs-rs`,
`posthog/redis`, `posthog/redpanda`, `posthog/temporal-admin-tools`, `posthog/temporal-auto-setup`,
`posthog/temporal-ui`, `posthog/zookeeper`. The script checks that they all exist before it pushes.

## What the EC2 machine needs (scripts 2 and 3)

- **Docker:** `sudo dnf install -y docker && sudo systemctl enable --now docker`
- **AWS CLI:** already on Amazon Linux 2023
- **IAM:** the instance role has `AmazonEC2ContainerRegistryReadOnly`
- **VPC endpoints:** `com.amazonaws.ca-central-1.ecr.api` and `...ecr.dkr` (interface), and
  `com.amazonaws.ca-central-1.s3` (gateway). Image layers are stored in S3.
- **Disk:** about 60 GB free for a fresh install. An upgrade also needs about as much again as
  PostHog's data, for its backup.

**Getting the script there:** copy the one file from `deploy/offline/out/` (scp, or paste it). Or,
on the machine, take it from a kit:

```bash
REG=555011114032.dkr.ecr.ca-central-1.amazonaws.com
aws ecr get-login-password --region ca-central-1 | sudo docker login -u AWS --password-stdin $REG
sudo docker run --rm --entrypoint cat $REG/posthog/kit:<tag> /kit/repo/deploy/offline/upgrade.sh > upgrade.sh
```

A script copied from `out/` uses the kit it was made with. Without that, it uses the newest kit in ECR.
A tag given as the first argument always wins.

## 2. `fresh-install.sh`: a new machine

```bash
sudo bash fresh-install.sh                 # asks for PostHog's address and the first login's email
sudo bash fresh-install.sh <kit tag>       # a particular kit
```

- **Asks two things:** the address(es) people open PostHog at, and the email for the first PostHog
  login. For no questions, set them in front: `sudo POSTHOG_ADDRESS=10.0.1.5 ADMIN_EMAIL=me@x.com YES=1 bash fresh-install.sh`.
- **Folders:** PostHog goes into `/opt/posthog`, PostHog Lens into `/opt/posthog-lens` (`POSTHOG_DIR`,
  `LENS_DIR` to change them). Settings are in `/etc/posthog-lens/posthog-lens.env`. More answers (Jira,
  Claude, ports...) can come from a file: `SETTINGS=my.env` (see `deploy/install.env.example`).
- **Takes 1-2 hours** (most of it is PostHog's first database setup, about 1,000 migrations). At the end it shows the status. The login, its password and the addresses
  are in `sudo cat /var/lib/posthog-lens-install/summary.txt`.
- **Refuses** when a PostHog already runs on the machine, so it can never install over one. Use
  script 3 there.
- **If it stops,** fix what it says and run the same command again: it continues where it stopped.

## 3. `upgrade.sh`: a machine that already runs PostHog

```bash
sudo bash upgrade.sh                       # shows what will happen, asks, then does it
sudo bash upgrade.sh <kit tag>
sudo YES=1 nohup bash upgrade.sh <kit tag> > upgrade.log 2>&1 < /dev/null &    # survives a dropped session
```

It first shows what will happen, then asks before it starts:

- **The kit has a new PostHog version:** PostHog is backed up in full, then upgraded. **PostHog is
  down for about 2-3 hours**, longer with many session replays. Then PostHog Lens is updated.
- **Same PostHog version:** only PostHog Lens and its settings are updated. This takes minutes, and
  PostHog keeps running.

**The first time on a machine** whose PostHog was set up another way (by hand, by an older kit, or with
an earlier PostHog Lens), it also sets up the `posthog-lens` command:

- **Finds the running PostHog**, or takes `POSTHOG_DIR=<its folder>`.
- **Puts PostHog Lens next to it** in `<parent>/posthog-lens` (`LENS_DIR` to change it), and copies an
  earlier PostHog Lens's settings and data from `OLD_DIR` (default `/data04/ph_ops/posthog-mcp-trial`).
- **Writes `/etc/posthog-lens/posthog-lens.env`.** On a machine with its own folder in `sites/` (prod,
  `sastraph1p`), that folder's settings are added: its addresses, Global Accelerator, apps that keep
  sending during the upgrade.

**If it stops,** run the same command again: it continues. **Needs root** (an admin), or the ops user
with these two lines added by an admin with `visudo`, after which the ops user runs
`sudo posthog-lens update <kit tag>` for later updates:

```
ph_ops ALL=(root) NOPASSWD: /usr/local/sbin/posthog-lens
ph_ops ALL=(root) NOPASSWD: /usr/local/sbin/posthog-lens *
```

**Before an upgrade to a new PostHog version:** take an EBS snapshot of the machine's disks. The
upgrade makes its own backup, but a snapshot is the way back if everything else fails.

## After scripts 2 and 3: `posthog-lens`

| Command | What it does |
|---|---|
| `sudo posthog-lens status` | what is installed, and whether PostHog and PostHog Lens answer |
| `sudo posthog-lens doctor` | PostHog Lens's full check of its settings against the running services |
| `sudo posthog-lens check [minutes]` | waits until PostHog, Lens and every status-page check are fine and prints READY, or says what is not (it waits 10 min, or 25 min in the first half hour after a boot); `upgrade.sh` and `fresh-install.sh` end with it |
| `sudo posthog-lens alert-test` | after putting a Teams or Slack webhook in `STATUS_ALERT_WEBHOOK` (deploy/status/status.env): applies it and sends a test alert |
| `sudo posthog-lens restart` | restarts PostHog Lens |
| `sudo posthog-lens update <kit tag>` | what `upgrade.sh` does, once the machine is set up |
| `sudo posthog-lens rollback` | after a PostHog upgrade: back to the PostHog from before it (about 6 minutes, then `cd <PostHog folder> && sudo docker compose up -d`) |
| `sudo posthog-lens cleanup` | after a PostHog upgrade you are happy with: deletes its backup (asks about each item). The next PostHog upgrade needs this first |

**Checks after either script:**
- `sudo posthog-lens doctor` ends with no ✘ (warnings are fine).
- `sudo docker ps --format '{{.Names}} {{.Status}}' | grep -E 'unhealthy|Restarting'` prints nothing. A
  worker can need up to 10 minutes after a start; if one is still listed after that,
  `sudo docker restart <its name>`.
- PostHog Lens opens at `http://<machine>:8080` with a PostHog login. Its System tab shows every
  container and the machine (admins, plus anyone they tick on the Admin page).

**After a reboot** everything comes back by itself, with nothing from ECR. PostHog answers 502 for
several minutes while it starts.

**Logs:** everything scripts 2 and 3 print is also in `/var/log/posthog-lens/`. The installer's own log
is in `/var/lib/posthog-lens-install/install.log`, and PostHog Lens's in `<LENS_DIR>/logs/service.log`.

## Trying it without AWS

```bash
docker run -d -p 127.0.0.1:5000:5000 registry:2
SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/build-images.sh
sudo bash deploy/offline/out/fresh-install.sh      # on the same machine: no login for a local registry
```

The three scripts were tested this way, end to end.
