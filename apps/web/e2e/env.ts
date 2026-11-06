/** Shared between the global setup (main process) and the specs (workers). */
export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password-1' };

export interface E2EFixtures {
  userId: string;
  /** H.264 channel with an archive and past programmes in the EPG */
  archiveChannel: { id: string; name: string };
  /** a channel without guide data, and its category's name */
  noGuideChannel: { id: string; name: string; category: string };
  /** the first channels of the unfiltered live list, in order */
  zapChannels: string[];
  /** MP4 movie (direct play), 3+ minutes */
  movie: { id: string; name: string };
  /** MKV H.264 movie (served as HLS, so it gets scrub thumbnails), 3+ minutes */
  hlsMovie: { id: string; name: string };
  /** another movie of the same multi-track MKV profile (German + English audio and subtitles), for tracks.spec.ts alone */
  tracksMovie: { id: string; name: string };
  /** a live channel with English and German audio (English first) and an archive, for tracks.spec.ts alone */
  tracksChannel: { id: string; name: string };
  /** a series whose first two episodes are H.264/AAC */
  series: { id: string; name: string; ep1: string; ep2: string; ep2Title: string };
  declutter: {
    liveCat: { de: string; en: string };
    movieCat: { de: string; en: string };
    channel: { de: string; en: string };
    movie: { de: string; en: string };
  };
}

/** The second stack: a mock with max_connections = 1 and its own server (one-connection.spec.ts). */
export interface OneConnectionStack {
  base: string;
  mockUrl: string;
  /** storage state signed in as ADMIN on this server */
  state: string;
  userId: string;
}
