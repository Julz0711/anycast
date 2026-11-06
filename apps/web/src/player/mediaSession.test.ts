import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { artworkFor, metadataInit, positionStateOf, useMediaSession, type MediaActions } from './mediaSession';
import { pipSupport } from './PipButton';

describe('media session helpers', () => {
  test('artwork paths become absolute URLs', () => {
    expect(artworkFor('/api/art/movie/7', 'https://tv.example')).toEqual([{ src: 'https://tv.example/api/art/movie/7', sizes: '512x512' }]);
    expect(artworkFor('https://cdn.example/p.jpg', 'https://tv.example')[0]!.src).toBe('https://cdn.example/p.jpg');
    expect(artworkFor(null)).toEqual([]);
  });

  test('metadata fills empty strings for missing fields', () => {
    expect(metadataInit({ title: 'Pilot', artist: null })).toEqual({ title: 'Pilot', artist: '', album: '', artwork: [] });
  });

  test('position state only for a known length, clamped', () => {
    expect(positionStateOf({ duration: Infinity, currentTime: 5, playbackRate: 1 })).toBeNull();
    expect(positionStateOf({ duration: NaN, currentTime: 5, playbackRate: 1 })).toBeNull();
    expect(positionStateOf({ duration: 100, currentTime: 120, playbackRate: 0 })).toEqual({ duration: 100, position: 100, playbackRate: 1 });
    expect(positionStateOf({ duration: 100, currentTime: 42, playbackRate: 1.5 })).toEqual({ duration: 100, position: 42, playbackRate: 1.5 });
  });
});

describe('useMediaSession', () => {
  const handlers = new Map<string, ((d: MediaSessionActionDetails) => void) | null>();
  const ms = {
    metadata: null as unknown,
    playbackState: 'none',
    setActionHandler: (a: string, fn: ((d: MediaSessionActionDetails) => void) | null) => handlers.set(a, fn),
    setPositionState: vi.fn(),
  };
  beforeEach(() => {
    handlers.clear();
    ms.setPositionState.mockClear();
    Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true });
    vi.stubGlobal('MediaMetadata', class {
      constructor(init: MediaMetadataInit) {
        Object.assign(this, init);
      }
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as unknown as Record<string, unknown>).mediaSession;
  });

  const actions = (): MediaActions & Record<string, ReturnType<typeof vi.fn>> => ({
    play: vi.fn(), pause: vi.fn(), seekBy: vi.fn(), seekTo: vi.fn(), previous: vi.fn(), next: vi.fn(),
  });

  test('VOD: metadata, seek actions, prev/next and position state; cleared on unmount', () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 300, configurable: true });
    video.currentTime = 0;
    const a = actions();
    const { unmount } = renderHook(() => useMediaSession(video, { title: 'Pilot', artist: 'Some Show', album: 'S1 E1', artwork: '/api/art/series/3' }, a, true));
    expect(ms.metadata).toMatchObject({ title: 'Pilot', artist: 'Some Show', album: 'S1 E1', artwork: [{ src: `${location.origin}/api/art/series/3` }] });
    handlers.get('seekbackward')!({ action: 'seekbackward' });
    expect(a.seekBy).toHaveBeenCalledWith(-10);
    handlers.get('seekforward')!({ action: 'seekforward', seekOffset: 30 });
    expect(a.seekBy).toHaveBeenCalledWith(30);
    handlers.get('seekto')!({ action: 'seekto', seekTime: 120 });
    expect(a.seekTo).toHaveBeenCalledWith(120);
    handlers.get('nexttrack')!({ action: 'nexttrack' });
    expect(a.next).toHaveBeenCalled();
    handlers.get('pause')!({ action: 'pause' });
    expect(a.pause).toHaveBeenCalled();
    expect(ms.setPositionState).toHaveBeenCalledWith({ duration: 300, position: 0, playbackRate: 1 });

    unmount();
    expect(ms.metadata).toBeNull();
    expect(handlers.get('play')).toBeNull();
    expect(handlers.get('nexttrack')).toBeNull();
  });

  test('live: no seekto, no position state; prev/next only when offered', () => {
    const video = document.createElement('video');
    const a = actions();
    delete (a as Partial<MediaActions>).previous;
    renderHook(() => useMediaSession(video, { title: 'News at 8', artist: 'News 24' }, a, false));
    expect(handlers.get('seekto')).toBeNull();
    expect(handlers.get('previoustrack')).toBeNull();
    expect(handlers.get('nexttrack')).toBeTypeOf('function');
    expect(ms.setPositionState).not.toHaveBeenCalled();
  });
});

describe('picture in picture support', () => {
  test('standard API, Safari presentation mode, or nothing', () => {
    const v = document.createElement('video') as HTMLVideoElement & Record<string, unknown>;
    expect(pipSupport(null)).toBeNull();
    expect(pipSupport(v, { pictureInPictureEnabled: false })).toBeNull();
    v.requestPictureInPicture = () => Promise.resolve({} as PictureInPictureWindow);
    expect(pipSupport(v, { pictureInPictureEnabled: true })).toBe('standard');
    v.disablePictureInPicture = true;
    expect(pipSupport(v, { pictureInPictureEnabled: true })).toBeNull();
    v.webkitSupportsPresentationMode = (m: string) => m === 'picture-in-picture';
    v.webkitSetPresentationMode = () => undefined;
    expect(pipSupport(v, { pictureInPictureEnabled: false })).toBe('webkit');
  });
});
