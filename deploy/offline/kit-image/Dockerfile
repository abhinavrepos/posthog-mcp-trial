# The kit: this project (with deploy/offline/ecr.env and images.lock), PostHog's source at the pinned
# commit, the GeoIP database and Docker Compose, for a machine without internet. Built and pushed to
# posthog/kit by deploy/offline/build-images.sh; on that machine:
#   sudo docker run --rm -v ~/posthog-mcp-trial:/out <registry>/posthog/kit:<tag>
ARG BASE=alpine:3.22
FROM ${BASE}
COPY repo /kit/repo
COPY files /kit/files
COPY unpack.sh /kit/unpack.sh
ENTRYPOINT ["/bin/sh", "/kit/unpack.sh"]
