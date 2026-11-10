# PostHog Lens as a container: the service, its MCP tools, and Chrome and ffmpeg for rendering clips.
# Built by deploy/offline/build-images.sh (pushed to ECR as posthog/lens), or by deploy/install.sh on a
# machine with internet. It runs through deploy/lens/lens.sh, which mounts the settings and the data
# folders (run/, clips/, .cache/, config/) from the project folder and runs it as the "triage" user.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

# Chrome's libraries, and fonts for pages and for comments burned into clips.
RUN apt-get update -qq \
    && apt-get install -y -qq --no-install-recommends ca-certificates curl libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libdrm2 libgbm1 libasound2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxext6 \
        libxi6 libxrender1 libx11-6 libxcb1 libdbus-1-3 libexpat1 libglib2.0-0 libpango-1.0-0 libcairo2 \
        fonts-liberation fonts-noto-core fonts-noto-color-emoji fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV CI=true \
    PUPPETEER_CACHE_DIR=/opt/puppeteer \
    COREPACK_HOME=/opt/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    LENS_CONTAINER=1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# pnpm from corepack (the version in package.json), then every package: puppeteer downloads Chrome
# (headless shell) into /opt/puppeteer, ffmpeg-static its ffmpeg. Readable by any user.
RUN corepack enable && corepack prepare --activate \
    && pnpm install --frozen-lockfile --reporter=append-only \
    && chmod -R a+rX /opt/puppeteer /opt/corepack \
    && ls /opt/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell
COPY . .
# The data folders are mounted over these at run time; empty ones keep a plain `docker run` working.
RUN mkdir -p run logs clips .cache config && chmod 777 run logs clips .cache \
    && ln -sf "$(ls -d /opt/puppeteer/chrome-headless-shell/*/chrome-headless-shell-linux64/chrome-headless-shell | head -1)" /usr/local/bin/chrome-headless-shell \
    && test -f vendor/rasterizer.cjs && test -f vendor/player.html
ENV CHROME_HEADLESS_SHELL=/usr/local/bin/chrome-headless-shell \
    HOME=/tmp \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/service/server.ts"]
