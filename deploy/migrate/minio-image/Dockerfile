# MinIO RELEASE.2025-04-22T22-12-26Z as a drop-in for the official image, which MinIO no longer
# publishes (Docker Hub, quay.io and dl.min.io all removed it when the open-source project was archived).
# PostHog's 2025 hobby install and its migrate-storage-hobby script both need that exact image.
#
# The server binary comes from Bitnami's archived image of the same release: its `minio --version` is
# commit 0d7408fc9969caf07de6a8c3a84f9fbb10a6739e, the commit MinIO's RELEASE.2025-04-22T22-12-26Z tag
# points to. This file only makes it start like the official image: as root, with "minio" put in front
# of arguments such as `server --address :19000 /data`, and with minio on the PATH.
#
#   docker build -t quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z .
#   docker tag quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z minio/minio:RELEASE.2025-04-22T22-12-26Z
FROM docker.io/bitnamilegacy/minio:2025.4.22
USER root
RUN ln -sf /opt/bitnami/minio/bin/minio /usr/bin/minio \
    && printf '#!/bin/sh\nif [ "${1}" != "minio" ] && [ -n "${1}" ]; then set -- minio "$@"; fi\nexec "$@"\n' > /usr/bin/docker-entrypoint.sh \
    && chmod +x /usr/bin/docker-entrypoint.sh
ENV MINIO_ROOT_USER= MINIO_ROOT_PASSWORD=
EXPOSE 9000
VOLUME ["/data"]
ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
