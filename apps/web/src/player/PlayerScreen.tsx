/**
 * Player for live channels (with the timeline ribbon), movies and episodes.
 * Route: /play/:kind/:id  (kind = live | movie | episode)  ?at=<epoch ms> (live)  ?series=<id> (episode)  ?start=0 (ignore resume)
 * PlayerHost renders it for that route and keeps it mounted as the mini player after leaving it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Episode, PlaybackInfo, TimelineInfo, TrackChoice } from '@anycast/shared';
import { useApp, useIsFavorite } from '../store/app';
import { saveProgress, saveProgressOnUnload, setZapList, toggleFavorite, type ProgressBody } from '../store/actions';
import { cachedGet, call } from '../api/client';
import { lookup, resolveItems } from '../api/catalog';
import { setBufferPin, useBufferPins } from '../api/buffer';
import { useAsync, useFormFactor } from '../lib/hooks';
import { writeLocal } from '../lib/storage';
import { isTypingTarget } from '../lib/misc';
import { fmtBehind, fmtClock, fmtDay, fmtDuration, fmtRange } from '../lib/time';
import { parseMediaTime, parseTimeInput } from '../lib/timeParse';
import { createEngine, PlaybackFailure, type Engine } from './engine';
import { fromApiError, fromPlaybackFailure, type PlayerErr } from './errors';
import { absolutePosition, computeWindow, mediaTimeFor, programAt, resolveSeek, type Win } from './timelineMath';
import { Ribbon, VodBar } from './Timeline';
import { useThumbIndex } from './thumbs';
import { hasTrackChoice, playingTracks, reloadTracks as keepTracks, renditionOf, subtitleAction, type TrackRequest } from './tracks';
import { TracksMenu } from './TracksMenu';
import { IconBack, IconClose, IconExpand, IconFullscreen, IconListAdd, IconPause, IconPlay, IconStar, IconTracks, IconClock } from '../components/Icons';
import { openAddToList } from '../store/lists';
import { Skeleton } from '../components/ui';
import { useMediaSession } from './mediaSession';
import { PipButton, usePictureInPicture } from './PipButton';
import { StatsButton, StatsOverlay, useStatsToggle } from './stats/Stats';
import '../theme/player.css';

/** Within this of the live edge counts as live. */
const LIVE_SLACK_MS = 6_000;

/** How a stream is (re)loaded: VOD from the start or a position, with other tracks (PB-3). */
interface LoadOpts {
  fromStart?: boolean;
  /** VOD: media time to continue from (a track switch) */
  position?: number;
  audio?: number;
  sub?: number | 'off';
}

interface Stream {
  info: PlaybackInfo;
  /** true when this is the plain live stream (not a timeshift from ?at) */
  liveEdge: boolean;
  /** media time to jump to once metadata is known */
  seekTo?: number;
  /** the load that got it */
  seq: number;
}

export interface PlayerProps {
  kind: 'live' | 'movie' | 'episode';
  id: string;
  /** the route's query string */
  search: string;
  /** shrunk into the corner while the viewer browses */
  mini: boolean;
  /** plays another item (zapping, next episode): replaces the route, or just the mini player's item */
  go: (path: string) => void;
  /** mini player: back to the full player */
  expand: () => void;
  /** mini player: stop and close */
  close: () => void;
}

