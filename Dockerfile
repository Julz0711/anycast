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
RUN cd apps/server && node -e "require('better-sqlite3')(':memory:').close(); require('@node-rs/argon2'); require('tsx/esm/api')"

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    BUFFER_DIR=/buffer \
    WEB_DIST=/app/apps/web/dist
VOLUME ["/data", "/buffer"]
EXPOSE 8787
WORKDIR /app/apps/server
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "src/main.ts"]
