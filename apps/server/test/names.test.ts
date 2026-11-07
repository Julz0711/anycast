import { describe, expect, test } from 'vitest';
import { cleanCategoryName, cleanEpisodeTitle, splitTitle, variantKey, variantScore } from '../src/catalog/names';

describe('category names', () => {
  test.each([
    ['UK: SPORTS', 'UK · Sports'],
    ['· EN| SPORTS', 'EN · Sports'],
    ['|EN| SPORTS', 'EN · Sports'],
    ['USA | NEWS', 'US · News'],
    ['UK ENTERTAINMENT', 'UK · Entertainment'],
    ['[FR] GÉNÉRALISTE', 'FR · Généraliste'],
    ['IT | RAI & MEDIASET', 'IT · RAI & Mediaset'],
    ['VIP | 4K', 'VIP · 4K'],
    ['SPORTS | beIN', 'Sports · beIN'],
    ['PPV EVENTS', 'PPV Events'],
    ['EN - Kids & Family', 'EN · Kids & Family'],
    ['GERMANY SPORTS', 'Germany Sports'],
  ])('%s -> %s', (raw, clean) => expect(cleanCategoryName(raw)).toBe(clean));
});

describe('movie and series titles', () => {
  test.each([
    ['Lost Promise (2023) 4K', 'Lost Promise', 2023],
    ['Dark Promise 2 - 2000 [MULTI-SUB]', 'Dark Promise 2', 2000],
    ['The Silent Harbor [2025] 4K', 'The Silent Harbor', 2025],
    ['Lost Frontier [MULTI-SUB]', 'Lost Frontier', null],
    ['Silent River 4K', 'Silent River', null],
    ['Blade Runner 2049', 'Blade Runner 2049', null],
    ['1917 (2019)', '1917', 2019],
  ])('%s', (raw, name, year) => expect(splitTitle(raw)).toEqual({ name, year }));
});

describe('episode titles', () => {
  test('drop the series name, year and code', () => {
    expect(cleanEpisodeTitle('The Hidden Kingdom (2018) - S01E01 - Hidden River')).toBe('Hidden River');
    expect(cleanEpisodeTitle('Show S02 E05: The End')).toBe('The End');
    expect(cleanEpisodeTitle('Show - Pilot', 'Show')).toBe('Pilot');
    expect(cleanEpisodeTitle('Show (2020) - Pilot', 'Show')).toBe('Pilot');
  });
  test('a bare code becomes "Episode n"', () => {
    expect(cleanEpisodeTitle('S02E03')).toBe('Episode 3');
    expect(cleanEpisodeTitle('Show S01E07', null, 7)).toBe('Episode 7');
  });
  test('plain titles stay', () => expect(cleanEpisodeTitle('Pilot', 'Show')).toBe('Pilot'));
});

describe('duplicate channels', () => {
  test('quality tags, codecs, superscripts and backups share a key', () => {
    const names = ['BBC One HD', 'BBC One FHD', 'BBC One', 'BBC One SD', 'BBC One 4K', 'BBC One HEVC', 'BBC One RAW', 'BBC One UHD',
      'BBC One H265', 'BBC One 50FPS', 'BBC One LOW', 'BBC One ᴴᴰ', 'BBC One HD²', 'BBC One HD [Geo]', 'BBC One VIP', 'BBC One HQ',
      'BBC One (BACKUP)', 'BBC One SD (OLD)', 'BBC One FHD (MULTI-AUDIO)', 'BBC One (2)'];
    expect(new Set(names.map((n) => variantKey(n).key))).toEqual(new Set(['bbc one']));
    expect(variantKey('BBC One ᴴᴰ').quality).toBe('HD');
    expect(variantKey('BBC One UHD').quality).toBe('4K');
    expect(variantKey('BBC One FHD').base).toBe('BBC One');
  });
  test('timeshift channels and numbered channels stay apart', () => {
    expect(variantKey('BBC One +1').key).not.toBe(variantKey('BBC One').key);
    expect(variantKey('Sky Sports 1 HD').key).not.toBe(variantKey('Sky Sports 2 HD').key);
  });
  test('backups come last, then quality decides, then catch-up', () => {
    const score = (n: string, archiveDays = 0) => {
      const v = variantKey(n);
      return variantScore({ quality: v.quality, archiveDays, spare: v.spare });
    };
    expect(score('X FHD')).toBeLessThan(score('X HD'));
    expect(score('X HD')).toBeLessThan(score('X RAW'));
    expect(score('X (BACKUP)', 7)).toBeGreaterThan(score('X RAW'));
    expect(score('X HD', 1)).toBeLessThan(score('X HD'));
  });
});
