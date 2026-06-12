# jonobones — a headless, Joplin-sync-compatible knowledge daemon.
# Docker is for CI/server deployment; the normal install is
# `npm install -g jonobones`.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build

FROM node:24-slim
LABEL org.opencontainers.image.source="https://github.com/ParkviewLab/jonobones" \
      org.opencontainers.image.description="A headless, Joplin-sync-compatible knowledge daemon" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/ dist/
COPY bin/ bin/
COPY LICENSE README.md ./

# The profile (config.json5, lock.json, events.sqlite, joplin/) lives on a
# volume. Configure via JONOBONES_* env vars or a config.json5 in /data —
# e.g. JONOBONES_API_TOKEN, JONOBONES_SYNC_TARGET, JONOBONES_SYNC_PATH.
VOLUME /data

# Inside the container the daemon must bind beyond loopback; publish the
# port back to loopback on the host (-p 127.0.0.1:26637:26637) to keep the
# localhost-only security model.
ENV JONOBONES_API_BIND=0.0.0.0
EXPOSE 26637

ENTRYPOINT ["node", "bin/jonobones.js"]
CMD ["start", "--profile", "/data"]
