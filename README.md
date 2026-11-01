# AnyCast

AnyCast is a self-hosted IPTV player for your own Xtream Codes subscription. One small server
syncs your provider's channels, movies, series and TV guide, and serves a fast web app (an
installable PWA) to every device in the house: phone, laptop, tablet and TV browser.

- **Live TV** as a simple channel list or a full guide grid, with quick zapping.
- **Rewind and catch-up:** a timeline per channel built from the provider's archive and a rolling
  buffer the server records while you watch. Pinned channels keep a buffer all the time.
- **Movies and series** with resume, continue watching and autoplay of the next episode.
- **Profiles** with their own favorites, progress, settings and language filters, synced live
  across devices.
- **Plays anywhere:** the server remuxes or transcodes with FFmpeg only what a device can't play.
- **Your login stays on your server.** The provider URL, username and password are stored
  encrypted and never reach a browser, a log line or a diagnostic report.

## Quick start (Docker Compose)

You need Docker with the Compose plugin.

```sh
git clone <this repo> anycast && cd anycast
cp .env.example .env
```

Edit `.env` on the machine that runs AnyCast:

- `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD`: your provider login.
- `ANYCAST_SECRET`: a long random string, for example from `openssl rand -hex 32`. It encrypts the
  stored provider login, so don't change it later.
- `ANYCAST_ADMIN_USER`, `ANYCAST_ADMIN_PASSWORD`: the first account, created on the first start.

Then:

```sh
docker compose up -d --build
```

Open `http://<server>:8787`, sign in with the admin account and pick the languages you watch. The
first catalog sync runs in the background and usually takes under a minute. The database lives in
the `anycast-data` volume and the live buffer in `anycast-buffer`. All server settings (buffer caps,
reverse proxy, log level) are listed in [apps/server/README.md](apps/server/README.md#configuration).

To update: `git pull && docker compose up -d --build`.

## Check your provider: `pnpm run doctor`

The doctor talks to your provider and reports what AnyCast will find there: account status and
connection limit, timezone, catalog sizes, countries and languages, archive and EPG coverage,
stream formats and one timeshift test.

```sh
pnpm install
pnpm run doctor          # or: pnpm run doctor -- --json  (also --samples 4, --no-streams)
```

You need Node 22+ and pnpm. FFmpeg (for `ffprobe`) is optional: without it the stream-format
section is skipped. Use `pnpm run doctor`, not `pnpm doctor`: the short form runs pnpm's own built-in `doctor` command, which
prints nothing.

**Run it on your own machine**, with your login in your own `.env`. The report contains no
credentials, hostnames or URLs, so it is safe to share when you ask for help. **Never paste your
provider login anywhere**: not in an issue, a chat or a support request. Nobody needs it to help
you; the doctor report has what they need.

## Development

Requirements: Node 22, pnpm 10 (`corepack enable`), and `ffmpeg`/`ffprobe` on the `PATH`.

```sh
pnpm install
cp .env.example .env
```

For development you don't need a real provider. Point `.env` at the bundled mock:

```sh
XTREAM_URL=http://127.0.0.1:8899
XTREAM_USERNAME=test
XTREAM_PASSWORD=test
```

Then `pnpm dev` starts everything in watch mode:

- the mock provider on `:8899` (synthetic channels, movies and series generated with FFmpeg),
- the server on `:8787`,
- the web app on `http://localhost:5173` (Vite, proxying `/api` to the server).

Each part also runs alone: `pnpm mock`, `pnpm --filter @anycast/server dev`,
`pnpm --filter @anycast/web dev`. The web app also has a demo mode with fixture data and no
server: open `http://localhost:5173/?demo=1` (if asked to sign in: any name, password `demo`).

## Repository layout

```
packages/shared      API contract (routes, types, preferences) shared by server and web
apps/server          Fastify + SQLite server: sync, search, profiles, playback, live buffer, doctor
apps/web             React PWA ("Ribbon" design); e2e/ holds the Playwright suite
tools/mock-xtream    Fake Xtream provider for development and tests
Dockerfile           One image serving the API and the built web app
docker-compose.yml   The same, with volumes for data and buffer
```

More detail: [server](apps/server/README.md), [mock provider](tools/mock-xtream/README.md).

## Testing

```sh
pnpm typecheck                      # every package, including the e2e specs
pnpm test                           # unit and integration tests (Vitest; server tests start the mock in-process)
pnpm e2e                            # builds the web app, then runs the Playwright suite
pnpm --filter @anycast/web build    # production build
```

The end-to-end suite starts the mock (small catalog) and the server on free ports, with a
temporary data and buffer directory, and drives Chromium through the main scenarios: rewinding to
a missed start, resuming a movie on another device, binge-watching with the next-episode countdown,
filtering languages in the first-run setup, zapping with the keyboard, playing a past programme
from the guide, and realtime sync of favorites and accent color. It needs Playwright's Chromium
(`pnpm --filter @anycast/web exec playwright install chromium` once). Set `E2E_DEBUG=1` to see the
mock and server logs. CI runs all of the above on every pull request.
