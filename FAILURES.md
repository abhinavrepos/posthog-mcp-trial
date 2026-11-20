# Failure log: load-test rehearsal on the offline Ubuntu VM (20 Nov 2026)

What went wrong while rehearsing today's deployment and load test, what caused it, and what was done.
Newest first. Times are UTC.

## 3. Status page could not reach Lens behind ufw (04:10, fixed 04:12)

- Fresh install on the main machine finished at 04:07 (58 min of PostHog's first database setup).
  `posthog-lens check` then said: *Lens: Triage service: Health endpoint did not respond within 8 s*,
  although Lens answered on the machine itself.
- Cause: this machine runs **ufw with a default-deny INPUT policy**. The status service runs in a container
  and reaches Lens on the host (`host.docker.internal:8080`, via the Docker bridge); ufw dropped that.
- Fix here: `iptables -I INPUT -i docker0|br+ -p tcp --dport 8080 -j ACCEPT` (comment `lens-loadtest`).
  After that: `READY: PostHog, PostHog Lens and every status-page check are fine.`
- **For production:** if the server has ufw (or another firewall) with default deny, the System page will
  wrongly show Lens as down. Allow port 8080 from the Docker networks, e.g.
  `sudo ufw allow in on docker0 to any port 8080 proto tcp` and the same for the compose bridge
  (`br-…`), or the equivalent iptables rule. Follow-up: make `posthog-lens doctor` detect and explain it.

## 2. Moving the load test to the main machine (02:45)

- At the owner's request the rehearsal VM (`/var/lib/ubuntu-vm`, ~104 GB disk, 16 GB RAM) was shut down
  cleanly and deleted, and the load test moved to the main machine (8 cores, 30 GB RAM, 112 GB free
  after the VM went).
- `fresh-install.sh` stops on this machine's OS: the installer accepts only Ubuntu 24.04 or Amazon Linux
  2023, and the main machine runs Ubuntu 26.10. For this test only, the unpacked copy in
  `/opt/posthog-lens/deploy/install.sh` was patched locally to accept it (`ALLOW_ANY_UBUNTU=1`); the
  repository is unchanged. PostHog's own installer already accepts any Ubuntu.
- The installer reported that Lens would listen on the machine's public address. Ports 8080 and 8090 were
  closed to the public interface with `iptables -I INPUT -i enp1s0 ... -j DROP` (comment `lens-loadtest`;
  remove after the test). PostHog's published ports 80/443 were already unreachable from outside through
  an earlier `DOCKER-USER` rule (comment `lens-test`).
- Today's deployment is not affected: the target is Ubuntu 24.04 and goes through `upgrade.sh`.

## 1. Event capture crash-looping for about 45 hours (found 02:20, fixed 02:35)

**What was seen.** On the offline Ubuntu VM (PostHog + Lens, the production rehearsal machine), three
PostHog services were restarting every minute or so, with exit code 137:

| Container | Restarts | Created |
|---|---|---|
| posthog-capture-1 (analytics events) | 2,266 | 13 Nov |
| posthog-replay-capture-1 (session replays) | 2,184 | 13 Nov |
| posthog-capture-ai-1 | similar | 13 Nov |

While this lasted, PostHog accepted no events and no replays (the proxy health check answered nothing).

**What it was not** (each checked):
- Not out of memory: Docker's OOM flag was false, the container's memory cgroup recorded 0 OOM kills,
  it used 6.5 MB, and the kernel log has no OOM kill since 18 Nov 19:52 (those killed PostHog's web
  process, not capture).
- Not Docker killing it: Docker's event stream shows only `start` then `die` (137) about 2 s later, with no
  `kill`.
- Not the image or the settings: the same image, environment, user (`nobody`), network, network alias and
  the offline host mapping (`extra_hosts`) run fine when started by hand.
- Not Lens's tuning: `docker-compose.lens-tuning.yml` does not touch capture.
- Not the pinned PostHog version changing: `deploy/migrate/versions` is identical between the VM's kit
  (5a3a086) and today's (4076eee).

**What fixed it.** Recreating the containers through Docker Compose
(`docker compose ... up -d --no-deps --force-recreate capture replay-capture capture-ai`). The new
containers run normally; PostHog's health check answers 200 and a test event is accepted.

**Probable cause (not proven).** The containers were created on 13 Nov and ran for days; about 45 h ago
(around 18 Nov 05:30, the VM's last Lens upgrade, and before two host out-of-memory kills that evening)
something left them in a state where every restart of the *same* container dies 2 s after start. A fresh
container from the same definition does not. Docker also logged "multiple images have the same target,
but one of them is still dangling" for the capture image at that time.

**What this means for today's deployment.**
- The production upgrade recreates PostHog's containers when the PostHog version changes (it does today:
  the 2025 install moves to the pinned version), so this exact state should not carry over.
- If a PostHog service ever keeps restarting, the System page shows it under Needs attention ("restarting
  (N restarts)"), and the fix to try first is recreating that service:
  `cd /opt/posthog && sudo docker compose -p posthog <the -f files> up -d --no-deps --force-recreate <service>`
- Follow-up: let `posthog-lens doctor` detect a restart loop and print that command.