export default function PlayerScreen({ kind, id, search, mini, go, expand, close }: PlayerProps) {
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const navigate = useNavigate();
  const form = useFormFactor();
  const prefs = useApp((s) => s.prefs.player);
  const zapList = useApp((s) => s.zapList);
  const isLive = kind === 'live';
  const vodKind = kind === 'episode' ? 'episode' : 'movie';

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const streamRef = useRef<Stream | null>(null);
  const loadSeq = useRef(0);
  const endedAt = useRef<number[]>([]);
  const [info, setInfo] = useState<PlaybackInfo | null>(null);
  // episodes: the link may carry ?series=, otherwise the server says (PlaybackInfo.seriesId)
  const seriesId = sp.get('series') ?? info?.seriesId ?? undefined;
  const [error, setError] = useState<PlayerErr | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [slow, setSlow] = useState(false);
  const [paused, setPaused] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  // scrub thumbnails (movies and episodes); a skip shows the preview where it landed
  const thumbs = useThumbIndex(vodKind, id, !isLive, !paused);
  const [seekHint, setSeekHint] = useState<{ t: number; key: number } | null>(null);
  const [, setTick] = useState(0);
  const [tracksVer, setTracksVer] = useState(0);
  /** subtitle track shown (source index), null = off (PB-3) */
  const [subIdx, setSubIdx] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<TimelineInfo | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [menu, setMenu] = useState<null | 'tracks' | 'jump'>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ripple, setRipple] = useState<{ side: 'l' | 'r'; text: string; key: number } | null>(null);
  const dragging = useRef(false);
  const overlay = !mini && (form === 'tv' || fullscreen);
  const isAdmin = useApp((s) => s.me?.user.isAdmin ?? false);
  const bufPins = useBufferPins(isLive && isAdmin);
  const pinned = !!bufPins.pins?.channelIds.includes(id);
  const [pinMsg, setPinMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  useEffect(() => setPinMsg(null), [id]);
  /** another device took this tab's provider connection over */
  const [moved, setMoved] = useState<{ profileName: string; device?: string } | null>(null);
  const movedRef = useRef(false);
  movedRef.current = !!moved;
  const stopped = useApp((s) => s.playbackStopped);
  const loadStarted = useRef(0);
  /** the live position (epoch ms) as of the last render */
  const positionRef = useRef(0);
  const lastLoad = useRef<{ at: number | null; opts: LoadOpts; seq: number }>({ at: null, opts: {}, seq: 0 });
  /** the tracks playing now (for which item), so every reload asks for them again (PB-3) */
  const playing = useRef<{ item: string; tracks: TrackRequest }>({ item: '', tracks: {} });
  const pip = usePictureInPicture(videoRef);
  const { supported: pipSupported, toggle: togglePip } = pip;
  const progressBodyRef = useRef<() => ProgressBody | null>(() => null);
  const stats = useStatsToggle();

  /* ---------------- metadata ---------------- */
  const channel = useAsync(
    async (signal) => (isLive ? (lookup('live', id) ?? (await resolveItems('live', [id], { signal }))[0] ?? null) : null),
    [isLive, id],
  );
  const movie = useAsync(async (signal) => (kind === 'movie' ? (lookup('movie', id) ?? (await resolveItems('movie', [id], { signal }))[0] ?? null) : null), [kind, id]);
  const series = useAsync(() => (kind === 'episode' && seriesId ? cachedGet('GET /api/series/:id', { params: { id: seriesId } }, 300_000) : Promise.resolve(null)), [kind, seriesId]);
  const episodes = useMemo(() => series.data?.seasons.flatMap((s) => s.episodes) ?? [], [series.data]);
  const epIdx = episodes.findIndex((e) => e.id === id);
  const episode: Episode | undefined = episodes[epIdx];
  const nextEpisode: Episode | undefined = epIdx >= 0 ? episodes[epIdx + 1] : undefined;
  const fav = useIsFavorite(isLive ? 'live' : kind === 'episode' ? 'series' : 'movie', isLive ? id : kind === 'episode' ? (seriesId ?? '') : id);

  /* ---------------- timeline (live) ---------------- */
  const refreshTimeline = useCallback(() => {
    if (!isLive) return;
    const t0 = Date.now();
    call('GET /api/timeline/:channelId', { params: { channelId: id } }).then(
      (tl) => {
        setTimeline(tl);
        setClockOffset(tl.now - (t0 + Date.now()) / 2);
      },
      () => setNotice("Couldn't load the timeline for this channel. Live playback still works."),
    );
  }, [isLive, id]);
  useEffect(() => {
    setTimeline(null);
    refreshTimeline();
    const t = setInterval(refreshTimeline, 60_000);
    return () => clearInterval(t);
  }, [refreshTimeline]);

  /* ---------------- loading streams ---------------- */
  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play().then(
      () => setNeedsTap(false),
      (e: DOMException) => {
        if (e.name === 'NotAllowedError') setNeedsTap(true);
      },
    );
  }, []);

  const onFatal = useCallback(
    (f: PlaybackFailure) => {
      if (movedRef.current) return;
      setError(fromPlaybackFailure(f, streamRef.current?.info.pipeline, isLive));
      setWaiting(false);
    },
    [isLive],
  );

  const load = useCallback(
    async (at: number | null, opts: LoadOpts = {}) => {
      const seq = ++loadSeq.current;
      lastLoad.current = { at, opts, seq };
      loadStarted.current = Date.now();
      setMoved(null);
      if (useApp.getState().playbackStopped) useApp.setState({ playbackStopped: null });
      setError(null);
      setWaiting(true);
      setCountdown(null);
      engineRef.current?.destroy();
      engineRef.current = null;
      let pi: PlaybackInfo;
      // retry, resume, go live, a seek into the archive or buffer: the same audio and subtitles
      const item = `${kind}:${id}`;
      const { audio, sub } = keepTracks(opts, playing.current.item === item ? playing.current.tracks : {});
      try {
        pi = isLive
          ? at !== null
            ? await call('GET /api/play/live/:id/at', { params: { id }, query: { at: Math.round(at), audio } })
            : await call('GET /api/play/live/:id', { params: { id }, query: { audio } })
          : await call(kind === 'episode' ? 'GET /api/play/episode/:id' : 'GET /api/play/movie/:id', { params: { id }, query: { audio, sub } });
      } catch (e) {
        if (seq !== loadSeq.current) return;
        setError(fromApiError(e, { live: isLive, timeshift: at !== null }));
        setWaiting(false);
        return;
      }
      if (seq !== loadSeq.current) return;
      const seekTo = isLive
        ? at !== null && pi.startsAt !== undefined && at - pi.startsAt > 1000
          ? (at - pi.startsAt) / 1000
          : undefined
        : opts.position !== undefined
          ? opts.position
          : opts.fromStart
            ? 0
            : pi.resumeAt;
      streamRef.current = { info: pi, liveEdge: at === null, seekTo, seq };
      setInfo(pi);
      setSubIdx(pi.tracks?.subtitleIndex ?? null);
      playing.current = { item, tracks: playingTracks(pi.tracks, pi.tracks?.subtitleIndex ?? null) };
      const video = videoRef.current!;
      try {
        const engine = await createEngine(video, pi, { live: isLive, onFatal, onTracks: () => setTracksVer((x) => x + 1) });
        if (seq !== loadSeq.current) return engine.destroy();
        engineRef.current = engine;
      } catch (e) {
        if (seq !== loadSeq.current) return;
        onFatal(e instanceof PlaybackFailure ? e : new PlaybackFailure('unsupported', String((e as Error).message ?? e)));
        return;
      }
      play();
    },
    [isLive, id, kind, onFatal, play],
  );

  useEffect(() => {
    const atParam = sp.get('at');
    void load(atParam ? Number(atParam) : null, { fromStart: sp.get('start') === '0' });
    if (isLive) writeLocal('anycast.lastChannel', id);
    return () => {
      loadSeq.current++;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  /**
   * Try again / Resume: the stream again from where it got to (live: the same time behind live),
   * or, when the last request never got a stream (a seek into the archive failed, say), that request again.
   */
  const reload = useCallback(() => {
    const s = streamRef.current;
    if (!s || s.seq !== lastLoad.current.seq) return void load(lastLoad.current.at, lastLoad.current.opts);
    void load(isLive && !s.liveEdge ? positionRef.current : null);
  }, [isLive, load]);

  /* ---------------- one connection: taken over, take over, release ---------------- */
  useEffect(() => {
    if (!stopped || stopped.at < loadStarted.current) return;
    const b = progressBodyRef.current();
    if (b && b.position > 1) void saveProgress(b);
    loadSeq.current++;
    engineRef.current?.destroy();
    engineRef.current = null;
    setMoved(stopped.by);
    setError(null);
    setWaiting(false);
    setCountdown(null);
  }, [stopped]);

  const takeOver = useCallback(async () => {
    setError(null);
    setWaiting(true);
    try {
      await call('POST /api/play/takeover');
    } catch {
      /* the next load says what is wrong */
    }
    void load(lastLoad.current.at, lastLoad.current.opts);
  }, [load]);

  // Closing the player releases this tab's provider connection right away (with one connection,
  // another device can start at once). Zapping needs no call: the next play request does it.
  useEffect(() => {
    const stop = () => {
      try {
        void call('POST /api/play/stop', { keepalive: true }).catch(() => undefined);
      } catch {
        /* unloading */
      }
    };
    window.addEventListener('pagehide', stop);
    return () => {
      window.removeEventListener('pagehide', stop);
      stop();
    };
  }, []);

  /* ---------------- position maths ---------------- */
  const video = videoRef.current;
  const now = Date.now() + clockOffset;
  const ct = video?.currentTime ?? 0;
  const seekEnd = video && video.seekable.length ? video.seekable.end(video.seekable.length - 1) : video?.duration && Number.isFinite(video.duration) ? video.duration : 0;
  const startsAt = info?.startsAt;
  const position = isLive ? (engineRef.current?.positionDate() ?? (info ? absolutePosition(startsAt, ct, seekEnd, now) : now)) : ct;
  positionRef.current = position;
  // Streams play a little behind real time (HLS latency). Measure that once at the live edge and
  // report "behind live" relative to it, so a 10 s skip back shows as 0:10, not 0:28.
  const rawBehind = isLive ? Math.max(0, now - position) : 0;
  const edge = useRef({ seq: -1, offset: 0 });
  useEffect(() => {
    if (!isLive || waiting || !streamRef.current?.liveEdge || edge.current.seq === loadSeq.current) return;
    edge.current = { seq: loadSeq.current, offset: Math.min(60_000, rawBehind) };
  });
  const behind = Math.max(0, rawBehind - edge.current.offset);
  const atLive = isLive && behind < LIVE_SLACK_MS;
  const span = (form === 'phone' ? 3 : 4) * 3_600_000;
  const winRef = useRef<Win | null>(null);
  if (!dragging.current || !winRef.current) winRef.current = computeWindow(now, position, span);
  const win = winRef.current;
  const program = isLive && timeline ? programAt(position, timeline.programs) : null;
  const duration = !isLive && video && Number.isFinite(video.duration) ? video.duration : (movie.data?.duration ?? episode?.duration ?? 0);
  const buffered = video && video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;

  // 1 s clock so "behind live" and the live edge keep moving even while paused
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  /* ---------------- seeking ---------------- */
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 6000);
  }, []);

  const goLive = useCallback(() => {
    const v = videoRef.current;
    const s = streamRef.current;
    if (s?.liveEdge && v && engineRef.current && s.info.startsAt === undefined) {
      const edge = engineRef.current.liveEdge();
      if (edge !== null) {
        v.currentTime = Math.max(0, edge - 2);
        play();
        return;
      }
    }
    void load(null);
  }, [load, play]);

  const seekAbs = useCallback(
    (t: number) => {
      const v = videoRef.current;
      const s = streamRef.current;
      const nowS = Date.now() + clockOffset;
      if (t >= nowS - 5_000) return goLive();
      if (v && s) {
        const se = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : v.duration;
        const ss = v.seekable.length ? v.seekable.start(0) : 0;
        const mt = Number.isFinite(se) ? mediaTimeFor(t, s.info.startsAt, ss, se, nowS) : null;
        if (mt !== null) {
          v.currentTime = mt;
          play();
          return;
        }
      }
      const r = resolveSeek(t, timeline ?? { ranges: [], gaps: [] }, nowS);
      if (r.reason) flash(`${fmtClock(t)} isn't available: ${r.reason}. ${r.live ? 'Showing live.' : `Jumped to ${fmtClock(r.at)}.`}`);
      if (r.live) return goLive();
      void load(r.at);
    },
    [clockOffset, timeline, goLive, load, play, flash],
  );

  const skip = useCallback(
    (dir: -1 | 1, seconds?: number) => {
      const secs = seconds ?? (dir < 0 ? prefs.skipBackSeconds : prefs.skipForwardSeconds);
      const v = videoRef.current;
      if (!v) return;
      if (isLive) seekAbs(position + dir * secs * 1000);
      else {
        v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + dir * secs));
        setSeekHint({ t: v.currentTime, key: Date.now() });
      }
    },
    [isLive, position, prefs.skipBackSeconds, prefs.skipForwardSeconds, seekAbs],
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) play();
    else v.pause();
  }, [play]);

  /* ---------------- channel zapping ---------------- */
  const zap = useCallback(
    async (dir: -1 | 1) => {
      if (!isLive) return;
      let list = zapList;
      if (!list.length) {
        const res = await cachedGet('GET /api/live', { query: { offset: 0, limit: 500 } });
        list = res.items.map((c) => c.id);
        setZapList(list);
      }
      if (!list.length) return;
      const i = list.indexOf(id);
      const next = list[(i + dir + list.length) % list.length]!;
      go(`/play/live/${next}`);
    },
    [isLive, zapList, id, go],
  );

  /* ---------------- fullscreen & chrome ---------------- */
  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    const v = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el?.requestFullscreen) void el.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    else v?.webkitEnterFullscreen?.();
  }, []);

  const hideTimer = useRef<number>();
  const activity = useCallback(() => {
    setChrome(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !dragging.current) setChrome(false);
    }, 4000);
  }, []);
  useEffect(() => {
    if (!overlay) setChrome(true);
    else activity();
  }, [overlay, activity]);
  useEffect(() => {
    if (menu) setChrome(true);
  }, [menu]);

  /* ---------------- keyboard ---------------- */
  const back = useCallback(() => {
    if ((history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate(isLive ? '/live' : kind === 'episode' && seriesId ? `/series/${seriesId}` : '/movies');
  }, [navigate, isLive, kind, seriesId]);

  useEffect(() => {
    // the mini player leaves the keyboard to the screen behind it
    if (mini) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (isTypingTarget(t) || t?.closest('[data-player-keys="off"]')) {
        if (e.key === 'Escape') {
          setMenu(null);
          e.preventDefault();
        }
        return;
      }
      const wasHidden = overlay && !chrome;
      activity();
      const onButton = !!t && t !== document.body && t.tagName !== 'VIDEO' && t.getAttribute('role') !== 'slider';
      const k = e.key;
      const arrows = k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown';
      // TV: with the controls showing and focus on a button, arrows move focus (spatial nav).
      if (form === 'tv' && arrows && !wasHidden && onButton) return;
      if (form === 'tv' && (k === 'ArrowUp' || k === 'ArrowDown') && !wasHidden) return;
      const handled = () => (e.preventDefault(), e.stopImmediatePropagation());
      switch (k) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          if (k === ' ' && onButton && form === 'tv') return;
          handled();
          togglePlay();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          handled();
          skip(-1);
          setRipple({ side: 'l', text: `−${prefs.skipBackSeconds} s`, key: Date.now() });
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          handled();
          skip(1);
          setRipple({ side: 'r', text: `+${prefs.skipForwardSeconds} s`, key: Date.now() });
          break;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ChannelUp':
        case 'ChannelDown':
          if (!isLive) return;
          handled();
          void zap(k === 'ArrowUp' || k === 'ChannelUp' ? -1 : 1);
          break;
        case 'Enter':
          if (t?.getAttribute('role') !== 'slider') return;
          handled();
          togglePlay();
          break;
        case 'g':
        case 'G':
          if (!isLive) return;
          handled();
          goLive();
          break;
        case 'f':
        case 'F':
          handled();
          toggleFullscreen();
          break;
        case 'm':
        case 'M':
          if (videoRef.current) videoRef.current.muted = !videoRef.current.muted;
          break;
        case 't':
        case 'T':
          handled();
          setMenu('jump');
          break;
        case 'p':
        case 'P':
          if (!pipSupported) return;
          handled();
          void togglePip();
          break;
        case 'Escape':
        case 'Backspace':
        case 'GoBack':
          handled();
          if (menu) setMenu(null);
          else if (document.fullscreenElement) void document.exitFullscreen();
          else if (overlay && chrome && !videoRef.current?.paused) setChrome(false);
          else back();
          break;
        default:
          if (e.keyCode === 461 || e.keyCode === 10009) {
            handled();
            back();
          }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mini, form, overlay, chrome, menu, activity, togglePlay, skip, zap, goLive, toggleFullscreen, back, isLive, prefs.skipBackSeconds, prefs.skipForwardSeconds, pipSupported, togglePip]);

  // shrinking closes menus; the mini player has its own few controls
  useEffect(() => {
    if (!mini) return;
    setMenu(null);
    setChrome(true);
  }, [mini]);

  /* ---------------- progress (VOD) ---------------- */
  const progressBody = useCallback(() => {
    const v = videoRef.current;
    if (!v || isLive || !Number.isFinite(v.duration) || v.duration <= 0) return null;
    return { kind: vodKind, id, position: v.ended ? v.duration : v.currentTime, duration: v.duration, ...(kind === 'episode' && seriesId ? { seriesId } : {}) } as const;
  }, [isLive, vodKind, id, kind, seriesId]);
  progressBodyRef.current = progressBody;

  useEffect(() => {
    if (isLive) return;
    const save = () => {
      const b = progressBody();
      if (b && b.position > 1) void saveProgress(b);
    };
    const unload = () => {
      const b = progressBody();
      if (b && b.position > 1) saveProgressOnUnload(b);
    };
    const t = setInterval(() => videoRef.current && !videoRef.current.paused && save(), 10_000);
    const vis = () => document.visibilityState === 'hidden' && unload();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', unload);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', unload);
      save();
    };
  }, [isLive, progressBody]);

  /* ---------------- next episode ---------------- */
  const goNext = useCallback(() => {
    if (!nextEpisode) return;
    setCountdown(null);
    go(`/play/episode/${nextEpisode.id}?series=${nextEpisode.seriesId}`);
  }, [nextEpisode, go]);
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) return goNext();
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, goNext]);

  /* ---------------- video events ---------------- */
  const slowTimer = useRef<number>();
  const onWaiting = () => {
    setWaiting(true);
    window.clearTimeout(slowTimer.current);
    slowTimer.current = window.setTimeout(() => setSlow(true), 15_000);
  };
  const onPlaying = () => {
    setWaiting(false);
    setSlow(false);
    setPaused(false);
    window.clearTimeout(slowTimer.current);
  };
  const onLoadedMetadata = () => {
    const s = streamRef.current;
    const v = videoRef.current;
    if (s?.seekTo !== undefined && v) {
      v.currentTime = s.seekTo;
      s.seekTo = undefined;
    }
  };
  const onEnded = () => {
    if (isLive) {
      // Archive/buffer stream ran out: continue from where we are, or go live. Guard against loops.
      const t = Date.now();
      endedAt.current = [...endedAt.current.filter((x) => t - x < 20_000), t];
      if (endedAt.current.length > 3) {
        setError({ title: 'The stream keeps ending', detail: 'The provider closed the stream several times in a row.', tips: ['Try again in a moment, or pick another channel.'], actions: ['retry', 'zap', 'back'] });
        return;
      }
      if (behind > LIVE_SLACK_MS) void load(position);
      else void load(null);
      return;
    }
    const b = progressBody();
    if (b) void saveProgress(b);
    if (kind === 'episode' && nextEpisode && prefs.autoplayNext) setCountdown(prefs.autoplayCountdown);
    else setPaused(true);
  };
  const onVideoError = () => {
    const v = videoRef.current;
    if (!v?.error || error) return;
    if (engineRef.current && engineRef.current.kind !== 'native' && engineRef.current.kind !== 'native-hls') return; // engine reports its own errors
    setError(fromPlaybackFailure(v.error, streamRef.current?.info.pipeline, isLive));
    setWaiting(false);
  };

  /* ---------------- phone gestures: double-tap sides to skip, swipe up/down to zap ---------------- */
  const gesture = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTap = useRef<{ t: number; side: 'l' | 'r' | 'c' } | null>(null);
  const tapTimer = useRef<number>();
  const onGestureDown = (e: RPointerEvent<HTMLDivElement>) => {
    gesture.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onGestureUp = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (isLive && Math.abs(dy) > 60 && Math.abs(dy) > Math.abs(dx) * 1.5 && Date.now() - g.t < 800) {
      void zap(dy < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const side = fx < 0.33 ? 'l' : fx > 0.67 ? 'r' : 'c';
    const prev = lastTap.current;
    const t = Date.now();
    if (prev && t - prev.t < 300 && prev.side === side && side !== 'c') {
      window.clearTimeout(tapTimer.current);
      lastTap.current = { t, side };
      skip(side === 'l' ? -1 : 1);
      setRipple({ side, text: side === 'l' ? `−${prefs.skipBackSeconds} s` : `+${prefs.skipForwardSeconds} s`, key: t });
      return;
    }
    lastTap.current = { t, side };
    window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      if (overlay) setChrome((c) => !c);
      else togglePlay();
    }, side === 'c' ? 0 : 280);
  };
  useEffect(() => {
    if (!ripple) return;
    const t = setTimeout(() => setRipple(null), 650);
    return () => clearTimeout(t);
  }, [ripple]);

  const togglePin = async () => {
    setPinBusy(true);
    try {
      const next = await setBufferPin(id, !pinned);
      bufPins.setPins(next);
      setPinMsg({
        text: next.channelIds.includes(id) ? 'This channel now keeps a rewind buffer, even when nobody watches it.' : 'This channel no longer keeps a rewind buffer when nobody watches it.',
        error: false,
      });
    } catch (e) {
      setPinMsg({ text: (e as Error).message, error: true });
    } finally {
      setPinBusy(false);
    }
  };

  const addToList = () =>
    isLive
      ? openAddToList({ id, name: channel.data?.name ?? 'this channel' })
      : kind === 'episode'
        ? seriesId && openAddToList({ kind: 'series', id: seriesId, name: series.data?.name ?? 'this series' })
        : openAddToList({ kind: 'movie', id, name: movie.data?.name ?? 'this movie' });
  const toggleFav = () => void toggleFavorite(isLive ? 'live' : kind === 'episode' ? 'series' : 'movie', isLive ? id : kind === 'episode' ? seriesId! : id);

  // TV: start with focus on the timeline so left/right seek straight away.
  useEffect(() => {
    if (form !== 'tv' || mini) return;
    const t = setTimeout(() => {
      if (document.activeElement === document.body) rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
    }, 300);
    return () => clearTimeout(t);
  }, [form, id, info, mini]);

  /* ---------------- audio & subtitles (PB-3) ---------------- */
  // show the chosen subtitle rendition once the engine knows the stream's renditions
  useEffect(() => {
    const e = engineRef.current;
    const t = info?.tracks;
    if (!e || !t) return;
    const pos = renditionOf(t, subIdx);
    if (pos !== null && pos >= e.subtitleCount()) return; // not read yet: onTracks brings us back
    e.setSubtitle(pos);
  }, [info, subIdx, tracksVer]);

  // kept per movie or episode, and per live channel (audio only: it also plays in its archive and buffer)
  const saveTracks = useCallback(
    (choice: TrackChoice) => {
      if (isLive && choice.audio === undefined) return;
      const body = isLive ? { audio: choice.audio } : choice;
      void call('PUT /api/tracks/:kind/:id', { params: { kind: isLive ? 'live' : vodKind, id }, body }).catch(() => undefined);
    },
    [isLive, vodKind, id],
  );
  /** Asks the server for the stream with other tracks and continues where playback was. */
  const reloadTracks = useCallback(
    (audio: number | undefined, sub: number | null) => {
      if (isLive) void load(atLive ? null : position, { audio });
      else void load(null, { position: videoRef.current?.currentTime ?? 0, audio, sub: sub ?? 'off' });
    },
    [isLive, atLive, position, load],
  );
  const chooseAudio = (n: number) => {
    const t = info?.tracks;
    if (!t || n === t.audioIndex) return;
    saveTracks({ audio: n });
    reloadTracks(n, subIdx);
  };
  const chooseSubtitle = (n: number | null) => {
    const t = info?.tracks;
    if (!t || n === subIdx) return;
    const action = subtitleAction(t, n);
    if (action === 'none') return;
    setSubIdx(n);
    playing.current.tracks = { ...playing.current.tracks, sub: n ?? 'off' };
    saveTracks({ subtitle: n });
    if (action === 'reload') reloadTracks(t.audioIndex ?? undefined, n);
  };

  /* ---------------- render ---------------- */
  const ch = channel.data;
  const metaLine = isLive
    ? [ch ? `${ch.number} · ${ch.name}` : null, program ? fmtRange(program.start, program.end) : null].filter(Boolean).join(' · ')
    : kind === 'episode'
      ? [series.data?.name, episode ? `S${episode.season} E${episode.episode}` : null].filter(Boolean).join(' · ')
      : [movie.data?.year, duration ? fmtDuration(duration) : null].filter(Boolean).join(' · ');
  const title = isLive ? (program?.title ?? ch?.name ?? 'Live') : kind === 'episode' ? (episode?.title ?? 'Episode') : (movie.data?.name ?? 'Movie');
  const tracks = info?.tracks;
  const hasTracks = hasTrackChoice(tracks);
  const showPlayOverlay = !error && !moved && countdown === null && (needsTap || (paused && !waiting));

  /* ---------------- media session (lock screen, media keys) ---------------- */
  const prevEpisode: Episode | undefined = epIdx > 0 ? episodes[epIdx - 1] : undefined;
  useMediaSession(
    video,
    isLive
      ? { title, artist: ch?.name, artwork: ch?.logo }
      : kind === 'episode'
        ? { title, artist: series.data?.name, album: episode ? `S${episode.season} E${episode.episode}` : null, artwork: series.data?.poster }
        : { title, album: movie.data?.year ? String(movie.data.year) : null, artwork: movie.data?.poster },
    {
      play,
      pause: () => videoRef.current?.pause(),
      seekBy: (s) => skip(s < 0 ? -1 : 1, Math.abs(s)),
      seekTo: (t) => videoRef.current && (videoRef.current.currentTime = t),
      previous: isLive ? () => void zap(-1) : prevEpisode ? () => go(`/play/episode/${prevEpisode.id}?series=${prevEpisode.seriesId}`) : undefined,
      next: isLive ? () => void zap(1) : nextEpisode ? goNext : undefined,
    },
    !isLive,
  );

  return (
    <div
      ref={rootRef}
      className="player"
      data-mode={mini ? 'mini' : overlay ? 'overlay' : 'stacked'}
      data-chrome={chrome ? 'on' : 'off'}
      onPointerMove={overlay ? activity : undefined}
    >
      <div className="pl-stage">
        <video
          ref={videoRef}
          className="pl-video"
          playsInline
          preload="auto"
          onTimeUpdate={() => setTick((x) => x + 1)}
          onWaiting={onWaiting}
          onPlaying={onPlaying}
          onCanPlay={() => setWaiting(false)}
          onPause={() => {
            setPaused(true);
            const b = progressBody();
            if (b && b.position > 1) void saveProgress(b);
            setChrome(true);
          }}
          onPlay={() => setPaused(false)}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
          onError={onVideoError}
        />
        <div className="pl-gesture" onPointerDown={onGestureDown} onPointerUp={onGestureUp} aria-hidden="true" />
        {waiting && !error && (
          <div className="pl-loading" aria-hidden="true">
            <span className="skel" />
          </div>
        )}
        <div className="pl-top">
          <button type="button" className="pl-round" onClick={back} aria-label="Back">
            <IconBack />
          </button>
          {isLive && info && !error && (
            <span className={`pl-badge tabnum${atLive ? ' live' : ''}`} aria-live="off">
              {atLive ? 'LIVE' : `${fmtBehind(behind)} behind live`}
            </span>
          )}
          {form === 'phone' && (
            <span className="pl-top-end">
              <button type="button" className="pl-round" aria-label={kind === 'episode' ? 'Add series to list' : 'Add to list'} onClick={addToList} disabled={kind === 'episode' && !seriesId}>
                <IconListAdd />
              </button>
              <button type="button" className="pl-round" aria-pressed={fav} aria-label={fav ? 'Remove from favorites' : 'Add to favorites'} onClick={toggleFav} disabled={kind === 'episode' && !seriesId}>
                <IconStar filled={fav} className={`ico${fav ? ' accent' : ''}`} />
              </button>
              <button type="button" className="pl-round" onClick={toggleFullscreen} aria-label="Full screen">
                <IconFullscreen />
              </button>
            </span>
          )}
        </div>
        {stats.open && <StatsOverlay video={video} info={info} routeKind={kind} engine={engineRef.current?.kind ?? null} behindLiveMs={isLive && info ? rawBehind : null} onClose={stats.close} />}
        {ripple && (
          <div key={ripple.key} className="pl-ripple" data-side={ripple.side} aria-hidden="true">
            {ripple.text}
          </div>
        )}
        {showPlayOverlay && (
          <button type="button" className="pl-bigplay" onClick={play} aria-label={needsTap ? 'Tap to play' : 'Play'}>
            <IconPlay />
          </button>
        )}
        {slow && waiting && !error && (
          <div className="pl-slow" role="status">
            Still loading. The provider may be slow.{' '}
            <button type="button" className="link-btn" onClick={() => void load(isLive && !atLive ? position : null)}>
              Try again
            </button>
          </div>
        )}
        {moved && (
          <div className="pl-error" role="alert" data-nav-trap="" data-testid="playback-moved">
            <h2>Playback moved to another device</h2>
            <p className="pl-error-detail">
              {moved.profileName} started watching{moved.device ? ` on ${moved.device}` : ''}. Your subscription plays one stream at a time.
            </p>
            <div className="actions">
              <button type="button" className="btn btn-primary" autoFocus onClick={reload}>
                Resume
              </button>
              <button type="button" className="btn" onClick={back}>
                Back
              </button>
            </div>
          </div>
        )}
        {error && !moved && (
          <div className="pl-error" role="alert" data-nav-trap="">
            <h2>{error.title}</h2>
            <p className="pl-error-detail">{error.detail}</p>
            {error.tips.length > 0 && (
              <ul>
                {error.tips.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <div className="actions">
              {error.actions.includes('takeover') && (
                <button type="button" className="btn btn-primary" autoFocus onClick={() => void takeOver()}>
                  Take over
                </button>
              )}
              {error.actions.includes('retry') && (
                <button type="button" className="btn btn-primary" autoFocus onClick={reload}>
                  Try again
                </button>
              )}
              {error.actions.includes('live') && (
                <button type="button" className="btn btn-primary" onClick={() => void load(null)}>
                  Go live
                </button>
              )}
              {error.actions.includes('zap') && (
                <button type="button" className="btn" onClick={() => void zap(1)}>
                  Next channel
                </button>
              )}
              {error.actions.includes('back') && (
                <button type="button" className="btn" onClick={back}>
                  Back
                </button>
              )}
            </div>
          </div>
        )}
        {countdown !== null && nextEpisode && (
          <div className="pl-next" role="dialog" aria-label="Next episode" data-nav-trap="">
            <div className="muted" style={{ fontSize: '0.8125rem' }}>
              Up next · S{nextEpisode.season} E{nextEpisode.episode}
            </div>
            <div className="pl-next-title">{nextEpisode.title}</div>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={goNext} autoFocus>
                <IconPlay /> Play now · {countdown}
              </button>
              <button type="button" className="btn" onClick={() => setCountdown(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {mini && (
          <MiniBar
            title={title}
            sub={isLive ? (ch?.name ?? null) : kind === 'episode' ? metaLine : null}
            live={isLive && !!info && !error && !moved}
            atLive={atLive}
            paused={paused || needsTap}
            progress={!isLive && duration > 0 ? ct / duration : null}
            problem={moved ? 'Playback moved to another device' : error ? error.title : null}
            onPlay={togglePlay}
            onExpand={expand}
            onClose={close}
          />
        )}
      </div>

      <div className="pl-panel" aria-hidden={overlay && !chrome ? true : undefined}>
        <div className="pl-meta">
          <div style={{ minWidth: 0 }}>
            <div className="pl-meta-line tabnum ellipsis">{metaLine || ' '}</div>
            <h1 className="pl-title">{title}</h1>
          </div>
          {overlay && isLive && info && <div className={`pl-behind tabnum${atLive ? ' live' : ''}`}>{atLive ? 'Live' : `${fmtBehind(behind)} behind live`}</div>}
        </div>

        {isLive ? (
          timeline || !info ? (
            <Ribbon
              win={win}
              now={now}
              position={position}
              timeline={timeline}
              showBlocks={prefs.timelineStyle === 'ribbon'}
              onSeek={seekAbs}
              onSkip={(d) => skip(d)}
              onDragChange={(d) => {
                dragging.current = d;
                if (d) setChrome(true);
              }}
              onBlockUnavailable={flash}
            />
          ) : (
            <Skeleton h="2.5rem" />
          )
        ) : (
          <VodBar
            position={ct}
            duration={duration}
            buffered={buffered}
            onSeek={(s) => videoRef.current && (videoRef.current.currentTime = s)}
            onSkip={(d) => skip(d)}
            thumbs={thumbs.index}
            onScrubStart={thumbs.refresh}
            hint={seekHint}
          />
        )}

        {notice && (
          <p className="pl-notice" role="status">
            {notice}
          </p>
        )}
        {pinMsg && (
          <p className={`pl-notice${pinMsg.error ? ' error' : ''}`} role={pinMsg.error ? 'alert' : 'status'} data-testid="pin-message">
            {pinMsg.text}{' '}
            <button type="button" className="link-btn" onClick={() => setPinMsg(null)}>
              OK
            </button>
          </p>
        )}

        <div className="pl-controls" data-nav-row="pl-controls">
          <button type="button" className="pl-round" onClick={() => skip(-1)} aria-label={`Back ${prefs.skipBackSeconds} seconds`}>
            −{prefs.skipBackSeconds < 60 ? `${prefs.skipBackSeconds}s` : '1m'}
          </button>
          <button type="button" className="pl-round pl-main" onClick={togglePlay} aria-label={paused ? 'Play' : 'Pause'}>
            {paused || needsTap ? <IconPlay /> : <IconPause />}
          </button>
          <button type="button" className="pl-round" onClick={() => skip(1)} aria-label={`Forward ${prefs.skipForwardSeconds} seconds`} disabled={atLive}>
            +{prefs.skipForwardSeconds < 60 ? `${prefs.skipForwardSeconds}s` : '1m'}
          </button>
        </div>

        <div className="pl-pills" data-nav-row="pl-pills">
          <button type="button" className="btn" onClick={() => setMenu(menu === 'jump' ? null : 'jump')} aria-expanded={menu === 'jump'}>
            <IconClock /> Jump to time…
          </button>
          {isLive && program && program.start < now && form !== 'phone' && (
            <button type="button" className="btn" onClick={() => seekAbs(program.start)}>
              Start of programme
            </button>
          )}
          {isLive && (
            <button type="button" className="btn btn-primary" onClick={goLive} disabled={atLive} aria-label={atLive ? 'Watching live' : `Go live, ${fmtBehind(behind)} behind`}>
              {atLive ? 'Live' : 'Go live'}
            </button>
          )}
          {isLive && isAdmin && bufPins.pins?.maxPins === 0 && !pinned && (
            <span className="pl-note" data-testid="pin-unavailable" title="Background buffering needs a second provider connection">
              Rewind works while you watch. Your subscription plays one stream at a time, so channels can't keep a buffer in the background.
            </span>
          )}
          {isLive && isAdmin && bufPins.pins && (bufPins.pins.maxPins !== 0 || pinned) && (
            <button
              type="button"
              className={`btn${pinned ? ' on' : ''}`}
              aria-pressed={pinned}
              aria-label="Keep a rewind buffer for this channel"
              title="Record this channel all the time, so you can always rewind it"
              disabled={pinBusy}
              onClick={() => void togglePin()}
            >
              <IconClock /> Keep a rewind buffer
            </button>
          )}
          {hasTracks && (
            <button type="button" className="btn" onClick={() => setMenu(menu === 'tracks' ? null : 'tracks')} aria-expanded={menu === 'tracks'}>
              <IconTracks /> Audio &amp; subtitles
            </button>
          )}
          {form !== 'phone' && (
            <>
              <button type="button" className={`btn${fav ? ' on' : ''}`} aria-pressed={fav} onClick={toggleFav} disabled={kind === 'episode' && !seriesId}>
                <IconStar filled={fav} /> {kind === 'episode' ? 'Favorite series' : 'Favorite'}
              </button>
              <button type="button" className="btn" onClick={addToList} disabled={kind === 'episode' && !seriesId}>
                <IconListAdd /> {kind === 'episode' ? 'Add series to list' : 'Add to list'}
              </button>
              <button type="button" className="btn" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}>
                <IconFullscreen />
              </button>
            </>
          )}
          <PipButton pip={pip} />
          <StatsButton open={stats.open} onToggle={stats.toggle} />
          {form === 'tv' && <span className="pl-hint">◀ ▶ seek · ▲▼ channels · Back to close</span>}
        </div>

        {menu === 'jump' && (
          <JumpBox
            live={isLive}
            onClose={() => setMenu(null)}
            onJump={(raw) => {
              if (isLive) {
                const r = parseTimeInput(raw, { now, position });
                if (!r.ok) return r.error;
                seekAbs(r.at);
              } else {
                const r = parseMediaTime(raw, { position: ct, duration });
                if (!r.ok) return r.error;
                if (videoRef.current) videoRef.current.currentTime = r.at;
              }
              setMenu(null);
              return null;
            }}
          />
        )}
        {menu === 'tracks' && tracks && (
          <TracksMenu tracks={tracks} subtitle={subIdx} onAudio={chooseAudio} onSubtitle={chooseSubtitle} onClose={() => setMenu(null)} />
        )}

        {isLive && !overlay && timeline && <Earlier timeline={timeline} now={now} position={position} onPlay={seekAbs} />}
        {!isLive && !overlay && kind === 'episode' && nextEpisode && (
          <div className="pl-upnext">
            <span className="label">Next</span>
            <button type="button" className="pl-earlier-row" onClick={goNext}>
              <span className="tabnum muted">
                S{nextEpisode.season} E{nextEpisode.episode}
              </span>
              <span className="ellipsis" style={{ flex: 1 }}>
                {nextEpisode.title}
              </span>
              <span className="accent">Play</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function JumpBox(props: { live: boolean; onJump: (raw: string) => string | null; onClose: () => void }) {
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="pl-jump"
      data-player-keys="off"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(props.onJump(v));
      }}
    >
      <label className="field" style={{ flex: 1 }}>
        <span>{props.live ? 'Jump to a time (20:15) or by an amount (−45m, +10m)' : 'Jump to a time (1:20:00) or by an amount (−5m, +10m)'}</span>
        <input className="input" value={v} onChange={(e) => (setV(e.target.value), setErr(null))} autoFocus placeholder={props.live ? '20:15' : '1:20:00'} inputMode="text" aria-invalid={!!err} />
      </label>
      <button type="submit" className="btn btn-primary">
        Go
      </button>
      <button type="button" className="btn" onClick={props.onClose}>
        Cancel
      </button>
      {err && (
        <p className="form-error" role="alert" style={{ flexBasis: '100%' }}>
          {err}
        </p>
      )}
    </form>
  );
}

function Earlier(props: { timeline: TimelineInfo; now: number; position: number; onPlay: (t: number) => void }) {
  const earliest = props.timeline.ranges[0]?.start ?? props.now;
  const items = props.timeline.programs
    .filter((p) => p.end <= props.now && p.end > earliest)
    .sort((a, b) => b.start - a.start)
    .slice(0, 12);
  if (!items.length) return null;
  let lastDay = '';
  return (
    <div className="pl-earlier">
      {items.map((p) => {
        const day = fmtDay(p.start, props.now);
        const head = day !== lastDay ? (lastDay = day) : null;
        const gap = props.timeline.gaps.find((g) => p.start >= g.start && p.start < g.end);
        return (
          <div key={p.start}>
            {head && <h2 className="label pl-earlier-head">{head === 'Today' ? 'Earlier today' : head}</h2>}
            <button type="button" className="pl-earlier-row" onClick={() => props.onPlay(Math.max(p.start, earliest))} aria-label={`Play ${p.title} from ${fmtClock(p.start)}`}>
              <span className="tabnum muted">{fmtClock(p.start)}</span>
              <span className="ellipsis" style={{ flex: 1 }}>
                {p.title}
              </span>
              <span className={gap ? 'muted' : 'accent'}>{gap ? 'Partly missing' : 'Play'}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The mini player's controls: what is playing, play/pause, expand, close. */
function MiniBar(props: {
  title: string;
  sub: string | null;
  live: boolean;
  atLive: boolean;
  paused: boolean;
  progress: number | null;
  problem: string | null;
  onPlay: () => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mini-bar">
      {props.problem && (
        <p className="mini-problem" role="status">
          {props.problem}
        </p>
      )}
      <div className="mini-row">
        <div className="mini-text">
          <div className="mini-title ellipsis">{props.title}</div>
          {(props.sub || props.live) && (
            <div className="mini-sub ellipsis">
              {props.live && <span className={`mini-live${props.atLive ? ' on' : ''}`}>{props.atLive ? 'LIVE' : 'Rewound'}</span>}
              {props.sub}
            </div>
          )}
        </div>
        {!props.problem && (
          <button type="button" className="mini-btn" onClick={props.onPlay} aria-label={props.paused ? 'Play' : 'Pause'}>
            {props.paused ? <IconPlay /> : <IconPause />}
          </button>
        )}
        <button type="button" className="mini-btn" onClick={props.onExpand} aria-label="Expand player">
          <IconExpand />
        </button>
        <button type="button" className="mini-btn" onClick={props.onClose} aria-label="Close player">
          <IconClose />
        </button>
      </div>
      {props.progress !== null && (
        <div className="mini-progress" aria-hidden="true">
          <i style={{ width: `${Math.min(100, Math.max(0, props.progress * 100)).toFixed(2)}%` }} />
        </div>
      )}
    </div>
  );
}
