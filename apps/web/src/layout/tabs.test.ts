import { describe, expect, test } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences, normalizeTabOrder } from '@anycast/shared';
import { visibleTabs } from './tabs';

const DEFAULT = ['home', 'search', 'live', 'movies', 'series', 'library'];

describe('tab order migration', () => {
  test('default: Home, Search, Live TV, Movies, Series, Library', () => {
    expect(DEFAULT_PREFERENCES.start.tabOrder).toEqual(DEFAULT);
    expect(mergePreferences({}).start.tabOrder).toEqual(DEFAULT);
  });

  test('an untouched old default becomes the new default', () => {
    for (const old of [
      ['live', 'favorites', 'movies', 'series', 'search'],
      ['live', 'movies', 'series', 'search'],
      ['search', 'favorites', 'lists', 'live', 'movies', 'series'],
      ['home', 'search', 'favorites', 'lists', 'live', 'movies', 'series'],
    ]) {
      expect(normalizeTabOrder(old)).toEqual(DEFAULT);
    }
    expect(mergePreferences({ start: { tabOrder: ['live', 'favorites', 'movies', 'series', 'search'] } }).start.tabOrder).toEqual(DEFAULT);
  });

  test('Favorites and Lists become Library at the place of the first of them', () => {
    expect(normalizeTabOrder(['live', 'movies', 'home', 'series', 'search', 'favorites', 'lists'])).toEqual(['live', 'movies', 'home', 'series', 'search', 'library']);
    expect(normalizeTabOrder(['lists', 'live', 'favorites', 'movies', 'series', 'search', 'home'])).toEqual(['library', 'live', 'movies', 'series', 'search', 'home']);
  });

  test('a custom order saved before Library existed gets it at the end, and Home first', () => {
    expect(normalizeTabOrder(['series', 'search', 'live', 'movies'])).toEqual(['home', 'series', 'search', 'live', 'movies', 'library']);
  });

  test('missing, unknown and repeated tabs are repaired', () => {
    expect(normalizeTabOrder(['movies', 'bogus', 'movies'])).toEqual(['home', 'movies', 'search', 'live', 'series', 'library']);
    expect(normalizeTabOrder(undefined)).toEqual(DEFAULT);
    const p = mergePreferences({ start: { tabOrder: 'x', hiddenTabs: ['search', 'nope'], startTab: 'gone' } });
    expect(p.start.hiddenTabs).toEqual(['search']);
    expect(p.start.startTab).toBe('home');
  });

  test('Library is hidden only when both Favorites and Lists were; a start tab on either opens Library', () => {
    expect(mergePreferences({ start: { hiddenTabs: ['favorites'] } }).start.hiddenTabs).toEqual([]);
    expect(mergePreferences({ start: { hiddenTabs: ['lists', 'favorites', 'search'] } }).start.hiddenTabs).toEqual(['search', 'library']);
    expect(mergePreferences({ start: { startTab: 'lists' }, home: {} }).start.startTab).toBe('library');
  });

  test('hidden tabs stay hidden', () => {
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['search'])).toEqual(['home', 'live', 'movies', 'series', 'library']);
    expect(visibleTabs(['live', 'movies', 'series', 'search'], ['library'])).toEqual(['home', 'search', 'live', 'movies', 'series']);
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
    expect(p.home.sections).toEqual(['favorites', 'watchLater', 'continue', 'newEpisodes', 'recent', 'next']);
    // a section added later lands next to its neighbour in the default order
    expect(mergePreferences({ home: { sections: ['watchLater', 'next', 'continue', 'recent', 'favorites'] } }).home.sections).toEqual([
      'watchLater', 'next', 'continue', 'newEpisodes', 'recent', 'favorites',
    ]);
    expect(p.home.hiddenSections).toEqual(['favorites', 'watchLater']);
    expect(p.home.rowLimit).toBe(12);
    expect(mergePreferences({}).home).toEqual(DEFAULT_PREFERENCES.home);
  });
});
