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
  `
  -- custom ordered channel lists per profile (LB-3); items keep channel ids even when a sync drops
  -- the channel, so it comes back in place if the provider brings it back
  CREATE TABLE channel_lists (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX channel_lists_profile ON channel_lists(profile_id, position);
  CREATE TABLE channel_list_items (
    list_id TEXT NOT NULL REFERENCES channel_lists(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (list_id, channel_id)
  ) WITHOUT ROWID;
  `,
  `
  -- parental lock per profile (PRD AC-3): mode, unlock duration and the argon2 hash of the PIN.
  -- IF NOT EXISTS keeps it safe to reorder against migrations added on other branches.
  CREATE TABLE IF NOT EXISTS parental (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'hidden',
    unlock_minutes INTEGER NOT NULL DEFAULT 30,
    pin_hash TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  -- audio and subtitle track picked per movie or episode (PB-3): audio = source audio index;
  -- subtitle = source subtitle index, -1 = turned off; NULL = not picked (preferences decide)
  CREATE TABLE IF NOT EXISTS track_choices (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    audio INTEGER,
    subtitle INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, item_id)
  ) WITHOUT ROWID;
  `,
  `
  -- only the hourly cleanup used it, and keeping it up to date was three quarters of an EPG sync
  -- on a ~900k programme guide (random inserts into a 26 MB index); the cleanup scans instead
  DROP INDEX IF EXISTS epg_end;
  `,
  `
  -- per-profile movie and series lists: the built-in Watch Later list (builtin = 'watch-later', one
  -- per profile, made on first read) and the user's own lists. Items keep their ids when a sync
  -- drops the title, so it comes back in place if the provider brings it back.
  CREATE TABLE IF NOT EXISTS media_lists (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    builtin TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_lists_profile ON media_lists(profile_id, position);
  CREATE UNIQUE INDEX IF NOT EXISTS media_lists_builtin ON media_lists(profile_id, builtin) WHERE builtin IS NOT NULL;
  CREATE TABLE IF NOT EXISTS media_list_items (
    list_id TEXT NOT NULL REFERENCES media_lists(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, kind, item_id)
  ) WITHOUT ROWID;
  `,
  `
  -- profile pictures and the profile lock (profiles.ts in @anycast/shared). avatar: built-in
  -- picture "shape.color"; lock_hash: argon2 hash of the profile lock PIN.
  ALTER TABLE profiles ADD COLUMN avatar TEXT;
  ALTER TABLE profiles ADD COLUMN lock_hash TEXT;
  -- an uploaded picture, already cropped and scaled by the web app
  CREATE TABLE IF NOT EXISTS profile_images (
    profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- locked profiles this sign-in session has entered with the PIN
  CREATE TABLE IF NOT EXISTS profile_entries (
    session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_hash, profile_id)
  ) WITHOUT ROWID;
  `,
  `
  -- live channels a profile watched lately (Home › Jump back in); trimmed to RECENT_CHANNELS_MAX
  CREATE TABLE IF NOT EXISTS recent_channels (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    watched_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, channel_id)
  ) WITHOUT ROWID;
  `,
  `
  -- duplicate channels (catalog/variants.ts): group = language + name without quality tags;
  -- variant_rank 0 is the channel a group shows first; set after every catalog sync
  ALTER TABLE channels ADD COLUMN group_key TEXT;
  ALTER TABLE channels ADD COLUMN group_name TEXT;
  ALTER TABLE channels ADD COLUMN group_number INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN quality TEXT;
  ALTER TABLE channels ADD COLUMN variant_rank INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE channels ADD COLUMN group_size INTEGER NOT NULL DEFAULT 1;
  CREATE INDEX IF NOT EXISTS channels_group ON channels(group_key, variant_rank);
  CREATE INDEX IF NOT EXISTS channels_group_number ON channels(group_number, country, language, category_id, has_epg);
  `,
  `
  -- movie details from get_vod_info, fetched when a movie page opens (MovieDetail)
  CREATE TABLE IF NOT EXISTS movie_info (
    movie_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  -- when AnyCast first saw an episode (ms); 0 = it was there at the series' first fetch.
  -- New episodes: first_seen after the profile last looked at the series (series_seen).
  ALTER TABLE episodes ADD COLUMN first_seen INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS series_seen (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    series_id TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, series_id)
  ) WITHOUT ROWID;
  -- sorting Movies and Series by name, year and rating (the provider order is by added)
  CREATE INDEX IF NOT EXISTS movies_name ON movies(name COLLATE NOCASE, country, language, category_id);
  CREATE INDEX IF NOT EXISTS movies_year ON movies(year DESC, country, language, category_id);
  CREATE INDEX IF NOT EXISTS movies_rating ON movies(rating DESC, country, language, category_id);
  CREATE INDEX IF NOT EXISTS series_name ON series(name COLLATE NOCASE, country, language, category_id);
  CREATE INDEX IF NOT EXISTS series_year ON series(year DESC, country, language, category_id);
  CREATE INDEX IF NOT EXISTS series_rating ON series(rating DESC, country, language, category_id);
  `,
  `
  -- Swipe (swipe.ts): movies and series a profile swiped away; they don't come up in the deck again
  CREATE TABLE IF NOT EXISTS swipe_passed (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    passed_at INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, item_id)
  ) WITHOUT ROWID;
  `,
  `
  -- watch history (recap.ts): seconds that played per profile, item and hour (hour = epoch ms of
  -- the UTC hour it started in). series_id is set for episodes.
  CREATE TABLE IF NOT EXISTS watch_history (
    profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    hour INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    series_id TEXT,
    seconds REAL NOT NULL,
    PRIMARY KEY (profile_id, hour, kind, item_id)
  ) WITHOUT ROWID;
  `,
  `
  -- the provider login can be entered in the app (Settings › Provider) as well as in .env:
  -- origin = where the saved login came from ('env' or 'app'); env_hash = HMAC of the .env login
  -- last applied, so an unchanged .env never overwrites a login entered in the app
  ALTER TABLE source ADD COLUMN origin TEXT;
  ALTER TABLE source ADD COLUMN env_hash TEXT;
  UPDATE source SET origin = 'env';
  `,
  `
  -- the provider's still image per episode (get_series_info › info.movie_image), shown in the player's episode list
  ALTER TABLE episodes ADD COLUMN image TEXT;
  -- where a series' end credits start, as seconds before the end of an episode: learned from when
  -- viewers go on to the next episode (the player shows its Up next card from then on)
  CREATE TABLE series_credits (
    series_id TEXT PRIMARY KEY,
    seconds REAL NOT NULL,
    samples TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  `,
];
