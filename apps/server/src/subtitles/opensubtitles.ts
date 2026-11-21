/**
 * OpenSubtitles REST API (https://opensubtitles.stoplight.io). An API key (a free "consumer" made
 * on opensubtitles.com) searches; downloading counts against a daily quota, which a signed-in
 * account raises (the key alone gets a few a day per IP, a free account 20, VIP 1000).
 */
import { normalizeLanguage } from '@anycast/shared';

export const OPENSUBTITLES_URL = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'AnyCast v1.0';

export interface OpenSubtitlesLogin {
  apiKey: string;
  username?: string | null;
  password?: string | null;
}

export interface OsQuery {
  type: 'movie' | 'episode';
  /** the movie's or series' name */
  query: string;
  year?: number | null;
  season?: number;
  episode?: number;
  tmdbId?: number | null;
  /** ISO 639-1 */
  language: string;
}

export interface OsResult {
  fileId: string;
  language: string | null;
  release: string;
  downloads: number;
  hearingImpaired: boolean;
  machineTranslated: boolean;
  trusted: boolean;
  /** the frame rate of the release it was timed for, when the uploader said */
  fps: number | null;
  /** what OpenSubtitles matched the result to */
  feature: { title: string | null; year: number | null; season: number | null; episode: number | null };
}

export class OpenSubtitlesError extends Error {
  constructor(
    public code: 'auth' | 'quota' | 'busy' | 'network' | 'upstream',
    message: string,
  ) {
    super(message);
    this.name = 'OpenSubtitlesError';
  }
}

/** OpenSubtitles writes Portuguese and Chinese with a region. */
const OS_LANGS: Record<string, string> = { pt: 'pt-pt,pt-br', zh: 'zh-cn,zh-tw' };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The search query string in the API's canonical form: keys in alphabetical order, lower-case
 * values, spaces as "+", commas as they are. Any other spelling gets a 301 to the canonical URL
 * (which also shares the API's cache).
 */
export function searchParams(q: OsQuery): string {
  const p: Record<string, string> = { languages: OS_LANGS[q.language] ?? q.language.toLowerCase() };
  if (q.tmdbId) {
    p[q.type === 'episode' ? 'parent_tmdb_id' : 'tmdb_id'] = String(q.tmdbId);
  } else {
    p.query = q.query.toLowerCase();
    if (q.year && q.type === 'movie') p.year = String(q.year);
  }
  if (q.type === 'episode') {
    if (q.season !== undefined) p.season_number = String(q.season);
    if (q.episode !== undefined) p.episode_number = String(q.episode);
  }
  p.type = q.type;
  return Object.keys(p)
    .sort()
    .map((k) => `${k}=${encodeURIComponent(p[k]!).replace(/%20/g, '+').replace(/%2C/gi, ',')}`)
    .join('&');
}

export function parseResults(data: unknown): OsResult[] {
  const list = Array.isArray(obj(data).data) ? (obj(data).data as unknown[]) : [];
  const out: OsResult[] = [];
  for (const item of list) {
    const a = obj(obj(item).attributes);
    const files = Array.isArray(a.files) ? a.files : [];
    const file = obj(files[0]);
    const fileId = num(file.file_id);
    if (fileId === null) continue;
    const f = obj(a.feature_details);
    out.push({
      fileId: String(fileId),
      language: normalizeLanguage(str(a.language)),
      release: str(a.release) ?? str(file.file_name) ?? 'Subtitle',
      downloads: num(a.download_count) ?? 0,
      hearingImpaired: a.hearing_impaired === true,
      machineTranslated: a.machine_translated === true || a.ai_translated === true,
      trusted: a.from_trusted === true,
      fps: num(a.fps) || null,
      feature: {
        title: str(f.parent_title) ?? str(f.title) ?? str(f.movie_name),
        year: num(f.year),
        season: num(f.season_number),
        episode: num(f.episode_number),
      },
    });
  }
  return out;
}

/** Best first: the most downloaded, with machine translations (often poor) after people's. */
export function rankResults<T extends Pick<OsResult, 'machineTranslated' | 'downloads'>>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(a.machineTranslated) - Number(b.machineTranslated) || b.downloads - a.downloads);
}

