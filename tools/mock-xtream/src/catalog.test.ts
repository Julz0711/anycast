import { describe, expect, it } from 'vitest';
import { buildCatalog, expectedTags } from './catalog.js';
import { FORMAT_MATRIX } from './matrix.js';
import { PROFILES } from './formats.js';
import { parseTimeshiftStart, secondsOfDay, formatLocal } from './tz.js';

const full = buildCatalog('full');
const small = buildCatalog('small');

describe('catalog', () => {
  it('has the requested sizes', () => {
    expect(full.live).toHaveLength(2000);
    expect(full.movies).toHaveLength(5000);
    expect(full.series).toHaveLength(500);
    expect(small.live).toHaveLength(60);
    expect(small.movies).toHaveLength(100);
    expect(small.series).toHaveLength(20);
  });

  it('is deterministic and small is a prefix of full (ids and profiles)', () => {
    const again = buildCatalog('full');
    expect(again.live.map((c) => c.name)).toEqual(full.live.map((c) => c.name));
    small.live.forEach((c, i) => {
      expect(full.live[i]?.id).toBe(c.id);
      expect(full.live[i]?.profile).toBe(c.profile);
      expect(full.live[i]?.name).toBe(c.name);
    });
    small.movies.forEach((m, i) => expect(full.movies[i]?.id).toBe(m.id));
    const other = buildCatalog('small', 7);
    expect(other.live.map((c) => c.id)).toEqual(small.live.map((c) => c.id));
    expect([...other.episodeById.keys()]).toEqual([...small.episodeById.keys()]);
  });

  it('has unique ids', () => {
    expect(new Set(full.live.map((c) => c.id)).size).toBe(full.live.length);
    expect(new Set(full.movies.map((c) => c.id)).size).toBe(full.movies.length);
    expect(new Set(full.series.map((c) => c.id)).size).toBe(full.series.length);
  });

  it('writes names the messy ways providers do', () => {
    const names = new Set(full.live.map((c) => c.name));
    for (const n of [
      'DE | ARD HD', 'UK: BBC One', '[FR] TF1', '|EN| Sky Sports 1 FHD', 'NL - NPO 1', 'ES ▎ La 1',
      'TR: TRT 1', 'AR | MBC 1', 'PL ● TVP 1', 'VIP | 4K Movies', 'SPORTS | beIN 1', 'XXX | Adult',
    ]) {
      expect(names.has(n), n).toBe(true);
    }
    const cats = new Set([...full.liveCategories, ...full.vodCategories, ...full.seriesCategories].map((c) => c.category_name));
    for (const n of ['DE | NEWS', 'UK ENTERTAINMENT', '[FR] SPORT', 'EN - Movies 2024', 'NETFLIX SERIES (MULTI-SUB)', 'XXX | Adult']) {
      expect(cats.has(n), n).toBe(true);
    }
  });

  it('has ground truth tags for every category and item name', () => {
    const all = [
      ...full.liveCategories, ...full.vodCategories, ...full.seriesCategories,
    ].map((c) => c.category_name);
    all.push(...full.live.map((c) => c.name), ...full.movies.map((m) => m.name), ...full.series.map((s) => s.name));
    for (const n of all) expect(expectedTags(n), n).toBeDefined();
    expect(expectedTags('DE | ARD HD')).toEqual({ country: 'de', language: 'de', adult: false });
    expect(expectedTags('UK: BBC One')).toEqual({ country: 'gb', language: 'en', adult: false });
    expect(expectedTags('|EN| Sky Sports 1 FHD')).toEqual({ country: null, language: 'en', adult: false });
    expect(expectedTags('AR | MBC 1')).toEqual({ country: null, language: 'ar', adult: false });
    expect(expectedTags('SPORTS | beIN 1')).toEqual({ country: null, language: null, adult: false });
    expect(expectedTags('XXX | Adult')?.adult).toBe(true);
    expect(expectedTags('NETFLIX SERIES (MULTI-SUB)')).toEqual({ country: null, language: null, adult: false });
    expect(expectedTags('EN - Movies 2024')).toEqual({ country: null, language: 'en', adult: false });
    expect(expectedTags('never produced')).toBeUndefined();
    // Item tags agree with the registry.
    for (const c of full.live) expect(expectedTags(c.name)).toEqual(c.tags);
  });

  it('marks the adult categories', () => {
    const adult = full.liveCategories.filter((c) => c.tags.adult).map((c) => c.category_name);
    expect(adult).toEqual(['XXX | Adult']);
    expect(full.vodCategories.some((c) => c.tags.adult)).toBe(true);
  });

  it('mixes archive and EPG ids realistically', () => {
    const archive = full.live.filter((c) => c.archive);
    expect(archive.length / full.live.length).toBeGreaterThan(0.33);
    expect(archive.length / full.live.length).toBeLessThan(0.47);
    for (const c of archive) expect(c.archiveDays).toBeGreaterThanOrEqual(1);
    for (const c of archive) expect(c.archiveDays).toBeLessThanOrEqual(7);
    const missing = full.live.filter((c) => !c.epgChannelId).length;
    expect(missing).toBeGreaterThan(0);
    expect(missing / full.live.length).toBeLessThan(0.2);
  });

  it('huge has the shape of a large real panel', () => {
    const huge = buildCatalog('huge');
    expect([huge.live.length, huge.movies.length, huge.series.length]).toEqual([19810, 139250, 35663]);
    expect([huge.liveCategories.length, huge.vodCategories.length, huge.seriesCategories.length]).toEqual([522, 145, 128]);
    const archive = huge.live.filter((c) => c.archive);
    expect(archive.length / huge.live.length).toBeGreaterThan(0.025);
    expect(archive.length / huge.live.length).toBeLessThan(0.04);
    expect(new Set(archive.map((c) => c.archiveDays))).toEqual(new Set([1, 3]));
    const withEpg = huge.live.filter((c) => c.epgChannelId);
    expect(withEpg.length / huge.live.length).toBeGreaterThan(0.17);
    expect(withEpg.length / huge.live.length).toBeLessThan(0.24);
    const listed = withEpg.filter((c) => c.epgListed);
    expect(listed.length / huge.live.length).toBeGreaterThan(0.13);
    expect(listed.length).toBeLessThan(withEpg.length);
    // every category name tags like its region, and the first channels keep their ids and profiles
    for (const c of huge.liveCategories) expect(expectedTags(c.category_name)).toEqual(c.tags);
    expect(huge.live.slice(0, 60).map((c) => [c.id, c.profile])).toEqual(small.live.map((c) => [c.id, c.profile]));
  });
});

