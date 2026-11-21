# The kit: this project (with deploy/offline/ecr.env and images.lock), PostHog's source at the pinned
# commit, the GeoIP database and Docker Compose, for a machine without internet. Built and pushed to
# posthog/kit by deploy/offline/build-images.sh; on that machine:
#   sudo docker run --rm -v ~/posthog-mcp-trial:/out <registry>/posthog/kit:<tag>
ARG BASE=alpine:3.22
FROM ${BASE}
# One layer per file, the ones that rarely change first: a new kit for the same PostHog version shares
# them with the previous kit, and a patch (save-images.sh SINCE=...) carries only the project layer.
COPY files/posthog-src.tar.gz /kit/files/
COPY files/docker-compose /kit/files/
COPY files/GeoLite2-City.mmdb /kit/files/
COPY files/GeoLite2-City.json /kit/files/
COPY unpack.sh /kit/unpack.sh
COPY repo /kit/repo
ENTRYPOINT ["/bin/sh", "/kit/unpack.sh"]
