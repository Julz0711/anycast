# AnyCast: one container serving the PWA and the API.
# Both stages use Debian bookworm (glibc), so the native modules (better-sqlite3, argon2)
# built or downloaded in the build stage run unchanged in the runtime stage.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/mock-xtream/package.json tools/mock-xtream/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @anycast/web build
# Runtime dependencies only: the server (which runs TypeScript with tsx) and the shared package.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules tools/*/node_modules \
 && pnpm install --frozen-lockfile --prod --filter "@anycast/server..."
# fail the build here, not at runtime, if a native module did not build
RUN cd apps/server && node -e "require('better-sqlite3')(':memory:').close(); require('@node-rs/argon2'); require('tsx/esm/api')" \
 && node --import tsx -e "0"

FROM node:22-bookworm-slim
# Hardware encoding (used only when /dev/dri or an NVIDIA GPU is passed in; see docs/casaos.md).
# Debian's FFmpeg already has VAAPI, QSV and NVENC built in; the GPU drivers are separate:
# VAAPI for AMD (mesa) and Intel (iHD, the non-free build, which can encode on every generation
# it supports), the Quick Sync runtime for newer Intel GPUs, and vainfo to check the device.
# NVENC needs nothing here: the NVIDIA container toolkit brings the driver libraries.
# The Quick Sync runtime (Gen12+) is best effort: QSV is only a fallback behind VAAPI.
# They add roughly 50 MB; build with --build-arg HWACCEL_DRIVERS=0 to leave them out.
ARG HWACCEL_DRIVERS=1
RUN set -eux; \
    pkgs="ffmpeg ca-certificates tini"; \
    if [ "$HWACCEL_DRIVERS" = "1" ]; then \
      pkgs="$pkgs vainfo mesa-va-drivers"; \
      if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
        sed -i 's/^Components: main$/Components: main non-free/' /etc/apt/sources.list.d/debian.sources; \
        pkgs="$pkgs intel-media-va-driver-non-free"; \
      fi; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends $pkgs; \
    if [ "$HWACCEL_DRIVERS" = "1" ] && [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends libmfx-gen1.2 || echo "libmfx-gen1.2 not available, QSV on newer Intel GPUs will fall back to VAAPI"; \
    fi; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    ANYCAST_HWACCEL=auto \
    PORT=8787 \
    DATA_DIR=/data \
    BUFFER_DIR=/buffer \
    WEB_DIST=/app/apps/web/dist
VOLUME ["/data", "/buffer"]
EXPOSE 8787
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# node loads tsx itself: the tsx CLI would add a second node process (~55 MB) just to relay
# signals. A smaller young generation keeps the heap ~35 MB lower after a big sync at no cost in speed.
CMD ["node", "--max-semi-space-size=4", "--import", "tsx", "src/main.ts"]
