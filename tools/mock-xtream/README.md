# @anycast/mock-xtream

A fake Xtream Codes IPTV panel for AnyCast development and tests. It answers like a real panel,
including the messy parts: numbers sent as strings, prefixes written five different ways, missing
EPG ids, connection limits, expired accounts and broken EPG. All content is synthetic and generated
on the fly with FFmpeg.

```sh
pnpm --filter @anycast/mock-xtream start                 # http://0.0.0.0:8899, user test / test, full catalog
SIZE=small PORT=9000 pnpm --filter @anycast/mock-xtream start
pnpm --filter @anycast/mock-xtream start -- --size small --username demo --password demo --max-connections 3
```

| Env / flag | Default | |
|---|---|---|
| `PORT` / `--port` | 8899 | |
| `HOST` / `--host` | 0.0.0.0 | (`createMockXtream` defaults to 127.0.0.1) |
| `USERNAME`, `PASSWORD` (or `MOCK_USERNAME`, `MOCK_PASSWORD`, which win; Windows always sets `USERNAME`) | test / test | |
| `SIZE` / `--size` | full | `full` = 2000 live, 5000 movies, 500 series; `small` = 60 / 100 / 20; `huge` = 19,810 / 139,250 / 35,663 (see below); `real` = like `huge` with a full guide |
| `MAX_CONNECTIONS` / `--max-connections` | 2 | |
| `SEED` / `--seed` | 42 | |
| `MOCK_TIMEZONE` / `--timezone` | Europe/Berlin | panel timezone (`server_info.timezone`) |
| `FFMPEG_PATH`, `MOCK_FONT_FILE`, `MOCK_DEBUG=1` | | override ffmpeg binary / font; log ffmpeg errors |

## Programmatic use

```ts
import { createMockXtream, FORMAT_MATRIX, expectedTags } from '@anycast/mock-xtream'; // add "@anycast/mock-xtream": "workspace:*" as a devDependency

const mock = await createMockXtream({ size: 'small' });   // port 0 = random free port
// mock.url, mock.port, mock.catalog, mock.setFaults({...}), mock.state(), await mock.reset(), await mock.close()
```

Options: `{ port?, host?, username?, password?, size?: 'full'|'small'|'huge'|'real', maxConnections? (2), seed? (42),
now?: () => number (ms), faults?: Partial<Faults>, timezone? ('Europe/Berlin'), xmltvOffsets? (true), cacheDir?, logger? }`.
`xmltvOffsets: false` writes XMLTV times without a UTC offset (bare panel-local time), like some panels.

## Endpoints

Everything except `/images` and `/__mock` checks the credentials.

| Endpoint | Notes |
|---|---|
| `GET /player_api.php?username&password` | `user_info` + `server_info`. Wrong credentials: `{"user_info":{"auth":0}}` (HTTP 200, like real panels). |
| `…&action=get_live_categories` / `get_vod_categories` / `get_series_categories` | `[{category_id:"1", category_name, parent_id:0}]` |
| `…&action=get_live_streams[&category_id]` | `tv_archive_duration` is sometimes a string, sometimes a number; `epg_channel_id` is sometimes `null` or `""` |
| `…&action=get_vod_streams[&category_id]`, `get_vod_info&vod_id` | `rating` is `""`, `"7.2"` or `7.2` |
| `…&action=get_series[&category_id]`, `get_series_info&series_id` | half the series return `seasons: []` |
| `…&action=get_short_epg&stream_id[&limit=4]` | current and upcoming programmes, base64 title/description |
| `…&action=get_simple_data_table&stream_id` | archive window to +2 days, with `has_archive` and `now_playing` |
| unknown action | `[]` |
| `GET /xmltv.php?username&password` | streamed XMLTV, 7 days back to 2 days ahead. Variants of a channel share an `epg_channel_id`, so each id appears once. |
| `GET /get.php?username&password&type=m3u_plus&output=ts\|m3u8` | M3U playlist (live, movies, episodes) |
| `GET /live/{u}/{p}/{id}.ts`, `/live/{u}/{p}/{id}`, `/{u}/{p}/{id}` | endless realtime MPEG-TS, one ffmpeg per viewer |
| `GET /live/{u}/{p}/{id}.m3u8` | HLS live. One shared ffmpeg per channel writes 4 s segments to a temp dir; segments are served from `/hls/{u}/{p}/{id}/seg_N.ts`. The generator is killed and the dir removed after 30 s without requests. The first playlist takes about 4 s. |
| `GET /timeshift/{u}/{p}/{minutes}/{YYYY-MM-DD:HH-MM}/{id}.ts` | archive playback, faster than realtime, length `min(minutes, now - start)` |
| `GET /streaming/timeshift.php?username&password&stream&start&duration` | same |
| `GET /movie/{u}/{p}/{id}.{ext}`, `/series/{u}/{p}/{episodeId}.{ext}` | VOD fixture files with HTTP `Range` support (`206`, suffix ranges, `416`). The extension is ignored. |
| `GET /images/{slug}.png` | generated icons |
| `GET /__mock/state` | active connections, HLS channels, faults, catalog counts, ffmpeg capabilities |
| `GET\|POST /__mock/faults` | read / merge fault switches (JSON body) |
| `POST /__mock/reset` | faults back to the creation options, all open streams aborted, sessions cleared |

