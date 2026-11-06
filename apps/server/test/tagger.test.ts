import { describe, expect, test } from 'vitest';
import { parseName, tagCategory, tagItem } from '../src/catalog/tagger';
import { buildCatalog } from './helpers';

const cases: [string, string | null, string | null, string][] = [
  ['DE | ARD HD', 'de', 'de', 'ARD HD'],
  ['DE: ZDF', 'de', 'de', 'ZDF'],
  ['DE| RTL', 'de', 'de', 'RTL'],
  ['[DE] Sat.1', 'de', 'de', 'Sat.1'],
  ['UK: BBC One', 'gb', 'en', 'BBC One'],
  ['GB: ITV', 'gb', 'en', 'ITV'],
  ['[FR] TF1', 'fr', 'fr', 'TF1'],
  ['|EN| Sky Sports 1 FHD', null, 'en', 'Sky Sports 1 FHD'],
  ['NL - NPO 1', 'nl', 'nl', 'NPO 1'],
  ['ES ▎ La 1', 'es', 'es', 'La 1'],
  ['PL ● TVP 1', 'pl', 'pl', 'TVP 1'],
  ['AR | MBC 1', null, 'ar', 'MBC 1'],
  ['ARABIC | Al Jazeera', null, 'ar', 'Al Jazeera'],
  ['US: CNN', 'us', 'en', 'CNN'],
  ['USA | FOX', 'us', 'en', 'FOX'],
  ['IT - Rai 1', 'it', 'it', 'Rai 1'],
  ['TR: TRT 1', 'tr', 'tr', 'TRT 1'],
  ['ALB | Top Channel', 'al', 'sq', 'Top Channel'],
  ['EX-YU | RTS 1', null, 'sr', 'RTS 1'],
  ['LATINO | Telemundo', null, 'es', 'Telemundo'],
  ['🇩🇪 ProSieben', 'de', 'de', 'ProSieben'],
  ['🇬🇧 Channel 4', 'gb', 'en', 'Channel 4'],
  ['Sky Cinema (DE)', 'de', 'de', 'Sky Cinema'],
  ['Canal+ [FR]', 'fr', 'fr', 'Canal+'],
  ['Discovery | UK', 'gb', 'en', 'Discovery'],
  ['DE', 'de', 'de', 'DE'],
];

describe('parseName', () => {
  test.each(cases)('%s', (name, country, language, stripped) => {
    const r = parseName(name);
    expect({ country: r.country, language: r.language, name: r.name }).toEqual({ country, language, name: stripped });
  });

  test.each(['IT Crowd', 'NO Time to Die', 'ZDF HD', 'Arte', 'In Bruges', 'X-Men (2000)', 'The Office [MULTI-SUB]', 'VIP | 4K', 'PPV EVENT 01'])(
    'no tag: %s',
    (name) => {
      const r = parseName(name);
      expect([r.country, r.language]).toEqual([null, null]);
    },
  );
});

describe('categories', () => {
  test.each([
    ['GERMANY SPORTS', 'de', 'de'],
    ['Arabic Movies', null, 'ar'],
    ['UK ENTERTAINMENT', 'gb', 'en'],
    ['FRANCE | CINEMA', 'fr', 'fr'],
    ['4K UHD MOVIES', null, null],
    ['NETFLIX MOVIES (MULTI-SUB)', null, null],
  ])('%s', (name, country, language) => {
    const r = tagCategory(name);
    expect([r.country, r.language]).toEqual([country, language]);
  });

  test('adult flag', () => {
    expect(tagCategory('XXX | Adult').adult).toBe(true);
    expect(tagCategory('FOR ADULTS 18+').adult).toBe(true);
    expect(tagCategory('DE | KIDS').adult).toBe(false);
  });
});

test('items inherit the category tag only when they have none', () => {
  const cat = { country: 'de', language: 'de' };
  expect(tagItem('Tatort (2019)', cat)).toMatchObject({ country: 'de', language: 'de', name: 'Tatort (2019)' });
  expect(tagItem('UK: BBC One', cat)).toMatchObject({ country: 'gb', language: 'en' });
  expect(tagItem('Something', null)).toMatchObject({ country: null, language: null });
});

test('>= 95% accuracy against the mock ground truth', () => {
  const c = buildCatalog('full', 42);
  let total = 0;
  let ok = 0;
  const check = (got: { country: string | null; language: string | null }, exp: { country: string | null; language: string | null }) => {
    total++;
    if (got.country === exp.country && got.language === exp.language) ok++;
  };
  const cats = new Map<string, ReturnType<typeof tagCategory>>();
  for (const cat of [...c.liveCategories, ...c.vodCategories, ...c.seriesCategories]) {
    const t = tagCategory(cat.category_name);
    cats.set(cat.category_id, t);
    check(t, cat.tags);
    expect(t.adult).toBe(cat.tags.adult);
  }
  for (const it of [...c.live, ...c.movies, ...c.series]) check(tagItem(it.name, cats.get(it.categoryId) ?? null), it.tags);
  expect(ok / total).toBeGreaterThanOrEqual(0.95);
});

test('decorative separators read as a middle dot in display names', () => {
  expect(parseName('UEFA▌ CHAMPIONS LEAGUE').name).toBe('UEFA · CHAMPIONS LEAGUE');
  expect(parseName('SPORTS ● REPLAY').name).toBe('SPORTS · REPLAY');
  expect(parseName('PL ● TVP 1')).toMatchObject({ country: 'pl', name: 'TVP 1' });
  expect(tagCategory('ASIA▌ NEW ZEALAND')).toMatchObject({ country: 'nz', language: 'en', name: 'ASIA · NEW ZEALAND' });
});
