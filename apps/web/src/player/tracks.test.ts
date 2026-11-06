import type { PlaybackTracks } from '@anycast/shared';
import { describe, expect, test } from 'vitest';
import { audioLabel, hasTrackChoice, renditionOf, subtitleAction, subtitleLabel } from './tracks';

const tracks = (over: Partial<PlaybackTracks> = {}): PlaybackTracks => ({
  audio: [
    { index: 0, language: 'de', codec: 'eac3', channels: 6, title: null, default: true },
    { index: 1, language: 'en', codec: 'aac', channels: 2, title: 'Commentary', default: false },
  ],
  subtitles: [
    { index: 0, language: 'en', codec: 'hdmv_pgs_subtitle', title: null, default: false, forced: false, format: 'bitmap', unavailable: "Picture-based (PGS) subtitles can't be shown" },
    { index: 1, language: 'en', codec: 'subrip', title: null, default: false, forced: false, format: 'text' },
    { index: 2, language: 'de', codec: 'ass', title: null, default: false, forced: true, format: 'text' },
  ],
  audioIndex: 0,
  subtitleIndex: null,
  subtitlesInStream: true,
  ...over,
});

describe('labels', () => {
  test('audio: language and title, then codec and channels', () => {
    expect(audioLabel(tracks().audio[0]!)).toEqual({ main: 'German', detail: 'Dolby Digital Plus 5.1' });
    expect(audioLabel(tracks().audio[1]!)).toEqual({ main: 'English · Commentary', detail: 'AAC Stereo' });
    expect(audioLabel({ index: 0, language: null, codec: 'truehd', channels: 8, title: null, default: false })).toEqual({ main: 'Unknown language', detail: 'Dolby TrueHD 7.1' });
  });
  test('subtitles: the reason a track cannot be shown, or forced', () => {
    expect(subtitleLabel(tracks().subtitles[0]!).detail).toBe("Picture-based (PGS) subtitles can't be shown");
    expect(subtitleLabel(tracks().subtitles[1]!)).toEqual({ main: 'English', detail: null });
    expect(subtitleLabel(tracks().subtitles[2]!).detail).toMatch(/^Forced/);
  });
});

describe('subtitle switching', () => {
  test('rendition positions skip the tracks the stream does not carry', () => {
    expect(renditionOf(tracks(), 1)).toBe(0);
    expect(renditionOf(tracks(), 2)).toBe(1);
    expect(renditionOf(tracks(), 0)).toBeNull();
    expect(renditionOf(tracks(), null)).toBeNull();
    expect(renditionOf(tracks({ subtitlesInStream: false }), 1)).toBeNull();
  });
  test('switch in the stream, reload a directly played one, nothing for picture-based', () => {
    expect(subtitleAction(tracks(), 1)).toBe('switch');
    expect(subtitleAction(tracks(), null)).toBe('switch');
    expect(subtitleAction(tracks({ subtitlesInStream: false }), 1)).toBe('reload');
    expect(subtitleAction(tracks({ subtitlesInStream: false }), null)).toBe('switch');
    expect(subtitleAction(tracks(), 0)).toBe('none');
    expect(subtitleAction(tracks(), 7)).toBe('none');
  });
  test('the tracks button shows with a choice of audio or any subtitles', () => {
    expect(hasTrackChoice(tracks())).toBe(true);
    expect(hasTrackChoice(tracks({ audio: tracks().audio.slice(0, 1), subtitles: [] }))).toBe(false);
    expect(hasTrackChoice(undefined)).toBe(false);
  });
});
