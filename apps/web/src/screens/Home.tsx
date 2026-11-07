/**
 * Home: a per-profile dashboard. Continue watching, Jump back in (recent channels), Up next,
 * favorite channels with what's on now, and Watch Later, in the order and with the sections the
 * profile chose (Preferences.home). Sections without anything in them stay out of the way.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { normalizeHomeSections, type Episode, type HomeSectionId, type LiveChannelWithNow, type Movie, type Progress, type Series } from '@anycast/shared';
import { useApp } from '../store/app';
import { forgetRecentChannels, setZapList } from '../store/actions';
import { whenUnlocked } from '../store/parental';
import { cachedGet } from '../api/client';
import { resolveItems } from '../api/catalog';
import { useAsync, useFormFactor, useNow } from '../lib/hooks';
import { writeLocal } from '../lib/storage';
import { fmtClock, fmtDuration, fmtRelativeAgo } from '../lib/time';
import { toneFor } from '../lib/misc';
import { Art, ChannelRow, ContinueCard, PosterCard, UpNextCard } from '../components/cards';
import { Empty, LogoTile, ProgressBar, Skeleton } from '../components/ui';
import { IconClose, IconPlay } from '../components/Icons';
import { HOME_SECTIONS, HomeEditor } from '../components/HomeEditor';
import { prefetchPlayer } from '../player/prefetch';
import { NewEpisodeCards, useNewEpisodes } from '../components/NewEpisodes';
import '../theme/home.css';

type ContMovie = Movie & { progress: Progress };
type ContEpisode = Episode & { progress: Progress; series: Series };
type ContItem = { kind: 'movie'; m: ContMovie } | { kind: 'episode'; e: ContEpisode };

const epLabel = (e: Episode) => `S${e.season} · E${e.episode}`;
const updated = (x: ContItem) => (x.kind === 'movie' ? x.m.progress.updatedAt : x.e.progress.updatedAt);

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function HomeScreen() {
  const form = useFormFactor();
  const navigate = useNavigate();
  const home = useApp((s) => s.prefs.home);
  const name = useApp((s) => s.me?.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  const version = useApp((s) => s.catalogVersion);
  const progressCount = useApp((s) => Object.keys(s.progress).length);
  const progressSum = useApp((s) => Object.values(s.progress).reduce((n, p) => n + p.updatedAt, 0));
  const favorites = useApp((s) => s.favorites);
  const recentIds = useApp((s) => s.recentChannels);
  const watchLater = useApp((s) => s.mediaLists.find((l) => l.builtin === 'watch-later'));
  const [editing, setEditing] = useState(false);
  const now = useNow(30_000);
  // live rows refresh their now/next every couple of minutes
  const slot = Math.floor(now / 120_000);
  const limit = home.rowLimit;

  const sections = normalizeHomeSections(home.sections).filter((s) => !home.hiddenSections.includes(s));
  const want = (s: HomeSectionId) => sections.includes(s);

  /* ---------- data ---------- */
  const needCont = want('continue') || want('next') || home.showHero;
  const cont = useAsync(
    () => (needCont ? cachedGet('GET /api/continue', {}, 10_000) : Promise.resolve({ movies: [], episodes: [] })),
    [needCont, progressCount, progressSum, version],
  );
  const contItems = useMemo<ContItem[]>(() => {
    if (!cont.data) return [];
    const out: ContItem[] = [
      ...cont.data.movies.map((m) => ({ kind: 'movie' as const, m })),
      ...cont.data.episodes.filter((e) => e.progress.position > 0).map((e) => ({ kind: 'episode' as const, e })),
    ];
    return out.sort((a, b) => updated(b) - updated(a));
  }, [cont.data]);
  const upNext = useMemo(() => (cont.data?.episodes ?? []).filter((e) => e.progress.position <= 0), [cont.data]);

  const newEps = useNewEpisodes(want('newEpisodes'));

  const recentKey = recentIds.map((r) => r.id).join(',');
  const needRecent = (want('recent') || home.showHero) && !!recentKey;
  const recent = useAsync(
    (signal) => (needRecent ? resolveItems('live', recentKey.split(','), { signal, fresh: true }) : Promise.resolve([])),
    [needRecent, recentKey, version, slot],
  );

  const favKey = useMemo(
    () =>
      favorites
        .filter((f) => f.kind === 'live')
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((f) => f.id)
        .join(','),
    [favorites],
  );
  const needFavs = want('favorites') && !!favKey;
  const favs = useAsync((signal) => (needFavs ? resolveItems('live', favKey.split(','), { signal, fresh: true }) : Promise.resolve([])), [needFavs, favKey, version, slot]);

  // newest saved first
  const wlItems = useMemo(() => [...(watchLater?.items ?? [])].reverse(), [watchLater]);
  const wlKey = wlItems.map((i) => `${i.kind}:${i.id}`).join(',');
  const needWl = want('watchLater') && !!wlKey;
  const wl = useAsync(
    async (signal) => {
      if (!needWl) return [];
      const ids = (k: 'movie' | 'series') => wlItems.filter((i) => i.kind === k).map((i) => i.id);
      const [movies, series] = await Promise.all([resolveItems('movie', ids('movie'), { signal }), resolveItems('series', ids('series'), { signal })]);
      const byKey = new Map<string, { kind: 'movie' | 'series'; item: Movie | Series }>([
        ...movies.map((m) => [`movie:${m.id}`, { kind: 'movie' as const, item: m }] as const),
        ...series.map((s) => [`series:${s.id}`, { kind: 'series' as const, item: s }] as const),
      ]);
      return wlItems.map((i) => byKey.get(`${i.kind}:${i.id}`)).filter((x): x is NonNullable<typeof x> => !!x);
    },
    [needWl, wlKey, version],
  );

  /* ---------- channels open in the player; up/down zaps through the row they came from ---------- */
  const openChannel = useCallback(
    (id: string, row: LiveChannelWithNow[]) => {
      setZapList(row.map((c) => c.id));
      writeLocal('anycast.lastChannel', id);
      navigate(`/play/live/${id}`);
    },
    [navigate],
  );

  const recentRows = (recent.data ?? []) as LiveChannelWithNow[];
  const watchedAt = new Map(recentIds.map((r) => [r.id, r.watchedAt]));
  const favRows = ((favs.data ?? []) as LiveChannelWithNow[]).filter((c) => !home.favoritesWithGuideOnly || c.hasEpg);

  /* ---------- the hero: the newest of what you were watching ---------- */
  const lastCont = contItems[0];
  const lastCh = recentRows[0];
  const heroChannel = lastCh && (!lastCont || (watchedAt.get(lastCh.id) ?? 0) > updated(lastCont));

  const loaded = (!want('newEpisodes') || !!newEps.data) && (!needCont || !!cont.data) && (!needRecent || !!recent.data) && (!needFavs || !!favs.data) && (!needWl || !!wl.data);
  const counts: Record<HomeSectionId, number> = {
    continue: contItems.length,
    newEpisodes: newEps.data?.length ?? 0,
    recent: recentRows.length,
    next: upNext.length,
    favorites: favRows.length,
    watchLater: wl.data?.length ?? 0,
  };
  const nothing = loaded && sections.every((s) => counts[s] === 0);

  const seeAll = (n: number, to: string) => (n > limit ? <Link to={to}>See all</Link> : null);

  const render = (id: HomeSectionId) => {
    const title = HOME_SECTIONS[id].title;
    switch (id) {
      case 'continue':
        if (cont.data && contItems.length === 0) return null;
        return (
          <Section key={id} id={id} title={title}>
            <div className="shelf wide" data-nav-row="home-continue">
              {!cont.data
                ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} h="auto" r="0.75rem" style={{ aspectRatio: '16 / 9' }} />)
                : contItems.slice(0, limit).map((x) =>
                    x.kind === 'movie' ? (
                      <ContinueCard key={`m${x.m.id}`} to={`/play/movie/${x.m.id}`} id={x.m.id} title={x.m.name} subtitle="Movie" poster={x.m.poster} position={x.m.progress.position} duration={x.m.progress.duration} locked={x.m.locked} />
                    ) : (
                      <ContinueCard
                        key={`e${x.e.id}`}
                        to={`/play/episode/${x.e.id}?series=${x.e.series.id}`}
                        id={x.e.series.id}
                        title={x.e.series.name}
                        subtitle={`${epLabel(x.e)} · ${x.e.title}`}
                        poster={x.e.series.poster}
                        position={x.e.progress.position}
                        duration={x.e.progress.duration}
                        locked={x.e.series.locked}
                      />
                    ),
                  )}
            </div>
          </Section>
        );
      case 'recent':
        if (!recentKey || (recent.data && recentRows.length === 0)) return null;
        return (
          <Section
            key={id}
            id={id}
            title={title}
            action={
              <button type="button" onClick={() => void forgetRecentChannels()}>
                Clear
              </button>
            }
          >
            <div className="fav-row home-recent" data-nav-row="home-recent">
              {!recent.data
                ? Array.from({ length: Math.min(4, recentIds.length) }, (_, i) => <Skeleton key={i} h="4.25rem" r="0.875rem" />)
                : recentRows.slice(0, limit).map((ch) => (
                    <div key={ch.id} className="recent-tile">
                      <button type="button" className="fav-tile" onClick={() => whenUnlocked(ch.locked, () => openChannel(ch.id, recentRows))} onMouseEnter={prefetchPlayer} onFocus={prefetchPlayer}>
                        <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />
                        <span className="recent-text">
                          <span className="ellipsis recent-name">{ch.name}</span>
                          <span className="ellipsis ch-now">{ch.now ? ch.now.title : `Watched ${fmtRelativeAgo(watchedAt.get(ch.id) ?? now, now)}`}</span>
                          {ch.now && (
                            <span className="recent-bar">
                              <ProgressBar value={(now - ch.now.start) / (ch.now.end - ch.now.start)} />
                            </span>
                          )}
                        </span>
                      </button>
                      <button type="button" className="recent-x" aria-label={`Remove ${ch.name} from Jump back in`} title="Remove" onClick={() => void forgetRecentChannels(ch.id)}>
                        <IconClose />
                      </button>
                    </div>
                  ))}
            </div>
          </Section>
        );
      case 'newEpisodes':
        if (!newEps.data?.length) return null;
        return (
          <Section key={id} id={id} title={title}>
            <NewEpisodeCards items={newEps.data} limit={limit} row="home-new-episodes" />
          </Section>
        );
      case 'next':
        if (cont.data && upNext.length === 0) return null;
        if (!cont.data) return null;
        return (
          <Section key={id} id={id} title={title}>
            <div className="shelf wide" data-nav-row="home-next">
              {upNext.slice(0, limit).map((e) => (
                <UpNextCard
                  key={e.id}
                  to={`/play/episode/${e.id}?series=${e.series.id}`}
                  id={e.series.id}
                  title={e.series.name}
                  label={`Next · ${epLabel(e)}`}
                  subtitle={e.title}
                  poster={e.series.poster}
                  locked={e.series.locked}
                />
              ))}
            </div>
          </Section>
        );
      case 'favorites':
        if (!favKey || (favs.data && favRows.length === 0)) return null;
        return (
          <Section key={id} id={id} title={title} action={seeAll(favRows.length, '/favorites/live') ?? <Link to="/favorites/live">Favorites</Link>}>
            {!favs.data ? (
              <div className="fav-live home-favs" aria-hidden="true">
                {Array.from({ length: Math.min(4, favKey.split(',').length) }, (_, i) => (
                  <Skeleton key={i} h="4.5rem" r="0.875rem" />
                ))}
              </div>
            ) : (
              <ul className="fav-live home-favs" aria-label="Favorite channels">
                {favRows.slice(0, limit).map((ch) => (
                  <li key={ch.id} className="fav-live-item" data-nav-row={`home-fav-${ch.id}`}>
                    <ChannelRow ch={ch} now={now} onOpen={(cid) => openChannel(cid, favRows)} showNext={form !== 'phone'} noFavMark />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      case 'watchLater':
        if (!wlKey || (wl.data && wl.data.length === 0)) return null;
        return (
          <Section key={id} id={id} title={title} action={watchLater ? <Link to={`/lists/${watchLater.id}`}>{(wl.data?.length ?? 0) > limit ? 'See all' : 'Open list'}</Link> : null}>
            <div className="shelf" data-nav-row="home-watch-later">
              {!wl.data
                ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} h="auto" r="0.625rem" style={{ aspectRatio: '2 / 3' }} />)
                : wl.data.slice(0, limit).map((x) => <PosterCard key={`${x.kind}:${x.item.id}`} kind={x.kind} item={x.item} />)}
            </div>
          </Section>
        );
    }
  };

  return (
    <div className="home">
      <div className="page-head">
        <div className="home-hello">
          <div className="label tabnum">
            {new Date(now).toLocaleDateString(undefined, { weekday: 'long' })} · {fmtClock(now)}
          </div>
          <h1 className="h1">
            {greeting(now)}
            {name ? `, ${name}` : ''}
          </h1>
        </div>
        <button type="button" className="btn" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
          {editing ? 'Done' : 'Customize'}
        </button>
      </div>

      {editing && (
        <section className="home-edit pad-x" aria-label="Customize Home">
          <p className="muted home-edit-intro">Choose which sections Home shows and in which order. This syncs to every device of this profile.</p>
          <HomeEditor />
        </section>
      )}

      {home.showHero &&
        (heroChannel ? (
          <ChannelHero ch={lastCh} watchedAt={watchedAt.get(lastCh.id) ?? now} now={now} onOpen={() => whenUnlocked(lastCh.locked, () => openChannel(lastCh.id, recentRows))} />
        ) : lastCont ? (
          <ContinueHero item={lastCont} />
        ) : null)}

      {sections.map(render)}

      {nothing && !editing && (
        <Empty title="Your Home fills up as you watch">
          <p>Channels you watch, movies and episodes you start, your favorites and Watch Later all show up here.</p>
          <div className="home-empty-actions">
            <Link to="/live" className="btn btn-primary">
              Browse Live TV
            </Link>
            <Link to="/movies" className="btn">
              Movies
            </Link>
            <Link to="/series" className="btn">
              Series
            </Link>
          </div>
        </Empty>
      )}
    </div>
  );
}

function Section(props: { id: HomeSectionId; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`home-sec home-sec-${props.id}`} aria-labelledby={`home-h-${props.id}`}>
      <div className="row-title">
        <h2 id={`home-h-${props.id}`}>{props.title}</h2>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

/* ---------------- the pick up card ---------------- */
function ContinueHero({ item }: { item: ContItem }) {
  const movie = item.kind === 'movie' ? item.m : null;
  const ep = item.kind === 'episode' ? item.e : null;
  const p = movie ? movie.progress : ep!.progress;
  const id = movie ? movie.id : ep!.series.id;
  const title = movie ? movie.name : ep!.series.name;
  const poster = movie ? movie.poster : ep!.series.poster;
  const locked = movie ? movie.locked : ep!.series.locked;
  const to = movie ? `/play/movie/${movie.id}` : `/play/episode/${ep!.id}?series=${ep!.series.id}`;
  const detail = movie ? `/movies/${movie.id}` : `/series/${ep!.series.id}`;
  const left = p.duration - p.position;
  const navigate = useNavigate();
  const showArt = useApp((s) => s.prefs.appearance.showArtwork) && !!poster && !locked;
  return (
    <section className={`home-hero${showArt ? '' : ' no-art'}`} aria-label="Pick up where you left off" style={{ ['--tone' as string]: toneFor(id) }}>
      {showArt && (
        <div className="home-hero-art">
          <Art id={id} name={title} src={poster} wide />
        </div>
      )}
      <div className="home-hero-text">
        <div className="label">Pick up where you left off</div>
        <h2 className="home-hero-title">{title}</h2>
        <div className="muted home-hero-sub">{ep ? `${epLabel(ep)} · ${ep.title}` : 'Movie'}</div>
        <div className="home-hero-progress">
          <ProgressBar value={p.position / p.duration} label={`${Math.round((p.position / p.duration) * 100)}% watched`} />
          <span className="muted tabnum">{left < 3600 ? `${Math.max(1, Math.round(left / 60))} min left` : `${fmtDuration(p.position)} of ${fmtDuration(p.duration)}`}</span>
        </div>
        <div className="actions" data-nav-row="home-hero">
          <button type="button" className="btn btn-primary btn-lg" onMouseEnter={prefetchPlayer} onClick={() => whenUnlocked(locked, () => navigate(to))} data-nav-autofocus="">
            <IconPlay /> Resume
          </button>
          <Link to={detail} className="btn btn-lg">
            {ep ? 'Episodes' : 'Details'}
          </Link>
        </div>
      </div>
    </section>
  );
}

function ChannelHero(props: { ch: LiveChannelWithNow; watchedAt: number; now: number; onOpen: () => void }) {
  const { ch, now } = props;
  const p = ch.now;
  return (
    <section className="home-hero home-hero-ch" aria-label="Pick up where you left off" style={{ ['--tone' as string]: toneFor(ch.id) }}>
      <div className="home-hero-logo">
        <LogoTile name={ch.name} logo={ch.logo} locked={ch.locked} />
      </div>
      <div className="home-hero-text">
        <div className="label">Back to live TV</div>
        <h2 className="home-hero-title">{ch.name}</h2>
        <div className="muted home-hero-sub">{p ? `Now: ${p.title}` : `Watched ${fmtRelativeAgo(props.watchedAt, now)}`}</div>
        {p && (
          <div className="home-hero-progress">
            <ProgressBar value={(now - p.start) / (p.end - p.start)} />
            <span className="muted tabnum">
              {fmtClock(p.start)} – {fmtClock(p.end)}
              {ch.next ? ` · Next: ${ch.next.title}` : ''}
            </span>
          </div>
        )}
        <div className="actions" data-nav-row="home-hero">
          <button type="button" className="btn btn-primary btn-lg" onMouseEnter={prefetchPlayer} onClick={props.onOpen} data-nav-autofocus="">
            <IconPlay /> Watch live
          </button>
        </div>
      </div>
    </section>
  );
}
