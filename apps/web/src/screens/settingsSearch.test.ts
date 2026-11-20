import { describe, expect, it } from 'vitest';
import { matches, normalize, queryTerms } from './settingsSearch';

describe('settings search', () => {
  it('needs every word, in any order, ignoring case and accents', () => {
    expect(matches('Live buffer Live TV waits for 4 s', queryTerms('buffer live'))).toBe(true);
    expect(matches('Live buffer', queryTerms('buffer movie'))).toBe(false);
    expect(normalize('  Größe  ÉTÉ ')).toBe('grosse ete');
  });
  it('finds English options from German words and word starts', () => {
    expect(matches('Subtitles Turn them on', queryTerms('Untertitel'))).toBe(true);
    expect(matches('Subtitles Turn them on', queryTerms('unter'))).toBe(true);
    expect(matches('Parental lock', queryTerms('kindersicherung'))).toBe(true);
    expect(matches('Accent color', queryTerms('farben'))).toBe(true);
    expect(matches('Live buffer', queryTerms('puffer'))).toBe(true);
  });
  it('an empty query matches everything', () => {
    expect(queryTerms('   ')).toEqual([]);
    expect(matches('anything', [])).toBe(true);
  });
});

describe('settings search, word starts', () => {
  it('matches the start of a word, not the middle', () => {
    expect(matches('Parental lock', queryTerms('lock'))).toBe(true);
    expect(matches('for titles and the clock', queryTerms('lock'))).toBe(false);
    expect(matches('Sign-in and devices', queryTerms('sign in'))).toBe(true);
  });
});
