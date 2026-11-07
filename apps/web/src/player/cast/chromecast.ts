/**
 * Chromecast (Google Cast Web Sender, Default Media Receiver). Works in Chrome and Edge on
 * Android, Windows, Mac and Linux, on a secure page (https or localhost). Not on iPhone (use
 * AirPlay there) and not in Firefox. The SDK script loads only where it can work.
 *
 * The TV opens a cast link (see server cast.ts): the same stream this app asked for, so casting
 * keeps the one provider connection.
 */
import { create } from 'zustand';
import { call } from '../../api/client';
import type { CastMedia } from './media';

const SDK_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/* ---------- the parts of the Cast SDK used here ---------- */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Ns = any;
declare global {
  interface Window {
    __onGCastApiAvailable?: (available: boolean, reason?: string) => void;
    cast?: Ns;
    chrome?: Ns;
  }
}

export type CastStateName = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';
export type RemoteState = 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING';

export interface ChromecastState {
  /** the SDK: not tried yet, loading, ready, or not available in this browser */
  sdk: 'idle' | 'loading' | 'ready' | 'unavailable';
  castState: CastStateName;
  /** the TV's name while connected */
  device: string | null;
  /** media of ours is loaded on the TV */
  loaded: boolean;
  playerState: RemoteState;
  /** why the TV stopped: FINISHED, ERROR, CANCELLED, INTERRUPTED (set when playerState goes IDLE) */
  idleReason: string | null;
  time: number;
  duration: number;
  /** bumps on each load, so a finished or failed state is tied to the media it belongs to */
  loadSeq: number;
}

export const useChromecast = create<ChromecastState>(() => ({
  sdk: 'idle',
  castState: 'NO_DEVICES_AVAILABLE',
  device: null,
  loaded: false,
  playerState: 'IDLE',
  idleReason: null,
  time: 0,
  duration: 0,
  loadSeq: 0,
}));

/** True while a Chromecast session is open (the TV is ours to play on). */
export const castConnected = () => useChromecast.getState().castState === 'CONNECTED';

/** Where the Cast SDK can work: Chromium-based, secure page, not iOS (Chrome there is WebKit). */
export function castSupported(env: { secure: boolean; ua: string; hasChrome: boolean }): boolean {
  if (!env.secure || !env.hasChrome) return false;
  if (/iPhone|iPad|iPod/.test(env.ua)) return false;
  return /Chrome\/|Chromium\/|Edg\//.test(env.ua) && !/Firefox\/|CriOS|EdgiOS/.test(env.ua);
}

let player: Ns = null;
let controller: Ns = null;
let loadPromise: Promise<boolean> | null = null;

/** Players mounted now: when none is, an ended cast session releases the provider connection itself. */
let mountedPlayers = 0;
export function playerMounted(): () => void {
  mountedPlayers++;
  return () => {
    mountedPlayers--;
  };
}

function loadScript(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(false), 15_000);
    window.__onGCastApiAvailable = (ok) => {
      window.clearTimeout(timer);
      resolve(ok);
    };
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    document.head.appendChild(s);
  });
}

function setup(): void {
  const { cast, chrome } = window;
  const ctx = cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  const syncDevice = () => {
    const session = ctx.getCurrentSession();
    useChromecast.setState({ castState: ctx.getCastState() as CastStateName, device: session?.getCastDevice()?.friendlyName ?? null });
  };
  ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, syncDevice);
  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e: { sessionState: string }) => {
    syncDevice();
    if (e.sessionState === 'SESSION_ENDED') {
      const was = useChromecast.getState().loaded;
      useChromecast.setState({ loaded: false, playerState: 'IDLE', time: 0, duration: 0 });
      // the player screen resumes on this device; with no player open, give the connection back
      if (was && mountedPlayers === 0) void call('POST /api/play/stop').catch(() => undefined);
    }
  });

  player = new cast.framework.RemotePlayer();
  controller = new cast.framework.RemotePlayerController(player);
  controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, () => {
    const state = (player.playerState as RemoteState | null) ?? 'IDLE';
    const media = ctx.getCurrentSession()?.getMediaSession();
    const prev = useChromecast.getState();
    useChromecast.setState({
      playerState: state,
      idleReason: state === 'IDLE' ? (media?.idleReason ?? prev.idleReason) : null,
      time: Number.isFinite(player.currentTime) ? player.currentTime : 0,
      duration: Number.isFinite(player.duration) ? player.duration : 0,
    });
  });
  syncDevice();
}

