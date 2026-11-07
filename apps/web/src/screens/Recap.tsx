/**
 * The recap: a Wrapped-style look back at what this profile watched, as full-screen story cards
 * that play one after another. Tap or click the right side (or →) for the next card, the left side
 * (or ←) for the one before; hold (or Space) to pause. The data comes from GET /api/recap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { recapPersona, recapRange, type Recap, type RecapItem, type RecapPeriod, type RecapPersonaId } from '@anycast/shared';
import { call } from '../api/client';
import { useApp } from '../store/app';
import { useAsync } from '../lib/hooks';
import { toneFor } from '../lib/misc';
import { toast } from '../store/actions';
import { LogoTile } from '../components/ui';
import { Art } from '../components/cards';
import { IconBack, IconChevron, IconClose, IconPause, IconPlay } from '../components/Icons';
import { ProfileAvatar } from '../profiles/Avatar';
import '../theme/recap.css';

const CARD_MS = 7_000;
/** less than this in a period: the recap says it is still warming up */
const MIN_RECAP_S = 5 * 60;

export const RECAP_PERIODS: { id: RecapPeriod; label: string }[] = [
  { id: 'month', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'year', label: 'This year' },
  { id: 'lastYear', label: 'Last year' },
  { id: 'all', label: 'All time' },
];
const isPeriod = (p: string | null): p is RecapPeriod => RECAP_PERIODS.some((x) => x.id === p);

/* ---------------- formatting ---------------- */
const hoursOf = (s: number) => Math.floor(s / 3600);
const minutesOf = (s: number) => Math.round((s % 3600) / 60);
export function fmtWatch(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const h = hoursOf(s);
  const m = minutesOf(s);
  if (!h) return `${m} min`;
  return m && h < 10 ? `${h} h ${m} min` : `${h} h`;
}
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const dayLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long' });

function periodTitle(period: RecapPeriod) {
  return recapRange(period).title;
}

