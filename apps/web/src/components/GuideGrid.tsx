/**
 * Extended Live layout: EPG guide grid. Channels down (virtualized), time across (only visible programs rendered),
 * sticky channel column and time header, a now-line, past programs playable on archive channels.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { EpgProgram, LiveChannelWithNow } from '@anycast/shared';
import { call } from '../api/client';
import { useApp } from '../store/app';
import { useNow } from '../lib/hooks';
import { fmtClock } from '../lib/time';
import { LogoTile, Skeleton } from './ui';
import { toast } from '../store/actions';
import type { FormFactor } from '../lib/device';

export interface ChannelSource {
  total: number | null;
  get: (i: number) => LiveChannelWithNow | undefined;
  ensure: (start: number, end: number) => void;
}

const MIN = 60_000;
const NO_PROGRAMS: EpgProgram[] = [];
const HOUR = 3_600_000;

/* ---------- EPG cache for the grid window ---------- */
const epgStore = new Map<string, EpgProgram[]>();
function useEpg(ids: string[], from: number, to: number): (id: string) => EpgProgram[] | undefined {
  const [, setTick] = useState(0);
  const windowKey = `${from}-${to}`;
  const key = (id: string) => `${windowKey}|${id}`;
  const pending = useRef(new Set<string>());
  const idsKey = ids.join(',');
  useEffect(() => {
    const missing = ids.filter((id) => !epgStore.has(key(id)) && !pending.current.has(key(id)));
    if (!missing.length) return;
    const t = setTimeout(() => {
      for (let i = 0; i < missing.length; i += 30) {
        const batch = missing.slice(i, i + 30);
        batch.forEach((id) => pending.current.add(key(id)));
        call('GET /api/epg', { query: { channelIds: batch.join(','), from, to } })
          .then((res) => {
            for (const id of batch) epgStore.set(key(id), res[id] ?? []);
          })
          .catch(() => {
            for (const id of batch) epgStore.set(key(id), []);
          })
          .finally(() => {
            batch.forEach((id) => pending.current.delete(key(id)));
            setTick((x) => x + 1);
          });
      }
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, windowKey]);
  return (id) => epgStore.get(key(id));
}

function remPx() {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

export function GuideGrid(props: {
  source: ChannelSource;
  form: FormFactor;
  onPlay: (ch: LiveChannelWithNow, at?: number) => void;
  onSelect?: (ch: LiveChannelWithNow, p: EpgProgram | null) => void;
}) {
  const { source, form } = props;
  const hours = useApp((s) => s.prefs.live.guideHoursVisible);
  const density = useApp((s) => s.prefs.appearance.density);
  const showNumbers = useApp((s) => s.prefs.live.showChannelNumbers);
  const showLogos = useApp((s) => s.prefs.live.showLogos);
  const now = useNow(30_000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const rem = useMemo(remPx, [form]); // eslint-disable-line react-hooks/exhaustive-deps
  const chW = Math.round((form === 'phone' ? 5.25 : 11) * rem);
  const rowH = Math.round((density === 'compact' ? 2.875 : 3.625) * rem);
  const headH = Math.round(2.25 * rem);

  // Window: past hours depend on the archive depth of the first channels; fixed once known.
  const [win, setWin] = useState<{ from: number; to: number } | null>(null);
  const first = source.get(0);
  useEffect(() => {
    if (win || source.total === null) return;
    let maxDays = 0;
    for (let i = 0; i < Math.min(60, source.total); i++) maxDays = Math.max(maxDays, source.get(i)?.archiveDays ?? 0);
    const pastH = Math.min(72, Math.max(2, maxDays * 24));
    const from = Math.floor((Date.now() - pastH * HOUR) / (30 * MIN)) * 30 * MIN;
    setWin({ from, to: from + (pastH + 12) * HOUR });
  }, [win, source, first]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pxPerMin = width > chW ? (width - chW) / (hours * 60) : 0;
  const x = useCallback((t: number) => (win ? chW + ((t - win.from) / MIN) * pxPerMin : 0), [win, chW, pxPerMin]);
  const totalW = win ? x(win.to) : width;

  const rows = useVirtualizer({
    count: source.total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 6,
    paddingStart: headH,
  });
  const vItems = rows.getVirtualItems();
  useEffect(() => {
    if (vItems.length) source.ensure(vItems[0]!.index, vItems[vItems.length - 1]!.index + 10);
  }, [vItems, source]);
  useEffect(() => rows.measure(), [rowH, rows]);

  // Initial horizontal position: now at ~20% of the visible time area.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current || !win || !pxPerMin || !scrollRef.current) return;
    placed.current = true;
    const left = x(Date.now()) - chW - (width - chW) * 0.2;
    scrollRef.current.scrollLeft = Math.max(0, left);
    setScrollLeft(scrollRef.current.scrollLeft);
  }, [win, pxPerMin, x, chW, width]);
  // Keep the same time in view when the scale changes (resize, hours preference).
  const prevScale = useRef(pxPerMin);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevScale.current && pxPerMin && prevScale.current !== pxPerMin) {
      el.scrollLeft = (el.scrollLeft / prevScale.current) * pxPerMin;
      setScrollLeft(el.scrollLeft);
    }
    prevScale.current = pxPerMin;
  }, [pxPerMin]);

  const raf = useRef(0);
  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => scrollRef.current && setScrollLeft(scrollRef.current.scrollLeft));
  };

  const visFrom = win && pxPerMin ? win.from + ((scrollLeft - 0) / pxPerMin) * MIN - HOUR : 0;
  const visTo = win && pxPerMin ? win.from + ((scrollLeft + width) / pxPerMin) * MIN + HOUR : 0;
  // only visible rows, and only channels that have guide data, are asked for (many have none)
  const ids = vItems
    .map((v) => source.get(v.index))
    .filter((c): c is LiveChannelWithNow => !!c && c.hasEpg)
    .map((c) => c.id);
  const epg = useEpg(win ? ids : [], win?.from ?? 0, win?.to ?? 0);

  const ticks: number[] = [];
  if (win && pxPerMin) {
    for (let t = Math.max(win.from, Math.floor(visFrom / (30 * MIN)) * 30 * MIN); t < Math.min(win.to, visTo); t += 30 * MIN) ticks.push(t);
  }

  const jumpNow = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ left: Math.max(0, x(Date.now()) - chW - (width - chW) * 0.2), behavior: 'smooth' });
  };
  const nowX = x(now);
  const nowVisible = nowX >= scrollLeft + chW && nowX <= scrollLeft + width;

  return (
    <div className="guide-wrap">
      <div
        className="guide"
        ref={scrollRef}
        onScroll={onScroll}
        style={{ scrollPaddingLeft: chW, scrollPaddingTop: headH } as React.CSSProperties}
        role="grid"
        aria-label="TV guide"
        aria-rowcount={source.total ?? undefined}
      >
        <div className="guide-inner" style={{ width: totalW, height: rows.getTotalSize() }}>
          <div className="guide-head" style={{ width: totalW, height: headH }} role="row">
            <div className="guide-corner" style={{ width: chW, height: headH }} />
            {ticks.map((t) => (
              <span key={t} className="guide-tick tabnum" style={{ left: x(t) }} role="columnheader">
                {fmtClock(t)}
              </span>
            ))}
          </div>
          {win && pxPerMin > 0 && <div className="now-line" style={{ left: nowX, top: headH }} aria-hidden="true" />}
          {vItems.map((v) => {
            const ch = source.get(v.index);
            return (
              <div key={v.key} className="guide-row" role="row" style={{ top: v.start, height: rowH, width: totalW }} data-nav-row={`g${v.index}`}>
                {ch ? (
                  <>
                    <button type="button" className="guide-ch" style={{ width: chW }} onClick={() => props.onPlay(ch)} aria-label={`${ch.number} ${ch.name}, watch live`}>
                      {showLogos && <LogoTile name={ch.name} logo={ch.logo} small />}
                      <span className="guide-ch-text">
                        {showNumbers && <span className="ch-num tabnum">{ch.number}</span>}
                        {form !== 'phone' && <span className="guide-ch-name">{ch.name}</span>}
                      </span>
                    </button>
                    {win && pxPerMin > 0 && (
                      <Programs
                        ch={ch}
                        programs={ch.hasEpg ? epg(ch.id) : NO_PROGRAMS}
                        now={now}
                        visFrom={visFrom}
                        visTo={visTo}
                        x={x}
                        chW={chW}
                        clipX={scrollLeft + chW}
                        viewW={Math.max(0, width - chW)}
                        onPlay={props.onPlay}
                        onSelect={props.onSelect}
                      />
                    )}
                  </>
                ) : (
                  <div className="guide-ch" style={{ width: chW }}>
                    <Skeleton w="2.125rem" h="2.125rem" r="0.625rem" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!nowVisible && win && (
        <button type="button" className="btn btn-primary guide-now-btn" onClick={jumpNow}>
          Now
        </button>
      )}
    </div>
  );
}

const Programs = memo(function Programs(props: {
  ch: LiveChannelWithNow;
  programs: EpgProgram[] | undefined;
  now: number;
  visFrom: number;
  visTo: number;
  x: (t: number) => number;
  chW: number;
  /** content x of the channel column's right edge; titles of programmes that start under it are shifted into view */
  clipX: number;
  /** width of the visible time area */
  viewW: number;
  onPlay: (ch: LiveChannelWithNow, at?: number) => void;
  onSelect?: (ch: LiveChannelWithNow, p: EpgProgram | null) => void;
}) {
  const { ch, programs, now, x } = props;
  if (!programs) {
    return <div className="prog skel" style={{ left: x(props.visFrom + 3_600_000), width: Math.max(0, x(props.visTo - 3_600_000) - x(props.visFrom + 3_600_000)) }} />;
  }
  if (!programs.length) {
    // one calm block across the visible time area, so the row reads as a channel, not a hole
    return (
      <button
        type="button"
        className="prog prog-empty"
        style={{ left: props.clipX + 2, width: Math.max(2, props.viewW - 4) }}
        onClick={() => props.onPlay(ch)}
        aria-label={`${ch.name}, no guide data, watch live`}
        role="gridcell"
      >
        <span className="prog-inner">
          <span className="prog-t">{ch.name}</span>
          <span className="prog-s">No guide data</span>
        </span>
      </button>
    );
  }
  const archiveFrom = ch.archiveDays > 0 ? now - ch.archiveDays * 86_400_000 : Infinity;
  return (
    <>
      {programs
        .filter((p) => p.end > props.visFrom && p.start < props.visTo)
        .map((p) => {
          const state = p.start <= now && p.end > now ? 'now' : p.end <= now ? (p.start >= archiveFrom ? 'past' : 'none') : 'future';
          const left = x(p.start);
          const w = x(p.end) - left;
          const shift = Math.max(0, Math.min(props.clipX - left - 2, w - 60));
          const tag = state === 'now' ? 'Live' : state === 'past' ? 'Play from start' : state === 'none' ? 'No archive' : fmtClock(p.start);
          const activate = () => {
            if (state === 'now') props.onPlay(ch);
            else if (state === 'past') props.onPlay(ch, p.start);
            else if (state === 'none') toast(`${ch.name} has no archive, so past programmes can't be played.`);
            else props.onSelect?.(ch, p);
          };
          return (
            <button
              key={p.start}
              type="button"
              className="prog"
              data-state={state}
              style={{ left: left + 2, width: Math.max(2, w - 4), paddingLeft: shift > 0 ? shift + 10 : undefined }}
              onClick={activate}
              onFocus={() => props.onSelect?.(ch, p)}
              title={`${fmtClock(p.start)}–${fmtClock(p.end)} ${p.title}`}
              aria-label={`${p.title}, ${fmtClock(p.start)} to ${fmtClock(p.end)}, ${tag}`}
              role="gridcell"
            >
              <span className="prog-inner">
                <span className="prog-t">{p.title}</span>
                {w > 90 && <span className="prog-s">{tag}</span>}
              </span>
            </button>
          );
        })}
    </>
  );
});
