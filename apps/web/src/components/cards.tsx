/** Poster, continue-watching and channel cards. */
import { memo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { LiveChannelWithNow, Movie, Series } from '@anycast/shared';
import { useApp, useIsFavorite } from '../store/app';
import { toneFor } from '../lib/misc';
import { fmtClock, fmtDuration } from '../lib/time';
import { IconLock, IconMore, IconStar } from './Icons';
import { useChannelMenu } from './lists';
import { whenUnlocked } from '../store/parental';
import { LogoTile, ProgressBar } from './ui';
import { prefetch } from '../api/client';
import { prefetchPlayer } from '../player/prefetch';

/** Locked adult items: the link asks for the PIN first, then continues. */
function useLockedLink(locked: boolean | undefined, to: string) {
  const navigate = useNavigate();
  return locked
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        whenUnlocked(true, () => navigate(to));
      }
    : undefined;
}

function Art(props: { id: string; name: string; src: string | null; children?: React.ReactNode; wide?: boolean; locked?: boolean }) {
  const show = useApp((s) => s.prefs.appearance.showArtwork);
  const [broken, setBroken] = useState(false);
  return (
    <div className={props.wide ? 'wide-art' : 'poster-art'} style={{ background: toneFor(props.id) }}>
      {props.locked ? (
        <span className="ph ph-locked">
          <IconLock />
          {!props.wide && props.name}
        </span>
      ) : show && props.src && !broken ? (
        <img src={props.src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
      ) : !props.wide ? (
        <span className="ph">{props.name}</span>
      ) : null}
      {props.children}
    </div>
  );
}

export const PosterCard = memo(function PosterCard(props: { kind: 'movie' | 'series'; item: Movie | Series; navRow?: string; /** the caller shows its own star */ noBadge?: boolean }) {
  const { item, kind } = props;
  const fav = useIsFavorite(kind, item.id);
  const to = kind === 'movie' ? `/movies/${item.id}` : `/series/${item.id}`;
  const meta = [item.year, item.rating ? item.rating.toFixed(1) : null].filter(Boolean).join(' · ');
  const warm = () => !item.locked && kind === 'series' && prefetch('GET /api/series/:id', { params: { id: item.id } });
  const onClick = useLockedLink(item.locked, to);
  return (
    <Link to={to} className="poster" onClick={onClick} onMouseEnter={warm} onFocus={warm} aria-label={`${item.name}${meta ? ', ' + meta : ''}${fav ? ', favorite' : ''}`}>
      <Art id={item.id} name={item.name} src={item.poster} locked={item.locked}>
        {fav && !props.noBadge && (
          <span className="badge">
            <IconStar filled />
          </span>
        )}
      </Art>
      <div className="poster-title">{item.name}</div>
      <div className="poster-meta">{meta || ' '}</div>
    </Link>
  );
});

export function ContinueCard(props: { to: string; id: string; title: string; subtitle?: string; poster: string | null; position: number; duration: number; locked?: boolean }) {
  const left = props.duration - props.position;
  const onClick = useLockedLink(props.locked, props.to);
  return (
    <Link to={props.to} className="cont-card poster" onClick={onClick} onMouseEnter={prefetchPlayer} onFocus={prefetchPlayer}>
      <Art id={props.id} name={props.title} src={props.poster} wide locked={props.locked}>
        <span className="left tabnum">{left < 3600 ? `${Math.max(1, Math.round(left / 60))} min left` : `${fmtDuration(props.position)} of ${fmtDuration(props.duration)}`}</span>
      </Art>
      <ProgressBar value={props.position / props.duration} label={`${Math.round((props.position / props.duration) * 100)}% watched`} />
      <div className="t">{props.title}</div>
      {props.subtitle && <div className="s">{props.subtitle}</div>}
    </Link>
  );
}

export const ChannelRow = memo(function ChannelRow(props: {
  ch: LiveChannelWithNow;
  now: number;
  onOpen: (id: string) => void;
  showNext?: boolean;
  /** shown instead of now/next when the channel has no guide data */
  category?: string;
  /** the caller shows its own star */
  noFavMark?: boolean;
  /** channel menu ("Add to list"): a ⋯ button next to the row, right-click and long-press on it */
  onMenu?: (ch: LiveChannelWithNow) => void;
}) {
  const { ch, now, onMenu } = props;
  const live = useApp((s) => s.prefs.live);
  const menu = useChannelMenu(onMenu ? () => onMenu(ch) : undefined);
  const fav = useIsFavorite('live', ch.id);
  const p = ch.now;
  const pct = p ? (now - p.start) / (p.end - p.start) : 0;
  const row = (
    <button
      type="button"
      className="ch-row"
      {...menu}
      onClick={() => whenUnlocked(ch.locked, () => props.onOpen(ch.id))}
      onMouseEnter={prefetchPlayer}
      onFocus={prefetchPlayer}
      aria-label={`${live.showChannelNumbers ? ch.number + ' ' : ''}${ch.name}${p ? ', now: ' + p.title : !ch.hasEpg && props.category ? ', ' + props.category : ''}`}
    >
      {live.showLogos && <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />}
      <div className="ch-main">
        <div className="ch-top">
          <span className="name">
            {ch.name} {fav && !props.noFavMark && <IconStar filled className="ico ch-fav" />}
          </span>
          {live.showChannelNumbers && <span className="ch-num tabnum">{ch.number}</span>}
        </div>
        {p ? (
          <div className="ch-now">{p.title}</div>
        ) : !ch.hasEpg && props.category ? (
          <div className="ch-now ch-cat">{props.category}</div>
        ) : (
          <div className="ch-now">No programme information</div>
        )}
        {live.showProgress && p && <ProgressBar value={pct} />}
        {props.showNext && ch.next && (
          <div className="ch-next">
            <span className="tabnum">{fmtClock(ch.next.start)}</span> · {ch.next.title}
          </div>
        )}
      </div>
    </button>
  );
  if (!onMenu) return row;
  return (
    <>
      {row}
      <button type="button" className="ch-more" aria-label={`More for ${ch.name}`} title="Add to list…" onClick={() => onMenu(ch)}>
        <IconMore />
      </button>
    </>
  );
});
