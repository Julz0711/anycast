/**
 * External subtitles for movies and episodes: found online (OpenSubtitles) or loaded from a file,
 * for titles whose stream has no subtitles (or none in the wanted language).
 *
 * The server keeps every subtitle file it fetched or was given per item (as WebVTT), so a second
 * play, another profile or another device never downloads it again. Each profile remembers which
 * one it picked for an item and how far it shifted it (the timing offset).
 *
 * The player shows them itself (an overlay over the video), not as a stream rendition, so they
 * work the same with every way of playing and can be shifted in time while playing.
 */

/** A subtitle file the server keeps for a movie or episode. */
export interface ExternalSubtitle {
  /** 'os-<OpenSubtitles file id>' or 'up-<random>' */
  id: string;
  source: 'opensubtitles' | 'upload';
  /** ISO 639-1 when known */
  language: string | null;
  /** the release or file name it came with ("Game.of.Thrones.S03E05.720p.HDTV") */
  label: string;
  /** cues in the file */
  cues: number;
  /** the frame rate of the video the subtitle was timed for (OpenSubtitles says, often not); null: unknown */
  fps: number | null;
  addedAt: number;
}

/** What GET /api/subtitles/:kind/:id says about an item, for the player's menu. */
export interface ExternalSubtitleState {
  /** online search is set up (an admin entered an OpenSubtitles API key) */
  online: boolean;
  /** files kept for this item, newest first */
  files: ExternalSubtitle[];
  /**
   * This profile's pick for the item: a file id, or null when it turned external subtitles off.
   * null (the whole field): nothing picked yet, so the profile's Subtitles preference decides.
   */
  choice: { fileId: string | null; offsetMs: number; rate: number | null } | null;
  /** the profile turned subtitles off for this item in the player (also off for the stream's own) */
  savedOff: boolean;
  /**
   * Episodes: the language this profile last picked an external subtitle in for the series. Its
   * other episodes then get one in that language on their own (the most downloaded), whatever
   * the Subtitles preference says. null: none picked, or turned off in an episode since.
   */
  seriesLanguage: string | null;
}

/** One result of an online search. Downloading it (POST …/download) keeps it as an ExternalSubtitle. */
export interface SubtitleSearchResult {
  /** OpenSubtitles file id */
  fileId: string;
  language: string | null;
  /** the release name the subtitle was made for */
  release: string;
  downloads: number;
  /** has descriptions of sounds ("[door slams]") */
  hearingImpaired: boolean;
  /** machine or AI translated (often poor) */
  machineTranslated: boolean;
  /** the uploader is trusted by OpenSubtitles */
  trusted: boolean;
  /** already downloaded: picking it costs no download */
  kept: boolean;
}

export interface SubtitleSearchResponse {
  results: SubtitleSearchResult[];
  /** what was searched for ("Game of Thrones S3 E5"), shown above the results */
  query: string;
}

export interface SubtitleDownloadResponse {
  file: ExternalSubtitle;
  /** downloads left today on the OpenSubtitles account (when it says) */
  remaining: number | null;
}

/** POST …/auto: the best file in a language, kept or fetched now; null when there is none. */
export interface SubtitleAutoResponse {
  file: ExternalSubtitle | null;
}

/** Settings › Online subtitles (admins). The API key and password are never sent back. */
export interface SubtitleSettings {
  configured: boolean;
  /** where the key came from: entered in the app, or the server's .env (OPENSUBTITLES_*) */
  origin: 'app' | 'env' | null;
  /** OpenSubtitles account name, when one is saved (more downloads per day than the key alone) */
  username: string | null;
  updatedAt: number | null;
}

/** PUT /api/subtitles/settings. Fields left out keep their saved value; an empty username removes the account. */
export interface SubtitleSettingsInput {
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface SubtitleSettingsTest {
  ok: boolean;
  /** why it failed, or what the account allows ("20 downloads a day") */
  message: string;
}

export const SUBTITLE_LIMITS = {
  apiKey: 100,
  username: 100,
  password: 200,
  /** an uploaded subtitle file, in bytes */
  uploadBytes: 2 * 1024 * 1024,
  name: 200,
  /** the timing offset, either way */
  offsetMs: 10 * 60_000,
  /** the drift fix (cue times multiplied by it), either way */
  rateMin: 0.9,
  rateMax: 1.1,
} as const;

/**
 * Drift: a subtitle timed for a video at another frame rate (a 23.976 fps film release on a 25 fps
 * European TV copy, which plays 4 % faster) starts in time and then falls behind more and more:
 * 30 s after 12 minutes, a minute after 25. Multiplying its cue times by the ratio of the two frame
 * rates puts it back. A rate of 1 leaves the times as they are.
 */
export const SUBTITLE_DRIFT = {
  /** the subtitles come later and later: made for 23.976 fps, the video runs at 25 */
  later: 24000 / 1001 / 25,
  /** earlier and earlier: made for 25 fps, the video runs at 23.976 */
  earlier: 25 / (24000 / 1001),
} as const;

/**
 * The drift fix to apply on its own, from the frame rate the subtitle was made for and the video's:
 * their ratio when they differ like film and TV frame rates do (2 %–7 %), else 1.
 */
export function autoSubtitleRate(subtitleFps: number | null | undefined, videoFps: number | null | undefined): number {
  if (!subtitleFps || !videoFps || subtitleFps <= 0 || videoFps <= 0) return 1;
  const r = subtitleFps / videoFps;
  const d = Math.abs(1 - r);
  return d >= 0.02 && d <= 0.07 ? r : 1;
}
