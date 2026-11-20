import type { ExternalSubtitleState, SubtitleDownloadResponse, SubtitleSearchResponse, SubtitleSettings } from '@anycast/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { convertSubtitle, decodeSubtitle, parseCues, parseTime } from '../src/subtitles/convert';
import { parseResults, rankResults, searchParams } from '../src/subtitles/opensubtitles';
import { guessLanguage } from '../src/subtitles/service';
import { login, makeApp } from './helpers';

const SRT = `1
00:00:01,000 --> 00:00:03,500
<font color="#ffff00">Hello</font> <i>there</i>

2
00:00:04,000 --> 00:00:05,000
{\\an8}Second line
and more

bad block

3
00:00:07,000 --> 00:00:06,000
ends before it starts
`;

describe('subtitle conversion', () => {
  test('SRT to clean WebVTT', () => {
    const conv = convertSubtitle(new TextEncoder().encode(SRT))!;
    expect(conv.cues).toBe(2);
    expect(conv.vtt).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello <i>there</i>\n\n00:00:04.000 --> 00:00:05.000\nSecond line\nand more\n');
  });

  test('WebVTT in, with header, notes and cue ids', () => {
    const cues = parseCues('WEBVTT\n\nNOTE made by hand\n\nid-1\n01:02.500 --> 01:04.000 line:90%\n<v Bob>Hi</v>\n');
    expect(cues).toEqual([{ start: 62.5, end: 64, text: 'Hi' }]);
  });

  test('times', () => {
    expect(parseTime('00:00:01,5')).toBe(1.5);
    expect(parseTime('1:02:03.250')).toBe(3723.25);
    expect(parseTime('nope')).toBeNull();
  });

  test('encodings: UTF-8 with BOM, UTF-16, Windows-1252', () => {
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0xc3, 0xbc]))).toBe('Hü');
    expect(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0xfc, 0x00]))).toBe('Hü');
    expect(decodeSubtitle(new Uint8Array([0x48, 0xfc, 0xdf]))).toBe('Hüß');
  });

  test('nothing readable', () => {
    expect(convertSubtitle(new TextEncoder().encode('just some text'))).toBeNull();
  });

  test('language from a file name', () => {
    expect(guessLanguage('Movie.2019.German.srt')).toBe('de');
    expect(guessLanguage('movie.de.srt')).toBe('de');
    expect(guessLanguage('movie.eng.srt')).toBe('en');
    expect(guessLanguage('movie.srt')).toBeNull();
  });
});

describe('OpenSubtitles requests and results', () => {
  test('query string: lower case, sorted keys', () => {
    expect(searchParams({ type: 'episode', query: 'Game of Thrones', season: 3, episode: 5, language: 'de' })).toBe(
      'episode_number=5&languages=de&query=game+of+thrones&season_number=3&type=episode',
    );
    expect(searchParams({ type: 'movie', query: 'Heat', year: 1995, tmdbId: 949, language: 'pt' })).toBe('languages=pt-pt%2Cpt-br&tmdb_id=949&type=movie');
  });

  test('parse and rank', () => {
    const results = parseResults({
      data: [
        { attributes: { language: 'de', download_count: 900, machine_translated: true, release: 'MT', files: [{ file_id: 1 }] } },
        { attributes: { language: 'de', download_count: 50, hearing_impaired: true, release: 'HI', files: [{ file_id: 2 }] } },
        { attributes: { language: 'de', download_count: 40, release: 'Plain', files: [{ file_id: 3 }] } },
        { attributes: { language: 'de', download_count: 99, release: 'No file', files: [] } },
      ],
    });
    expect(rankResults(results).map((r) => r.release)).toEqual(['Plain', 'HI', 'MT']);
  });
});

/* ---------------- the API, with OpenSubtitles faked ---------------- */

interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeOpenSubtitles(opts: { badKey?: boolean; results?: object[]; remaining?: number } = {}) {
  const seen: Seen[] = [];
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    seen.push({ url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('https://dl.example/')) return new Response(SRT);
    if (opts.badKey) return json({ message: 'You cannot consume this service' }, 403);
    const path = url.replace('https://os.example/api/v1', '');
    if (path === '/infos/languages') return json({ data: [] });
    if (path === '/login') return json({ token: 'tok-1', base_url: 'api.opensubtitles.com', user: { allowed_downloads: 20 } });
    if (path === '/infos/user') return json({ data: { allowed_downloads: 20, remaining_downloads: 18 } });
    if (path.startsWith('/subtitles?')) {
      return json({
        data: opts.results ?? [
          { attributes: { language: 'de', download_count: 10, release: 'GoT.S03E05.German', feature_details: { parent_title: 'Game of Thrones', season_number: 3, episode_number: 5 }, files: [{ file_id: 111 }] } },
          { attributes: { language: 'de', download_count: 999, release: 'Wrong episode', feature_details: { season_number: 3, episode_number: 6 }, files: [{ file_id: 222 }] } },
          { attributes: { language: 'de', download_count: 5, hearing_impaired: true, release: 'GoT.S03E05.HI', feature_details: { season_number: 3, episode_number: 5 }, files: [{ file_id: 333 }] } },
        ],
      });
    }
    if (path === '/download') return json({ link: 'https://dl.example/file.srt', remaining: opts.remaining ?? 4 });
    return json({ message: 'not found' }, 404);
  }) as typeof fetch;
  return { fetchFn, seen };
}

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function setup(os = fakeOpenSubtitles(), env: { apiKey: string; username: null; password: null } | null = null) {
  const built = await makeApp(null, { subtitles: { fetch: os.fetchFn, baseUrl: 'https://os.example/api/v1' }, config: { opensubtitles: env } });
  close = () => built.app.close();
  const { app, services } = built;
  const db = services.db;
  db.prepare("INSERT INTO movies (id, name, raw_name, category_id, year, gen) VALUES ('m1', 'Heat', 'EN - Heat (1995)', 'c1', 1995, 1)").run();
  db.prepare("INSERT INTO series (id, name, raw_name, category_id, year, gen) VALUES ('s1', 'Game of Thrones', 'Game of Thrones', 'c2', 2011, 1)").run();
  db.prepare("INSERT INTO episodes (id, series_id, season, episode, title) VALUES ('e1', 's1', 3, 5, 'Episode 5')").run();
  const cookie = await login(app);
  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } });
  return { app, services, req, seen: os.seen };
}

