/** Shared between the global setup (main process) and the specs (workers). */
export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password-1' };

export interface E2EFixtures {
  userId: string;
  /** H.264 channel with an archive and past programmes in the EPG */
  archiveChannel: { id: string; name: string };
  /** the first channels of the unfiltered live list, in order */
  zapChannels: string[];
  /** MP4 movie (direct play), 3+ minutes */
  movie: { id: string; name: string };
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
