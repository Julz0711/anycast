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
  choice: { fileId: string | null; offsetMs: number } | null;
  /** the profile turned subtitles off for this item in the player (also off for the stream's own) */
  savedOff: boolean;
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
} as const;
