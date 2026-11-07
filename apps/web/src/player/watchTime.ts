/**
 * Watch history: counts the seconds that actually play (not paused, not buffering) and reports
 * them about once a minute, and whatever is left when the item changes or the page goes away.
 */
import { useEffect, useRef } from 'react';
import { reportWatchTime, type WatchBody } from '../store/actions';

const TICK_MS = 1_000;
const REPORT_EVERY_S = 60;

export function useWatchTime(kind: WatchBody['kind'], id: string, seriesId: string | undefined, playing: () => boolean) {
  const playingRef = useRef(playing);
  playingRef.current = playing;
  useEffect(() => {
    let acc = 0;
    let last = performance.now();
    const flush = (unload = false) => {
      if (acc >= 1) reportWatchTime({ kind, id, seconds: acc, ...(seriesId ? { seriesId } : {}) }, unload);
      acc = 0;
    };
    const t = setInterval(() => {
      const now = performance.now();
      // a sleeping tab or device must not count as hours of watching
      const dt = Math.min(now - last, 5 * TICK_MS) / 1000;
      last = now;
      if (playingRef.current()) acc += dt;
      if (acc >= REPORT_EVERY_S) flush();
    }, TICK_MS);
    const unload = () => flush(true);
    const vis = () => document.visibilityState === 'hidden' && unload();
    window.addEventListener('pagehide', unload);
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      window.removeEventListener('pagehide', unload);
      document.removeEventListener('visibilitychange', vis);
      flush();
    };
  }, [kind, id, seriesId]);
}
