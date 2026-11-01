/**
 * Playback engine wrapper. Picks by PlaybackInfo.type:
 *   'hls'    -> hls.js (MSE), or native HLS on Safari/iOS (no MSE or Apple WebKit)
 *   'mpegts' -> mpegts.js (MSE)
 *   'file'   -> native <video src>
 * hls.js and mpegts.js are dynamic imports, so they are separate chunks loaded only when needed.
 */
import type { PlaybackInfo, Preferences } from '@anycast/shared';

export interface Track {
  id: number;
  label: string;
  lang: string | null;
  active: boolean;
}

export type EngineKind = 'hls.js' | 'native-hls' | 'mpegts' | 'native';

export interface Engine {
  kind: EngineKind;
  audioTracks(): Track[];
  setAudioTrack(id: number): void;
  textTracks(): Track[];
  setTextTrack(id: number | null): void;
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

export function isAppleWebKit(ua = navigator.userAgent) {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android|Edg\//.test(ua);
}

export function chooseEngine(type: PlaybackInfo['type'], env: { mse: boolean; nativeHls: boolean; appleWebKit: boolean }): EngineKind {
  if (type === 'file') return 'native';
  if (type === 'hls') return env.nativeHls && (env.appleWebKit || !env.mse) ? 'native-hls' : env.mse ? 'hls.js' : 'native-hls';
  return env.mse ? 'mpegts' : 'native';
}

type Listener = () => void;

/* ---------- native element tracks (Safari exposes audioTracks; textTracks everywhere) ---------- */
interface NativeAudioTrack {
  id: string;
  label: string;
  language: string;
  enabled: boolean;
}
function nativeAudio(video: HTMLVideoElement): NativeAudioTrack[] {
  const list = (video as unknown as { audioTracks?: ArrayLike<NativeAudioTrack> }).audioTracks;
  return list ? Array.from(list) : [];
}
function nativeText(video: HTMLVideoElement): TextTrack[] {
  return Array.from(video.textTracks).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
}
const nativeTracks = (video: HTMLVideoElement) => ({
  audioTracks: () => nativeAudio(video).map((t, i) => ({ id: i, label: t.label || t.language || `Track ${i + 1}`, lang: t.language || null, active: t.enabled })),
  setAudioTrack: (id: number) => nativeAudio(video).forEach((t, i) => (t.enabled = i === id)),
  textTracks: () => nativeText(video).map((t, i) => ({ id: i, label: t.label || t.language || `Subtitles ${i + 1}`, lang: t.language || null, active: t.mode === 'showing' })),
  setTextTrack: (id: number | null) => nativeText(video).forEach((t, i) => (t.mode = i === id ? 'showing' : 'disabled')),
});

export async function createEngine(
  video: HTMLVideoElement,
  info: PlaybackInfo,
  hooks: { live: boolean; onFatal: (e: PlaybackFailure) => void; onTracks: Listener },
): Promise<Engine> {
  const mse = typeof window !== 'undefined' && ('MediaSource' in window || 'ManagedMediaSource' in window);
  const kind = chooseEngine(info.type, { mse, nativeHls: video.canPlayType('application/vnd.apple.mpegurl') !== '', appleWebKit: isAppleWebKit() });

  if (kind === 'hls.js') {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) throw new PlaybackFailure('unsupported', "This browser can't play HLS streams.");
    const hls = new Hls({ enableWorker: true, backBufferLength: 120, maxBufferLength: 30, liveDurationInfinity: false, // Retry fragments on 409 too (the server restarted ffmpeg after a seek elsewhere), not just 5xx/timeouts.
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
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      const status = (d.response as { code?: number } | undefined)?.code;
      if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // 409: a seek elsewhere restarted the server's ffmpeg for this VOD; 5xx: transient. Retry those.
        if (netRetries++ < 3 && (!status || status >= 500 || status === 409)) return void setTimeout(() => hls.startLoad(), 1000 * netRetries);
        hooks.onFatal(new PlaybackFailure(status && status < 600 ? 'server' : 'network', d.details, status));
      } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        if (mediaRetries === 0) return void (mediaRetries++, hls.recoverMediaError());
        if (mediaRetries === 1) return void (mediaRetries++, hls.swapAudioCodec(), hls.recoverMediaError());
        hooks.onFatal(new PlaybackFailure('decode', d.details));
      } else {
        hooks.onFatal(new PlaybackFailure('unsupported', d.details));
      }
    });
    for (const ev of [Hls.Events.MANIFEST_PARSED, Hls.Events.AUDIO_TRACKS_UPDATED, Hls.Events.SUBTITLE_TRACKS_UPDATED, Hls.Events.AUDIO_TRACK_SWITCHED, Hls.Events.SUBTITLE_TRACK_SWITCH]) {
      hls.on(ev, hooks.onTracks);
    }
    hls.loadSource(info.url);
    hls.attachMedia(video);
    return {
      kind,
      audioTracks: () => hls.audioTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Track ${i + 1}`, lang: t.lang ?? null, active: i === hls.audioTrack })),
      setAudioTrack: (id) => (hls.audioTrack = id),
      textTracks: () => hls.subtitleTracks.map((t, i) => ({ id: i, label: t.name || t.lang || `Subtitles ${i + 1}`, lang: t.lang ?? null, active: i === hls.subtitleTrack })),
      setTextTrack: (id) => {
        hls.subtitleDisplay = id !== null;
        hls.subtitleTrack = id ?? -1;
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
      { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false },
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

/** Apply audio/subtitle preferences to the available tracks. */
export function applyTrackPrefs(engine: Engine, prefs: Preferences['player']) {
  const audio = engine.audioTracks();
  if (prefs.preferredAudioLanguage && audio.length > 1) {
    const m = audio.find((t) => t.lang?.toLowerCase().startsWith(prefs.preferredAudioLanguage!));
    if (m && !m.active) engine.setAudioTrack(m.id);
  }
  const text = engine.textTracks();
  if (!text.length) return;
  if (prefs.subtitlesDefault === 'off') return engine.setTextTrack(null);
  const want = prefs.preferredSubtitleLanguage;
  const match = want ? text.find((t) => t.lang?.toLowerCase().startsWith(want)) : undefined;
  if (prefs.subtitlesDefault === 'on') return engine.setTextTrack((match ?? text[0])!.id);
  // auto: subtitles only when a preferred subtitle language is set and the audio isn't already in it
  const activeAudio = engine.audioTracks().find((t) => t.active);
  if (match && !activeAudio?.lang?.toLowerCase().startsWith(want!)) engine.setTextTrack(match.id);
}
