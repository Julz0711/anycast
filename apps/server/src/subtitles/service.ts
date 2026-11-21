/**
 * External subtitles (see packages/shared/src/subtitles.ts): the OpenSubtitles login, searching
 * for a movie or episode, keeping downloaded and uploaded files, and each profile's pick.
 *
 * Matching: the provider rarely gives ids, so a movie is searched by its TMDB id when the panel's
 * get_vod_info had one, else by its name and year; an episode by the series name with its season
 * and episode number. Search results are kept in memory for a while (searching is free but rate
 * limited); downloaded files are kept in the database for good (downloading costs quota).
 */
import { randomBytes } from 'node:crypto';
import {
  normalizeLanguage, SUBTITLE_LIMITS,
  type ExternalSubtitle, type ExternalSubtitleState, type SubtitleSearchResponse, type SubtitleSearchResult, type SubtitleSettings, type SubtitleSettingsInput,
} from '@anycast/shared';
import { getEpisode, getMovie, getSeries } from '../catalog/store';
import { decrypt, encrypt } from '../crypto';
import { kvGet, kvSet, type Db } from '../db';
import { convertSubtitle } from './convert';
import { OpenSubtitlesClient, OpenSubtitlesError, rankResults, type ClientOptions, type OpenSubtitlesLogin, type OsQuery, type OsResult } from './opensubtitles';

export type SubKind = 'movie' | 'episode';
const KV_KEY = 'opensubtitles';
const SEARCH_TTL_MS = 6 * 3600_000;

interface FileRow { id: string; kind: string; item_id: string; source: string; language: string | null; label: string; cues: number; fps: number | null; created_at: number }
interface Saved { login: OpenSubtitlesLogin; updatedAt: number }

export class SubtitleError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const toFile = (r: FileRow): ExternalSubtitle => ({
  id: r.id, source: r.source === 'upload' ? 'upload' : 'opensubtitles', language: r.language, label: r.label, cues: r.cues, fps: r.fps ?? null, addedAt: r.created_at,
});

