/** Audio and subtitle track menu helpers (PB-3). Tracks come from PlaybackInfo.tracks (the server's probe). */
import type { AudioTrack, PlaybackTracks, SubtitleTrack } from '@anycast/shared';
import { languageName } from '../lib/lang';

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', truehd: 'Dolby TrueHD', dts: 'DTS', opus: 'Opus', mp3: 'MP3', mp2: 'MP2', flac: 'FLAC', vorbis: 'Vorbis', pcm_s16le: 'PCM',
};

function channelsName(n: number | null): string | null {
  if (!n) return null;
  if (n === 1) return 'Mono';
  if (n === 2) return 'Stereo';
  if (n === 6) return '5.1';
  if (n === 8) return '7.1';
  return `${n} ch`;
}

const lang = (code: string | null) => (code ? languageName(code) : 'Unknown language');

/** "English · Commentary" (the main line) and "Dolby Digital Plus 5.1" (the detail line). */
export function audioLabel(t: AudioTrack): { main: string; detail: string } {
  return {
    main: [lang(t.language), t.title].filter(Boolean).join(' · '),
    detail: [CODEC_NAMES[t.codec] ?? t.codec.toUpperCase(), channelsName(t.channels)].filter(Boolean).join(' '),
  };
}

/** Main line, and the detail line: why it can't be shown, or "Forced". */
export function subtitleLabel(t: SubtitleTrack): { main: string; detail: string | null } {
  return {
    main: [lang(t.language), t.title].filter(Boolean).join(' · '),
    detail: t.unavailable ?? (t.forced ? 'Forced (signs and foreign dialogue)' : null),
  };
}

/** Position of subtitle track `index` among the renditions the stream carries (the shown-able tracks, in order). */
export function renditionOf(tracks: PlaybackTracks, index: number | null): number | null {
  if (index === null || !tracks.subtitlesInStream) return null;
  const pos = tracks.subtitles.filter((s) => !s.unavailable).findIndex((s) => s.index === index);
  return pos < 0 ? null : pos;
}

/**
 * What picking subtitle `index` takes: 'switch' (the stream carries it, or turning off),
 * 'reload' (played directly: ask the server for a stream with subtitles), or 'none' (can't be shown).
 */
export function subtitleAction(tracks: PlaybackTracks, index: number | null): 'switch' | 'reload' | 'none' {
  if (index === null) return 'switch';
  const t = tracks.subtitles.find((s) => s.index === index);
  if (!t || t.unavailable) return 'none';
  return tracks.subtitlesInStream ? 'switch' : 'reload';
}

/** The tracks button is worth showing: a choice of audio, or any subtitles (even ones listed as unavailable). */
export const hasTrackChoice = (t: PlaybackTracks | undefined) => !!t && (t.audio.length > 1 || t.subtitles.length > 0);

/** The tracks a stream plays, asked for again by every reload of it (retry, resume, go live, a seek into the archive). */
export interface TrackRequest {
  audio?: number;
  /** VOD only */
  sub?: number | 'off';
}

/** What is playing now: the stream's audio track and the subtitle track shown (`shown`, null = off). */
export function playingTracks(tracks: PlaybackTracks | undefined, shown: number | null): TrackRequest {
  if (!tracks) return {};
  return { ...(tracks.audioIndex !== null ? { audio: tracks.audioIndex } : {}), sub: shown ?? 'off' };
}

/** A reload's tracks: the ones it names, else the ones playing now. */
export function reloadTracks(asked: TrackRequest, playing: TrackRequest): TrackRequest {
  const audio = asked.audio ?? playing.audio;
  const sub = asked.sub ?? playing.sub;
  return { ...(audio !== undefined ? { audio } : {}), ...(sub !== undefined ? { sub } : {}) };
}
