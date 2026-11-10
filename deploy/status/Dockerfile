# PostHog Lens status page, for a machine that builds it itself (deploy/status/up.sh). With images from
# ECR it runs from the PostHog Lens image instead (same folder, same user), so there is no separate image.
#   docker build -t posthog-lens-status deploy/status
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app/deploy/status
COPY server.mjs .
ENV NODE_ENV=production
USER node
EXPOSE 8090
CMD ["node", "server.mjs"]
