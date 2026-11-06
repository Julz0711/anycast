/**
 * Audio and subtitle tracks (PB-3): selection rules, WebVTT handling, and against the mock's
 * multi-track MKV (German + English E-AC-3 audio, German + English SubRip): the tracks listed,
 * the chosen audio track really mapped, subtitles converted to WebVTT renditions with true times,
 * and choices saved per item.
 */
import { DEFAULT_PREFERENCES, normalizeLanguage, sameLanguage, type PlaybackInfo, type Preferences } from '@anycast/shared';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { audioTracks, pickAudio, pickSubtitle, subtitleTracks } from '../src/playback/tracks';
import { formatVtt, parseVtt } from '../src/playback/webvtt';
import { VodHlsSession } from '../src/playback/hls';
import type { ProbeAudio, ProbeSubtitle } from '../src/playback/probe';
import { createMockXtream, FORMAT_MATRIX, login, makeApp } from './helpers';

const prefs = (p: Partial<Preferences['player']> = {}): Preferences['player'] => ({ ...DEFAULT_PREFERENCES.player, ...p });

describe('languages', () => {
  test('ISO 639-2 tags map to the 639-1 codes preferences use', () => {
    expect(normalizeLanguage('eng')).toBe('en');
    expect(normalizeLanguage('ger')).toBe('de');
    expect(normalizeLanguage('deu')).toBe('de');
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('und')).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage('xyz')).toBe('xyz');
    expect(sameLanguage('fre', 'fr')).toBe(true);
    expect(sameLanguage(null, null)).toBe(false);
  });
});

describe('track lists', () => {
  test('text subtitles can be shown; picture-based and teletext ones say why not', () => {
    const subs: ProbeSubtitle[] = [
      { codec: 'subrip', language: 'eng' },
      { codec: 'hdmv_pgs_subtitle', language: 'deu', forced: true },
      { codec: 'dvd_subtitle', language: null },
      { codec: 'ass', language: 'fra', title: 'Signs' },
      { codec: 'dvb_teletext', language: 'nld' },
      { codec: 'eia_608', language: null },
    ];
    const list = subtitleTracks(subs, 'vod');
    expect(list.map((s) => [s.format, s.unavailable ?? null])).toEqual([
      ['text', null],
      ['bitmap', "Picture-based (PGS) subtitles can't be shown"],
      ['bitmap', "Picture-based (DVD) subtitles can't be shown"],
      ['text', null],
      ['bitmap', "Teletext subtitles can't be shown"],
      ['bitmap', "This subtitle format isn't supported"],
    ]);
    expect(list[1]).toMatchObject({ index: 1, language: 'de', forced: true });
    expect(list[3]).toMatchObject({ index: 3, language: 'fr', title: 'Signs' });
    // live streams: listed, not shown
    expect(subtitleTracks(subs, 'live')[0]!.unavailable).toBe('Subtitles are shown for movies and episodes only');
  });

  test('audio tracks carry language, codec, channels, title and the default flag', () => {
    expect(audioTracks([{ codec: 'eac3', language: 'eng', channels: 6, title: 'Main', default: true }, { codec: 'aac', language: null, channels: 2 }])).toEqual([
      { index: 0, language: 'en', codec: 'eac3', channels: 6, title: 'Main', default: true },
      { index: 1, language: null, codec: 'aac', channels: 2, title: null, default: false },
    ]);
  });
});

describe('picking audio', () => {
  const audio: ProbeAudio[] = [
    { codec: 'ac3', language: 'deu', channels: 6, default: true },
    { codec: 'ac3', language: 'eng', channels: 6, title: 'Commentary' },
    { codec: 'ac3', language: 'eng', channels: 6 },
  ];
  test.each([
    ['asked for wins', { requested: 1, saved: 2, preferred: 'de' }, 1],
    ['an invalid ask falls through to the saved one', { requested: 9, saved: 2, preferred: 'de' }, 2],
    ['saved wins over the language', { saved: 0, preferred: 'en' }, 0],
    ['preferred language, skipping commentary', { preferred: 'en' }, 2],
    ['no match: the source default', { preferred: 'fr' }, 0],
    ['no preference: the source default', { preferred: null }, 0],
  ] as const)('%s', (_n, o, want) => {
    expect(pickAudio(audio, o)).toBe(want);
  });
  test('no audio, no track; no default flag, the first', () => {
    expect(pickAudio([], { preferred: 'en' })).toBeNull();
    expect(pickAudio([{ codec: 'aac', language: 'fra', channels: 2 }, { codec: 'aac', language: 'ita', channels: 2 }], { preferred: 'en' })).toBe(0);
  });
});