export class SubtitleService {
  private readonly searches = new Map<string, { at: number; results: OsResult[]; query: string }>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private client: { key: string; c: OpenSubtitlesClient } | null = null;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
    private readonly env: OpenSubtitlesLogin | null,
    private readonly clientOptions: ClientOptions = {},
  ) {}

  /* ---------------- login ---------------- */

  private saved(): Saved | null {
    const raw = kvGet(this.db, KV_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(decrypt(this.secret, raw)) as Saved;
    } catch {
      return null; // ANYCAST_SECRET changed: as if nothing was saved
    }
  }

  /** The login in use: the one entered in the app, else .env's. */
  login(): OpenSubtitlesLogin | null {
    return this.saved()?.login ?? (this.env?.apiKey ? this.env : null);
  }

  settings(): SubtitleSettings {
    const saved = this.saved();
    const login = this.login();
    return {
      configured: !!login,
      origin: saved ? 'app' : login ? 'env' : null,
      username: login?.username || null,
      updatedAt: saved?.updatedAt ?? null,
    };
  }

  /** The login PUT would save: fields left out keep the saved ones; an empty username drops the account. */
  merge(input: SubtitleSettingsInput): OpenSubtitlesLogin {
    const cur = this.login();
    const apiKey = input.apiKey?.trim() || cur?.apiKey;
    if (!apiKey) throw new SubtitleError(400, 'bad_request', 'Enter the API key from your OpenSubtitles consumer.');
    const username = input.username === undefined ? (cur?.username ?? null) : input.username.trim() || null;
    let password = input.password ? input.password : null;
    if (!password && username && username === cur?.username) password = cur?.password ?? null;
    if (username && !password) throw new SubtitleError(400, 'bad_request', 'Enter the password of the OpenSubtitles account.');
    return { apiKey, username, password: username ? password : null };
  }

  /** Tries a login: a short message on success, OpenSubtitlesError otherwise. */
  test(login: OpenSubtitlesLogin): Promise<string> {
    return new OpenSubtitlesClient(login, this.clientOptions).check();
  }

  save(login: OpenSubtitlesLogin): void {
    kvSet(this.db, KV_KEY, encrypt(this.secret, JSON.stringify({ login, updatedAt: Date.now() } satisfies Saved)));
    this.client = null;
    this.searches.clear();
  }

  clear(): void {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(KV_KEY);
    this.client = null;
    this.searches.clear();
  }

  private os(): OpenSubtitlesClient {
    const login = this.login();
    if (!login) throw new SubtitleError(409, 'not_configured', 'Online subtitles are not set up. An admin can add an OpenSubtitles API key in Settings › Online subtitles.');
    const key = JSON.stringify(login);
    if (this.client?.key !== key) this.client = { key, c: new OpenSubtitlesClient(login, this.clientOptions) };
    return this.client.c;
  }

  /* ---------------- items ---------------- */

  /** The item's search, or 404 when it isn't in the catalog. */
  query(kind: SubKind, id: string, language: string): OsQuery & { label: string } {
    if (kind === 'movie') {
      const m = getMovie(this.db, id);
      if (!m) throw new SubtitleError(404, 'not_found', 'Movie not found');
      const info = this.db.prepare('SELECT data FROM movie_info WHERE movie_id = ?').get(id) as { data: string } | undefined;
      let tmdbId: number | null = null;
      try {
        tmdbId = info ? ((JSON.parse(info.data) as { tmdbId?: number | null }).tmdbId ?? null) : null;
      } catch {
        tmdbId = null;
      }
      return { type: 'movie', query: m.name, year: m.year, tmdbId, language, label: m.year ? `${m.name} (${m.year})` : m.name };
    }
    const e = getEpisode(this.db, id);
    if (!e) throw new SubtitleError(404, 'not_found', 'Episode not found');
    const s = getSeries(this.db, e.series_id);
    const name = s?.name ?? e.title;
    return { type: 'episode', query: name, season: e.season, episode: e.episode, language, label: `${name} S${e.season} E${e.episode}` };
  }

  exists(kind: SubKind, id: string): void {
    this.query(kind, id, 'en');
  }

  files(kind: SubKind, id: string): ExternalSubtitle[] {
    const rows = this.db
      .prepare('SELECT id, kind, item_id, source, language, label, cues, fps, created_at FROM subtitle_files WHERE kind = ? AND item_id = ? ORDER BY created_at DESC')
      .all(kind, id) as FileRow[];
    return rows.map(toFile);
  }

  file(fileId: string): { kind: SubKind; itemId: string; vtt: string } | null {
    const r = this.db.prepare('SELECT kind, item_id, vtt FROM subtitle_files WHERE id = ?').get(fileId) as { kind: SubKind; item_id: string; vtt: string } | undefined;
    return r ? { kind: r.kind, itemId: r.item_id, vtt: r.vtt } : null;
  }

  state(profileId: string, kind: SubKind, id: string, savedOff: boolean): ExternalSubtitleState {
    const c = this.db.prepare('SELECT file_id, offset_ms, rate FROM subtitle_choices WHERE profile_id = ? AND kind = ? AND item_id = ?').get(profileId, kind, id) as
      | { file_id: string | null; offset_ms: number; rate: number | null }
      | undefined;
    const files = this.files(kind, id);
    // a picked file that is gone (should not happen) counts as nothing picked
    const choice = c && (c.file_id === null || files.some((f) => f.id === c.file_id)) ? { fileId: c.file_id, offsetMs: c.offset_ms, rate: c.rate ?? null } : null;
    return { online: !!this.login(), files, choice, savedOff, seriesLanguage: kind === 'episode' ? this.seriesLanguage(profileId, id) : null };
  }

  private seriesOf(episodeId: string): string | null {
    return getEpisode(this.db, episodeId)?.series_id ?? null;
  }

  seriesLanguage(profileId: string, episodeId: string): string | null {
    const series = this.seriesOf(episodeId);
    if (!series) return null;
    const r = this.db.prepare('SELECT language FROM subtitle_series WHERE profile_id = ? AND series_id = ?').get(profileId, series) as { language: string } | undefined;
    return r?.language ?? null;
  }

  /** rate: the drift fix (cue times multiplied by it); null or left out = worked out from the frame rates */
  saveChoice(profileId: string, kind: SubKind, id: string, fileId: string | null, offsetMs: number | undefined, rate?: number | null): void {
    if (fileId !== null && !this.files(kind, id).some((f) => f.id === fileId)) throw new SubtitleError(404, 'not_found', 'That subtitle is not kept for this title');
    const off = Math.round(Math.max(-SUBTITLE_LIMITS.offsetMs, Math.min(SUBTITLE_LIMITS.offsetMs, offsetMs ?? 0)));
    const r = rate === undefined || rate === null || fileId === null ? null : Math.max(SUBTITLE_LIMITS.rateMin, Math.min(SUBTITLE_LIMITS.rateMax, rate));
    this.db
      .prepare(
        `INSERT INTO subtitle_choices (profile_id, kind, item_id, file_id, offset_ms, rate, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, kind, item_id) DO UPDATE SET file_id = excluded.file_id, offset_ms = excluded.offset_ms, rate = excluded.rate, updated_at = excluded.updated_at`,
      )
      .run(profileId, kind, id, fileId, off, r, Date.now());
    // an episode: the series keeps the language for its other episodes (off: none for them either)
    const series = kind === 'episode' ? this.seriesOf(id) : null;
    if (!series) return;
    const language = fileId ? this.files(kind, id).find((f) => f.id === fileId)?.language : null;
    if (fileId && !language) return;
    if (language) {
      this.db
        .prepare(
          `INSERT INTO subtitle_series (profile_id, series_id, language, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(profile_id, series_id) DO UPDATE SET language = excluded.language, updated_at = excluded.updated_at`,
        )
        .run(profileId, series, language, Date.now());
    } else this.db.prepare('DELETE FROM subtitle_series WHERE profile_id = ? AND series_id = ?').run(profileId, series);
  }

  /* ---------------- online ---------------- */

  private async results(kind: SubKind, id: string, language: string): Promise<{ results: OsResult[]; query: string }> {
    const q = this.query(kind, id, language);
    const key = `${kind}:${id}:${language}`;
    const hit = this.searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit;
    const os = this.os();
    let results = await os.search(q);
    // a TMDB id the provider got wrong finds nothing: try the name too
    if (!results.length && q.tmdbId) results = await os.search({ ...q, tmdbId: null });
    // an episode search sometimes matches other episodes of the series
    if (q.type === 'episode') results = results.filter((r) => (r.feature.season === null || r.feature.season === q.season) && (r.feature.episode === null || r.feature.episode === q.episode));
    results = results.filter((r) => !r.language || r.language === language);
    const out = { at: Date.now(), results: rankResults(results), query: q.label };
    this.searches.set(key, out);
    if (this.searches.size > 500) this.searches.delete(this.searches.keys().next().value!);
    return out;
  }

  async search(kind: SubKind, id: string, lang: string): Promise<SubtitleSearchResponse> {
    const language = normalizeLanguage(lang);
    if (!language) throw new SubtitleError(400, 'bad_request', 'lang is a language code like "de"');
    const r = await this.wrap(this.results(kind, id, language));
    const kept = new Set(this.files(kind, id).map((f) => f.id));
    const results: SubtitleSearchResult[] = r.results.slice(0, 40).map((x) => ({
      fileId: x.fileId, language: x.language ?? language, release: x.release, downloads: x.downloads,
      hearingImpaired: x.hearingImpaired, machineTranslated: x.machineTranslated, trusted: x.trusted, kept: kept.has(`os-${x.fileId}`),
    }));
    return { results, query: r.query };
  }

  /** Downloads an OpenSubtitles file for the item and keeps it; a kept one is returned as it is. */
  async download(kind: SubKind, id: string, fileId: string, hint?: { language: string | null; release: string; fps: number | null }): Promise<{ file: ExternalSubtitle; remaining: number | null }> {
    if (!/^\d{1,12}$/.test(fileId)) throw new SubtitleError(400, 'bad_request', 'fileId is an OpenSubtitles file id');
    this.exists(kind, id);
    const fid = `os-${fileId}`;
    const kept = this.files(kind, id).find((f) => f.id === fid);
    if (kept) return { file: kept, remaining: null };
    // two devices asking at once download it once
    const key = `dl:${kind}:${id}:${fid}`;
    let p = this.inflight.get(key) as Promise<{ file: ExternalSubtitle; remaining: number | null }> | undefined;
    if (!p) {
      p = (async () => {
        // the language and release come from the search that listed it
        const meta = hint ?? [...this.searches.entries()].filter(([k]) => k.startsWith(`${kind}:${id}:`)).flatMap(([, v]) => v.results).find((r) => r.fileId === fileId);
        const { bytes, remaining } = await this.wrap(this.os().download(fileId));
        const conv = convertSubtitle(bytes);
        if (!conv) throw new SubtitleError(502, 'upstream', 'That subtitle file has no lines AnyCast can read. Pick another one.');
        const file = this.store(fid, kind, id, 'opensubtitles', meta?.language ?? null, meta?.release ?? 'OpenSubtitles', conv, meta?.fps ?? null);
        return { file, remaining };
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /** The best file in `lang` for the item: a kept one, else the top search result, downloaded now. */
  async auto(kind: SubKind, id: string, lang: string): Promise<ExternalSubtitle | null> {
    const language = normalizeLanguage(lang);
    if (!language) throw new SubtitleError(400, 'bad_request', 'language is a language code like "de"');
    this.exists(kind, id);
    const kept = this.files(kind, id).filter((f) => f.language === language);
    if (kept.length) return kept.find((f) => f.source === 'opensubtitles') ?? kept[0]!;
    if (!this.login()) return null;
    const { results } = await this.wrap(this.results(kind, id, language));
    const best = results[0];
    if (!best) return null;
    return (await this.download(kind, id, best.fileId, { language: best.language ?? language, release: best.release, fps: best.fps })).file;
  }

  /** Keeps a file from the device. */
  upload(kind: SubKind, id: string, name: string, bytes: Uint8Array, language: string | null): ExternalSubtitle {
    this.exists(kind, id);
    if (bytes.byteLength > SUBTITLE_LIMITS.uploadBytes) throw new SubtitleError(413, 'too_large', 'That file is too big for a subtitle file.');
    const conv = convertSubtitle(bytes);
    if (!conv) throw new SubtitleError(400, 'bad_format', 'No subtitles found in that file. AnyCast reads SRT and WebVTT files.');
    const label = name.replace(/[\p{C}]/gu, '').trim().slice(0, SUBTITLE_LIMITS.name) || 'Subtitle file';
    return this.store(`up-${randomBytes(9).toString('base64url')}`, kind, id, 'upload', normalizeLanguage(language) ?? guessLanguage(label), label, conv);
  }

  private store(fid: string, kind: SubKind, id: string, source: string, language: string | null, label: string, conv: { vtt: string; cues: number }, fps: number | null = null): ExternalSubtitle {
    const now = Date.now();
    this.db
      .prepare('INSERT OR REPLACE INTO subtitle_files (id, kind, item_id, source, language, label, vtt, cues, fps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fid, kind, id, source, language, label, conv.vtt, conv.cues, fps, now);
    return toFile({ id: fid, kind, item_id: id, source, language, label, cues: conv.cues, fps, created_at: now });
  }

  /** OpenSubtitles errors as SubtitleErrors with a status for the route. */
  private async wrap<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof OpenSubtitlesError) {
        const status = err.code === 'quota' ? 429 : err.code === 'busy' ? 503 : err.code === 'auth' ? 409 : 502;
        throw new SubtitleError(status, err.code === 'auth' ? 'not_configured' : err.code, err.message);
      }
      throw err;
    }
  }
}

/** "Movie.2019.German.srt", "movie.de.srt" -> 'de'. */
export function guessLanguage(name: string): string | null {
  const base = name.replace(/\.(srt|vtt|txt)$/i, '');
  const tag = /[._ -]([a-z]{2,3})$/i.exec(base)?.[1];
  const n = tag ? normalizeLanguage(tag) : null;
  if (n && n.length === 2) return n;
  const words: Record<string, string> = { german: 'de', deutsch: 'de', english: 'en', french: 'fr', spanish: 'es', italian: 'it', dutch: 'nl', turkish: 'tr', polish: 'pl', portuguese: 'pt' };
  const w = Object.keys(words).find((k) => new RegExp(`(^|[._ -])${k}([._ -]|$)`, 'i').test(base));
  return w ? words[w]! : null;
}
