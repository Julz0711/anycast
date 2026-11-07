/**
 * What a backup does with every table of the schema (db/migrations.ts). Every table needs an
 * explicit decision: test/backup.test.ts fails when a migration adds a table that isn't listed here.
 *
 * Included (the user's own data; it can't be fetched again):
 *   users             accounts with their argon2 password hashes and admin flag
 *   profiles          profiles of each account (name, built-in picture, argon2 hash of the profile lock PIN)
 *   profile_images    uploaded profile pictures (small, already scaled by the web app)
 *   preferences       per-profile settings (appearance, player, tabs, setup done, ...)
 *   hide_rules        per-profile hidden countries, languages and groups
 *   parental          per-profile parental lock: mode, unlock duration, argon2 hash of the PIN
 *   favorites         per-profile favorites (live, movies, series)
 *   progress          per-profile playback progress: Continue watching and finished state
 *   track_choices     per-profile audio and subtitle track picked per movie, episode or channel
 *   channel_lists     per-profile custom channel lists ...
 *   channel_list_items ... and their channels, in order
 *   pinned_channels   channels that always keep a rewind buffer (server-wide)
 *
 * Excluded:
 *   sessions          sign-in tokens (hashed); a restore must not sign anyone in, or out of a new server
 *   profile_entries   which sign-in sessions opened a locked profile; goes with the sessions
 *   source            the provider login (Xtream URL, user, password), encrypted with ANYCAST_SECRET:
 *                     it comes from .env, and a backup file must never carry it
 *   kv                only the last catalog / guide sync times (sync state, not user data)
 *   categories, channels, movies, series, episodes
 *                     the catalog: synced from the provider again
 *   search_fts        the search index of the catalog (rebuilt by the sync)
 *   epg               the programme guide: synced from the provider again
 *   probe_cache       cached stream formats (ffprobe), rebuilt on demand
 *   buffer_runs, buffer_segments
 *                     the index of the rewind buffer recordings; the recordings themselves live in
 *                     BUFFER_DIR and are not part of a backup
 *
 * Not tables: the "tag overrides" that fix a channel's country or language are built into the
 * tagger (catalog/tagger.ts), and what a profile hides lives in hide_rules. Thumbnails (DATA_DIR/
 * thumbs) and the buffer (BUFFER_DIR) are caches outside the database.
 */
export const BACKUP_TABLES = {
  users: 'include',
  profiles: 'include',
  profile_images: 'include',
  preferences: 'include',
  hide_rules: 'include',
  parental: 'include',
  favorites: 'include',
  progress: 'include',
  track_choices: 'include',
  channel_lists: 'include',
  channel_list_items: 'include',
  pinned_channels: 'include',

  sessions: 'exclude',
  profile_entries: 'exclude',
  source: 'exclude',
  kv: 'exclude',
  categories: 'exclude',
  channels: 'exclude',
  movies: 'exclude',
  series: 'exclude',
  episodes: 'exclude',
  search_fts: 'exclude',
  epg: 'exclude',
  probe_cache: 'exclude',
  buffer_runs: 'exclude',
  buffer_segments: 'exclude',
} as const satisfies Record<string, 'include' | 'exclude'>;

export type BackupTable = keyof typeof BACKUP_TABLES;
