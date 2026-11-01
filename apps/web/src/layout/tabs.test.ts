import { describe, expect, test } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, normalizeTabOrder } from '@anycast/shared';
import { visibleTabs } from './tabs';

describe('tab order migration', () => {
  test('defaults put Favorites right after Live TV', () => {
    expect(DEFAULT_PREFERENCES.start.tabOrder).toEqual(['live', 'favorites', 'movies', 'series', 'search']);
    expect(mergePreferences({}).start.tabOrder).toEqual(DEFAULT_PREFERENCES.start.tabOrder);
  });

  test('an order saved before Favorites existed gets it after Live TV, wherever Live is', () => {
    expect(normalizeTabOrder(['live', 'movies', 'series', 'search'])).toEqual(['live', 'favorites', 'movies', 'series', 'search']);
    expect(normalizeTabOrder(['series', 'search', 'live', 'movies'])).toEqual(['series', 'search', 'live', 'favorites', 'movies']);
    expect(mergePreferences({ start: { tabOrder: ['movies', 'live', 'series', 'search'] } }).start.tabOrder).toEqual(['movies', 'live', 'favorites', 'series', 'search']);
  });

  test('a saved order that has Favorites keeps its place', () => {
    expect(normalizeTabOrder(['search', 'favorites', 'live', 'movies', 'series'])).toEqual(['search', 'favorites', 'live', 'movies', 'series']);
  });

  test('missing, unknown and repeated tabs are repaired', () => {
    expect(normalizeTabOrder(['movies', 'bogus', 'movies'])).toEqual(['movies', 'live', 'favorites', 'series', 'search']);
    expect(normalizeTabOrder(undefined)).toEqual(['live', 'favorites', 'movies', 'series', 'search']);
    const p = mergePreferences({ start: { tabOrder: 'x', hiddenTabs: ['search', 'nope'], startTab: 'gone' } });
    expect(p.start.hiddenTabs).toEqual(['search']);
    expect(p.start.startTab).toBe('live');
  });

  test('hidden tabs stay hidden; Favorites shows for old orders unless hidden', () => {
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['search'])).toEqual(['live', 'favorites', 'movies', 'series']);
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['favorites'])).toEqual(['live', 'movies', 'series', 'search']);
  });
});
