/**
 * Audio and subtitle track listing and selection (PB-3). Pure functions over a probe result.
 *
 * Which audio track plays: the one asked for, else the one saved for the item, else the first in
 * the preferred language (the source's default among several), else the source's default, else
 * the first. Subtitles likewise, with Preferences.player.subtitlesDefault deciding when nothing
 * was asked for or saved. Only text subtitles can be picked.
 */
import {
  BITMAP_SUBTITLE_CODECS, normalizeLanguage, sameLanguage, TEXT_SUBTITLE_CODECS,
  type AudioTrack, type Preferences, type SubtitleTrack,
} from '@anycast/shared';
import type { ProbeAudio, ProbeSubtitle } from './probe';

export type SubtitleRequest = number | 'off' | undefined;

/** null: nothing saved for the item; subtitle null: saved as off */
export interface SavedChoice { audio: number | null; subtitle: number | null | undefined }

export function audioTracks(audio: ProbeAudio[]): AudioTrack[] {
  return audio.map((a, index) => ({
    index, language: normalizeLanguage(a.language), codec: a.codec, channels: a.channels,
    title: a.title ?? null, default: a.default ?? false,
  }));
}

const BITMAP_NAMES: Record<string, string> = {
  hdmv_pgs_subtitle: 'PGS', pgssub: 'PGS', dvd_subtitle: 'DVD', dvdsub: 'DVD', vobsub: 'DVD', dvb_subtitle: 'DVB', dvbsub: 'DVB', xsub: 'XSUB',
};

export function subtitleTracks(subs: ProbeSubtitle[], mode: 'vod' | 'live'): SubtitleTrack[] {
  return subs.map((s, index) => {
    const text = TEXT_SUBTITLE_CODECS.includes(s.codec);
    const bitmap = BITMAP_SUBTITLE_CODECS.includes(s.codec);
    const track: SubtitleTrack = {
      index, language: normalizeLanguage(s.language), codec: s.codec, title: s.title ?? null,
      default: s.default ?? false, forced: s.forced ?? false, format: bitmap || !text ? 'bitmap' : 'text',
    };
    if (bitmap) track.unavailable = `Picture-based (${BITMAP_NAMES[s.codec] ?? 'bitmap'}) subtitles can't be shown`;
    else if (s.codec === 'dvb_teletext') track.unavailable = "Teletext subtitles can't be shown";
    else if (!text) track.unavailable = "This subtitle format isn't supported";
    else if (mode === 'live') track.unavailable = 'Subtitles are shown for movies and episodes only';
    return track;
  });
}

const valid = (n: number | null | undefined, count: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < count;

export function pickAudio(audio: ProbeAudio[], o: { requested?: number; saved?: number | null; preferred: string | null }): number | null {
  if (!audio.length) return null;
  if (valid(o.requested, audio.length)) return o.requested;
  if (valid(o.saved, audio.length)) return o.saved;
  const byLang = o.preferred ? audio.map((a, i) => ({ a, i })).filter(({ a }) => sameLanguage(a.language, o.preferred)) : [];
  // among several in the language, a commentary track is rarely what anyone wants first
  const pick = byLang.find(({ a }) => a.default) ?? byLang.find(({ a }) => !/comment/i.test(a.title ?? '')) ?? byLang[0];
  if (pick) return pick.i;
  const def = audio.findIndex((a) => a.default);
  return def >= 0 ? def : 0;
}

export function pickSubtitle(
  subs: SubtitleTrack[],
  o: { requested?: SubtitleRequest; saved?: number | null; prefs: Preferences['player']; audioLanguage: string | null },
): number | null {
  const usable = subs.filter((s) => !s.unavailable);
  const ok = (n: number | null | undefined): n is number => typeof n === 'number' && usable.some((s) => s.index === n);
  if (o.requested === 'off') return null;
  if (ok(o.requested)) return o.requested;
  if (o.saved === null) return null;
  if (ok(o.saved)) return o.saved;
  const text = usable;
  if (!text.length) return null;
  const want = o.prefs.preferredSubtitleLanguage;
  const inLang = want ? text.filter((s) => sameLanguage(s.language, want)) : [];
  const best = (list: SubtitleTrack[]) => list.find((s) => !s.forced && s.default) ?? list.find((s) => !s.forced) ?? list[0];
  switch (o.prefs.subtitlesDefault) {
    case 'off':
      return null;
    case 'on':
      return (best(inLang) ?? best(text.filter((s) => s.default)) ?? best(text))?.index ?? null;
    case 'auto':
      // only when the audio is not already in the language the subtitles are wanted in
      if (!want || sameLanguage(o.audioLanguage, want)) return null;
      return best(inLang)?.index ?? null;
  }
}
