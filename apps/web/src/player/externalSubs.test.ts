import { describe, expect, test } from 'vitest';
import { autoSubtitleRate, DEFAULT_PREFERENCES, SUBTITLE_DRIFT, type ExternalSubtitleState, type PlaybackTracks } from '@anycast/shared';
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

  test('drift: a subtitle made for 23.976 fps on a 25 fps video', () => {
    // a line at 25:00 in the file belongs at 23:58 in the faster video: a minute behind without the fix
    const cues = [{ start: 1500, end: 1503, text: 'Late line' }];
    const rate = SUBTITLE_DRIFT.later;
    expect(activeCues(cues, 1500.5, 0)).toHaveLength(1);
    expect(activeCues(cues, 1500.5, 0, rate)).toEqual([]);
    expect(activeCues(cues, 1500 * rate + 0.5, 0, rate)).toHaveLength(1);
    // with an offset on top
    expect(activeCues(cues, 1500 * rate + 2.5, 2000, rate)).toHaveLength(1);
    // the other way round
    expect(activeCues(cues, 1500 * SUBTITLE_DRIFT.earlier + 0.5, 0, SUBTITLE_DRIFT.earlier)).toHaveLength(1);
  });

  test('drift from the frame rates', () => {
    expect(autoSubtitleRate(23.976, 25)).toBeCloseTo(SUBTITLE_DRIFT.later, 3);
    expect(autoSubtitleRate(25, 23.976)).toBeCloseTo(SUBTITLE_DRIFT.earlier, 3);
    expect(autoSubtitleRate(24, 25)).toBeCloseTo(0.96, 3);
    // the same rate, 23.976 vs 24 (0.1 %), 30 vs 25 (another kind of mismatch) or unknown: as made
    expect(autoSubtitleRate(25, 25)).toBe(1);
    expect(autoSubtitleRate(23.976, 24)).toBe(1);
    expect(autoSubtitleRate(30, 25)).toBe(1);
    expect(autoSubtitleRate(null, 25)).toBe(1);
    expect(autoSubtitleRate(23.976, null)).toBe(1);
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
  const state: ExternalSubtitleState = { online: true, files: [], choice: null, savedOff: false, seriesLanguage: null };
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
    expect(autoLanguage({ ...base, prefs: prefs('on', 'de'), state: { ...state, choice: { fileId: null, offsetMs: 0, rate: null } } })).toBeNull();
  });

  test('another episode of the series had some: the same language, even with the preference off', () => {
    const series = { ...state, seriesLanguage: 'de' };
    expect(autoLanguage({ ...base, prefs: prefs('off', null), state: series })).toBe('de');
    expect(autoLanguage({ ...base, prefs: prefs('off', null), state: { ...series, choice: { fileId: null, offsetMs: 0, rate: null } } })).toBeNull();
    expect(autoLanguage({ ...base, prefs: prefs('off', null), state: series, shown: 1 })).toBeNull();
  });

  test('search language', () => {
    expect(searchLanguage(prefs('auto', 'es'), 'de-DE')).toBe('es');
    expect(searchLanguage(prefs('off', null), 'de-DE')).toBe('de');
    expect(searchLanguage(prefs('off', null), null)).toBe('en');
  });
});