describe('picking subtitles', () => {
  const subs = subtitleTracks(
    [
      { codec: 'hdmv_pgs_subtitle', language: 'eng' },
      { codec: 'subrip', language: 'eng', forced: true },
      { codec: 'subrip', language: 'eng' },
      { codec: 'subrip', language: 'deu', default: true },
    ],
    'vod',
  );
  const pick = (o: Partial<Parameters<typeof pickSubtitle>[1]>) => pickSubtitle(subs, { prefs: prefs(), audioLanguage: 'en', ...o });
  test('asked for and saved choices win; picture-based tracks are never picked', () => {
    expect(pick({ requested: 3 })).toBe(3);
    expect(pick({ requested: 0, saved: 2 })).toBe(2);
    expect(pick({ requested: 'off', saved: 2 })).toBeNull();
    expect(pick({ saved: null, prefs: prefs({ subtitlesDefault: 'on' }) })).toBeNull();
  });
  test('off by default', () => {
    expect(pick({})).toBeNull();
  });
  test('on: the preferred language (not the forced track), else the default, else the first', () => {
    expect(pick({ prefs: prefs({ subtitlesDefault: 'on', preferredSubtitleLanguage: 'en' }) })).toBe(2);
    expect(pick({ prefs: prefs({ subtitlesDefault: 'on', preferredSubtitleLanguage: null }) })).toBe(3);
    expect(pick({ prefs: prefs({ subtitlesDefault: 'on', preferredSubtitleLanguage: 'ja' }) })).toBe(3);
  });
  test('auto: only when the audio is in another language', () => {
    const auto = prefs({ subtitlesDefault: 'auto', preferredSubtitleLanguage: 'de' });
    expect(pick({ prefs: auto, audioLanguage: 'en' })).toBe(3);
    expect(pick({ prefs: auto, audioLanguage: 'de' })).toBeNull();
  });
});

describe('WebVTT', () => {
  test('parses FFmpeg output, skips a partial last block while the file grows, and writes it back', () => {
    const text = 'WEBVTT\n\n00:28.006 --> 00:29.506\nSubtitle 14\n\n01:00:00.000 --> 01:00:02.500 align:start\n<i>two</i>\nlines\n\n00:40.000 --> 00:4';
    expect(parseVtt(text)).toEqual([
      { start: 28.006, end: 29.506, text: 'Subtitle 14' },
      { start: 3600, end: 3602.5, text: '<i>two</i>\nlines' },
    ]);
    expect(parseVtt('WEBVTT\n\n00:01.000 --> 00:02.000\nlast', true)).toEqual([{ start: 1, end: 2, text: 'last' }]);
    expect(formatVtt([{ start: 3600, end: 3602.5, text: 'b' }, { start: 1.5, end: 2, text: 'a' }])).toBe(
      'WEBVTT\n\n00:00:01.500 --> 00:00:02.000\na\n\n01:00:00.000 --> 01:00:02.500\nb\n',
    );
  });
});

