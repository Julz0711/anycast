/**
 * FORMAT_MATRIX: for every format profile, the item ids that use it. Ids and profiles are seed
 * independent and the small catalog is a prefix of the full one, so these ids are valid for every
 * size and seed.
 */
import { buildCatalog, DEFAULT_SEED } from './catalog.js';
import { PROFILES, type FormatProfile } from './formats.js';

export interface FormatMatrixEntry extends FormatProfile {
  kind: 'live' | 'movie' | 'episode';
  /** Example ids (up to 3) using this profile; first one is the canonical test id. */
  ids: number[];
  /** Real duration of the generated file in seconds, per id (VOD only). */
  durations?: Record<number, number>;
}

function compute(): FormatMatrixEntry[] {
  const c = buildCatalog('small', DEFAULT_SEED);
  const out: FormatMatrixEntry[] = [];
  const add = (kind: FormatMatrixEntry['kind'], items: { id: number; profile: keyof typeof PROFILES; durationSecs?: number }[]) => {
    const byProfile = new Map<string, typeof items>();
    for (const it of items) byProfile.set(it.profile, [...(byProfile.get(it.profile) ?? []), it]);
    for (const [profile, list] of byProfile) {
      const ids = list.slice(0, 3);
      const entry: FormatMatrixEntry = { ...PROFILES[profile as keyof typeof PROFILES], kind, ids: ids.map((i) => i.id) };
      if (kind !== 'live') entry.durations = Object.fromEntries(ids.map((i) => [i.id, i.durationSecs ?? 0]));
      out.push(entry);
    }
  };
  add('live', c.live);
  add('movie', c.movies);
  add('episode', [...c.episodeById.values()]);
  return out;
}

export const FORMAT_MATRIX: readonly FormatMatrixEntry[] = compute();
