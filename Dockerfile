# AnyCast: one container serving the PWA and the API.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY tools/mock-xtream/package.json tools/mock-xtream/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @anycast/web build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    BUFFER_DIR=/buffer \
    WEB_DIST=/app/apps/web/dist
VOLUME ["/data", "/buffer"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["pnpm", "--filter", "@anycast/server", "start"]