### Times and timezone

The panel timezone is `Europe/Berlin` (configurable), as in `server_info.timezone`. EPG `start`/`end`
strings, `time_now`, XMLTV offsets, timeshift URLs and the burned-in clock all use panel local time.
`*_timestamp` fields are unix seconds.

### Errors (empty bodies, like real panels)

| Case | Status |
|---|---|
| wrong credentials on a stream, account expired | `403` |
| connection limit reached | `509` (set `faults.connectionLimitStatus` to `403` to mimic panels that use 403) |
| unknown id, channel without archive, timeshift start in the future or outside `tv_archive_duration` days | `404` |

Stream responses also carry an `X-Mock-Error` header that says why.

## Clock and timecode verification

Every video shows the item name and a large clock of the **content time** (HH:MM:SS), with the date
and timezone below it. Live and timeshift clocks show panel local time. VOD clocks show the playback
position from 00:00:00. There is also a moving box, and the audio beeps once a second.

There are three machine-checkable ways to read the content time:

1. **Response headers** on live and timeshift streams:
   `X-Mock-Content-Start` (unix seconds of the first frame), `X-Mock-Content-Start-Local`
   (`YYYY-MM-DD HH:MM:SS`, panel time), `X-Mock-Pts-Offset`, `X-Mock-Profile`, plus `X-Mock-Duration`
   on timeshift and VOD.
2. **PTS of day** (live, timeshift and HLS): the first video PTS, in seconds, equals the content start
   as **seconds since local midnight** in the panel timezone. A frame with PTS `p` shows
   `startOfLocalDay + p`. Example: a timeshift request for `2026-11-01:20-15` returns a first video
   packet with `pts_time = 72900.0` (20×3600 + 15×60). To check it:
   `ffprobe -select_streams v:0 -show_entries packet=pts_time -read_intervals %+#1 file.ts`.
   (90 kHz PTS wraps at about 26.5 h, so seconds of day always fit.) The TS program also carries
   `service_name` = channel name and `service_provider` = `AnyCast Mock`.
3. **VOD**: PTS starts at 0 and equals the position shown by the clock. Generated subtitles say
   `Subtitle HH:MM:SS` / `Untertitel HH:MM:SS` every 10 s, so subtitle sync can be checked too.

The burned-in clock needs ffmpeg's `drawtext` (libfreetype) and a font. The mock tries DejaVu, Free,
Liberation and Arial paths, or uses `MOCK_FONT_FILE`. Without them it still streams (only the moving
box, no text) and the header and PTS conventions still work. `GET /__mock/state` → `ffmpeg.drawtext`
reports which mode is active.

## Format matrix

Profiles are assigned by catalog position. Ids and profiles do not depend on the seed, and the small
catalog is a prefix of the full one, so `FORMAT_MATRIX` ids work for every size and seed.

| Profile | Container | Video | Audio | Subtitles | Assignment |
|---|---|---|---|---|---|
| `mp4_h264_aac` | mp4 (faststart) | H.264 | AAC | | movies `index % 5 == 0` |
| `mkv_hevc_ac3` | mkv | HEVC | AC3 | | `== 1` |
| `mkv_h264_eac3_multi` | mkv | H.264 | EAC3 deu (default) + EAC3 eng | SRT deu + SRT eng | `== 2` |
| `mkv_h264_dts` | mkv | H.264 | DTS (ffmpeg `dca`, experimental; falls back to AC3 if the encoder is missing) | | `== 3` |
| `ts_h264_aac` | ts | H.264 | AAC | | `== 4` |
| `live_h264_aac` | ts | H.264 | AAC | | live, default |
| `live_hevc_aac` | ts | HEVC | AAC | | live `index % 10 == 3` |
| `live_h264_ac3` | ts | H.264 | AC3 | | live `index % 10 == 7` |

Episodes cycle through the VOD profiles too. `FORMAT_MATRIX` lists each `{kind, id (profile),
container, video, audio, subtitles, ids, durations}`.

