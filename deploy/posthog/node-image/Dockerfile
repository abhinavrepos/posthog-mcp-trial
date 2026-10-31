# PostHog's Node image plus one setting, PLUGINS_DISABLED_CAPABILITIES (see disable-capabilities.js).
# Without the setting it behaves exactly like the base image.
ARG BASE=ghcr.io/posthog/posthog-node:master
FROM ${BASE}
COPY disable-capabilities.js /tmp/disable-capabilities.js
USER root
RUN grep -q '^exports.getPluginServerCapabilities = getPluginServerCapabilities;' /code/nodejs/dist/capabilities.js \
    && cat /tmp/disable-capabilities.js >> /code/nodejs/dist/capabilities.js \
    && rm /tmp/disable-capabilities.js \
    && node -e "require('/code/nodejs/dist/capabilities.js')"
USER posthog