/** Loads the Cast SDK once (where it can work); true when casting is possible. */
export function initChromecast(): Promise<boolean> {
  if (loadPromise) return loadPromise;
  const ok = castSupported({ secure: window.isSecureContext, ua: navigator.userAgent, hasChrome: typeof window.chrome === 'object' });
  if (!ok) {
    useChromecast.setState({ sdk: 'unavailable' });
    return (loadPromise = Promise.resolve(false));
  }
  useChromecast.setState({ sdk: 'loading' });
  loadPromise = loadScript().then((available) => {
    if (!available || !window.cast?.framework) {
      useChromecast.setState({ sdk: 'unavailable' });
      return false;
    }
    try {
      setup();
    } catch {
      useChromecast.setState({ sdk: 'unavailable' });
      return false;
    }
    useChromecast.setState({ sdk: 'ready' });
    return true;
  });
  return loadPromise;
}

/** Opens Chrome's device picker. Resolves true once connected, false when the picker was closed. */
export async function requestChromecast(): Promise<boolean> {
  if (!(await initChromecast())) return false;
  try {
    const err = await window.cast.framework.CastContext.getInstance().requestSession();
    return !err;
  } catch {
    return false;
  }
}

/** Disconnects from the TV (and stops what it plays). */
export function endChromecast(): void {
  try {
    window.cast?.framework.CastContext.getInstance().endCurrentSession(true);
  } catch {
    /* already gone */
  }
}

export async function castLoad(m: CastMedia): Promise<void> {
  const { cast, chrome } = window;
  const session = cast?.framework.CastContext.getInstance().getCurrentSession();
  if (!session) throw new Error('Not connected to a TV');
  const media = chrome.cast.media;
  const info = new media.MediaInfo(m.url, m.contentType);
  info.streamType = m.live ? media.StreamType.LIVE : media.StreamType.BUFFERED;
  if (m.segments === 'fmp4') {
    info.hlsSegmentFormat = media.HlsSegmentFormat.FMP4;
    info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.FMP4;
  } else if (m.segments === 'ts') {
    info.hlsSegmentFormat = media.HlsSegmentFormat.TS;
    info.hlsVideoSegmentFormat = media.HlsVideoSegmentFormat.MPEG2_TS;
  }
  const meta = new media.GenericMediaMetadata();
  meta.title = m.title;
  if (m.subtitle) meta.subtitle = m.subtitle;
  if (m.image) meta.images = [new chrome.cast.Image(m.image)];
  info.metadata = meta;
  const req = new media.LoadRequest(info);
  req.autoplay = true;
  if (m.startTime > 0) req.currentTime = m.startTime;
  useChromecast.setState((s) => ({ loaded: true, idleReason: null, playerState: 'BUFFERING', time: m.startTime, loadSeq: s.loadSeq + 1 }));
  const err = await session.loadMedia(req);
  if (err) throw new Error(String(err));
}

export function castPlayPause(): void {
  controller?.playOrPause();
}

export function castPlay(): void {
  if (player?.isPaused) controller?.playOrPause();
}

export function castPause(): void {
  if (player && !player.isPaused) controller?.playOrPause();
}

export function castSeek(seconds: number): void {
  if (!player || !controller) return;
  player.currentTime = Math.max(0, seconds);
  controller.seek();
  useChromecast.setState({ time: Math.max(0, seconds) });
}

/** Stops what the TV plays but stays connected (another device took the connection over). */
export function castStopMedia(): void {
  try {
    controller?.stop();
  } catch {
    /* nothing loaded */
  }
  useChromecast.setState({ loaded: false });
}
