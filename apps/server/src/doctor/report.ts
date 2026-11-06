/**
 * Provider diagnostics. Talks to the provider directly and summarizes what AnyCast will see.
 * The report contains no credentials, hostnames, URLs or tokens: every string passes the redactor.
 */
import type { XtreamCredentials } from '../config';
import { tagCategory, tagItem, type Tag } from '../catalog/tagger';
import { runFfprobe, type ProbeResult } from '../playback/probe';
import { createRedactor, redactDeep } from '../redact';
import { XtreamClient, XtreamError } from '../xtream/client';
import { parseXmltv } from '../xtream/xmltv';

export interface DoctorOptions {
  samples: number;
  streams: boolean;
  probe?: (url: string) => Promise<ProbeResult>;
  now?: number;
}

interface StreamSample {
  kind: 'live' | 'movie' | 'episode';
  ok: boolean;
  container: string | null;
  video: string | null;
  audio: string | null;
  resolution: string | null;
  subtitles: boolean;
  error: string | null;
}

export interface DoctorReport {
  account: { status: string; expiresAt: string | null; trial: boolean; maxConnections: number | null; activeConnections: number | null };
  timezone: string | null;
  categories: { live: number; movie: number; series: number };
  items: { live: number; movie: number; series: number };
  topCountries: { code: string; count: number }[];
  topLanguages: { code: string; count: number }[];
  untagged: { percent: number };
  archive: { percentChannels: number; days: Record<string, number> };
  epg: { percentWithId: number; percentWithProgramNow: number | null; error: string | null };
  streams: { samples: StreamSample[]; summary: Record<string, Record<string, number>> } | null;
  timeshift: { tested: boolean; ok: boolean; detail: string } | null;
}

export class DoctorAuthError extends Error {}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

function top(counts: Map<string, number>, n = 15) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([code, count]) => ({ code, count }));
}

function sampleOf(kind: StreamSample['kind'], p: ProbeResult): StreamSample {
  return {
    kind, ok: true, container: p.container, video: p.video?.codec ?? null, audio: p.audio[0]?.codec ?? null,
    resolution: p.video?.width && p.video.height ? `${p.video.width}x${p.video.height}` : null,
    subtitles: p.subtitles.length > 0, error: null,
  };
}

export async function runDoctor(creds: XtreamCredentials, opts: DoctorOptions): Promise<DoctorReport> {
  const redact = createRedactor(creds);
  const client = new XtreamClient(creds, { timeoutMs: 120_000, retries: 1 });
  const probe = opts.probe ?? ((url: string) => runFfprobe(url, 12_000));
  const now = opts.now ?? Date.now();

  let auth;
  try {
    auth = await client.authenticate();
  } catch (err) {
    if (err instanceof XtreamError && (err.code === 'auth' || err.code === 'parse')) throw new DoctorAuthError(err.message);
    throw err;
  }
  const u = auth.user_info;

  const [liveCats, vodCats, seriesCats, live, vod, series] = await Promise.all([
    client.liveCategories(), client.vodCategories(), client.seriesCategories(), client.liveStreams(), client.vodStreams(), client.series(),
  ]);

  const countries = new Map<string, number>();
  const languages = new Map<string, number>();
  let untagged = 0;
  const catTags = new Map<string, Tag>();
  for (const [prefix, cats] of [['l', liveCats], ['m', vodCats], ['s', seriesCats]] as const) {
    for (const c of cats) catTags.set(prefix + c.category_id, tagCategory(c.category_name));
  }
  const count = (prefix: string, name: string, cat: string | null) => {
    const t = tagItem(name, catTags.get(prefix + (cat ?? '')) ?? null);
    if (t.country) countries.set(t.country, (countries.get(t.country) ?? 0) + 1);
    if (t.language) languages.set(t.language, (languages.get(t.language) ?? 0) + 1);
    if (!t.country && !t.language) untagged++;
  };
  live.forEach((s) => count('l', s.name, s.category_id));
  vod.forEach((s) => count('m', s.name, s.category_id));
  series.forEach((s) => count('s', s.name, s.category_id));

  const archived = live.filter((s) => s.tv_archive && (s.tv_archive_duration ?? 0) > 0);
  const days: Record<string, number> = {};
  for (const s of archived) {
    const d = String(Math.round(s.tv_archive_duration ?? 0));
    days[d] = (days[d] ?? 0) + 1;
  }

  const withEpgId = live.filter((s) => s.epg_channel_id?.trim());
  const epg: DoctorReport['epg'] = { percentWithId: pct(withEpgId.length, live.length), percentWithProgramNow: null, error: null };
  try {
    const airing = new Set<string>();
    for await (const p of parseXmltv(await client.xmltv(), auth.server_info.timezone)) {
      if (p.start <= now && p.stop > now) airing.add(p.channel);
    }
    epg.percentWithProgramNow = pct(withEpgId.filter((s) => airing.has(s.epg_channel_id!.trim())).length, live.length);
  } catch (err) {
    epg.error = redact((err as Error).message);
  }

  let streams: DoctorReport['streams'] = null;
  let timeshift: DoctorReport['timeshift'] = null;
  if (opts.streams) {
    const samples: StreamSample[] = [];
    // one probe at a time to respect the provider's connection limit
    const run = async (kind: StreamSample['kind'], url: string) => {
      try {
        samples.push(sampleOf(kind, await probe(url)));
      } catch (err) {
        samples.push({ kind, ok: false, container: null, video: null, audio: null, resolution: null, subtitles: false, error: redact((err as Error).message) });
      }
    };
    for (const s of pickRandom(live, opts.samples)) await run('live', client.liveUrl(s.stream_id));
    for (const m of pickRandom(vod, 5)) await run('movie', client.movieUrl(m.stream_id, m.container_extension));
    const episodes = [];
    for (const s of pickRandom(series, 3)) {
      try {
        const info = await client.seriesInfo(s.series_id);
        const ep = pickRandom(info.episodes, 1)[0];
        if (ep) episodes.push(ep);
      } catch {
        // counted as missing sample
      }
    }
    for (const e of episodes) await run('episode', client.episodeUrl(e.id, e.container_extension));

    const summary: Record<string, Record<string, number>> = {};
    const bump = (field: string, value: string) => {
      summary[field] ??= {};
      summary[field]![value] = (summary[field]![value] ?? 0) + 1;
    };
    for (const s of samples) {
      if (!s.ok) {
        bump('failed', s.kind);
        continue;
      }
      bump('container', `${s.kind}:${s.container ?? '?'}`);
      bump('video', s.video ?? 'none');
      bump('audio', s.audio ?? 'none');
      bump('resolution', s.resolution ?? 'unknown');
      bump('subtitles', s.subtitles ? 'yes' : 'no');
    }
    streams = { samples, summary };

    const channel = pickRandom(archived, 1)[0];
    if (!channel) timeshift = { tested: false, ok: false, detail: 'No channel with archive' };
    else {
      const start = now - 60 * 60_000;
      try {
        const p = await probe(client.timeshiftUrl(channel.stream_id, start, 10, auth.server_info.timezone));
        timeshift = { tested: true, ok: true, detail: `${p.container ?? '?'} ${p.video?.codec ?? '?'}/${p.audio[0]?.codec ?? '?'} from one hour ago` };
      } catch (err) {
        timeshift = { tested: true, ok: false, detail: redact((err as Error).message) };
      }
    }
  }

  const report: DoctorReport = {
    account: {
      status: u.status ?? 'Unknown',
      expiresAt: u.exp_date ? new Date(u.exp_date * 1000).toISOString().slice(0, 10) : null,
      trial: u.is_trial,
      maxConnections: u.max_connections,
      activeConnections: u.active_cons,
    },
    timezone: auth.server_info.timezone,
    categories: { live: liveCats.length, movie: vodCats.length, series: seriesCats.length },
    items: { live: live.length, movie: vod.length, series: series.length },
    topCountries: top(countries),
    topLanguages: top(languages),
    untagged: { percent: pct(untagged, live.length + vod.length + series.length) },
    archive: { percentChannels: pct(archived.length, live.length), days },
    epg,
    streams,
    timeshift,
  };
  return redactDeep(report, redact);
}

