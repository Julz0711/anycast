/** Media format profiles. Which item gets which profile is a pure function of its position in the catalog. */

export type VodProfileId = 'mp4_h264_aac' | 'mkv_hevc_ac3' | 'mkv_h264_eac3_multi' | 'mkv_h264_dts' | 'ts_h264_aac';
export type LiveProfileId = 'live_h264_aac' | 'live_hevc_aac' | 'live_h264_ac3' | 'live_h264_aac_multi';
export type ProfileId = VodProfileId | LiveProfileId;

export interface TrackInfo {
  codec: string;
  language?: string;
}

export interface FormatProfile {
  id: ProfileId;
  container: 'mp4' | 'mkv' | 'ts';
  video: 'h264' | 'hevc';
  audio: TrackInfo[];
  subtitles: TrackInfo[];
}

export const PROFILES: Record<ProfileId, FormatProfile> = {
  mp4_h264_aac: { id: 'mp4_h264_aac', container: 'mp4', video: 'h264', audio: [{ codec: 'aac' }], subtitles: [] },
  mkv_hevc_ac3: { id: 'mkv_hevc_ac3', container: 'mkv', video: 'hevc', audio: [{ codec: 'ac3' }], subtitles: [] },
  mkv_h264_eac3_multi: {
    id: 'mkv_h264_eac3_multi',
    container: 'mkv',
    video: 'h264',
    audio: [
      { codec: 'eac3', language: 'deu' },
      { codec: 'eac3', language: 'eng' },
    ],
    subtitles: [
      { codec: 'subrip', language: 'deu' },
      { codec: 'subrip', language: 'eng' },
    ],
  },
  mkv_h264_dts: { id: 'mkv_h264_dts', container: 'mkv', video: 'h264', audio: [{ codec: 'dts' }], subtitles: [] },
  ts_h264_aac: { id: 'ts_h264_aac', container: 'ts', video: 'h264', audio: [{ codec: 'aac' }], subtitles: [] },
  live_h264_aac: { id: 'live_h264_aac', container: 'ts', video: 'h264', audio: [{ codec: 'aac' }], subtitles: [] },
  live_hevc_aac: { id: 'live_hevc_aac', container: 'ts', video: 'hevc', audio: [{ codec: 'aac' }], subtitles: [] },
  live_h264_ac3: { id: 'live_h264_ac3', container: 'ts', video: 'h264', audio: [{ codec: 'ac3' }], subtitles: [] },
  /** two AAC audio tracks: English first (the default), then German (track switching on live channels) */
  live_h264_aac_multi: {
    id: 'live_h264_aac_multi',
    container: 'ts',
    video: 'h264',
    audio: [
      { codec: 'aac', language: 'eng' },
      { codec: 'aac', language: 'deu' },
    ],
    subtitles: [],
  },
};

export const VOD_PROFILE_ORDER: readonly VodProfileId[] = [
  'mp4_h264_aac',
  'mkv_hevc_ac3',
  'mkv_h264_eac3_multi',
  'mkv_h264_dts',
  'ts_h264_aac',
];

/**
 * Live channel at catalog index i: every 10th (offset 3) is HEVC, every 10th (offset 7) has AC3
 * audio, every 20th (offset 5) has a second (German) audio track after the English one.
 */
export function liveProfileForIndex(i: number): LiveProfileId {
  if (i % 10 === 3) return 'live_hevc_aac';
  if (i % 10 === 7) return 'live_h264_ac3';
  if (i % 20 === 5) return 'live_h264_aac_multi';
  return 'live_h264_aac';
}

export function vodProfileForIndex(i: number): VodProfileId {
  return VOD_PROFILE_ORDER[i % VOD_PROFILE_ORDER.length] ?? 'mp4_h264_aac';
}

/** Real file duration of a VOD fixture (seconds): 120, 180 or 240 depending on the id. */
export function vodDurationForId(id: number): number {
  return 120 + (id % 3) * 60;
}