describe('VOD subtitles after a seek', () => {
  test('a cue that started before the seek point and is still on screen is kept', async () => {
    // 60 s MKV, keyframes every 2 s, 9 s cues every 10 s: at slot 18 (108 s) the cue of 100-109 s is showing
    const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-subseek-'));
    const ts = (s: number) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')},000`;
    const srt = Array.from({ length: 12 }, (_, i) => `${i + 1}\n${ts(i * 10)} --> ${ts(i * 10 + 9)}\nCue ${i * 10}\n`).join('\n');
    writeFileSync(path.join(dir, 'a.srt'), srt);
    const src = path.join(dir, 'a.mkv');
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=f=440', '-i', path.join(dir, 'a.srt'),
      '-t', '120', '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:a', 'aac', '-c:s', 'srt', src,
    ]);
    // served over HTTP with ranges, like a provider
    const server = http.createServer((req, res) => {
      const size = statSync(src).size;
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m?.[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, { 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(src, { start, end }).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a.mkv`;
    const out = mkdtempSync(path.join(os.tmpdir(), 'anycast-subseek-out-'));
    const session = new VodHlsSession(out, () => url, 'remux', 120, () => ({ release: () => undefined }), () => undefined, 'aac', undefined, {
      audio: 0, subtitles: [{ index: 0, name: 'Subtitles', language: null }],
    });
    try {
      await session.segment(18);
      const cues = parseVtt(await session.subtitleSegment(0, 18), true);
      expect(cues.map((c) => c.text)).toContain('Cue 100');
      expect(cues.find((c) => c.text === 'Cue 100')!.start).toBeCloseTo(100, 0);
    } finally {
      session.close();
      server.closeAllConnections();
      server.close();
    }
  }, 60_000);
});

/* ---------------- against the mock provider ---------------- */

const CHROME = JSON.stringify({ hls: false, mse: true, codecs: ['avc1', 'mp4a'] });
const CLIENT = { 'x-anycast-client': 'tracks-client-0001', 'x-anycast-device': 'Test' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;
let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let base: string;
const scratch = mkdtempSync(path.join(os.tmpdir(), 'anycast-tracks-'));
const seen: string[] = [];

async function get(url: string, init: RequestInit = {}) {
  const res = await fetch(base + url, { ...init, headers: { cookie, 'x-anycast-caps': CHROME, ...CLIENT, ...(init.headers as Record<string, string>) } });
  return res;
}
async function info(url: string): Promise<PlaybackInfo> {
  const res = await get(url);
  const text = await res.text();
  seen.push(text);
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as PlaybackInfo;
}
const dirOf = (url: string) => url.replace(/[^/]+$/, '');
async function file(url: string): Promise<Buffer> {
  const res = await get(url);
  expect(res.status, url).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** Which of the mock's tones an fMP4 init + segment carries: its audio tracks beep at 440 Hz (German) and 660 Hz (English). */
async function toneOf(dir: string, n: number): Promise<440 | 660> {
  // the segment first: it starts the FFmpeg run there, whose init segment goes with it
  const seg = await file(`${dir}seg/${n}.m4s`);
  return toneOfMedia(Buffer.concat([await file(`${dir}init.mp4`), seg]));
}

/** The tone of a live (or archive) HLS stream's first segment. Live channels: 440 Hz first track (English), 660 Hz second (German). */
async function liveToneOf(url: string): Promise<440 | 660> {
  const playlist = (await file(url)).toString();
  const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)![1]!;
  const seg = playlist.split('\n').find((l) => l && !l.startsWith('#'))!;
  const dir = dirOf(url);
  return toneOfMedia(Buffer.concat([await file(dir + init), await file(dir + seg)]));
}

async function toneOfMedia(media: Buffer): Promise<440 | 660> {
  const f = path.join(scratch, `seg-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(f, media);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { maxBuffer: 1 << 24 });
  const x = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  // Goertzel: signal power at one frequency
  const power = (hz: number) => {
    const k = 2 * Math.cos((2 * Math.PI * hz) / 48000);
    let s1 = 0;
    let s2 = 0;
    for (const v of x) [s1, s2] = [v + k * s1 - s2, s1];
    return s1 * s1 + s2 * s2 - k * s1 * s2;
  };
  expect(x.length).toBeGreaterThan(48000);
  return power(440) > power(660) ? 440 : 660;
}

let profile: { id: string } | null = null;
async function me(): Promise<{ id: string }> {
  profile ??= ((await (await get('/api/profiles')).json()) as { id: string }[])[0]!;
  return profile;
}

const multi = FORMAT_MATRIX.find((f) => f.id === 'mkv_h264_eac3_multi' && f.kind === 'movie')!;
const mp4 = FORMAT_MATRIX.find((f) => f.id === 'mp4_h264_aac' && f.kind === 'movie')!;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', maxConnections: 2, username: 'tr-user-5120', password: 'tr-pass-6631' });
  built = await makeApp({ url: mock.url, username: mock.username, password: mock.password });
  await built.services.sync.syncCatalog();
  cookie = await login(built.app);
  base = await built.app.listen({ port: 0, host: '127.0.0.1' });
}, 60_000);

afterEach(() => built.services.playback.sessions.closeAll());

afterAll(async () => {
  await built.app.close();
  await mock.close();
});

describe('multi-track MKV from the mock', () => {
  test('lists both audio and subtitle tracks; English audio by default, subtitles off', async () => {
    const id = multi.ids[0]!;
    const pi = await info(`/api/play/movie/${id}`);
    expect(pi.tracks).toMatchObject({
      audio: [
        { index: 0, language: 'de', codec: 'eac3', channels: 2, default: true },
        { index: 1, language: 'en', codec: 'eac3', channels: 2, default: false },
      ],
      subtitles: [
        { index: 0, language: 'de', codec: 'subrip', format: 'text' },
        { index: 1, language: 'en', codec: 'subrip', format: 'text' },
      ],
      audioIndex: 1,
      subtitleIndex: null,
      subtitlesInStream: true,
    });
    expect(pi).toMatchObject({ type: 'hls', pipeline: 'transcode-audio', url: `/api/stream/movie/${id}/transcode-audio/a1/master.m3u8` });
    const master = (await file(pi.url)).toString();
    expect(master).toContain('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="German",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=NO,URI="subs/0.m3u8"');
    expect(master).toContain('NAME="English",LANGUAGE="en"');
    expect(master).toMatch(/#EXT-X-STREAM-INF:BANDWIDTH=\d+,SUBTITLES="subs"\nindex\.m3u8/);
  });

  test('the chosen audio track is the one in the segments, also after a seek restarts FFmpeg', async () => {
    const id = multi.ids[0]!;
    const en = await info(`/api/play/movie/${id}`);
    expect(await toneOf(dirOf(en.url), 0)).toBe(660);
    // switch: ?audio=0 plays from the plain URL; the English session is stopped
    const de = await info(`/api/play/movie/${id}?audio=0`);
    expect(de.url).toBe(`/api/stream/movie/${id}/transcode-audio/master.m3u8`);
    expect(de.tracks!.audioIndex).toBe(0);
    const far = Math.floor((multi.durations![id]! / 6) * 0.6);
    expect(await toneOf(dirOf(de.url), far)).toBe(440);
    expect(built.services.playback.pool.active).toBeLessThanOrEqual(1);
    // a track the item does not have
    expect((await get(`/api/stream/movie/${id}/transcode-audio/a7/index.m3u8`)).status).toBe(404);
  });

  test('subtitles become WebVTT renditions with their true times, also after a seek', async () => {
    const id = multi.ids[0]!;
    const pi = await info(`/api/play/movie/${id}?sub=1`);
    expect(pi.tracks!.subtitleIndex).toBe(1);
    const dir = dirOf(pi.url);
    const playlist = (await file(`${dir}subs/1.m3u8`)).toString();
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('\n1/0.vtt\n');
    expect(playlist.match(/#EXTINF/g)!.length).toBe(Math.ceil(multi.durations![id]! / 6));

    // the player loads the video first; slot 2 (12-18 s) carries the cues around it
    await file(`${dir}init.mp4`);
    for (let n = 0; n < 3; n++) await file(`${dir}seg/${n}.m4s`);
    const res = await get(`${dir}subs/1/2.vtt`);
    expect(res.headers.get('content-type')).toMatch(/^text\/vtt/);
    const cues = parseVtt(await res.text(), true);
    expect(cues.map((c) => c.text)).toEqual(['Subtitle 00:00:10', 'Subtitle 00:00:20']);
    expect(cues[0]!.start).toBeCloseTo(10, 1);
    expect(cues[0]!.end).toBeCloseTo(14, 1);
    // German track, same slot
    expect(parseVtt((await file(`${dir}subs/0/2.vtt`)).toString(), true).map((c) => c.text)).toEqual(['Untertitel 00:00:10', 'Untertitel 00:00:20']);

    // jump ahead: the new run (from slot 16) writes the cues there
    await file(`${dir}seg/16.m4s`);
    const later = parseVtt((await file(`${dir}subs/1/17.vtt`)).toString(), true);
    expect(later.map((c) => c.text)).toContain('Subtitle 00:01:40');
    expect(later.find((c) => c.text === 'Subtitle 00:01:40')!.start).toBeCloseTo(100, 1);
    expect((await get(`${dir}subs/5/2.vtt`)).status).toBe(404);
  });

  test('choices are saved per item and used the next time; ?sub=off overrides', async () => {
    const id = multi.ids[1]!;
    const put = await get(`/api/tracks/movie/${id}`, { method: 'PUT', body: JSON.stringify({ audio: 0, subtitle: 0 }), headers: { 'content-type': 'application/json' } });
    expect(put.status).toBe(200);
    const pi = await info(`/api/play/movie/${id}`);
    expect(pi.tracks).toMatchObject({ audioIndex: 0, subtitleIndex: 0 });
    expect(pi.url).toBe(`/api/stream/movie/${id}/transcode-audio/master.m3u8`);
    expect((await info(`/api/play/movie/${id}?sub=off`)).tracks!.subtitleIndex).toBeNull();
    // turning subtitles off is saved too, and audio stays
    await get(`/api/tracks/movie/${id}`, { method: 'PUT', body: JSON.stringify({ subtitle: null }), headers: { 'content-type': 'application/json' } });
    expect((await info(`/api/play/movie/${id}`)).tracks).toMatchObject({ audioIndex: 0, subtitleIndex: null });
    const bad = await get(`/api/tracks/movie/${id}`, { method: 'PUT', body: JSON.stringify({ audio: -1 }), headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400);
    expect((await get('/api/tracks/movie/nope-404', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(404);
  });

  test('preferred audio language comes from the profile preferences', async () => {
    const id = multi.ids[2] ?? multi.ids[0]!;
    await get('/api/preferences', { method: 'PUT', body: JSON.stringify({ player: { preferredAudioLanguage: 'de', subtitlesDefault: 'on', preferredSubtitleLanguage: 'en' } }), headers: { 'content-type': 'application/json' } });
    try {
      const pi = await info(`/api/play/movie/${id}`);
      expect(pi.tracks).toMatchObject({ audioIndex: 0, subtitleIndex: 1 });
    } finally {
      await get('/api/preferences', { method: 'PUT', body: JSON.stringify({ player: DEFAULT_PREFERENCES.player }), headers: { 'content-type': 'application/json' } });
    }
  });
});

describe('live channels with two audio tracks', () => {
  const ml = FORMAT_MATRIX.find((f) => f.id === 'live_h264_aac_multi' && f.kind === 'live')!;
  const json = { 'content-type': 'application/json' };

  test('the audio track picked is saved per channel and profile, and used for its live stream and archive', async () => {
    // a channel with an archive (the mock decides which)
    const id = String(mock.catalog.live.find((c) => c.profile === 'live_h264_aac_multi' && c.archive)!.id);
    try {
      const first = await info(`/api/play/live/${id}`);
      expect(first.tracks).toMatchObject({ audio: [{ index: 0, language: 'en' }, { index: 1, language: 'de' }], audioIndex: 0 });
      expect(first).toMatchObject({ pipeline: 'passthrough', url: `/api/stream/live/${id}.ts` });

      const put = await get(`/api/tracks/live/${id}`, { method: 'PUT', body: JSON.stringify({ audio: 1, subtitle: 0 }), headers: json });
      expect(put.status).toBe(200);
      const again = await info(`/api/play/live/${id}`);
      expect(again.tracks!.audioIndex).toBe(1);
      expect(again.url).toBe(`/api/stream/live/${id}/remux/a1/index.m3u8`);
      expect(await liveToneOf(again.url)).toBe(660);
      // live channels keep no subtitle choice
      expect(built.services.userData.trackChoice((await me()).id, 'live', id)).toEqual({ audio: 1, subtitle: undefined });

      // the archive of the channel plays the same track
      const at = await info(`/api/play/live/${id}/at?at=${Date.now() - 5 * 60_000}`);
      expect(at.tracks!.audioIndex).toBe(1);
      expect(at.url).toMatch(new RegExp(`^/api/stream/timeshift/${id}/\\d+/\\d+/remux/a1/index\\.m3u8$`));
      // ?audio still wins
      expect((await info(`/api/play/live/${id}?audio=0`)).tracks!.audioIndex).toBe(0);

      // another profile has its own choice
      const kid = (await (await get('/api/profiles', { method: 'POST', body: JSON.stringify({ name: 'Live kid' }), headers: json })).json()) as { id: string };
      const theirs = await get(`/api/play/live/${id}`, { headers: { 'x-anycast-profile': kid.id } });
      expect(((await theirs.json()) as PlaybackInfo).tracks!.audioIndex).toBe(0);
    } finally {
      await get('/api/play/stop', { method: 'POST' });
    }
  });

  test('switching back and forth leaves one conversion running for the channel', async () => {
    const id = String(ml.ids[1] ?? ml.ids[0]);
    const hls = { 'x-anycast-caps': JSON.stringify({ hls: true, mse: false, codecs: ['avc1', 'mp4a'] }) };
    try {
      const a0 = (await (await get(`/api/play/live/${id}?audio=0`, { headers: hls })).json()) as PlaybackInfo;
      expect(a0.url).toBe(`/api/stream/live/${id}/remux/index.m3u8`);
      expect(await liveToneOf(a0.url)).toBe(440);
      const a1 = (await (await get(`/api/play/live/${id}?audio=1`, { headers: hls })).json()) as PlaybackInfo;
      expect(await liveToneOf(a1.url)).toBe(660);
      // the first track's conversion was stopped, not left running until it idles out
      expect(built.services.playback.sessions.size).toBe(1);
      // nothing saved for this channel: without ?audio it is back on the preferred (English) track
      expect((await info(`/api/play/live/${id}`)).tracks!.audioIndex).toBe(0);
    } finally {
      await get('/api/play/stop', { method: 'POST' });
    }
  });

  test('saving a choice: unknown channels and kinds are 404', async () => {
    const put = { method: 'PUT', body: JSON.stringify({ audio: 1 }), headers: json };
    expect((await get('/api/tracks/live/nope-404', put)).status).toBe(404);
    expect((await get(`/api/tracks/series/${ml.ids[0]}`, put)).status).toBe(404);
  });
});

describe('single-track sources', () => {
  test('an MP4 keeps direct play until subtitles or another track are asked for', async () => {
    const id = mp4.ids[0]!;
    const pi = await info(`/api/play/movie/${id}`);
    expect(pi).toMatchObject({ type: 'file', pipeline: 'passthrough' });
    expect(pi.tracks).toMatchObject({ audio: [{ index: 0, codec: 'aac' }], subtitles: [], audioIndex: 0, subtitleIndex: null, subtitlesInStream: false });
    // a track it does not have changes nothing
    expect((await info(`/api/play/movie/${id}?audio=3`)).pipeline).toBe('passthrough');
  });

  test('live: the track is listed and only existing tracks get a stream', async () => {
    const live = FORMAT_MATRIX.find((f) => f.id === 'live_h264_aac' && f.kind === 'live')!;
    const id = live.ids[0]!;
    const pi = await info(`/api/play/live/${id}`);
    expect(pi.tracks).toMatchObject({ audioIndex: 0, subtitleIndex: null, subtitlesInStream: false });
    expect(pi.tracks!.audio).toHaveLength(1);
    expect((await get(`/api/stream/live/${id}/remux/a1/index.m3u8`)).status).toBe(404);
    await get('/api/play/stop', { method: 'POST' });
  });

  test('responses never carry provider details', () => {
    const all = seen.join('\n');
    for (const secret of [mock.username, mock.password, new URL(mock.url).host]) expect(all).not.toContain(secret);
  });
});
