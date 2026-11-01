import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { Page } from '@anycast/shared';
import { useApp } from '../store/app';
import { detectFormFactor, type FormFactor } from './device';
import { isAbort } from '../api/client';

/* ---------- form factor ---------- */
function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}
export function useFormFactor(): FormFactor {
  const override = useApp((s) => s.deviceOverride);
  const width = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
  return detectFormFactor({ ua: navigator.userAgent, search: location.search, width, override });
}
export function useViewportWidth() {
  return useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
}

/* ---------- clock ---------- */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/* ---------- async data ---------- */
export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [tick, reload] = useReducer((x: number) => x + 1, 0);
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ data: s.data, loading: true }));
    fn(ac.signal).then(
      (data) => !ac.signal.aborted && setState({ data, loading: false }),
      (error) => !ac.signal.aborted && !isAbort(error) && setState({ error, loading: false }),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

/* ---------- paged + sparse list for virtualized views ---------- */
export interface PagedList<T> {
  total: number | null;
  get: (i: number) => T | undefined;
  ensure: (start: number, end: number) => void;
  error: unknown;
  /** items loaded so far, in order (holes skipped) */
  loaded: () => T[];
}
export function usePagedList<T>(
  key: string,
  fetchPage: (offset: number, limit: number, signal: AbortSignal) => Promise<Page<T>>,
  pageSize = 60,
): PagedList<T> {
  const pages = useRef(new Map<number, T[]>());
  const inflight = useRef(new Set<number>());
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const ac = useRef<AbortController | null>(null);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const load = useCallback((p: number) => {
    if (pages.current.has(p) || inflight.current.has(p)) return;
    inflight.current.add(p);
    const signal = ac.current!.signal;
    fetchRef.current(p * pageSize, pageSize, signal).then(
      (res) => {
        if (signal.aborted) return;
        inflight.current.delete(p);
        pages.current.set(p, res.items);
        setTotal(res.total);
        bump();
      },
      (e) => {
        inflight.current.delete(p);
        if (!signal.aborted && !isAbort(e)) setError(e);
      },
    );
  }, [pageSize]);

  useEffect(() => {
    ac.current?.abort();
    ac.current = new AbortController();
    pages.current = new Map();
    inflight.current = new Set();
    setTotal(null);
    setError(null);
    load(0);
    return () => ac.current?.abort();
  }, [key, load]);

  return useMemo(
    () => ({
      total,
      error,
      get: (i: number) => pages.current.get(Math.floor(i / pageSize))?.[i % pageSize],
      ensure: (start: number, end: number) => {
        for (let p = Math.floor(Math.max(0, start) / pageSize); p <= Math.floor(Math.max(0, end) / pageSize); p++) {
          if (total === null || p * pageSize < total) load(p);
        }
      },
      loaded: () => [...pages.current.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, v]) => v),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [total, error, load, pageSize, pages.current.size],
  );
}

/* ---------- element width ---------- */
export function useElementWidth<T extends HTMLElement>(): [React.RefCallback<T>, number] {
  const [w, setW] = useState(0);
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    setW(el.clientWidth);
    ro.current = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.current.observe(el);
  }, []);
  return [ref, w];
}

/** Becomes true once the element scrolls near the viewport (for lazy rows). */
export function useInView<T extends HTMLElement>(margin = '300px'): [React.RefCallback<T>, boolean] {
  const [seen, setSeen] = useState(false);
  const io = useRef<IntersectionObserver | null>(null);
  const ref = useCallback(
    (el: T | null) => {
      io.current?.disconnect();
      if (!el || seen) return;
      if (typeof IntersectionObserver === 'undefined') return setSeen(true);
      io.current = new IntersectionObserver(([e]) => e!.isIntersecting && (setSeen(true), io.current?.disconnect()), { rootMargin: margin });
      io.current.observe(el);
    },
    [margin, seen],
  );
  return [ref, seen];
}
