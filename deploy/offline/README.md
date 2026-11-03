# A machine without internet: everything from your ECR

The machine that runs PostHog and PostHog Lens downloads nothing from the internet. Every image comes
from your ECR, and everything else (this project, PostHog's source, the GeoIP database, Docker Compose)
comes in one more image, **the kit**. A machine that has internet puts it all there first.

```
your Ubuntu machine (internet)                 ECR (ca-central-1)              EC2 (no internet)
deploy/offline/push-images.sh   ─────────────▶  posthog/*  ─────────────────▶  docker run <kit>
  copies PostHog's 26 images                                                    sudo deploy/install.sh
  builds node, lens, status, minio, kit
```

## 1. Push (on a machine with internet)

You need **Ubuntu (x86_64) with Docker, buildx, git, python3, curl and the AWS CLI v2**, signed in to
an identity that can push to the `posthog/*` repositories in 555011114032 / ca-central-1. You also
need about 10 GB of free disk. Then, from a clone of this branch:

```bash
git clone --branch ticket-triage-amazon-linux --single-branch https://github.com/abhinavrepos/posthog-mcp-trial lens
cd lens
deploy/offline/push-images.sh --plan     # what goes where; nothing is pushed
deploy/offline/push-images.sh            # about 25 GB up the first time
```

It ends by printing the kit's name and the three commands for the EC2 machine. It also writes the kit's
name to `deploy/offline/last-kit.txt`. A second run skips everything ECR already has, so after a change
only the changed images go up, and the kit is always rebuilt.

| What | ECR repository | How |
|---|---|---|
| PostHog web, workers, migrations (and the older version the upgrade needs first) | `posthog/posthog` | copied |
| ClickHouse, Postgres, Redis, Redpanda, Zookeeper, Caddy, Elasticsearch, Temporal ×3, capture, feature flags, livestream, property-defs | their own `posthog/*` | copied |
| Everything without a repository of its own: cymbal, hypercache, personhog ×2, capture-logs, SeaweedFS, Valkey, browserless, alpine | `posthog/services`, one tag each | copied |
| PostHog's MCP server | `posthog/mcp` | copied |
| PostHog's Node image + one setting (ingestion, replays, plugins) | `posthog/node` | built |
| PostHog Lens (service, its MCP tools, Chrome, ffmpeg); the status page as `status-…` | `posthog/lens` | built, tests run in it first |
| MinIO, to copy an old PostHog's files | `posthog/minio` | built |
| The kit | `posthog/kit` | built |

**Copied** means byte for byte, for linux/amd64, then checked by digest. Nothing of PostHog's is rebuilt.
**Built** images come from the commit you have checked out (uncommitted changes are left out).

Tags are made from the content: digests for copies, git tree hashes for builds. They never change
meaning, which fits your repositories' immutable tags.

## 2. What the EC2 machine and the admin need

- **IAM:** the instance role has `AmazonEC2ContainerRegistryReadOnly`.
- **VPC endpoints:**
  - `com.amazonaws.ca-central-1.ecr.api` and `com.amazonaws.ca-central-1.ecr.dkr` (interface)
  - `com.amazonaws.ca-central-1.s3` (gateway). Image layers are stored in S3, and dnf reaches Amazon
    Linux's repositories through it.
- **Docker** on the machine (`sudo dnf install -y docker && sudo systemctl enable --now docker`) and the
  AWS CLI (already on Amazon Linux 2023).

## 3. Install or upgrade (on the EC2 machine)

```bash
REG=555011114032.dkr.ecr.ca-central-1.amazonaws.com
aws ecr get-login-password --region ca-central-1 | sudo docker login -u AWS --password-stdin $REG
sudo docker run --rm -v ~/posthog-mcp-trial:/out $REG/posthog/kit:<tag from step 1>
cd ~/posthog-mcp-trial && sudo deploy/install.sh
```

The kit writes this project into the folder you mount at `/out`. Your `.secrets.env`, the data in
`run/` and `clips/`, and the logs are kept. Its files go to `deploy/offline/kit/`, and
`deploy/offline/ecr.env` switches everything to ECR:

- **The installer** shows `Images  from 555011114032.dkr.ecr...` in its plan, and it checks the ECR
  login before it changes anything.
- **PostHog:** the install, or the upgrade of the PostHog already there (`deploy/migrate/`), takes its
  source from the kit. Every service's image comes from ECR through `docker-compose.ecr.yml` in the
  PostHog folder. It stops, listing them, if any image is not in ECR.
- **PostHog Lens** runs as a container (`posthog-lens:current`, from `posthog/lens`) through
  `deploy/lens/lens.sh`:
  - it uses this machine's network, as the `triage` user, with its data in the project folder
  - Chrome renders clips inside it, sandboxed (`deploy/lens/seccomp-chrome.json`)
  - nothing is installed on the machine for it: no Node, no Chrome libraries
- **The status page** and **PostHog's MCP server** come from ECR too.
- **No internet:** `deploy/offline/no-internet.sh` makes outside calls fail at once, as before.

**A new version** works the same way: push again, run the new kit, then run `sudo deploy/install.sh`
again.

| Command | What it does |
|---|---|
| `sudo deploy/lens/lens.sh doctor` | checks every setting against the running services |
| `sudo deploy/lens/lens.sh mcp-config` | writes `.mcp.json`. Lens's tools are reached over HTTP at `/mcp` with `MCP_TOKEN`, since there is no Node on the machine |
| `sudo deploy/lens/lens.sh test` | the test suite, inside the image |
| `sudo deploy/lens/lens.sh run sh` | a shell in the image, with the same settings and folders |
| `sudo systemctl restart ticket-triage` | restarts PostHog Lens. Logs go to `logs/service.log` |

## Rehearsing without AWS

`SKIP_AWS=1 REGISTRY=localhost:5000 deploy/offline/push-images.sh` pushes everything into a local
registry (`docker run -d -p 127.0.0.1:5000:5000 registry:2`). This is how the script was tested.
