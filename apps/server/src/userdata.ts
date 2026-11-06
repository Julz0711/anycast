/** Per-profile state: favorites, progress, preferences, hide rules, track choices. Every change but track choices emits a SyncEvent. */
import {
  DEFAULT_PREFERENCES, mergePreferences, type Favorite, type HideRules, type MediaKind, type Preferences, type Progress,
  type TrackChoice,
} from '@anycast/shared';
import { EMPTY_RULES } from './catalog/store';
import type { Db } from './db';
import type { EventBus } from './events';
import { isFinished } from './progress';

interface ProgressRow {
  kind: 'movie' | 'episode'; item_id: string; series_id: string | null; position: number; duration: number; finished: number; updated_at: number;
}

const toProgress = (r: ProgressRow): Progress => ({
  kind: r.kind, id: r.item_id, position: r.position, duration: r.duration, finished: r.finished === 1, updatedAt: r.updated_at,
  ...(r.series_id ? { seriesId: r.series_id } : {}),
});

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export class UserData {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
  ) {}

  favorites(profileId: string): Favorite[] {
    return (
      this.db.prepare('SELECT kind, item_id AS id, added_at AS addedAt FROM favorites WHERE profile_id = ? ORDER BY added_at').all(profileId) as Favorite[]
    );
  }

  setFavorite(profileId: string, kind: MediaKind, id: string, favorite: boolean): Favorite[] {
    if (favorite) {
      this.db
        .prepare('INSERT OR IGNORE INTO favorites (profile_id, kind, item_id, added_at) VALUES (?, ?, ?, ?)')
        .run(profileId, kind, id, Date.now());
    } else {
      this.db.prepare('DELETE FROM favorites WHERE profile_id = ? AND kind = ? AND item_id = ?').run(profileId, kind, id);
    }
    const favorites = this.favorites(profileId);
    this.bus.emit({ type: 'favorites', profileId, favorites });
    return favorites;
  }

  allProgress(profileId: string): Progress[] {
    return (this.db.prepare('SELECT * FROM progress WHERE profile_id = ? ORDER BY updated_at DESC').all(profileId) as ProgressRow[]).map(toProgress);
  }

  progressFor(profileId: string, kind: 'movie' | 'episode', id: string): Progress | null {
    const r = this.db.prepare('SELECT * FROM progress WHERE profile_id = ? AND kind = ? AND item_id = ?').get(profileId, kind, id) as ProgressRow | undefined;
    return r ? toProgress(r) : null;
  }

  saveProgress(profileId: string, input: Omit<Progress, 'updatedAt' | 'finished'>): Progress {
    const position = Math.max(0, input.position);
    const duration = Math.max(0, input.duration);
    const progress: Progress = {
      kind: input.kind, id: input.id, position, duration, finished: isFinished(position, duration), updatedAt: Date.now(),
      ...(input.seriesId ? { seriesId: input.seriesId } : {}),
    };
    this.db
      .prepare(
        `INSERT INTO progress (profile_id, kind, item_id, series_id, position, duration, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, kind, item_id) DO UPDATE SET series_id = excluded.series_id, position = excluded.position,
           duration = excluded.duration, finished = excluded.finished, updated_at = excluded.updated_at`,
      )
      .run(profileId, progress.kind, progress.id, progress.seriesId ?? null, position, duration, progress.finished ? 1 : 0, progress.updatedAt);
    this.bus.emit({ type: 'progress', profileId, progress });
    return progress;
  }

  /** The audio and subtitle track picked for a movie or episode (PB-3); null when nothing was picked. */
  trackChoice(profileId: string, kind: 'movie' | 'episode', id: string): { audio: number | null; subtitle: number | null | undefined } | null {
    const r = this.db.prepare('SELECT audio, subtitle FROM track_choices WHERE profile_id = ? AND kind = ? AND item_id = ?').get(profileId, kind, id) as
      | { audio: number | null; subtitle: number | null }
      | undefined;
    if (!r) return null;
    return { audio: r.audio, subtitle: r.subtitle === null ? undefined : r.subtitle < 0 ? null : r.subtitle };
  }

  /** Fields left out keep their saved value; subtitle null = off. */
  saveTrackChoice(profileId: string, kind: 'movie' | 'episode', id: string, choice: TrackChoice): void {
    const sub = choice.subtitle === undefined ? undefined : choice.subtitle === null ? -1 : choice.subtitle;
    this.db
      .prepare(
        `INSERT INTO track_choices (profile_id, kind, item_id, audio, subtitle, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, kind, item_id) DO UPDATE SET
           audio = COALESCE(excluded.audio, track_choices.audio),
           subtitle = COALESCE(excluded.subtitle, track_choices.subtitle),
           updated_at = excluded.updated_at`,
      )
      .run(profileId, kind, id, choice.audio ?? null, sub ?? null, Date.now());
  }

  preferences(profileId: string): Preferences {
    const r = this.db.prepare('SELECT data FROM preferences WHERE profile_id = ?').get(profileId) as { data: string } | undefined;
    return r ? mergePreferences(JSON.parse(r.data)) : structuredClone(DEFAULT_PREFERENCES);
  }

  updatePreferences(profileId: string, partial: unknown): Preferences {
    const current = this.preferences(profileId);
    const patch = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      const base = (current as unknown as Record<string, unknown>)[k];
      merged[k] = base && typeof base === 'object' && !Array.isArray(base) && v && typeof v === 'object' ? { ...base, ...v } : v;
    }
    const preferences = mergePreferences(merged);
    this.db
      .prepare('INSERT INTO preferences (profile_id, data) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data')
      .run(profileId, JSON.stringify(preferences));
    this.bus.emit({ type: 'preferences', profileId, preferences });
    return preferences;
  }

  hideRules(profileId: string): HideRules {
    const r = this.db.prepare('SELECT data FROM hide_rules WHERE profile_id = ?').get(profileId) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as HideRules) : structuredClone(EMPTY_RULES);
  }

  setHideRules(profileId: string, input: HideRules): HideRules {
    const rules: HideRules = {
      countries: uniq(input.countries).map((c) => c.toLowerCase()),
      languages: uniq(input.languages).map((c) => c.toLowerCase()),
      categoryIds: uniq(input.categoryIds),
    };
    this.db
      .prepare('INSERT INTO hide_rules (profile_id, data) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET data = excluded.data')
      .run(profileId, JSON.stringify(rules));
    this.bus.emit({ type: 'hide-rules', profileId, rules });
    return rules;
  }
}
