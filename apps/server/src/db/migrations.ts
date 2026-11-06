/** Append-only list of schema migrations; index + 1 is stored in PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX profiles_user ON profiles(user_id, created_at);

  CREATE TABLE source (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credentials TEXT NOT NULL,
    account TEXT,
    server TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    country TEXT,
    language TEXT,
    adult INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL,
    gen INTEGER NOT NULL
  );
  CREATE INDEX categories_kind ON categories(kind, sort);

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_name TEXT NOT NULL,
    number INTEGER NOT NULL,
    category_id TEXT NOT NULL,
    logo TEXT,
    country TEXT,
    language TEXT,
    archive_days INTEGER NOT NULL DEFAULT 0,
    epg_channel_id TEXT,
    gen INTEGER NOT NULL
  );
  CREATE INDEX channels_cat ON channels(category_id, number);
  CREATE INDEX channels_number ON channels(number);
  CREATE INDEX channels_epg ON channels(epg_channel_id);

  CREATE TABLE movies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_name TEXT NOT NULL,
    category_id TEXT NOT NULL,
    poster TEXT,
    year INTEGER,
    rating REAL,
    plot TEXT,
    duration INTEGER,
    container TEXT,
    country TEXT,
    language TEXT,
    added INTEGER NOT NULL DEFAULT 0,
    gen INTEGER NOT NULL
  );
  CREATE INDEX movies_cat ON movies(category_id, added DESC);
  CREATE INDEX movies_added ON movies(added DESC);

  CREATE TABLE series (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    raw_name TEXT NOT NULL,
    category_id TEXT NOT NULL,
    poster TEXT,
    year INTEGER,
    rating REAL,
    plot TEXT,
    country TEXT,
    language TEXT,
    added INTEGER NOT NULL DEFAULT 0,
    episodes_synced_at INTEGER,
    gen INTEGER NOT NULL
  );
  CREATE INDEX series_cat ON series(category_id, added DESC);
  CREATE INDEX series_added ON series(added DESC);

  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    series_id TEXT NOT NULL,
    season INTEGER NOT NULL,
    episode INTEGER NOT NULL,
    title TEXT NOT NULL,
    plot TEXT,
    duration INTEGER,
    container TEXT
  );
  CREATE INDEX episodes_series ON episodes(series_id, season, episode);

  CREATE TABLE epg (
    epg_id TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    gen INTEGER NOT NULL,
    PRIMARY KEY (epg_id, start)
  ) WITHOUT ROWID;
  CREATE INDEX epg_end ON epg(end);

  CREATE TABLE favorites (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, item_id)
  );
  CREATE TABLE progress (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    series_id TEXT,
    position REAL NOT NULL,
    duration REAL NOT NULL,
    finished INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, item_id)
  );
  CREATE TABLE preferences (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );
  CREATE TABLE hide_rules (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  );
  CREATE TABLE probe_cache (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    probed_at INTEGER NOT NULL
  );

  -- rowid = item rowid * 4 + kind index (see catalog/store.ts)
  CREATE VIRTUAL TABLE search_fts USING fts5(
    name, kind UNINDEXED, item_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2',
    prefix = '1 2 3'
  );
  `,
  `
  CREATE TABLE pinned_channels (
    channel_id TEXT PRIMARY KEY,
    pinned_at INTEGER NOT NULL
  );
  -- one recording of a channel; a new run starts after every stop or drop
  CREATE TABLE buffer_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    dir TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT
  );
  CREATE INDEX buffer_runs_channel ON buffer_runs(channel_id);
  -- wall-clock (epoch ms) span of each recorded MPEG-TS segment
  CREATE TABLE buffer_segments (
    run_id INTEGER NOT NULL REFERENCES buffer_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    pts REAL NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (run_id, seq)
  ) WITHOUT ROWID;
  CREATE INDEX buffer_segments_channel ON buffer_segments(channel_id, start_ms);
  CREATE INDEX buffer_segments_start ON buffer_segments(start_ms);
  `,
  `
  -- channels with programmes in the stored guide ("only channels with a guide", guide rows)
  ALTER TABLE channels ADD COLUMN has_epg INTEGER NOT NULL DEFAULT 0;
  UPDATE channels SET has_epg = EXISTS (SELECT 1 FROM epg WHERE epg.epg_id = channels.epg_channel_id);
  -- list indexes carry the hide-rule columns, so filtered pages and counts are answered from the
  -- index (no table reads for hidden rows) on 100k+ item catalogs
  DROP INDEX channels_cat;
  DROP INDEX channels_number;
  CREATE INDEX channels_number ON channels(number, country, language, category_id, has_epg);
  CREATE INDEX channels_cat ON channels(category_id, number, country, language, has_epg);
  DROP INDEX movies_cat;
  DROP INDEX movies_added;
  CREATE INDEX movies_added ON movies(added DESC, country, language, category_id);
  CREATE INDEX movies_cat ON movies(category_id, added DESC, country, language);
  DROP INDEX series_cat;
  DROP INDEX series_added;
  CREATE INDEX series_added ON series(added DESC, country, language, category_id);
  CREATE INDEX series_cat ON series(category_id, added DESC, country, language);
  `,
];
