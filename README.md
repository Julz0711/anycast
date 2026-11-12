# AnyCast

A self-hosted IPTV player for your own Xtream Codes subscription. One server brings live TV, movies, series, and the TV guide to an installable web app across your devices.

[Features](#features) · [Quick start](#quick-start) · [Configuration](#configuration-and-data) · [Development](#development) · [Testing](#testing)

## Features

| Area | What you get |
| --- | --- |
| Live TV | Channel lists, a guide grid, quick zapping, and custom ordered lists. |
| Rewind | Provider catch-up plus a rolling server-side buffer; pinned channels can buffer continuously. |
| Movies and series | Resume playback, continue watching, next-episode autoplay, and thumbnails for played sections. |
| Catalog | Grouped quality variants, alternate-stream fallback, cleaned titles, sorting, filters, and cached artwork. |
| Discovery | Recently added titles, followed-series updates, movie details, Watch Later, and swipe-to-pick browsing. |
| Profiles | Separate favorites, lists, progress, preferences, language filters, and optional PINs, synced across devices. |
| Parental controls | Per-profile adult-content visibility and PIN restrictions enforced by the server. |
| Watch recap | Profile-based viewing summaries, top titles, genres, streaks, and viewing patterns. |
| Playback | FFmpeg remuxing or transcoding when needed for the receiving device. |

Your provider credentials are encrypted on the server. AnyCast needs a provider subscription; it does not include channels or media.

## Quick start

Requirements: **Docker with the Compose plugin**, plus your Xtream provider details.

```sh
git clone https://github.com/Julz0711/anycast.git
cd anycast
cp .env.example .env
```

Edit `.env` before starting:

| Variable | Purpose |
| --- | --- |
| `ANYCAST_SECRET` | A stable random encryption secret, for example generated with `openssl rand -hex 32`. |
| `ANYCAST_ADMIN_USER` | Initial administrator username. |
| `ANYCAST_ADMIN_PASSWORD` | Initial administrator password. |
| `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` | Optional provider details; these can also be entered in the app. |

```sh
docker compose up -d --build
```

Open `http://<server>:8787`, sign in, enter your provider if needed, and select your preferred languages. Catalog synchronization runs in the background.

To update, pull the latest source and rebuild:

```sh
git pull
docker compose up -d --build
```

For CasaOS, hardware transcoding, and HTTPS setup, see [docs/casaos.md](docs/casaos.md).

## Configuration and data

- **Persistent app data:** the `anycast-data` Docker volume stores the database, profile data, settings, and related server files.
- **Live buffer:** `anycast-buffer` stores recorded segments for rewind.
- **Encryption:** preserve `ANYCAST_SECRET`; changing it prevents existing encrypted provider credentials from being decrypted.
- **Limits and hosting:** buffer caps, hardware acceleration, reverse proxy settings, backups, and logging are documented in the [server guide](apps/server/README.md#configuration).
- **Viewing history:** profile settings can disable watch-history collection or clear it.

Catch-up availability depends on your provider. Buffer duration and storage limits depend on server configuration. Stream concurrency is also constrained by your subscription.

## Provider diagnostics

The doctor checks account status, connection limits, catalogs, guide/archive coverage, stream formats, and a timeshift sample.

Use **Node.js 22+** and **pnpm 10**:

```sh
pnpm install
pnpm run doctor
```

Run it on the machine containing your own `.env`. Optional flags include `--json`, `--samples 4`, and `--no-streams`. FFprobe is optional for diagnostics; without it the stream-format section is skipped.

Use `pnpm run doctor`: `pnpm doctor` invokes pnpm's own command. Diagnostic output redacts provider credentials, hostnames, and URLs. Do not include provider credentials in issues or support requests.

## Development

Requirements: **Node.js 22+**, **pnpm 10**, and **ffmpeg/ffprobe** on `PATH`.

```sh
pnpm install
cp .env.example .env
```

Set the encryption secret and initial admin credentials as in Quick start. For development without a real provider, use the bundled mock:

```dotenv
XTREAM_URL=http://127.0.0.1:8899
XTREAM_USERNAME=test
XTREAM_PASSWORD=test
```

Run `pnpm mock` in one terminal, then `pnpm dev` in another. The mock listens on **8899**, the API on **8787**, and Vite on **5173**.

With a real provider configured, skip the mock. To explore fixture data without the server, open `http://localhost:5173/?demo=1` while the web app is running; if prompted, use any name and password `demo`.

## Testing

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check every package, including end-to-end specs. |
| `pnpm test` | Run unit and integration tests. |
| `pnpm e2e` | Build the web app and run Playwright scenarios. |
| `pnpm --filter @anycast/web build` | Build the web client. |
| `pnpm build` | Build workspace packages. |

Install Playwright Chromium once with `pnpm --filter @anycast/web exec playwright install chromium`.

The end-to-end suite launches a mock provider and server using temporary data directories and free ports. It covers playback, rewind, resume, profiles, catalog filters, guide catch-up, live synchronization, and provider connection limits. Set `E2E_DEBUG=1` to show mock/server logs.

## Architecture

| Path | Responsibility |
| --- | --- |
| [apps/server/](apps/server/) | Fastify/SQLite API, provider sync, profiles, playback, buffering, and diagnostics. |
| [apps/web/](apps/web/) | React PWA, browsing, player, and Playwright tests. |
| [packages/shared/](packages/shared/) | Shared API contracts, types, and preferences. |
| [tools/mock-xtream/](tools/mock-xtream/) | Synthetic provider for development and tests. |
| [Dockerfile](Dockerfile) | Image serving the API and built web app. |
| [docker-compose.yml](docker-compose.yml) | Service, ports, data volumes, and CasaOS metadata. |

More detail: [server guide](apps/server/README.md) · [mock-provider guide](tools/mock-xtream/README.md).
