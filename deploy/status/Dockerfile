# PostHog Lens status page: one small image, no dependencies beyond Node.
#   docker build -t posthog-lens-status deploy/status      (or: deploy/status/up.sh)
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
WORKDIR /app
COPY server.mjs .
ENV NODE_ENV=production
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://127.0.0.1:8090/self || exit 1
CMD ["node", "server.mjs"]
