/**
 * Media Session (lock screen, notification, hardware media keys, headphones) and background
 * audio. The player keeps playing when the tab or app is hidden: nothing here, or in the player,
 * pauses on visibilitychange (progress is still saved on hide, CT-1).
 */
import { useEffect, useRef } from 'react';

export interface MediaInfo {
  title: string;
  /** channel name (live), series name (episodes) */
  artist?: string | null;
  /** e.g. "S2 E5" or the year */
  album?: string | null;
  /** /api/art/... path or absolute URL */
  artwork?: string | null;
}

export interface MediaActions {
  play: () => void;
  pause: () => void;
  /** relative seek in seconds (negative = back) */
  seekBy: (seconds: number) => void;
  /** absolute seek (VOD only) */
  seekTo?: (seconds: number) => void;
  /** previous / next channel (live) or episode (series); absent = not offered */
  previous?: () => void;
  next?: () => void;
}

export const DEFAULT_SEEK_OFFSET = 10;

const hasMediaSession = () => typeof navigator !== 'undefined' && 'mediaSession' in navigator && !!navigator.mediaSession;

/** Artwork entries for MediaMetadata; relative /api paths are made absolute (the OS fetches them). */
export function artworkFor(src: string | null | undefined, origin = typeof location !== 'undefined' ? location.origin : ''): MediaImage[] {
  if (!src) return [];
  const url = /^https?:\/\//.test(src) ? src : `${origin}${src.startsWith('/') ? '' : '/'}${src}`;
  return [{ src: url, sizes: '512x512' }];
}

export function metadataInit(m: MediaInfo): MediaMetadataInit {
  return { title: m.title, artist: m.artist ?? '', album: m.album ?? '', artwork: artworkFor(m.artwork) };
}

/** A valid setPositionState() argument for this element, or null when there is none (live, unknown length). */
export function positionStateOf(v: Pick<HTMLMediaElement, 'duration' | 'currentTime' | 'playbackRate'>): MediaPositionState | null {
  const d = v.duration;
  if (!Number.isFinite(d) || d <= 0) return null;
  const rate = v.playbackRate > 0 ? v.playbackRate : 1;
  return { duration: d, position: Math.min(Math.max(0, v.currentTime || 0), d), playbackRate: rate };
}

function setHandler(action: MediaSessionAction, fn: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, fn);
  } catch {
    /* this browser does not know the action */
  }
}

const ACTIONS: MediaSessionAction[] = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'stop'];

/**
 * Publishes `info` to the Media Session and routes its actions to the player. `vod` turns on
 * seekto and position state. Handlers always call the latest `actions` (kept in a ref).
 */
export function useMediaSession(video: HTMLVideoElement | null, info: MediaInfo | null, actions: MediaActions, vod: boolean): void {
  const act = useRef(actions);
  act.current = actions;
  const hasPrev = !!actions.previous;
  const hasNext = !!actions.next;

  // metadata
  const key = info ? JSON.stringify(metadataInit(info)) : '';
  useEffect(() => {
    if (!hasMediaSession() || !info || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata(metadataInit(info));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // action handlers
  useEffect(() => {
    if (!hasMediaSession()) return;
    setHandler('play', () => act.current.play());
    setHandler('pause', () => act.current.pause());
    setHandler('stop', () => act.current.pause());
    setHandler('seekbackward', (d) => act.current.seekBy(-(d.seekOffset ?? DEFAULT_SEEK_OFFSET)));
    setHandler('seekforward', (d) => act.current.seekBy(d.seekOffset ?? DEFAULT_SEEK_OFFSET));
    setHandler('seekto', vod ? (d) => d.seekTime !== undefined && act.current.seekTo?.(d.seekTime) : null);
    setHandler('previoustrack', hasPrev ? () => act.current.previous?.() : null);
    setHandler('nexttrack', hasNext ? () => act.current.next?.() : null);
  }, [vod, hasPrev, hasNext]);

  // playback state + position (VOD)
  useEffect(() => {
    if (!hasMediaSession() || !video) return;
    const ms = navigator.mediaSession;
    let last = 0;
    const position = (force = false) => {
      if (!vod || typeof ms.setPositionState !== 'function') return;
      const now = Date.now();
      if (!force && now - last < 1000) return;
      last = now;
      const st = positionStateOf(video);
      try {
        if (st) ms.setPositionState(st);
      } catch {
        /* rejected (e.g. a position past a changing duration); the next update fixes it */
      }
    };
    const onPlay = () => ((ms.playbackState = 'playing'), position(true));
    const onPause = () => ((ms.playbackState = 'paused'), position(true));
    const onTime = () => position();
    const onJump = () => position(true);
    video.addEventListener('play', onPlay);
    video.addEventListener('playing', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onJump);
    video.addEventListener('durationchange', onJump);
    video.addEventListener('ratechange', onJump);
    ms.playbackState = video.paused ? 'paused' : 'playing';
    position(true);
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('playing', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onJump);
      video.removeEventListener('durationchange', onJump);
      video.removeEventListener('ratechange', onJump);
    };
  }, [video, vod]);

  // leaving the player clears everything
  useEffect(
    () => () => {
      if (!hasMediaSession()) return;
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      for (const a of ACTIONS) setHandler(a, null);
      try {
        navigator.mediaSession.setPositionState?.();
      } catch {
        /* not supported */
      }
    },
    [],
  );
}