export function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  const kv = (k: string, v: unknown) => lines.push(`  ${k.padEnd(24)} ${v}`);
  lines.push('AnyCast doctor', '', 'Account');
  kv('status', r.account.status + (r.account.trial ? ' (trial)' : ''));
  kv('expires', r.account.expiresAt ?? 'never / unknown');
  kv('connections', `${r.account.activeConnections ?? '?'} active of ${r.account.maxConnections ?? '?'}`);
  kv('timezone', r.timezone ?? 'unknown');
  lines.push('', 'Catalog');
  kv('live', `${r.items.live} channels in ${r.categories.live} categories`);
  kv('movies', `${r.items.movie} in ${r.categories.movie} categories`);
  kv('series', `${r.items.series} in ${r.categories.series} categories`);
  kv('untagged items', `${r.untagged.percent}%`);
  kv('top countries', r.topCountries.map((c) => `${c.code} ${c.count}`).join(', ') || '-');
  kv('top languages', r.topLanguages.map((c) => `${c.code} ${c.count}`).join(', ') || '-');
  lines.push('', 'Archive (catch-up)');
  kv('channels with archive', `${r.archive.percentChannels}%`);
  kv('days', Object.entries(r.archive.days).sort((a, b) => Number(a[0]) - Number(b[0])).map(([d, n]) => `${d}d: ${n}`).join(', ') || '-');
  lines.push('', 'EPG');
  kv('channels with EPG id', `${r.epg.percentWithId}%`);
  kv('with a programme now', r.epg.percentWithProgramNow === null ? `unavailable (${r.epg.error})` : `${r.epg.percentWithProgramNow}%`);
  if (r.streams) {
    lines.push('', `Stream formats (${r.streams.samples.length} samples)`);
    for (const [field, counts] of Object.entries(r.streams.summary)) {
      kv(field, Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', '));
    }
    for (const s of r.streams.samples.filter((x) => !x.ok)) kv(`failed ${s.kind}`, s.error);
  }
  if (r.timeshift) {
    lines.push('', 'Timeshift');
    kv('result', r.timeshift.tested ? `${r.timeshift.ok ? 'ok' : 'failed'}: ${r.timeshift.detail}` : r.timeshift.detail);
  }
  return lines.join('\n');
}

export function parseArgs(argv: string[]): { samples: number; json: boolean; streams: boolean } {
  const out = { samples: 8, json: false, streams: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-streams') out.streams = false;
    else if (a === '--samples') out.samples = Math.max(0, Math.min(100, Number(argv[++i]) || 0));
    else if (a?.startsWith('--samples=')) out.samples = Math.max(0, Math.min(100, Number(a.slice(10)) || 0));
  }
  return out;
}
