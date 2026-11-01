/**
 * The ribbon: EPG program blocks above a thin track. Playable ranges, greyed gaps (with reason),
 * live-edge marker, playhead. Drag or tap to seek; arrow keys skip; Home/End jump to start/live.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { TimelineInfo } from '@anycast/shared';
import { clampFrac, fracToTime, layoutBlocks, programAt, timeToFrac, type Win } from './timelineMath';
import { fmtClock, fmtDuration } from '../lib/time';

interface RibbonProps {
  win: Win;
  now: number;
  position: number;
  timeline: TimelineInfo | null;
  showBlocks: boolean;
  onSeek: (t: number) => void;
  onSkip: (dir: -1 | 1) => void;
  onDragChange?: (dragging: boolean) => void;
  onBlockUnavailable: (reason: string) => void;
}

const pct = (f: number) => `${(clampFrac(f) * 100).toFixed(3)}%`;

export function Ribbon(props: RibbonProps) {
  const { win, now, position, timeline } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const ranges = timeline?.ranges ?? [];
  const gaps = timeline?.gaps ?? [];
  const programs = timeline?.programs ?? [];
  const blocks = useMemo(() => layoutBlocks(programs, win, position, now, ranges), [programs, win, position, now, ranges]);
  const shown = preview ?? position;
  const earliest = ranges[0]?.start ?? now;

  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    const t = fracToTime(clampFrac((clientX - r.left) / r.width), win);
    return Math.min(now, t);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setPreview(timeAt(e.clientX));
    props.onDragChange?.(true);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (preview !== null) setPreview(timeAt(e.clientX));
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (preview === null) return;
    const t = timeAt(e.clientX);
    setPreview(null);
    props.onDragChange?.(false);
    props.onSeek(t);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      props.onSkip(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      props.onSeek(earliest);
    } else if (e.key === 'End') {
      e.preventDefault();
      props.onSeek(now);
    }
  };

  const behind = Math.max(0, now - shown);
  const curRange = ranges.find((r) => position >= r.start && position <= r.end);
  const fillFrom = Math.max(win.start, curRange?.start ?? position);
  const previewProg = preview !== null ? programAt(preview, programs) : null;
  const gapInView = gaps.find((g) => g.end > win.start && g.start < Math.min(win.end, now));
  const startLabel = ranges.length && ranges[0]!.start > win.start ? `Nothing before ${fmtClock(ranges[0]!.start)}` : ranges[0]?.source === 'archive' ? 'archive' : '';

  return (
    <div className="ribbon">
      {props.showBlocks && (
        <div className="rb-blocks" data-nav-row="rb-blocks">
          {blocks.map((b) => (
            <button
              key={b.program.start}
              type="button"
              className="rb-block"
              data-state={b.state}
              data-playable={b.playable || b.state === 'now' ? '' : undefined}
              style={{ left: pct(b.left), width: `calc(${pct(b.width)} - 3px)` }}
              onClick={() =>
                b.program.start >= now
                  ? props.onBlockUnavailable(`${b.program.title} starts at ${fmtClock(b.program.start)}.`)
                  : b.playable || b.state === 'now'
                    ? props.onSeek(Math.max(b.program.start, earliest))
                    : props.onBlockUnavailable(gaps.find((g) => b.program.start >= g.start && b.program.start < g.end)?.reason ?? 'This programme is not available to play.')
              }
              title={`${fmtClock(b.program.start)}–${fmtClock(b.program.end)} ${b.program.title}`}
              aria-label={`${b.program.title}, ${fmtClock(b.program.start)} to ${fmtClock(b.program.end)}${b.program.start < now ? ', play from start' : ''}`}
              tabIndex={b.width < 0.04 ? -1 : 0}
            >
              <span className="ellipsis">{b.program.title}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={trackRef}
        className={`rb-track${preview !== null ? ' dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Timeline"
        aria-valuemin={win.start}
        aria-valuemax={now}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${fmtClock(shown)}${behind > 15_000 ? `, ${fmtDuration(behind / 1000)} behind live` : ', live'}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (setPreview(null), props.onDragChange?.(false))}
        onKeyDown={onKey}
        data-nav-autofocus=""
      >
        <div className="rb-rail">
          {ranges.map((r) => (
            <i key={r.start} className="rb-range" data-source={r.source} style={{ left: pct(timeToFrac(r.start, win)), width: pct(timeToFrac(Math.min(r.end, now), win) - timeToFrac(r.start, win)) }} />
          ))}
          {gaps.map((g) => (
            <i key={g.start} className="rb-gap" title={g.reason} style={{ left: pct(timeToFrac(g.start, win)), width: pct(timeToFrac(g.end, win) - timeToFrac(g.start, win)) }} />
          ))}
          <i className="rb-fill" style={{ left: pct(timeToFrac(fillFrom, win)), width: pct(timeToFrac(shown, win) - timeToFrac(fillFrom, win)) }} />
          <i className="rb-future" style={{ left: pct(timeToFrac(now, win)), right: 0 }} />
        </div>
        <i className="rb-live" style={{ left: pct(timeToFrac(now, win)) }} aria-hidden="true" />
        <i className="rb-knob" style={{ left: pct(timeToFrac(shown, win)) }} aria-hidden="true" />
        {preview !== null && (
          <span className="rb-tip tabnum" style={{ left: pct(timeToFrac(preview, win)) }}>
            {fmtClock(preview)}
            {previewProg && <small className="ellipsis">{previewProg.title}</small>}
          </span>
        )}
      </div>
      <div className="rb-labels tabnum">
        <span>
          {fmtClock(win.start)}
          {startLabel && ` · ${startLabel}`}
        </span>
        <span className="rb-cur">{fmtClock(shown)}</span>
        <span>{fmtClock(now)} live</span>
      </div>
      {gapInView && (
        <p className="rb-gap-note">
          <i className="rb-gap-swatch" aria-hidden="true" />
          {fmtClock(gapInView.start)}–{fmtClock(Math.min(gapInView.end, now))} unavailable: {gapInView.reason}
        </p>
      )}
    </div>
  );
}

/** Plain scrub bar for movies and episodes. */
export function VodBar(props: { position: number; duration: number; buffered: number; onSeek: (s: number) => void; onSkip: (dir: -1 | 1) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const d = props.duration || 1;
  const shown = preview ?? props.position;
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return clampFrac((x - r.left) / r.width) * d;
  };
  return (
    <div className="ribbon vod">
      <div
        ref={ref}
        className={`rb-track${preview !== null ? ' dragging' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(d)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={`${fmtDuration(shown)} of ${fmtDuration(d)}`}
        data-nav-autofocus=""
        onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), setPreview(at(e.clientX)))}
        onPointerMove={(e) => preview !== null && setPreview(at(e.clientX))}
        onPointerUp={(e) => {
          if (preview === null) return;
          setPreview(null);
          props.onSeek(at(e.clientX));
        }}
        onPointerCancel={() => setPreview(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            props.onSkip(e.key === 'ArrowLeft' ? -1 : 1);
          } else if (e.key === 'Home') props.onSeek(0);
        }}
      >
        <div className="rb-rail">
          <i className="rb-range" style={{ left: 0, width: pct(props.buffered / d) }} />
          <i className="rb-fill" style={{ left: 0, width: pct(shown / d) }} />
        </div>
        <i className="rb-knob" style={{ left: pct(shown / d) }} aria-hidden="true" />
        {preview !== null && (
          <span className="rb-tip tabnum" style={{ left: pct(preview / d) }}>
            {fmtDuration(preview)}
          </span>
        )}
      </div>
      <div className="rb-labels tabnum">
        <span className="rb-cur">{fmtDuration(shown)}</span>
        <span>−{fmtDuration(Math.max(0, d - shown))}</span>
      </div>
    </div>
  );
}