/** Counts up to `to` while the card is shown. */
function useCountUp(to: number, active: boolean, ms = 1400) {
  const [v, setV] = useState(active ? 0 : to);
  useEffect(() => {
    if (!active) return setV(to);
    if (document.documentElement.dataset.anim !== 'full') return setV(to);
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    setV(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, active, ms]);
  return v;
}

/* ---------------- cards ---------------- */
interface CardDef {
  id: string;
  /** the card's colour, mixed into the accent */
  tone: string;
  render: (active: boolean) => React.ReactNode;
}

function buildCards(r: Recap, period: RecapPeriod, ctx: { name: string; onPeriod: (p: RecapPeriod) => void; replay: () => void; close: () => void }): CardDef[] {
  const title = periodTitle(period);
  const cards: CardDef[] = [];
  const persona = recapPersona(r);

  cards.push({ id: 'intro', tone: '#7C5CFF', render: (a) => <IntroCard r={r} period={period} title={title} name={ctx.name} onPeriod={ctx.onPeriod} active={a} /> });
  cards.push({ id: 'total', tone: '#FF6B4A', render: (a) => <TotalCard r={r} period={period} active={a} /> });
  const kinds = [r.byKind.live, r.byKind.movie, r.byKind.episode].filter((x) => x > 0).length;
  if (kinds > 1) cards.push({ id: 'mix', tone: '#2BB3A3', render: (a) => <MixCard r={r} active={a} /> });
  if (r.topChannels.length) cards.push({ id: 'channels', tone: '#3E8BFF', render: (a) => <TopCard kind="live" items={r.topChannels} active={a} /> });
  if (r.topSeries.length) cards.push({ id: 'series', tone: '#E0457B', render: (a) => <TopCard kind="series" items={r.topSeries} active={a} /> });
  if (r.topMovies.length) cards.push({ id: 'movies', tone: '#F5A524', render: (a) => <TopCard kind="movie" items={r.topMovies} active={a} /> });
  if (r.genres.length > 1) cards.push({ id: 'genres', tone: '#8BC34A', render: (a) => <GenresCard r={r} active={a} /> });
  cards.push({ id: 'clock', tone: '#5C6BC0', render: (a) => <ClockCard r={r} active={a} /> });
  cards.push({ id: 'persona', tone: PERSONA_TONE[persona.id], render: (a) => <PersonaCard id={persona.id} title={persona.title} line={persona.line} active={a} /> });
  cards.push({ id: 'summary', tone: '#7C5CFF', render: () => <SummaryCard r={r} title={title} persona={persona.title} name={ctx.name} replay={ctx.replay} close={ctx.close} /> });
  return cards;
}

const PERSONA_TONE: Record<RecapPersonaId, string> = {
  'night-owl': '#4B3FD1', 'early-bird': '#FF9F1C', binger: '#E0457B', cinephile: '#C0392B',
  surfer: '#00A8E8', loyal: '#2BB3A3', weekender: '#FF6B4A', explorer: '#8BC34A',
};

function PeriodChips(props: { period: RecapPeriod; onPeriod: (p: RecapPeriod) => void }) {
  return (
    <div className="rc-chips" role="radiogroup" aria-label="Period" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      {RECAP_PERIODS.map((p) => (
        <button key={p.id} type="button" role="radio" aria-checked={p.id === props.period} className={`rc-chip${p.id === props.period ? ' on' : ''}`} onClick={() => props.onPeriod(p.id)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

function IntroCard(props: { r: Recap; period: RecapPeriod; title: string; name: string; onPeriod: (p: RecapPeriod) => void; active: boolean }) {
  const profile = useApp((s) => s.me?.profiles.find((p) => p.id === s.profileId));
  return (
    <div className="rc-body rc-intro">
      <div className="rc-kicker">AnyCast Recap</div>
      {profile && (
        <div className="rc-who rc-in" style={{ ['--i' as string]: 0 }}>
          <ProfileAvatar profile={profile} size="lg" />
        </div>
      )}
      <h2 className="rc-huge rc-in" style={{ ['--i' as string]: 1 }}>
        {props.period === 'all' ? 'Your story' : 'Your'}
        <br />
        <span className="rc-accent">{props.period === 'all' ? 'so far' : props.title}</span>
      </h2>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 2 }}>
        {props.name ? `${props.name}, here` : 'Here'}'s what you watched{props.period === 'all' ? '' : ' in ' + props.title}. Ready?
      </p>
      <PeriodChips period={props.period} onPeriod={props.onPeriod} />
    </div>
  );
}

function TotalCard({ r, period, active }: { r: Recap; period: RecapPeriod; active: boolean }) {
  const hours = useCountUp(r.totalSeconds / 3600, active);
  const big = r.totalSeconds >= 3600;
  const minutes = useCountUp(r.totalSeconds / 60, active);
  const movies = Math.round(r.totalSeconds / (110 * 60));
  const prevName = period === 'month' || period === 'lastMonth' ? 'the month before' : period === 'all' ? '' : 'the year before';
  const delta = r.previousSeconds && r.previousSeconds > 0 ? Math.round(((r.totalSeconds - r.previousSeconds) / r.previousSeconds) * 100) : null;
  return (
    <div className="rc-body">
      <div className="rc-kicker">Time well spent</div>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 0 }}>You watched</p>
      <div className="rc-number rc-in tabnum" style={{ ['--i' as string]: 1 }}>
        {big ? Math.floor(hours).toLocaleString('en') : Math.round(minutes)}
        <span className="rc-unit">{big ? (Math.floor(hours) === 1 ? 'hour' : 'hours') : 'minutes'}</span>
      </div>
      {big && minutesOf(r.totalSeconds) > 0 && (
        <p className="rc-lead rc-in" style={{ ['--i' as string]: 2 }}>
          and {minutesOf(r.totalSeconds)} minutes
        </p>
      )}
      <ul className="rc-facts">
        <li className="rc-in" style={{ ['--i' as string]: 3 }}>
          on <b>{r.counts.days}</b> {r.counts.days === 1 ? 'day' : 'days'}
          {r.longestStreak > 1 && (
            <>
              , <b>{r.longestStreak}</b> of them in a row
            </>
          )}
        </li>
        {movies >= 2 && (
          <li className="rc-in" style={{ ['--i' as string]: 4 }}>
            that's about <b>{movies}</b> feature films back to back
          </li>
        )}
        {delta !== null && prevName && (
          <li className="rc-in" style={{ ['--i' as string]: 5 }}>
            <b className={delta >= 0 ? 'rc-up' : 'rc-down'}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
            </b>{' '}
            {delta >= 0 ? 'more' : 'less'} than {prevName}
          </li>
        )}
      </ul>
    </div>
  );
}

function MixCard({ r, active }: { r: Recap; active: boolean }) {
  const rows = [
    { label: 'Live TV', s: r.byKind.live, note: r.counts.channels ? `${r.counts.channels} ${r.counts.channels === 1 ? 'channel' : 'channels'}` : '' },
    { label: 'Series', s: r.byKind.episode, note: r.counts.episodes ? `${r.counts.episodes} ${r.counts.episodes === 1 ? 'episode' : 'episodes'}` : '' },
    { label: 'Movies', s: r.byKind.movie, note: r.counts.movies ? `${r.counts.movies} ${r.counts.movies === 1 ? 'movie' : 'movies'}` : '' },
  ]
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const max = Math.max(...rows.map((x) => x.s));
  return (
    <div className="rc-body">
      <div className="rc-kicker">Your mix</div>
      <h2 className="rc-title rc-in" style={{ ['--i' as string]: 0 }}>
        Mostly <span className="rc-accent">{rows[0]!.label}</span>
      </h2>
      <div className="rc-bars">
        {rows.map((x, i) => (
          <div key={x.label} className="rc-bar rc-in" style={{ ['--i' as string]: i + 1 }}>
            <div className="rc-bar-head">
              <span>{x.label}</span>
              <span className="tabnum">{pct(x.s, r.totalSeconds)}%</span>
            </div>
            <div className="rc-bar-track">
              <div className="rc-bar-fill" style={{ width: active ? `${(x.s / max) * 100}%` : '0%' }} />
            </div>
            <div className="rc-bar-note">
              {fmtWatch(x.s)}
              {x.note ? ` · ${x.note}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemArt({ item, big }: { item: RecapItem; big?: boolean }) {
  if (item.kind === 'live') {
    return (
      <div className={`rc-logo${big ? ' big' : ''}`}>
        <LogoTile name={item.name} logo={item.art} locked={item.locked} />
      </div>
    );
  }
  return (
    <div className={`rc-poster${big ? ' big' : ''}`}>
      <Art id={item.id} name={item.name} src={item.art} locked={item.locked} />
    </div>
  );
}

const TOP_COPY = {
  live: { kicker: 'On repeat', title: 'Your #1 channel', count: (n: number) => `on ${n} ${n === 1 ? 'day' : 'days'}` },
  series: { kicker: 'Hooked', title: 'Your top series', count: (n: number) => `${n} ${n === 1 ? 'episode' : 'episodes'}` },
  movie: { kicker: 'Main feature', title: 'Your top movie', count: () => '' },
} as const;

function TopCard({ kind, items }: { kind: 'live' | 'series' | 'movie'; items: RecapItem[]; active: boolean }) {
  const copy = TOP_COPY[kind];
  const [top, ...rest] = items;
  const meta = (x: RecapItem) => [fmtWatch(x.seconds), x.count ? copy.count(x.count) : ''].filter(Boolean).join(' · ');
  return (
    <div className={`rc-body rc-top rc-top-${kind}`}>
      <div className="rc-kicker">{copy.kicker}</div>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 0 }}>
        {copy.title}
      </p>
      <div className="rc-hero rc-pop" style={{ ['--i' as string]: 1 }}>
        <ItemArt item={top!} big />
      </div>
      <h2 className="rc-title rc-in rc-clamp" style={{ ['--i' as string]: 2 }}>
        {top!.name}
      </h2>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 3 }}>
        {meta(top!)}
      </p>
      {rest.length > 0 && (
        <ol className="rc-list" start={2}>
          {rest.map((x, i) => (
            <li key={x.id} className="rc-in" style={{ ['--i' as string]: 4 + i }}>
              <span className="rc-rank tabnum">{i + 2}</span>
              <ItemArt item={x} />
              <span className="rc-list-name ellipsis">{x.name}</span>
              <span className="rc-list-meta tabnum">{fmtWatch(x.seconds)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function GenresCard({ r, active }: { r: Recap; active: boolean }) {
  const total = r.genres.reduce((n, g) => n + g.seconds, 0);
  return (
    <div className="rc-body">
      <div className="rc-kicker">Your taste</div>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 0 }}>
        Your top genre
      </p>
      <h2 className="rc-huge rc-in rc-clamp" style={{ ['--i' as string]: 1 }}>
        <span className="rc-accent">{r.genres[0]!.name}</span>
      </h2>
      <div className="rc-genres">
        {r.genres.map((g, i) => {
          const share = g.seconds / total;
          return (
            <span
              key={g.name}
              className={`rc-genre rc-pop${i === 0 ? ' first' : ''}`}
              style={{ ['--i' as string]: i + 2, ['--size' as string]: `${0.85 + Math.sqrt(share) * 1.4}rem`, ['--tone' as string]: toneFor(g.name), opacity: active ? undefined : 0 }}
            >
              {g.name}
              <small className="tabnum">{pct(g.seconds, total)}%</small>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function ClockCard({ r, active }: { r: Recap; active: boolean }) {
  const peak = r.hours.indexOf(Math.max(...r.hours));
  const max = Math.max(...r.hours, 1);
  const day = r.weekdays.indexOf(Math.max(...r.weekdays));
  const label = peak >= 22 || peak < 4 ? 'Late night' : peak < 12 ? 'Morning' : peak < 17 ? 'Afternoon' : 'Prime time';
  return (
    <div className="rc-body">
      <div className="rc-kicker">When you watch</div>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 0 }}>
        Your favourite time
      </p>
      <h2 className="rc-huge rc-in" style={{ ['--i' as string]: 1 }}>
        <span className="rc-accent tabnum">{hourLabel(peak)}</span>
      </h2>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 2 }}>
        {label} is your time
      </p>
      <div className="rc-hours rc-in" style={{ ['--i' as string]: 3 }} aria-hidden="true">
        {r.hours.map((s, h) => (
          <span key={h} className={`rc-hour${h === peak ? ' peak' : ''}`} style={{ height: active ? `${Math.max(4, (s / max) * 100)}%` : '4%', transitionDelay: `${h * 25}ms` }} />
        ))}
      </div>
      <div className="rc-hours-axis" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
      <ul className="rc-facts">
        <li className="rc-in" style={{ ['--i' as string]: 4 }}>
          <b>{WEEKDAYS[day]}s</b> are your busiest day
        </li>
        {r.topDay && (
          <li className="rc-in" style={{ ['--i' as string]: 5 }}>
            biggest day: <b>{dayLabel(r.topDay.date)}</b>, {fmtWatch(r.topDay.seconds)}
          </li>
        )}
      </ul>
    </div>
  );
}

const PERSONA_GLYPH: Record<RecapPersonaId, React.ReactNode> = {
  'night-owl': <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  'early-bird': (
    <>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  binger: (
    <>
      <rect x="2.5" y="6" width="15" height="11" rx="2" />
      <path d="M6 3.5h13a2 2 0 012 2V14" />
    </>
  ),
  cinephile: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" />
    </>
  ),
  surfer: <path d="M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M12 3l3 6h-6z" />,
  loyal: <path d="M12 20.5s-8-4.6-8-10.6A4.4 4.4 0 0112 7a4.4 4.4 0 018 2.9c0 6-8 10.6-8 10.6z" />,
  weekender: (
    <>
      <path d="M4 12h16v5a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
      <path d="M6 12V8a2 2 0 012-2h8a2 2 0 012 2v4M6 19v2M18 19v2" />
    </>
  ),
  explorer: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </>
  ),
};

function PersonaCard(props: { id: RecapPersonaId; title: string; line: string; active: boolean }) {
  return (
    <div className="rc-body rc-persona">
      <div className="rc-kicker">Your viewer type</div>
      <div className="rc-glyph rc-pop" style={{ ['--i' as string]: 0 }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {PERSONA_GLYPH[props.id]}
        </svg>
      </div>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 1 }}>
        You're
      </p>
      <h2 className="rc-huge rc-in" style={{ ['--i' as string]: 2 }}>
        <span className="rc-accent">{props.title}</span>
      </h2>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 3 }}>
        {props.line}
      </p>
    </div>
  );
}

function shareText(r: Recap, title: string, persona: string) {
  const lines = [
    `My AnyCast Recap · ${title}`,
    `${fmtWatch(r.totalSeconds)} watched on ${r.counts.days} ${r.counts.days === 1 ? 'day' : 'days'}`,
    r.topChannels[0] && `Top channel: ${r.topChannels[0].name}`,
    r.topSeries[0] && `Top series: ${r.topSeries[0].name}`,
    r.topMovies[0] && `Top movie: ${r.topMovies[0].name}`,
    r.genres[0] && `Top genre: ${r.genres[0].name}`,
    `Viewer type: ${persona}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function SummaryCard(props: { r: Recap; title: string; persona: string; name: string; replay: () => void; close: () => void }) {
  const { r } = props;
  const share = async () => {
    const text = shareText(r, props.title, props.persona);
    try {
      if (navigator.share) await navigator.share({ title: 'My AnyCast Recap', text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Copied your recap');
      }
    } catch {
      /* the share sheet was closed */
    }
  };
  const tiles: { label: string; value: string; item?: RecapItem }[] = [
    { label: 'Watched', value: fmtWatch(r.totalSeconds) },
    { label: 'Viewer type', value: props.persona },
  ];
  if (r.topChannels[0]) tiles.push({ label: 'Top channel', value: r.topChannels[0].name, item: r.topChannels[0] });
  if (r.topSeries[0]) tiles.push({ label: 'Top series', value: r.topSeries[0].name, item: r.topSeries[0] });
  if (r.topMovies[0]) tiles.push({ label: 'Top movie', value: r.topMovies[0].name, item: r.topMovies[0] });
  if (r.genres[0]) tiles.push({ label: 'Top genre', value: r.genres[0].name });
  return (
    <div className="rc-body rc-summary">
      <div className="rc-kicker">AnyCast Recap · {props.title}</div>
      <h2 className="rc-title rc-in" style={{ ['--i' as string]: 0 }}>
        {props.name ? `${props.name}'s` : 'Your'} {props.title === 'All time' ? 'story so far' : props.title}
      </h2>
      <div className="rc-tiles">
        {tiles.slice(0, 6).map((t, i) => (
          <div key={t.label} className="rc-tile rc-in" style={{ ['--i' as string]: i + 1 }}>
            {t.item && <ItemArt item={t.item} />}
            <div className="rc-tile-text">
              <span className="rc-tile-label">{t.label}</span>
              <span className="rc-tile-value rc-clamp">{t.value}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="rc-actions" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="btn btn-primary" onClick={() => void share()}>
          Share
        </button>
        <button type="button" className="btn" onClick={props.replay}>
          Watch again
        </button>
        <button type="button" className="btn" onClick={props.close}>
          Done
        </button>
      </div>
    </div>
  );
}

function WarmingUp(props: { r: Recap | null; period: RecapPeriod; onPeriod: (p: RecapPeriod) => void; close: () => void }) {
  const since = props.r?.historySince;
  return (
    <div className="rc-body rc-intro">
      <div className="rc-kicker">AnyCast Recap</div>
      <h2 className="rc-title rc-in" style={{ ['--i' as string]: 0 }}>
        Your recap is still warming up
      </h2>
      <p className="rc-lead rc-in" style={{ ['--i' as string]: 1 }}>
        {since
          ? `AnyCast has been keeping track since ${new Date(since).toLocaleDateString('en', { day: 'numeric', month: 'long', year: 'numeric' })}. There isn't enough for ${periodTitle(props.period) === 'All time' ? 'a recap' : periodTitle(props.period)} yet, so try another period or come back after a few more evenings on the couch.`
          : 'AnyCast starts keeping track of what you watch now. Come back after a few more evenings on the couch.'}
      </p>
      <PeriodChips period={props.period} onPeriod={props.onPeriod} />
      <div className="rc-actions">
        <button type="button" className="btn" onClick={props.close}>
          Close
        </button>
      </div>
    </div>
  );
}

/* ---------------- the story player ---------------- */
export default function RecapScreen() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('p');
  const period: RecapPeriod = isPeriod(raw) ? raw : 'month';
  const profileId = useApp((s) => s.profileId);
  const name = useApp((s) => s.me?.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  const range = useMemo(() => recapRange(period), [period]);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);
  const recap = useAsync(() => call('GET /api/recap', { query: { from: range.from, to: range.to, tz } }), [range.from, range.to, tz, profileId]);

  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const autoplay = document.documentElement.dataset.anim === 'full';

  const close = useCallback(() => {
    if ((history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate('/home', { replace: true });
  }, [navigate]);
  const setPeriod = useCallback(
    (p: RecapPeriod) => {
      setSp({ p }, { replace: true });
      setIndex(0);
      setElapsed(0);
    },
    [setSp],
  );
  const replay = useCallback(() => {
    setIndex(0);
    setElapsed(0);
    setPaused(false);
  }, []);

  const r = recap.data ?? null;
  const enough = !!r && r.totalSeconds >= MIN_RECAP_S;
  const cards = useMemo(() => (r && enough ? buildCards(r, period, { name, onPeriod: setPeriod, replay, close }) : []), [r, enough, period, name, setPeriod, replay, close]);
  const count = cards.length;
  const last = index >= count - 1;

  const go = useCallback(
    (d: number) => {
      setElapsed(0);
      setIndex((i) => Math.max(0, Math.min(count - 1, i + d)));
    },
    [count],
  );

  // the clock of the current card; the last card stays
  const stopped = held || paused || !autoplay || last || !count;
  useEffect(() => {
    if (stopped) return;
    let raf = 0;
    let prev = performance.now();
    const step = (t: number) => {
      const dt = t - prev;
      prev = t;
      setElapsed((e) => {
        const n = e + dt;
        if (n >= CARD_MS) {
          setIndex((i) => Math.min(count - 1, i + 1));
          return 0;
        }
        return n;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [stopped, count, index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) setPaused((p) => !p);
      else if (e.key === 'Escape' || e.key === 'GoBack' || e.key === 'BrowserBack') close();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, close]);

  // tap: left third back, the rest forward; a long press only pauses
  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const holdTimer = useRef<number>();
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    holdTimer.current = window.setTimeout(() => setHeld(true), 220);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    window.clearTimeout(holdTimer.current);
    const d = down.current;
    down.current = null;
    setHeld(false);
    if (!d) return;
    const long = performance.now() - d.t > 350;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 50) return go(dx < 0 ? 1 : -1); // swipe
    if (e.clientY - d.y > 90) return close(); // swipe down
    if (long) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    go(e.clientX - box.left < box.width / 3 ? -1 : 1);
  };
  const onPointerCancel = () => {
    window.clearTimeout(holdTimer.current);
    down.current = null;
    setHeld(false);
  };

  const card = cards[index];
  const tone = card?.tone ?? '#7C5CFF';
  return (
    <div className="recap" style={{ ['--rc-tone' as string]: tone }} role="dialog" aria-modal="true" aria-label="Your recap">
      <div className="rc-backdrop" aria-hidden="true" />
      <button type="button" className="rc-side rc-prev" aria-label="Previous card" onClick={() => go(-1)} disabled={index === 0 || !count}>
        <IconBack />
      </button>
      <div className="rc-stage">
        <div className="rc-frame">
          <div className="rc-glow" aria-hidden="true" />
          <div className="rc-top-bar">
            <div className="rc-progress" aria-hidden="true">
              {(count ? cards : [null]).map((c, i) => (
                <span key={c?.id ?? i} className="rc-seg">
                  <span style={{ width: i < index ? '100%' : i === index ? `${last || !autoplay ? 100 : (elapsed / CARD_MS) * 100}%` : '0%' }} />
                </span>
              ))}
            </div>
            <div className="rc-tools">
              {count > 0 && autoplay && !last && (
                <button type="button" className="rc-icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play' : 'Pause'}>
                  {paused ? <IconPlay /> : <IconPause />}
                </button>
              )}
              <button type="button" className="rc-icon" onClick={close} aria-label="Close recap">
                <IconClose />
              </button>
            </div>
          </div>
          {recap.loading && !r ? (
            <div className="rc-body rc-loading" aria-busy="true">
              <div className="rc-kicker">AnyCast Recap</div>
              <h2 className="rc-title">Adding it all up…</h2>
            </div>
          ) : recap.error && !r ? (
            <div className="rc-body rc-intro">
              <h2 className="rc-title">Couldn't load your recap</h2>
              <div className="rc-actions">
                <button type="button" className="btn btn-primary" onClick={recap.reload}>
                  Try again
                </button>
                <button type="button" className="btn" onClick={close}>
                  Close
                </button>
              </div>
            </div>
          ) : !enough ? (
            <WarmingUp r={r} period={period} onPeriod={setPeriod} close={close} />
          ) : (
            <div
              key={`${period}-${card!.id}`}
              className="rc-card"
              role="group"
              aria-roledescription="card"
              aria-label={`${index + 1} of ${count}`}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onPointerLeave={onPointerCancel}
              onContextMenu={(e) => e.preventDefault()}
            >
              {card!.render(true)}
            </div>
          )}
        </div>
      </div>
      <button type="button" className="rc-side rc-next" aria-label="Next card" onClick={() => go(1)} disabled={last || !count}>
        <IconChevron />
      </button>
    </div>
  );
}
