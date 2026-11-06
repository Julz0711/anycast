/** Scrub thumbnails (PB-1): the server's tile index for a movie or episode, and time -> tile lookup. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThumbIndex, ThumbTile } from '@anycast/shared';
import { call } from '../api/client';

/** The tile that covers `t` seconds (start <= t < start + interval), or null when that part has none yet. */
export function tileAt(index: ThumbIndex | null, t: number): ThumbTile | null {
  if (!index || !index.tiles.length || !Number.isFinite(t) || t < 0) return null;
  const { tiles, interval } = index;
  let lo = 0;
  let hi = tiles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tiles[mid]!.start <= t) lo = mid;
    else hi = mid - 1;
  }
  const tile = tiles[lo]!;
  return tile.start <= t && t < tile.start + interval ? tile : null;
}

const REFRESH_MS = 30_000;
const STALE_MS = 5_000;

/**
 * The thumbnail index of a movie or episode. While `playing`, it is re-fetched every 30 s (the
 * server adds tiles as playback goes); `refresh()` re-fetches when the copy is older than 5 s (on
 * starting to scrub). Sheets are preloaded so a preview shows at once.
 */
export function useThumbIndex(kind: 'movie' | 'episode', id: string, enabled: boolean, playing: boolean) {
  const [index, setIndex] = useState<ThumbIndex | null>(null);
  const fetchedAt = useRef(0);
  const inflight = useRef(false);
  const preloaded = useRef(new Set<string>());

  const load = useCallback(async () => {
    if (!enabled || inflight.current) return;
    inflight.current = true;
    fetchedAt.current = Date.now();
    try {
      const next = await call('GET /api/thumbs/:kind/:id', { params: { kind, id } });
      for (const url of new Set(next.tiles.map((t) => t.url))) {
        if (preloaded.current.has(url)) continue;
        preloaded.current.add(url);
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
      setIndex(next);
    } catch {
      /* thumbnails are optional: the preview then shows only the time */
    } finally {
      inflight.current = false;
    }
  }, [enabled, kind, id]);

  useEffect(() => {
    setIndex(null);
    fetchedAt.current = 0;
    void load();
  }, [load]);

  useEffect(() => {
    if (!enabled || !playing) return;
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [enabled, playing, load]);

  const refresh = useCallback(() => {
    if (Date.now() - fetchedAt.current > STALE_MS) void load();
  }, [load]);

  return { index, refresh };
}
