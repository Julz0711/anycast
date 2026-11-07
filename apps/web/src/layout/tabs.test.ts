import { describe, expect, test } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, normalizeTabOrder } from '@anycast/shared';
import { visibleTabs } from './tabs';

const DEFAULT = ['search', 'favorites', 'lists', 'live', 'movies', 'series'];

describe('tab order migration', () => {
  test('default: Search, Favorites, Lists, Live TV, Movies, Series', () => {
    expect(DEFAULT_PREFERENCES.start.tabOrder).toEqual(DEFAULT);
    expect(mergePreferences({}).start.tabOrder).toEqual(DEFAULT);
  });

  test('an untouched old default becomes the new default', () => {
    expect(normalizeTabOrder(['live', 'favorites', 'movies', 'series', 'search'])).toEqual(DEFAULT);
    expect(normalizeTabOrder(['live', 'movies', 'series', 'search'])).toEqual(DEFAULT);
    expect(mergePreferences({ start: { tabOrder: ['live', 'favorites', 'movies', 'series', 'search'] } }).start.tabOrder).toEqual(DEFAULT);
  });

  test('a custom order saved before Favorites existed gets it after Live TV, and Lists after Favorites', () => {
    expect(normalizeTabOrder(['series', 'search', 'live', 'movies'])).toEqual(['series', 'search', 'live', 'favorites', 'lists', 'movies']);
    expect(mergePreferences({ start: { tabOrder: ['movies', 'live', 'series', 'search'] } }).start.tabOrder).toEqual(['movies', 'live', 'favorites', 'lists', 'series', 'search']);
  });

  test('a custom order with Favorites gets Lists right after it', () => {
    expect(normalizeTabOrder(['search', 'favorites', 'live', 'movies', 'series'])).toEqual(['search', 'favorites', 'lists', 'live', 'movies', 'series']);
    expect(normalizeTabOrder(['movies', 'series', 'favorites', 'live', 'search'])).toEqual(['movies', 'series', 'favorites', 'lists', 'live', 'search']);
  });

  test('a saved order that has Lists keeps its place', () => {
    expect(normalizeTabOrder(['lists', 'live', 'favorites', 'movies', 'series', 'search'])).toEqual(['lists', 'live', 'favorites', 'movies', 'series', 'search']);
  });

  test('missing, unknown and repeated tabs are repaired', () => {
    expect(normalizeTabOrder(['movies', 'bogus', 'movies'])).toEqual(['movies', 'search', 'live', 'favorites', 'lists', 'series']);
    expect(normalizeTabOrder(undefined)).toEqual(DEFAULT);
    const p = mergePreferences({ start: { tabOrder: 'x', hiddenTabs: ['search', 'nope'], startTab: 'gone' } });
    expect(p.start.hiddenTabs).toEqual(['search']);
    expect(p.start.startTab).toBe('live');
  });

  test('hidden tabs stay hidden; new tabs show unless hidden', () => {
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['search'])).toEqual(['favorites', 'lists', 'live', 'movies', 'series']);
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['favorites', 'lists'])).toEqual(['search', 'live', 'movies', 'series']);
  });
});
