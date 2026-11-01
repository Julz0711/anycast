# AnyCast server

The Node server behind the AnyCast web app. It syncs one Xtream Codes subscription into SQLite,
serves the `/api` routes described in `packages/shared/src/api.ts`, proxies and adapts streams with
FFmpeg, and serves the built PWA.

## Requirements

- Node 22 and pnpm
- `ffmpeg` and `ffprobe` on the `PATH`

## Configuration

Copy `.env.example` (repo root) to `.env` and fill it in. The server reads `.env` from the
working directory and from the repo root.

| Variable | Meaning |
| --- | --- |
| `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` | Your provider login. Stored encrypted (AES-256-GCM) in the database. Never sent to clients or written to logs. |
| `ANYCAST_SECRET` | 16+ random characters. The key for encrypting the provider login. Don't change it later. |
| `ANYCAST_ADMIN_USER`, `ANYCAST_ADMIN_PASSWORD` | Creates the first account on first start (only when no account exists yet). |
| `PORT` (8787), `HOST` (0.0.0.0) | Where the server listens. |
| `DATA_DIR` (`./data`) | Where the SQLite database lives. |
| `BUFFER_DIR` (`./buffer`) | Where the rolling live buffer keeps its segments. |
| `BUFFER_MAX_HOURS_PER_CHANNEL` (2), `BUFFER_MAX_GB` (20) | Buffer caps. The oldest segments are evicted first. |
| `BUFFER_GRACE_MINUTES` (10) | Keep recording this long after the last viewer leaves. |
| `BUFFER_ENABLED` (on) | Set to `0` to turn the rolling buffer off. |
| `WEB_DIST` | The built web app. Defaults to `apps/web/dist` if that folder exists. Any unknown non-API path gets `index.html`. |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy that sets `X-Forwarded-*`. |
| `LOG_LEVEL` | Pino level (`info` by default). |

## Run

```sh
pnpm install
pnpm --filter @anycast/server dev     # watch mode
pnpm --filter @anycast/server start   # plain start
```

On start, the server stores the provider login and creates the admin account if needed. It then
syncs the catalog if the last sync is older than 12 hours, and the EPG if it is older than 1 hour.
The app stays usable during a sync. `POST /api/source/sync` starts a sync right away.

To try it without a real provider, start the mock in another terminal (`pnpm mock`, which listens
on port 8899 with user and password `test`). Then point `XTREAM_URL` at `http://127.0.0.1:8899`.

## Doctor

```sh
pnpm doctor                 # human-readable report
pnpm doctor --json          # machine-readable
pnpm doctor --samples 4     # probe 4 random live channels (default 8), plus 5 movies and 3 episodes
pnpm doctor --no-streams    # skip ffprobe sampling and the timeshift test
```

The doctor talks to your provider directly, using the `XTREAM_*` values from `.env`. Its report
covers:

- the account and connections
- the timezone
- catalog sizes and the detected countries and languages
- archive coverage
- EPG coverage
- stream formats
- one timeshift test

All output goes through a central redactor, so the report contains no credentials, hostnames or
URLs. If the provider rejects the login, the doctor exits with code 2.

## Tests

```sh
pnpm --filter @anycast/server typecheck
pnpm --filter @anycast/server test
```

The integration tests start `tools/mock-xtream` in-process. They also use a small fixture panel in
`test/fixtures` that has 50k items and real-panel quirks.

## Layout

```
src/
  main.ts, app.ts         entry point; buildApp(config) for tests
  config.ts, crypto.ts    env config; AES-GCM, tokens
  redact.ts               the one credential redactor (logs, errors, doctor)
  db/                     SQLite schema and the migration runner (PRAGMA user_version)
  xtream/                 player_api client, zod schemas for messy panels, streaming XMLTV parser
  catalog/                sync (batched upserts + generation prune), tagger, read queries
  search.ts               FTS5 search (prefix tokens, folds diacritics)
  progress.ts             finished threshold, continue watching
  userdata.ts, events.ts  per-profile favorites/progress/preferences/hide rules, SSE bus
  auth/users.ts           users (argon2), sessions (sha256 of token), profiles
  playback/               caps, ffprobe cache, pipeline choice, connection pool, live fan-out,
                          HLS sessions, timeline sources, PlaybackService
  routes/                 HTTP routes
  doctor/                 provider diagnostics
```

## Playback notes

- **Stream URLs** are AnyCast paths under `/api/stream/...` and need the session cookie. Provider
  URLs never reach the client. Artwork goes through `/api/art/...`.
- **Pipeline choice** is `choosePipeline(probe, caps)`. The client sends its capabilities in the
  `x-anycast-caps` header or the `caps` query parameter, as `{hls, mse, codecs}`. The server uses:
  - **file passthrough** for MP4 H.264/AAC
  - **raw TS** for live H.264/AAC when the client has MSE
  - **HLS** (fMP4) with stream copy otherwise, with AAC audio when the client can't decode the
    audio, and with libx264 when it can't decode the video
- **Connections:** viewers of the same live channel share one upstream connection. When the
  provider's `max_connections` are all in use, the API answers
  `429 {error: "connection_limit", message}`.
- **VOD seeking:** the playlist covers the whole duration from the start, in fixed 6 s slots.
  Asking for a slot the current FFmpeg run won't reach soon restarts FFmpeg at that slot (`-ss`).
  `-copyts` with `movflags=+frag_discont` keeps each segment's real media time. Runs that get far
  ahead of playback are paused. A session ends after 60 s without requests.
- **Timeline:** ranges come from `TimelineSource`s: the provider archive and the rolling buffer.
  Where both cover a moment the buffer wins. Gaps carry a reason (`This channel has no archive
  before 21:03`, `Stream dropped`, `Not recorded: nobody was watching`, ...).
- **Rolling buffer** (`playback/buffer.ts`): while a live channel is watched, a recorder taps the
  channel's fan-out (no second provider connection) and runs `ffmpeg -c copy -copyts -f segment`
  into `BUFFER_DIR/<channel>/<run>/<seq>.ts`. Each finished segment is indexed in SQLite
  (`buffer_segments`) with its wall-clock span (PTS anchored to the clock as segments complete).
  Recording continues for the grace period after the last viewer leaves. Pinned channels
  (`PUT /api/buffer/pins`) record all the time; at most `max_connections - 1` can be pinned.
  `GET /api/play/live/:id/at` serves buffered times as a growing EVENT playlist of the recorded
  TS segments (or through FFmpeg when the client needs other codecs). On start the index is checked
  against the disk: unmatched rows and files are removed. `GET /api/buffer/status` reports it all.
