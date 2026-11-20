/**
 * External subtitles in the player (see @anycast/shared subtitles.ts): the server's WebVTT parsed
 * into cues, the cues showing at a time (with the viewer's timing offset), and when the player
 * fetches some on its own (the profile's Subtitles preference).
 */
import { normalizeLanguage, sameLanguage, type ExternalSubtitleState, type PlaybackTracks, type Preferences } from '@anycast/shared';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseTime(s: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

/** Cues of a WebVTT file (as the server writes them: one time line, then the text). */
export function parseVtt(text: string): Cue[] {
  const out: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at]!.split('-->');
    const start = parseTime(a ?? '');
    const end = parseTime((b ?? '').trim().split(/\s+/)[0] ?? '');
    const body = lines.slice(at + 1).join('\n').trim();
    if (start !== null && end !== null && end > start && body) out.push({ start, end, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Index of the first cue that ends after `t` (cues are sorted by start; most are short and don't overlap). */
function firstEndingAfter(cues: Cue[], t: number): number {
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.start + 30 <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The cues showing at video time `t`, with `offsetMs` (positive: the subtitles come later). */
export function activeCues(cues: Cue[], t: number, offsetMs: number): Cue[] {
  const at = t - offsetMs / 1000;
  const out: Cue[] = [];
  // a cue longer than 30 s is rare; starting there keeps this cheap every frame
  for (let i = firstEndingAfter(cues, at); i < cues.length; i++) {
    const c = cues[i]!;
    if (c.start > at) break;
    if (c.end > at) out.push(c);
  }
  return out;
}

export type Segment = { text: string; i?: boolean; b?: boolean; u?: boolean };

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'" };

/** A cue's text as plain segments with italic / bold / underline (the only tags the server keeps). */
export function cueSegments(text: string): Segment[] {
  const out: Segment[] = [];
  const on = { i: 0, b: 0, u: 0 };
  for (const part of text.split(/(<\/?[ibu]>)/)) {
    const tag = /^<(\/?)([ibu])>$/.exec(part);
    if (tag) {
      const k = tag[2] as 'i' | 'b' | 'u';
      on[k] = Math.max(0, on[k] + (tag[1] ? -1 : 1));
      continue;
    }
    if (!part) continue;
    out.push({ text: part.replace(/&(amp|lt|gt|nbsp|quot|#39);/g, (e) => ENTITIES[e] ?? e), ...(on.i ? { i: true } : {}), ...(on.b ? { b: true } : {}), ...(on.u ? { u: true } : {}) });
  }
  return out;
}

/** "+1.5 s", "−0.25 s", "0 s" */
export function fmtOffset(ms: number): string {
  if (!ms) return '0 s';
  const s = Math.abs(ms) / 1000;
  return `${ms > 0 ? '+' : '−'}${Number.isInteger(s) ? s : s.toFixed(s * 10 === Math.round(s * 10) ? 1 : 2)} s`;
}

/**
 * The language to fetch external subtitles in on its own, or null to leave them off: when nothing
 * was picked for the item, the stream shows none of its own, and either another episode of the
 * series had some (its language) or the Subtitles preference wants some. Auto: only when the audio (or, when the stream doesn't say, the title's language from its
 * category) is not already in the subtitle language.
 */
export function autoLanguage(o: {
  prefs: Preferences['player'];
  tracks: PlaybackTracks | undefined;
  /** the subtitle track the stream shows (null = none) */
  shown: number | null;
  state: ExternalSubtitleState;
  /** the movie's or series' language from its category, when tagged */
  itemLanguage: string | null;
  /** the device's language, for Always without a subtitle language */
  deviceLanguage: string | null;
}): string | null {
  const { prefs, tracks, state } = o;
  if (state.choice || state.savedOff || o.shown !== null) return null;
  // picked for another episode of the series: the same language, whatever the preference says
  if (state.seriesLanguage) return state.seriesLanguage;
  const want = normalizeLanguage(prefs.preferredSubtitleLanguage);
  const audioLang = tracks?.audio.find((a) => a.index === tracks.audioIndex)?.language ?? null;
  const spoken = audioLang ?? o.itemLanguage;
  switch (prefs.subtitlesDefault) {
    case 'off':
      return null;
    case 'on':
      return want ?? normalizeLanguage(o.deviceLanguage) ?? 'en';
    case 'auto':
      if (!want || sameLanguage(spoken, want)) return null;
      return want;
  }
}

/** The language a search starts in: the subtitle language, else the device's. */
export function searchLanguage(prefs: Preferences['player'], deviceLanguage: string | null): string {
  return normalizeLanguage(prefs.preferredSubtitleLanguage) ?? normalizeLanguage(deviceLanguage) ?? 'en';
}