describe('FORMAT_MATRIX', () => {
  it('covers every profile with ids that exist in the small and full catalogs', () => {
    const covered = new Set(FORMAT_MATRIX.map((e) => `${e.kind}:${e.id}`));
    for (const p of ['mp4_h264_aac', 'mkv_hevc_ac3', 'mkv_h264_eac3_multi', 'mkv_h264_dts', 'ts_h264_aac']) {
      expect(covered.has(`movie:${p}`), p).toBe(true);
      expect(covered.has(`episode:${p}`), p).toBe(true);
    }
    for (const p of ['live_h264_aac', 'live_hevc_aac', 'live_h264_ac3']) expect(covered.has(`live:${p}`), p).toBe(true);
    for (const e of FORMAT_MATRIX) {
      expect(e).toMatchObject(PROFILES[e.id]);
      for (const id of e.ids) {
        const lookup = e.kind === 'live' ? [small.liveById, full.liveById] : e.kind === 'movie' ? [small.movieById, full.movieById] : [small.episodeById, full.episodeById];
        for (const map of lookup) expect(map.get(id)?.profile).toBe(e.id);
      }
    }
  });
});

describe('timezone helpers', () => {
  it('parses timeshift starts in the panel timezone (CET and CEST)', () => {
    expect(parseTimeshiftStart('2026-11-01:20-15', 'Europe/Berlin')).toBe(Date.UTC(2026, 10, 1, 19, 15) / 1000);
    expect(parseTimeshiftStart('2026-07-01:20-15', 'Europe/Berlin')).toBe(Date.UTC(2026, 6, 1, 18, 15) / 1000);
    expect(parseTimeshiftStart('nope', 'Europe/Berlin')).toBeNull();
    const t = Date.UTC(2026, 10, 1, 19, 15) / 1000;
    expect(formatLocal(t, 'Europe/Berlin')).toBe('2026-11-01 20:15:00');
    expect(secondsOfDay(t, 'Europe/Berlin')).toBe(20 * 3600 + 15 * 60);
  });
});
