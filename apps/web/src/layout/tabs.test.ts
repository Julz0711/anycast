import { describe, expect, test } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, normalizeTabOrder } from '@anycast/shared';
import { visibleTabs } from './tabs';

const DEFAULT = ['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series'];

describe('tab order migration', () => {
  test('default: Home, Search, Favorites, Lists, Live TV, Movies, Series', () => {
    expect(DEFAULT_PREFERENCES.start.tabOrder).toEqual(DEFAULT);
    expect(mergePreferences({}).start.tabOrder).toEqual(DEFAULT);
  });

  test('an untouched old default becomes the new default', () => {
    expect(normalizeTabOrder(['live', 'favorites', 'movies', 'series', 'search'])).toEqual(DEFAULT);
    expect(normalizeTabOrder(['live', 'movies', 'series', 'search'])).toEqual(DEFAULT);
    expect(normalizeTabOrder(['search', 'favorites', 'lists', 'live', 'movies', 'series'])).toEqual(DEFAULT);
    expect(mergePreferences({ start: { tabOrder: ['live', 'favorites', 'movies', 'series', 'search'] } }).start.tabOrder).toEqual(DEFAULT);
  });

  test('a custom order saved before Favorites existed gets it after Live TV, and Lists after Favorites', () => {
    expect(normalizeTabOrder(['series', 'search', 'live', 'movies'])).toEqual(['home', 'series', 'search', 'live', 'favorites', 'lists', 'movies']);
    expect(mergePreferences({ start: { tabOrder: ['movies', 'live', 'series', 'search'] } }).start.tabOrder).toEqual(['home', 'movies', 'live', 'favorites', 'lists', 'series', 'search']);
  });

  test('a custom order with Favorites gets Lists right after it', () => {
    expect(normalizeTabOrder(['search', 'favorites', 'live', 'movies', 'series'])).toEqual(['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series']);
    expect(normalizeTabOrder(['movies', 'series', 'favorites', 'live', 'search'])).toEqual(['home', 'movies', 'series', 'favorites', 'lists', 'live', 'search']);
  });

  test('a saved order that has Lists keeps its place', () => {
    expect(normalizeTabOrder(['lists', 'live', 'favorites', 'movies', 'series', 'search'])).toEqual(['home', 'lists', 'live', 'favorites', 'movies', 'series', 'search']);
  });

  test('missing, unknown and repeated tabs are repaired', () => {
    expect(normalizeTabOrder(['movies', 'bogus', 'movies'])).toEqual(['home', 'movies', 'search', 'live', 'favorites', 'lists', 'series']);
    expect(normalizeTabOrder(undefined)).toEqual(DEFAULT);
    const p = mergePreferences({ start: { tabOrder: 'x', hiddenTabs: ['search', 'nope'], startTab: 'gone' } });
    expect(p.start.hiddenTabs).toEqual(['search']);
    expect(p.start.startTab).toBe('home');
  });

  test('a saved order keeps its place and gets Home first; a custom order with Home keeps it where it is', () => {
    expect(normalizeTabOrder(['live', 'movies', 'home', 'series', 'search', 'favorites', 'lists'])).toEqual(['live', 'movies', 'home', 'series', 'search', 'favorites', 'lists']);
  });

  test('hidden tabs stay hidden; new tabs show unless hidden', () => {
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['search'])).toEqual(['home', 'favorites', 'lists', 'live', 'movies', 'series']);
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['favorites', 'lists'])).toEqual(['home', 'search', 'live', 'movies', 'series']);
  });
});

describe('Home', () => {
  test('a profile saved before Home existed, still opening on Live TV, opens on Home', () => {
    expect(mergePreferences({ start: { startTab: 'live' } }).start.startTab).toBe('home');
    // a different start tab was the user's choice
    expect(mergePreferences({ start: { startTab: 'movies' } }).start.startTab).toBe('movies');
    // once Home exists in the saved preferences, Live TV is a choice too
    expect(mergePreferences({ start: { startTab: 'live' }, home: {} }).start.startTab).toBe('live');
  });

  test('sections: unknown and repeated dropped, missing added; hidden kept in order; bad row limit repaired', () => {
    const p = mergePreferences({ home: { sections: ['favorites', 'bogus', 'favorites', 'continue'], hiddenSections: ['watchLater', 'nope', 'favorites'], rowLimit: 7 } });
    expect(p.home.sections).toEqual(['favorites', 'continue', 'recent', 'next', 'watchLater']);
    expect(p.home.hiddenSections).toEqual(['favorites', 'watchLater']);
    expect(p.home.rowLimit).toBe(12);
    expect(mergePreferences({}).home).toEqual(DEFAULT_PREFERENCES.home);
  });
});
