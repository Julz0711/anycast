import { describe, expect, test } from 'vitest';
import { DEFAULT_PREFERENCES, type ExternalSubtitleState, type PlaybackTracks } from '@anycast/shared';
import { activeCues, autoLanguage, cueSegments, fmtOffset, parseVtt, searchLanguage } from './externalSubs';

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello <i>there</i>\n\n00:00:03.000 --> 00:00:05.000\nTwo\nlines\n\n01:00:00.000 --> 01:00:02.000\nLate\n';

describe('external subtitles', () => {
  test('parse WebVTT', () => {
    expect(parseVtt(VTT)).toEqual([
      { start: 1, end: 3.5, text: 'Hello <i>there</i>' },
      { start: 3, end: 5, text: 'Two\nlines' },
      { start: 3600, end: 3602, text: 'Late' },
    ]);
  });

  test('cues at a time, with an offset', () => {
    const cues = parseVtt(VTT);
    expect(activeCues(cues, 0.5, 0)).toEqual([]);
    expect(activeCues(cues, 3.2, 0).map((c) => c.text)).toEqual(['Hello <i>there</i>', 'Two\nlines']);
    // +2 s: subtitles come later, so at 3.2 s the first line just started
    expect(activeCues(cues, 3.2, 2000).map((c) => c.text)).toEqual(['Hello <i>there</i>']);
    expect(activeCues(cues, 3601, 0).map((c) => c.text)).toEqual(['Late']);
    expect(activeCues(cues, 3601, -500).map((c) => c.text)).toEqual(['Late']);
    expect(activeCues(cues, 3603, 0)).toEqual([]);
  });

  test('segments keep italic and decode entities', () => {
    expect(cueSegments('Hi <i>you &amp; me</i>!')).toEqual([{ text: 'Hi ' }, { text: 'you & me', i: true }, { text: '!' }]);
  });

  test('offset label', () => {
    expect(fmtOffset(0)).toBe('0 s');
    expect(fmtOffset(1500)).toBe('+1.5 s');
    expect(fmtOffset(-2000)).toBe('−2 s');
  });
});

describe('when the player fetches subtitles on its own', () => {
  const tracks = (audioLang: string | null): PlaybackTracks => ({
    audio: [{ index: 0, language: audioLang, codec: 'aac', channels: 2, title: null, default: true }],
    subtitles: [],
    audioIndex: 0,
    subtitleIndex: null,
    subtitlesInStream: false,
  });
  const state: ExternalSubtitleState = { online: true, files: [], choice: null, savedOff: false };
  const prefs = (subtitlesDefault: 'off' | 'auto' | 'on', preferredSubtitleLanguage: string | null) => ({ ...DEFAULT_PREFERENCES.player, subtitlesDefault, preferredSubtitleLanguage });
  const base = { tracks: tracks('en'), shown: null, state, itemLanguage: null, deviceLanguage: 'de-DE' };

  test('off: never', () => {
    expect(autoLanguage({ ...base, prefs: prefs('off', 'de') })).toBeNull();
  });

  test('auto: only when the audio is in another language', () => {
    expect(autoLanguage({ ...base, prefs: prefs('auto', 'de') })).toBe('de');
    expect(autoLanguage({ ...base, tracks: tracks('deu'), prefs: prefs('auto', 'de') })).toBeNull();
    // untagged audio: the title's category language decides
    expect(autoLanguage({ ...base, tracks: tracks(null), itemLanguage: 'de', prefs: prefs('auto', 'de') })).toBeNull();
    expect(autoLanguage({ ...base, tracks: tracks(null), itemLanguage: 'en', prefs: prefs('auto', 'de') })).toBe('de');
    // no subtitle language: nothing to compare with
    expect(autoLanguage({ ...base, prefs: prefs('auto', null) })).toBeNull();
  });

  test('always: the subtitle language, else the device language', () => {
    expect(autoLanguage({ ...base, prefs: prefs('on', 'fr') })).toBe('fr');
    expect(autoLanguage({ ...base, prefs: prefs('on', null) })).toBe('de');
  });

  test('not when something was picked, turned off, or the stream shows its own', () => {
    expect(autoLanguage({ ...base, prefs: prefs('on', 'de'), shown: 0 })).toBeNull();
    expect(autoLanguage({ ...base, prefs: prefs('on', 'de'), state: { ...state, savedOff: true } })).toBeNull();
    expect(autoLanguage({ ...base, prefs: prefs('on', 'de'), state: { ...state, choice: { fileId: null, offsetMs: 0 } } })).toBeNull();
  });

  test('search language', () => {
    expect(searchLanguage(prefs('auto', 'es'), 'de-DE')).toBe('es');
    expect(searchLanguage(prefs('off', null), 'de-DE')).toBe('de');
    expect(searchLanguage(prefs('off', null), null)).toBe('en');
  });
});
