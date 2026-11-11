/**
 * Playback engine wrapper. Picks by PlaybackInfo.type:
 *   'hls'    -> hls.js (MSE), or native HLS on Safari/iOS (no MSE or Apple WebKit)
 *   'mpegts' -> mpegts.js (MSE)
 *   'file'   -> native <video src>
 * hls.js and mpegts.js are dynamic imports, so they are separate chunks loaded only when needed.
 */
import type { PlaybackInfo } from '@anycast/shared';
import type { LoadStep } from './loadStatus';

export type EngineKind = 'hls.js' | 'native-hls' | 'mpegts' | 'native';

/**
 * Audio tracks are chosen on the server (PB-3: the stream plays one), so the engine only switches
 * between the subtitle renditions the stream carries.
 */
export interface Engine {
  kind: EngineKind;
  /** subtitle renditions the stream offers so far (they appear once the master playlist is read) */
  subtitleCount(): number;
  /** shows rendition `pos` (in the stream's order), or none */
  setSubtitle(pos: number | null): void;
  /** Wall-clock time of the playhead if the stream carries it (HLS program date time). */
  positionDate(): number | null;
  /** Media time of the live edge if known. */
  liveEdge(): number | null;
  destroy(): void;
}

export type FailKind = 'network' | 'decode' | 'unsupported' | 'server';
export class PlaybackFailure extends Error {
  constructor(
    public kind: FailKind,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * Why a stream file failed, in words: the server's own reason (the JSON body of an AnyCast error),
 * or, when the answer did not come from AnyCast (an HTML page from a reverse proxy, say), that the
 * proxy in front of it could not reach it. Null when the file cannot be fetched again.
 */
export async function failureReason(url: string, status: number, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(url, { credentials: 'include' });
    if (res.ok) return null;
    if ((res.headers.get('content-type') ?? '').includes('application/json')) {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === 'string' && body.message) return body.message;
    }
    if (status === 502 || status === 504) return 'The reverse proxy in front of AnyCast could not reach the server. Check that the AnyCast container is running.';
    return null;
  } catch {
    return null;
  }
}

export function isAppleWebKit(ua = navigator.userAgent) {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
}

export function chooseEngine(type: PlaybackInfo['type'], env: { mse: boolean; nativeHls: boolean; appleWebKit: boolean }): EngineKind {
  if (type === 'file') return 'native';
  if (type === 'hls') return env.nativeHls && (env.appleWebKit || !env.mse) ? 'native-hls' : env.mse ? 'hls.js' : 'native-hls';
  return env.mse ? 'mpegts' : 'native';
}

type Listener = () => void;

/** Seconds of live stream kept ahead of the playhead unless the user picked another Live buffer. */
export const DEFAULT_LIVE_BUFFER = 4;

/**
 * mpegts.js on a live channel. Its latency chasing (on before) jumps the playhead forward whenever
 * more than 1.5 s is buffered: every jump drops frames, and the buffer never grows past that, so
 * any hiccup from the provider stalls the picture. Instead the buffer is filled up to the Live
 * buffer before playback starts (see liveBuffer.ts), and latency that grew past it (after a
 * stall) is caught up by playing a little faster, without skipping.
 */
export function mpegtsLiveConfig(buffer: number) {
  return {
    liveBufferLatencyChasing: false,
    liveSync: true,
    liveSyncTargetLatency: buffer + 1,
    liveSyncMaxLatency: buffer * 2 + 4,
    liveSyncPlaybackRate: 1.1,
  };
}

/**
 * hls.js: how far behind the live edge to start (more room for a slow segment) and how much to
 * buffer. The server's live playlist holds 8 segments of 4 s, so the start point stays inside it.
 */
export function hlsLiveConfig(buffer: number) {
  return {
    liveSyncDuration: Math.min(24, Math.max(12, buffer + 8)),
    liveMaxLatencyDuration: Math.min(30, Math.max(20, buffer + 16)),
    maxBufferLength: Math.max(30, buffer * 2),
  };
}