export interface ClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Only an OpenSubtitles host may get the key and token (the VIP host comes from the login answer). */
const OS_HOST = /^([a-z0-9-]+\.)*opensubtitles\.com$/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenSubtitlesClient {
  private token: { value: string; base: string; at: number } | null = null;
  private signingIn: Promise<{ token?: string; base: string }> | null = null;
  /** the account was rejected: logging in is "expensive", so it isn't tried again with the same login */
  private rejected: OpenSubtitlesError | null = null;
  private lastLoginAt = 0;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly login: OpenSubtitlesLogin,
    opts: ClientOptions = {},
  ) {
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? OPENSUBTITLES_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, base = this.baseUrl, token?: string, retried = false): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(`${base}${path}`, {
        method,
        headers: {
          'Api-Key': this.login.apiKey,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new OpenSubtitlesError('network', "Couldn't reach OpenSubtitles. Try again in a moment.");
    }
    const text = await res.text().catch(() => '');
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    const said = str(obj(data).message) ?? str(obj(data).error);
    // too many requests a second: wait as asked (or 2 s) and try once more
    if (res.status === 429 && !retried && path !== '/login') {
      const after = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 5) * 1000 : 2000);
      return this.request(method, path, body, base, token, true);
    }
    if (res.status === 429) throw new OpenSubtitlesError('busy', 'OpenSubtitles is busy right now. Try again in a moment.');
    // an expired account token: sign in again once
    if (res.status === 401 && token && !retried) {
      this.token = null;
      const s = await this.session();
      return this.request(method, path, body, s.base, s.token, true);
    }
    if (res.status === 401 || res.status === 403) {
      const message =
        path === '/login' ? 'OpenSubtitles rejected this username or password.'
        : /user agent/i.test(said ?? '') ? `OpenSubtitles refused the app (${said}).`
        : 'OpenSubtitles rejected the API key.';
      throw new OpenSubtitlesError('auth', message);
    }
    if (res.status === 406) {
      throw new OpenSubtitlesError('quota', said ? `OpenSubtitles: ${said}` : 'The OpenSubtitles download limit for today is used up.');
    }
    throw new OpenSubtitlesError('upstream', `OpenSubtitles answered with an error (${res.status}${said ? `: ${said}` : ''}).`);
  }

  /**
   * Signs in with the account, when one is set: once at a time, at most once a second (the API's
   * login limit), never again after the login was rejected. The token is kept for 12 hours and
   * renewed when a request says it expired.
   */
  private async session(): Promise<{ token?: string; base: string }> {
    if (!this.login.username || !this.login.password) return { base: this.baseUrl };
    if (this.rejected) throw this.rejected;
    if (this.token && Date.now() - this.token.at < 12 * 3600_000) return { token: this.token.value, base: this.token.base };
    if (!this.signingIn) {
      this.signingIn = (async () => {
        const wait = this.lastLoginAt + 1100 - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastLoginAt = Date.now();
        let data: Record<string, unknown>;
        try {
          data = obj(await this.request('POST', '/login', { username: this.login.username, password: this.login.password }));
        } catch (err) {
          if (err instanceof OpenSubtitlesError && err.code === 'auth') this.rejected = err;
          throw err;
        }
        const value = str(data.token);
        if (!value) throw new OpenSubtitlesError('upstream', 'OpenSubtitles did not sign in.');
        // VIP accounts get their own API host (only ever an opensubtitles.com one)
        const host = str(data.base_url)?.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const base = host && OS_HOST.test(host) && this.baseUrl === OPENSUBTITLES_URL ? `https://${host}/api/v1` : this.baseUrl;
        this.token = { value, base, at: Date.now() };
        return { token: value, base };
      })().finally(() => {
        this.signingIn = null;
      });
    }
    return this.signingIn;
  }

  /** Checks the key (and account): what an admin sees after saving. */
  async check(): Promise<string> {
    if (this.login.username && this.login.password) {
      const s = await this.session();
      const user = obj(obj(await this.request('GET', '/infos/user', undefined, s.base, s.token)).data);
      const allowed = num(user.allowed_downloads);
      const left = num(user.remaining_downloads);
      return `Signed in as ${this.login.username}.${allowed ? ` ${allowed} downloads a day${left !== null ? `, ${left} left today` : ''}.` : ''}`;
    }
    await this.request('GET', '/infos/languages');
    return 'The API key works. Without an account, OpenSubtitles allows only a few downloads a day: add one for more.';
  }

  async search(q: OsQuery): Promise<OsResult[]> {
    const s = await this.session();
    return parseResults(await this.request('GET', `/subtitles?${searchParams(q)}`, undefined, s.base, s.token));
  }

  /** The subtitle file's bytes, and the downloads left today. */
  async download(fileId: string): Promise<{ bytes: Uint8Array; remaining: number | null }> {
    const s = await this.session();
    const data = obj(await this.request('POST', '/download', { file_id: Number(fileId), sub_format: 'srt' }, s.base, s.token));
    const link = str(data.link);
    if (!link || !/^https?:\/\//.test(link)) throw new OpenSubtitlesError('upstream', str(data.message) ?? 'OpenSubtitles gave no download link.');
    let res: Response;
    try {
      res = await this.fetchFn(link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new OpenSubtitlesError('network', "Couldn't download the subtitle. Try again in a moment.");
    }
    if (!res.ok) throw new OpenSubtitlesError('upstream', `The subtitle download failed (${res.status}).`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), remaining: num(data.remaining) };
  }
}
