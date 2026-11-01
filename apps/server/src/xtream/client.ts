import { Readable } from 'node:stream';
import type { XtreamCredentials } from '../config';
import {
  AuthResponse, parseList, parseSeriesInfo, XCategory, XLiveStream, XSeries, XVodStream,
  type XSeriesInfo,
} from './schemas';

export class XtreamError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'network' | 'http' | 'parse',
  ) {
    super(message);
    this.name = 'XtreamError';
  }
}

export interface ClientOptions {
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
}

const UA = 'AnyCast/0.1';

/** Typed access to an Xtream Codes panel. Error messages never include the URL or credentials. */
export class XtreamClient {
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    readonly creds: XtreamCredentials,
    opts: ClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
    this.fetchFn = opts.fetch ?? fetch;
  }

  private apiUrl(params: Record<string, string>): string {
    const q = new URLSearchParams({ username: this.creds.username, password: this.creds.password, ...params });
    return `${this.creds.url}/player_api.php?${q}`;
  }

  private async request(url: string, timeoutMs = this.timeoutMs): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      try {
        const res = await this.fetchFn(url, {
          headers: { 'user-agent': UA, accept: '*/*' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 401 || res.status === 403) {
          throw new XtreamError('Provider rejected the login (check XTREAM_USERNAME / XTREAM_PASSWORD)', 'auth');
        }
        if (res.status >= 500) {
          lastErr = new XtreamError(`Provider responded with HTTP ${res.status}`, 'http');
          continue;
        }
        if (!res.ok) throw new XtreamError(`Provider responded with HTTP ${res.status}`, 'http');
        return res;
      } catch (err) {
        if (err instanceof XtreamError) {
          if (err.code === 'auth' || err.code === 'http') throw err;
        }
        lastErr = err;
      }
    }
    if (lastErr instanceof XtreamError) throw lastErr;
    const reason = lastErr instanceof Error && lastErr.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
    throw new XtreamError(`Provider ${reason}`, 'network');
  }

  private async json(params: Record<string, string>): Promise<unknown> {
    const res = await this.request(this.apiUrl(params));
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new XtreamError('Provider returned a response that is not JSON', 'parse');
    }
  }

  async authenticate(): Promise<AuthResponse> {
    const data = await this.json({});
    const hasUser = !!data && typeof data === 'object' && 'user_info' in data;
    const parsed = AuthResponse.safeParse(data);
    if (!hasUser || !parsed.success || parsed.data.user_info.auth === 0) {
      throw new XtreamError('Provider rejected the login (check XTREAM_USERNAME / XTREAM_PASSWORD)', 'auth');
    }
    return parsed.data;
  }

  async liveCategories() { return parseList(XCategory, await this.json({ action: 'get_live_categories' })); }
  async vodCategories() { return parseList(XCategory, await this.json({ action: 'get_vod_categories' })); }
  async seriesCategories() { return parseList(XCategory, await this.json({ action: 'get_series_categories' })); }
  async liveStreams() { return parseList(XLiveStream, await this.json({ action: 'get_live_streams' })); }
  async vodStreams() { return parseList(XVodStream, await this.json({ action: 'get_vod_streams' })); }
  async series() { return parseList(XSeries, await this.json({ action: 'get_series' })); }

  async seriesInfo(seriesId: string): Promise<XSeriesInfo> {
    return parseSeriesInfo(await this.json({ action: 'get_series_info', series_id: seriesId }));
  }

  /** Full XMLTV guide as a byte stream (can be hundreds of MB; parse it streaming). */
  async xmltv(): Promise<Readable> {
    const q = new URLSearchParams({ username: this.creds.username, password: this.creds.password });
    const res = await this.request(`${this.creds.url}/xmltv.php?${q}`, 10 * 60_000);
    if (!res.body) throw new XtreamError('Provider returned an empty guide', 'parse');
    return Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  liveUrl(streamId: string, format: 'ts' | 'm3u8' = 'ts'): string {
    return `${this.creds.url}/live/${enc(this.creds.username)}/${enc(this.creds.password)}/${streamId}.${format}`;
  }

  movieUrl(streamId: string, ext: string | null): string {
    return `${this.creds.url}/movie/${enc(this.creds.username)}/${enc(this.creds.password)}/${streamId}.${ext || 'mp4'}`;
  }

  episodeUrl(episodeId: string, ext: string | null): string {
    return `${this.creds.url}/series/${enc(this.creds.username)}/${enc(this.creds.password)}/${episodeId}.${ext || 'mp4'}`;
  }

  /** Catch-up stream. The start time is expressed in the provider's timezone, minute resolution. */
  timeshiftUrl(streamId: string, startMs: number, durationMin: number, timezone: string | null): string {
    const start = formatProviderTime(startMs, timezone);
    return `${this.creds.url}/timeshift/${enc(this.creds.username)}/${enc(this.creds.password)}/${Math.max(1, Math.round(durationMin))}/${start}/${streamId}.ts`;
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** YYYY-MM-DD:HH-MM in the given IANA timezone (UTC if unknown). */
export function formatProviderTime(ms: number, timezone: string | null): string {
  let tz = 'UTC';
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      tz = timezone;
    } catch {
      tz = 'UTC';
    }
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}