/**
 * hls.js on a movie or episode: keep a minute ahead (hls.js stops at 30 s by default), so a slow
 * stretch of Wi-Fi or mobile data, or a server converting the video, doesn't reach the playhead.
 * maxBufferSize still caps the memory it takes (60 MB, about a minute at 8 Mbit/s), and only 30 s
 * behind the playhead is kept (a phone has little memory for media; seeking back loads it again).
 */
export const HLS_VOD_CONFIG = { maxBufferLength: 60, maxBufferSize: 60 * 1000 * 1000 };

/* ---------- native element text tracks (native HLS: the master playlist's subtitle renditions) ---------- */
function nativeText(video: HTMLVideoElement): TextTrack[] {
  return Array.from(video.textTracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
}
const nativeTracks = (video: HTMLVideoElement) => ({
  subtitleCount: () => nativeText(video).length,
  setSubtitle: (pos: number | null) => nativeText(video).forEach((t, i) => (t.mode = i === pos ? 'showing' : 'disabled')),
});

export async function createEngine(
  video: HTMLVideoElement,
  info: PlaybackInfo,
  hooks: {
    live: boolean;
    /** seconds of live stream the player keeps ahead of the playhead (Settings › Player › Live buffer) */
    liveBuffer?: number;
    onFatal: (e: PlaybackFailure) => void;
    onTracks: Listener;
    /** what a start is waiting on (hls.js only): the first data, or a retry after an error */
    onStep?: (s: LoadStep) => void;
  },
): Promise<Engine> {
  const buffer = hooks.liveBuffer ?? DEFAULT_LIVE_BUFFER;
  const mse = typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window);
  const kind = chooseEngine(info.type, { mse, nativeHls: video.canPlayType('application/vnd.apple.mpegurl') !== '', appleWebKit: isAppleWebKit() });

  if (kind === 'hls.js') {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) throw new PlaybackFailure('unsupported', "This browser can't play HLS streams.");
    const hls = new Hls({ enableWorker: true, backBufferLength: hooks.live ? 120 : 30, ...(hooks.live ? hlsLiveConfig(buffer) : HLS_VOD_CONFIG), liveDurationInfinity: false, // Retry fragments on 409 too (the server restarted ffmpeg after a seek elsewhere), not just 5xx/timeouts.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: {
            maxNumRetry: 6,
            retryDelayMs: 500,
            maxRetryDelayMs: 4000,
            shouldRetry: (cfg, count, _timeout, res, retry) => {
              if (!cfg || count >= cfg.maxNumRetry) return false;
              const code = res?.code ?? 0;
              return retry || code === 0 || code === 409 || code === 408 || code === 429 || code >= 500;
            },
          },
        },
      },
      xhrSetup: (xhr) => {
        xhr.withCredentials = true;
      } });
    let netRetries = 0;
    let mediaRetries = 0;
    let attempts = 0;
    hls.on(Hls.Events.FRAG_LOADED, () => hooks.onStep?.({ stage: 'buffering' }));
    hls.on(Hls.Events.ERROR, (_e, d) => {
      const status = (d.response as { code?: number } | undefined)?.code;
      if (!d.fatal) {
        // hls.js retries this file itself: say so, with the server's answer
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hooks.onStep?.({ stage: 'retrying', attempt: ++attempts, ...(status ? { status } : {}) });
        return;
      }
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // 409: a seek elsewhere restarted the server's ffmpeg for this VOD; 5xx: transient. Retry those.
        if (netRetries++ < 3 && (!status || status >= 500 || status === 409)) {
          hooks.onStep?.({ stage: 'retrying', attempt: ++attempts, ...(status ? { status } : {}) });
          return void setTimeout(() => hls.startLoad(), 1000 * netRetries);
        }
        const url = d.frag?.url ?? d.context?.url ?? d.url;
        if (status && status >= 500 && status < 600 && url) {
          // hls.js only knows the status: ask once more for the server's reason, so the error says what went wrong
          return void failureReason(url, status).then((why) => hooks.onFatal(new PlaybackFailure('server', why ?? d.details, status)));
        }
        hooks.onFatal(new PlaybackFailure(status && status < 600 ? 'server' : 'network', d.details, status));
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (mediaRetries === 0) return void (mediaRetries++, hls.recoverMediaError());
        if (mediaRetries === 1) return void (mediaRetries++, hls.swapAudioCodec(), hls.recoverMediaError());
        hooks.onFatal(new PlaybackFailure('decode', d.details));
      } else {
        hooks.onFatal(new PlaybackFailure('unsupported', d.details));
      }
    });
    for (const ev of [Hls.Events.MANIFEST_PARSED, Hls.Events.SUBTITLE_TRACKS_UPDATED]) {
      hls.on(ev, hooks.onTracks);
    }
    hls.loadSource(info.url);
    hls.attachMedia(video);
    return {
      kind,
      subtitleCount: () => hls.subtitleTracks.length,
      setSubtitle: (pos) => {
        if (pos === (hls.subtitleTrack < 0 ? null : hls.subtitleTrack) && hls.subtitleDisplay === (pos !== null)) return;
        hls.subtitleDisplay = pos !== null;
        hls.subtitleTrack = pos ?? -1;
      },
      positionDate: () => hls.playingDate?.getTime() ?? null,
      liveEdge: () => hls.liveSyncPosition ?? null,
      destroy: () => hls.destroy(),
    };
  }

  if (kind === 'mpegts') {
    const mpegts = (await import('mpegts.js')).default;
    if (!mpegts.isSupported()) throw new PlaybackFailure('unsupported', "This browser can't play MPEG-TS streams.");
    const player = mpegts.createPlayer(
      { type: 'mpegts', isLive: hooks.live, url: new URL(info.url, location.href).href, withCredentials: true },
      { enableWorker: true, lazyLoad: false, ...mpegtsLiveConfig(buffer) },
    );
    player.on(mpegts.Events.ERROR, (type: string, detail: string, data?: { code?: number; msg?: string }) => {
      const status = data?.code && data.code > 0 ? data.code : undefined;
      if (type === mpegts.ErrorTypes.NETWORK_ERROR) hooks.onFatal(new PlaybackFailure(status ? 'server' : 'network', data?.msg ?? detail, status));
      else if (type === mpegts.ErrorTypes.MEDIA_ERROR) hooks.onFatal(new PlaybackFailure('decode', data?.msg ?? detail));
      else hooks.onFatal(new PlaybackFailure('unsupported', detail));
    });
    player.attachMediaElement(video);
    player.load();
    const nt = nativeTracks(video);
    return {
      kind,
      ...nt,
      positionDate: () => null,
      liveEdge: () => (video.buffered.length ? video.buffered.end(video.buffered.length - 1) : null),
      destroy: () => {
        try {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        } catch {
          /* already gone */
        }
      },
    };
  }

  // native (file or native HLS)
  video.src = info.url;
  video.load();
  const nt = nativeTracks(video);
  const onChange = () => hooks.onTracks();
  video.textTracks.addEventListener('addtrack', onChange);
  const at = (video as unknown as { audioTracks?: EventTarget }).audioTracks;
  at?.addEventListener('addtrack', onChange);
  return {
    kind,
    ...nt,
    positionDate: () => {
      const d = (video as unknown as { getStartDate?: () => Date }).getStartDate?.();
      return d && !Number.isNaN(d.getTime()) ? d.getTime() + video.currentTime * 1000 : null;
    },
    liveEdge: () => (video.seekable.length ? video.seekable.end(video.seekable.length - 1) : null),
    destroy: () => {
      video.textTracks.removeEventListener('addtrack', onChange);
      at?.removeEventListener('addtrack', onChange);
      video.removeAttribute('src');
      video.load();
    },
  };
}