Each VOD item is generated on first request into `os.tmpdir()/anycast-mock-cache/vod`. Generation is
cached, deduplicated, and limited to 2 at a time. Items are 640×360, 10 fps, about 250 kbit/s, and
120, 180 or 240 s long (`120 + (id % 3) * 60`). The `duration_secs` reported by the API is exactly
the real file length. A first request waits for generation: about 3–8 s.

Live encoding is 640×360 at 10 fps, ultrafast/zerolatency, about 250 kbit/s, with a 440 Hz beeping
sine. A live viewer costs a few percent of one core.

## Catalog and tag ground truth

Names are written the ways providers write them: `DE | ARD HD`, `UK: BBC One`, `[FR] TF1`,
`|EN| Sky Sports 1 FHD`, `NL - NPO 1`, `ES ▎ La 1`, `TR: TRT 1`, `AR | MBC 1`, `PL ● TVP 1`, `🇩🇪 ZDF`,
`VIP | 4K Movies`, `SPORTS | beIN 1`, `XXX | Adult`, plus quality suffixes (`FHD`, `ᴴᴰ`, `+1`,
`(BACKUP)`, …). Each region has a primary style (about 85%) and alternates. About 40% of channels
have an archive (1–7 days), and about 10% have no `epg_channel_id`.

The `huge` size has the shape of a large real panel: 19,810 channels in 522 categories, 139,250
movies in 145 and 35,663 series in 128 (generated categories such as `DE | REGIONAL 3` fill up
each region). About 3.2% of channels have an archive (mostly 1 day, a few 3 days), about 20% have
an `epg_channel_id`, and about a fifth of those ids have no programmes in the guide, so roughly 16%
of channels show something "now". Building it takes a few seconds and about 700 MB of memory. The
first 60 channels keep the ids and format profiles of `small`.

The `real` size has the same items and categories as `huge`, but every `epg_channel_id` belongs to
one channel and has programmes: about 4,000 guide channels, 7 days back and 2 days ahead, which is
a ~240 MB XMLTV served in about 5 s. It is what `pnpm run perf` measures against.

`expectedTags(name)` returns `{ country, language, adult }` for any category or item name the mock
produced. `country` is ISO‑3166 alpha‑2 lowercase (`UK` → `gb`), `language` is ISO‑639‑1, and each is
`null` when the name cannot tell. Conventions:

- `EN` is a language: `{country: null, language: 'en'}`. `AR` means Arabic, not Argentina:
  `{null, 'ar'}`. `US`/`USA` gives `{'us', 'en'}`. `ALB` gives `{'al', 'sq'}`.
- `VIP |`, `SPORTS |`, `PPV`, `4K UHD MOVIES` and `NETFLIX … (MULTI-SUB)` give `{null, null}`.
- `XXX | …` sets `adult: true`.
- Tags come from the name only. An unprefixed movie inside `NETFLIX MOVIES (MULTI-SUB)` is
  `{null, null}`.

Every catalog entity also carries its `tags`, e.g. `mock.catalog.live[0].tags`.

## Faults

Set them with `createMockXtream({ faults })`, `mock.setFaults(patch)`, or `POST /__mock/faults`
with a JSON body. Unknown keys and wrong types get a `400`.

| Fault | Effect |
|---|---|
| `slowStartMs` | delay before the first byte of any stream (the connection already counts) |
| `dropAfterSeconds` | destroy stream sockets after N seconds |
| `connectionLimitReached` | every new stream gets the limit status |
| `expired` | `status: "Expired"`, `exp_date` 2 days ago, streams get `403` (the API still returns `auth: 1`) |
| `brokenEpg` | `get_short_epg` returns truncated JSON, `get_simple_data_table` returns `[]`, XMLTV is cut off |
| `slowApiMs` | delay on `player_api.php`, `xmltv.php` and `get.php` |
| `redirectStreams` | streams answer with `302` to the same URL plus `?token=…`, like load-balanced panels |
| `connectionLimitStatus` | status for the connection limit (default `509`) |

## Connection accounting

Each open stream response counts as one connection: live TS, timeshift, and each VOD request,
including parallel Range requests. An HLS viewer (account + IP + channel) counts while it fetched a
playlist or segment within the last 20 s. `user_info.active_cons` and `GET /__mock/state` report the
live count; the state also has `peakConnections`, the most connections open at the same time since
start or the last reset (tests use it to prove a client never held two at once).

## Tests

`pnpm --filter @anycast/mock-xtream test` takes about 20 s warm, or about 45 s with a cold fixture
cache. It needs `ffmpeg` and `ffprobe` on the PATH.
