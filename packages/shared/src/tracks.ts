/**
 * Audio and subtitle tracks of a stream (PB-3).
 *
 * The server probes each item once and lists its tracks in PlaybackInfo.tracks. Switching audio
 * asks for the stream again with ?audio=<index> (the server maps that track, restarting its FFmpeg
 * run at the position the client seeks to). Text subtitles of movies and episodes are converted to
 * WebVTT by the server and carried as HLS subtitle renditions; picture-based ones (PGS, DVD, DVB)
 * are listed but cannot be shown.
 */

/** One audio stream of the source. `index` is its position among the source's audio streams. */
export interface AudioTrack {
  index: number;
  /** ISO 639-1 ("en") when known, else the raw tag in lower case; null when untagged or "und" */
  language: string | null;
  /** ffprobe codec name: aac, ac3, eac3, dts, ... */
  codec: string;
  channels: number | null;
  /** the stream's own title tag ("Director's commentary"), if any */
  title: string | null;
  /** flagged as the default track in the source */
  default: boolean;
}

export interface SubtitleTrack {
  /** position among the source's subtitle streams */
  index: number;
  language: string | null;
  codec: string;
  title: string | null;
  default: boolean;
  forced: boolean;
  /** text formats can be converted to WebVTT; bitmap ones (PGS, DVD, DVB) cannot */
  format: 'text' | 'bitmap';
  /** set when this track cannot be shown, with a short reason for the menu */
  unavailable?: string;
}

export interface PlaybackTracks {
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  /** the audio track this stream plays; null when it has no audio */
  audioIndex: number | null;
  /** the subtitle track to show (saved choice for this item, or the profile's preferences); null = off */
  subtitleIndex: number | null;
  /**
   * The stream (an HLS master playlist) carries every shown-able subtitle track as a WebVTT
   * rendition, in `subtitles` order (the ones without `unavailable`): switch between them in the
   * player. false while the stream is played directly (file or raw TS): ask for the stream again
   * with ?sub=<index> to get one that carries them.
   */
  subtitlesInStream: boolean;
}

/** Per-item choice saved by PUT /api/tracks/:kind/:id. subtitle null = turned off. */
export interface TrackChoice {
  audio?: number;
  subtitle?: number | null;
}

/** Codec names (ffprobe) of subtitles AnyCast converts to WebVTT. */
export const TEXT_SUBTITLE_CODECS: readonly string[] = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
/** Picture-based subtitle codecs (ffprobe names). */
export const BITMAP_SUBTITLE_CODECS: readonly string[] = ['hdmv_pgs_subtitle', 'pgssub', 'dvd_subtitle', 'dvdsub', 'dvb_subtitle', 'dvbsub', 'xsub', 'vobsub'];

/** ISO 639-2 (bibliographic and terminology codes) to ISO 639-1. */
const ISO2_TO_1: Record<string, string> = {
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', nld: 'nl', dut: 'nl',
  por: 'pt', pol: 'pl', tur: 'tr', ara: 'ar', swe: 'sv', dan: 'da', nor: 'no', nob: 'no', nno: 'no',
  fin: 'fi', ell: 'el', gre: 'el', rus: 'ru', ukr: 'uk', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh',
  hin: 'hi', ces: 'cs', cze: 'cs', hun: 'hu', ron: 'ro', rum: 'ro', heb: 'he', hrv: 'hr', srp: 'sr',
  bul: 'bg', slk: 'sk', slo: 'sk', slv: 'sl', sqi: 'sq', alb: 'sq', tha: 'th', vie: 'vi', ind: 'id',
  msa: 'ms', may: 'ms', fas: 'fa', per: 'fa', cat: 'ca', est: 'et', lav: 'lv', lit: 'lt', isl: 'is',
  ice: 'is', bos: 'bs', mkd: 'mk', mac: 'mk', kur: 'ku', urd: 'ur', ben: 'bn', tam: 'ta', tel: 'te',
  pan: 'pa', fil: 'tl', tgl: 'tl', glg: 'gl', eus: 'eu', baq: 'eu', cym: 'cy', wel: 'cy', gle: 'ga',
};

/** "eng", "en", "en-US", "EN" -> "en"; "und", "" and unknown placeholders -> null. */
export function normalizeLanguage(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const t = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!t || t === 'und' || t === 'mis' || t === 'zxx' || t === 'mul' || t === 'unk') return null;
  if (t.length === 2) return t;
  return ISO2_TO_1[t] ?? t;
}

/** Same language, whatever the tag style ("deu" and "de"). */
export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeLanguage(a);
  return x !== null && x === normalizeLanguage(b);
}
