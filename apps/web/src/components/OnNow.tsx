/**
 * "On now": favorite channels on one shared timeline. Every row is cut from the same window of
 * time, so the now-line runs straight through all of them and a glance shows what is on, how far
 * in it is and what follows. A row opens its channel.
 */
import type { EpgProgram, LiveChannelWithNow } from '@anycast/shared';
import { useApp } from '../store/app';
import { whenUnlocked } from '../store/parental';
import { useElementWidth } from '../lib/hooks';
import { fmtClock } from '../lib/time';
import { prefetchPlayer } from '../player/prefetch';
import { LogoTile } from './ui';

const MIN = 60_000;
const TICK = 30 * MIN;

/**
 * The stretch of time the strip shows: a little of the past, mostly what is ahead. How much
 * depends on the room the timeline has, so a programme's block stays wide enough for its title
 * (a phone shows about an hour and a half, a wide desktop three hours).
 */
export function onNowWindow(now: number, trackWidth: number, wide: boolean) {
  const perMinute = wide ? 5 : 3.6;
  const fallback = wide ? 180 : 90;
  const span = trackWidth > 0 ? Math.min(180, Math.max(60, Math.round(trackWidth / perMinute / 30) * 30)) : fallback;
  const start = now - Math.min(30, Math.max(15, span / 6)) * MIN;
  return { start, end: start + span * MIN };
}

/** The room (px) a title needs beside the now-line to sit clear of it. */
const TITLE_ROOM = 92;

/** Where a programme sits in the window, as fractions of its width; null when it is outside. */
export function placeProgram(p: Pick<EpgProgram, 'start' | 'end'>, win: { start: number; end: number }) {
  const span = win.end - win.start;
  const left = Math.max(0, (p.start - win.start) / span);
  const right = Math.min(1, (p.end - win.start) / span);
  return right - left > 0.005 ? { left, width: right - left } : null;
}

/** Half-hour marks inside the window (not hard against its right edge, where a label would be cut). */
export function onNowTicks(win: { start: number; end: number }) {
  const out: { t: number; at: number }[] = [];
  for (let t = Math.ceil(win.start / TICK) * TICK; t < win.end; t += TICK) {
    const at = (t - win.start) / (win.end - win.start);
    if (at <= 0.88) out.push({ t, at });
  }
  return out;
}

export function timeLeftText(end: number, now: number) {
  const m = Math.max(1, Math.round((end - now) / MIN));
  return m < 60 ? `${m} min left` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} left`;
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

export function OnNow(props: { rows: LiveChannelWithNow[]; now: number; wide: boolean; onOpen: (id: string) => void }) {
  const { now } = props;
  const showNumbers = useApp((s) => s.prefs.live.showChannelNumbers);
  const [trackRef, trackWidth] = useElementWidth<HTMLSpanElement>();
  const win = onNowWindow(now, trackWidth, props.wide);
  const nowAt = (now - win.start) / (win.end - win.start);
  // until it is measured, guess the track from the kind of screen
  const trackPx = trackWidth || (props.wide ? 900 : 300);
  /** A block's text starts after the now-line when there is room there; a short block has it across the line. */
  const side = (at: { left: number; width: number }) => ((at.left + at.width - nowAt) * trackPx >= TITLE_ROOM ? ' on-ahead' : ' on-cross');
  return (
    <div className="on-now" style={{ ['--on-at' as string]: nowAt.toFixed(4) }}>
      <div className="on-ticks tabnum" aria-hidden="true">
        <span className="on-lead" />
        <span className="on-track" ref={trackRef}>
          {/* a mark just before the now-line would have its label run into it */}
          {onNowTicks(win)
            .filter((k) => !((nowAt - k.at) * trackPx > 0 && (nowAt - k.at) * trackPx < 46))
            .map((k) => (
              <span key={k.t} className="on-tick" style={{ left: pct(k.at) }}>
                {fmtClock(k.t)}
              </span>
            ))}
        </span>
      </div>
      <ul className="on-rows" aria-label="Favorite channels">
        {props.rows.map((ch) => {
          const cur = ch.now && ch.now.end > now ? ch.now : null;
          const curAt = cur && placeProgram(cur, win);
          const nextAt = ch.next && placeProgram(ch.next, win);
          return (
            <li key={ch.id}>
              <button
                type="button"
                className="on-row"
                onClick={() => whenUnlocked(ch.locked, () => props.onOpen(ch.id))}
                onMouseEnter={prefetchPlayer}
                onFocus={prefetchPlayer}
                aria-label={`${showNumbers ? ch.number + ' ' : ''}${ch.name}${cur ? `, now: ${cur.title}, ${timeLeftText(cur.end, now)}` : ''}${ch.next ? `, next: ${ch.next.title}` : ''}`}
              >
                <span className="on-lead">
                  <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />
                  <span className="on-name ellipsis">{ch.name}</span>
                </span>
                <span className="on-track">
                  {cur && curAt && (
                    <span className="on-block on-cur" style={{ left: pct(curAt.left), width: pct(curAt.width) }}>
                      <span className={`on-cell${side(curAt)}`} style={{ ['--on-done' as string]: Math.min(1, Math.max(0, (nowAt - curAt.left) / curAt.width)).toFixed(4) }}>
                        <span className="on-title ellipsis">{cur.title}</span>
                        <span className="on-left tabnum ellipsis">{timeLeftText(cur.end, now)}</span>
                      </span>
                    </span>
                  )}
                  {ch.next && nextAt && (
                    <span className="on-block on-next" style={{ left: pct(nextAt.left), width: pct(nextAt.width) }}>
                      <span className="on-cell">
                        <span className="on-title ellipsis">{ch.next.title}</span>
                      </span>
                    </span>
                  )}
                  {!curAt && !nextAt && (
                    <span className="on-block on-none" style={{ left: 0, width: '100%' }}>
                      <span className="on-cell on-ahead" style={{ ['--on-done' as string]: nowAt.toFixed(4) }}>
                        <span className="on-title ellipsis">{ch.name}</span>
                        <span className="on-left ellipsis">{ch.hasEpg ? 'Nothing listed right now' : 'No guide for this channel'}</span>
                      </span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <span className="on-line" aria-hidden="true" />
    </div>
  );
}