describe('external subtitles API', () => {
  test('without a key: state says offline, search says not configured, files from the device still work', async () => {
    const { req } = await setup();
    const st = (await req('GET', '/api/subtitles/episode/e1')).json<ExternalSubtitleState>();
    expect(st).toEqual({ online: false, files: [], choice: null, savedOff: false });
    const search = await req('GET', '/api/subtitles/episode/e1/search?lang=de');
    expect(search.statusCode).toBe(409);
    expect(search.json()).toMatchObject({ error: 'not_configured' });
    expect((await req('POST', '/api/subtitles/episode/e1/auto', { language: 'de' })).json()).toEqual({ file: null });

    const up = await req('POST', '/api/subtitles/movie/m1/upload', { name: 'Heat.1995.German.srt', data: Buffer.from(SRT).toString('base64') });
    expect(up.statusCode).toBe(200);
    const file = up.json<SubtitleDownloadResponse>().file;
    expect(file).toMatchObject({ source: 'upload', language: 'de', label: 'Heat.1995.German.srt', cues: 2 });
    const vtt = await req('GET', `/api/subtitles/file/${file.id}`);
    expect(vtt.headers['content-type']).toContain('text/vtt');
    expect(vtt.body).toContain('Hello <i>there</i>');
    // garbage is refused
    expect((await req('POST', '/api/subtitles/movie/m1/upload', { name: 'x.srt', data: Buffer.from('hello').toString('base64') })).statusCode).toBe(400);
    // unknown items and kinds
    expect((await req('GET', '/api/subtitles/movie/nope')).statusCode).toBe(404);
    expect((await req('GET', '/api/subtitles/live/m1')).statusCode).toBe(404);
  });

  test('an admin saves a key; search, download once, pick with an offset', async () => {
    const { app, req, services, seen } = await setup();
    // a viewer can't see or change the key
    await services.users.create('viewer', 'viewer-password-1', false);
    const viewer = await login(app, { username: 'viewer', password: 'viewer-password-1' });
    expect((await req('GET', '/api/subtitles/settings', undefined, viewer)).statusCode).toBe(403);
    expect((await req('PUT', '/api/subtitles/settings', { apiKey: 'x' }, viewer)).statusCode).toBe(403);

    const saved = await req('PUT', '/api/subtitles/settings', { apiKey: ' key-123 ' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ configured: true, origin: 'app', username: null, test: { ok: true } });
    expect(JSON.stringify(saved.json())).not.toContain('key-123');
    expect(seen.at(-1)!.headers['Api-Key']).toBe('key-123');
    expect(seen.at(-1)!.headers['User-Agent']).toMatch(/^AnyCast/);

    const search = (await req('GET', '/api/subtitles/episode/e1/search?lang=de')).json<SubtitleSearchResponse>();
    expect(search.query).toBe('Game of Thrones S3 E5');
    // the other episode is dropped; plain before hearing-impaired
    expect(search.results.map((r) => r.fileId)).toEqual(['111', '333']);
    expect(seen.at(-1)!.url).toContain('query=game+of+thrones');

    const dl = (await req('POST', '/api/subtitles/episode/e1/download', { fileId: '111' })).json<SubtitleDownloadResponse>();
    expect(dl).toMatchObject({ file: { id: 'os-111', source: 'opensubtitles', language: 'de', label: 'GoT.S03E05.German', cues: 2 }, remaining: 4 });
    const downloads = seen.filter((s) => s.url.endsWith('/download')).length;
    // again: kept, no second download
    await req('POST', '/api/subtitles/episode/e1/download', { fileId: '111' });
    expect(seen.filter((s) => s.url.endsWith('/download')).length).toBe(downloads);
    expect((await req('GET', '/api/subtitles/episode/e1/search?lang=de')).json<SubtitleSearchResponse>().results[0]!.kept).toBe(true);

    // pick it with an offset; the state remembers it per profile
    expect((await req('PUT', '/api/subtitles/episode/e1/choice', { fileId: 'os-111', offsetMs: 1500 })).statusCode).toBe(200);
    let st = (await req('GET', '/api/subtitles/episode/e1')).json<ExternalSubtitleState>();
    expect(st).toMatchObject({ online: true, choice: { fileId: 'os-111', offsetMs: 1500 } });
    expect(st.files.map((f) => f.id)).toEqual(['os-111']);
    // a file that isn't kept can't be picked
    expect((await req('PUT', '/api/subtitles/episode/e1/choice', { fileId: 'os-999' })).statusCode).toBe(404);
    // off
    await req('PUT', '/api/subtitles/episode/e1/choice', { fileId: null });
    st = (await req('GET', '/api/subtitles/episode/e1')).json<ExternalSubtitleState>();
    expect(st.choice).toEqual({ fileId: null, offsetMs: 0 });
    // subtitles turned off in the player for the stream's own tracks show as savedOff
    await req('PUT', '/api/tracks/episode/e1', { subtitle: null });
    expect((await req('GET', '/api/subtitles/episode/e1')).json<ExternalSubtitleState>().savedOff).toBe(true);

    // removing the key
    expect((await req('DELETE', '/api/subtitles/settings')).json<SubtitleSettings>()).toMatchObject({ configured: false, origin: null });
  });

  test('auto: a kept file in the language, else the best result downloaded', async () => {
    const { req, seen } = await setup(fakeOpenSubtitles(), { apiKey: 'env-key', username: null, password: null });
    expect((await req('GET', '/api/subtitles/settings')).json<SubtitleSettings>()).toMatchObject({ configured: true, origin: 'env' });
    const a = (await req('POST', '/api/subtitles/episode/e1/auto', { language: 'de' })).json<{ file: { id: string } | null }>();
    expect(a.file?.id).toBe('os-111');
    const n = seen.length;
    const b = (await req('POST', '/api/subtitles/episode/e1/auto', { language: 'deu' })).json<{ file: { id: string } | null }>();
    expect(b.file?.id).toBe('os-111');
    expect(seen.length).toBe(n);
  });

  test('a movie with a TMDB id from the provider is searched by it', async () => {
    const { req, services, seen } = await setup(fakeOpenSubtitles({ results: [] }), { apiKey: 'env-key', username: null, password: null });
    services.db.prepare("INSERT INTO movie_info (movie_id, data, fetched_at) VALUES ('m1', ?, ?)").run(JSON.stringify({ tmdbId: 949 }), Date.now());
    const r = (await req('GET', '/api/subtitles/movie/m1/search?lang=en')).json<SubtitleSearchResponse>();
    expect(r).toEqual({ results: [], query: 'Heat (1995)' });
    const searches = seen.filter((s) => s.url.includes('/subtitles?')).map((s) => s.url.split('?')[1]);
    // nothing by id: the name and year too
    expect(searches).toEqual(['languages=en&tmdb_id=949&type=movie', 'languages=en&query=heat&type=movie&year=1995']);
  });

  test('a rejected key is not saved; an account needs its password', async () => {
    const { req } = await setup(fakeOpenSubtitles({ badKey: true }));
    const bad = await req('PUT', '/api/subtitles/settings', { apiKey: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('rejected');
    expect((await req('GET', '/api/subtitles/settings')).json<SubtitleSettings>().configured).toBe(false);
    expect((await req('PUT', '/api/subtitles/settings', { apiKey: 'k', username: 'me' })).statusCode).toBe(400);
  });

  test('an account signs in and its token is sent with downloads', async () => {
    const { req, seen } = await setup();
    const saved = await req('PUT', '/api/subtitles/settings', { apiKey: 'k', username: 'me', password: 'pw-1' });
    expect(saved.json()).toMatchObject({ username: 'me', test: { ok: true, message: expect.stringContaining('20 downloads a day, 18 left') } });
    await req('POST', '/api/subtitles/episode/e1/auto', { language: 'de' });
    const dl = seen.find((s) => s.url.endsWith('/download'))!;
    expect(dl.headers.Authorization).toBe('Bearer tok-1');
    expect(dl.body).toEqual({ file_id: 111, sub_format: 'srt' });
    // changing only the key keeps the account and its password
    expect((await req('PUT', '/api/subtitles/settings', { apiKey: 'k2' })).json()).toMatchObject({ username: 'me' });
  });
});
