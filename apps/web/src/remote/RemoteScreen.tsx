/**
 * /remote: the phone as a remote for AnyCast on another device (a computer by the TV, a TV's
 * browser, a computer casting to a Chromecast). It lists the account's devices that allow it,
 * shows what the chosen one plays, steers it, and starts channels, movies and episodes on it.
 *
 * It can be its own icon on the home screen: on this route the page points to a manifest of its
 * own (remote.webmanifest), so "Add to Home Screen" here adds the remote, not the whole app.
 */
import type { Channel, Episode, Movie, RemoteCommand, RemoteForm, RemoteNowPlaying, Series } from '@anycast/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, call, errorMessage } from '../api/client';
import { resolveItems } from '../api/catalog';
import { IconBack, IconDown, IconLaptop, IconMuted, IconPause, IconPhone, IconPlay, IconRemote, IconSearch, IconStop, IconTv, IconUp, IconVolume } from '../components/Icons';
import { LogoTile } from '../components/ui';
import { IconSkip } from '../player/barIcons';
import { fmtBehind, fmtDuration } from '../lib/time';
import { readLocal, writeLocal } from '../lib/storage';
import { progressKey, useApp } from '../store/app';
import { toast } from '../store/actions';
import { patchRemotePlaying, positionNow, setRemoteDevices, useRemoteDevices, type SeenDevice } from './devices';
import '../theme/remote.css';

const TARGET_KEY = 'anycast.remote.target';
const SKIP_S = 10;
const VOL_STEP = 0.1;

/** A short buzz under the thumb, where the phone can (not iPhones). */
const buzz = () => {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not allowed */
  }
};

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

/** On this route the page offers the remote's own manifest and icon, so it installs as "Remote". */
function useRemoteManifest() {
  useEffect(() => {
    const swaps: [Element, string, string][] = [];
    const swap = (sel: string, attr: string, value: string) => {
      const el = document.head.querySelector(sel);
      if (!el) return;
      swaps.push([el, attr, el.getAttribute(attr) ?? '']);
      el.setAttribute(attr, value);
    };
    swap('link[rel="manifest"]', 'href', '/remote.webmanifest');
    swap('link[rel="apple-touch-icon"]', 'href', '/remote-touch-icon.png');
    swap('meta[name="apple-mobile-web-app-title"]', 'content', 'Remote');
    const title = document.title;
    document.title = 'AnyCast Remote';
    return () => {
      for (const [el, attr, v] of swaps) el.setAttribute(attr, v);
      document.title = title;
    };
  }, []);
}

/** The device list: asked once, then kept current by the realtime stream; asked again on return. */
function useDeviceList() {
  const { devices, loaded } = useRemoteDevices();
  const refresh = useCallback(() => {
    call('GET /api/remote/devices').then(setRemoteDevices, () => undefined);
  }, []);
  useEffect(() => {
    refresh();
    // iOS drops the realtime stream in the background: coming back asks again
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    const t = setInterval(refresh, 20_000);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      clearInterval(t);
    };
  }, [refresh]);
  return { devices, loaded, refresh };
}

/** Re-renders every second while something plays, so the position moves. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

const FormIcon = ({ form }: { form: RemoteForm }) => (form === 'tv' ? <IconTv /> : form === 'phone' ? <IconPhone /> : <IconLaptop />);

export default function RemoteScreen() {
  useRemoteManifest();
  const navigate = useNavigate();
  const { devices, loaded, refresh } = useDeviceList();
  const [targetId, setTargetId] = useState<string | null>(() => readLocal(TARGET_KEY));
  // the one picked before, else one that plays something, else the newest
  const target = devices.find((d) => d.clientId === targetId) ?? devices.find((d) => d.playing) ?? devices[0] ?? null;
  const pick = (d: SeenDevice) => {
    buzz();
    setTargetId(d.clientId);
    writeLocal(TARGET_KEY, d.clientId);
  };

  const send = useCallback(
    async (c: RemoteCommand, optimistic?: (p: RemoteNowPlaying) => RemoteNowPlaying) => {
      if (!target) return;
      buzz();
      if (optimistic) patchRemotePlaying(target.clientId, optimistic);
      try {
        await call('POST /api/remote/command', { body: { clientId: target.clientId, command: c } });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          toast(`${target.name} is no longer open`, 'error');
          refresh();
        } else toast(`Couldn't reach ${target.name}: ${errorMessage(e)}`, 'error');
      }
    },
    [target, refresh],
  );

  const close = () => {
    if ((history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate('/home', { replace: true });
  };

  return (
    <div className="remote" data-standalone={standalone() ? '' : undefined}>
      <header className="rm-head">
        <button type="button" className="icon-btn" onClick={close} aria-label={standalone() ? 'Open AnyCast' : 'Back'}>
          <IconBack />
        </button>
        <h1 className="h1 rm-title">Remote</h1>
        <span className="rm-head-end" />
      </header>

      {!loaded ? (
        <div className="rm-empty" aria-busy="true">
          <p className="muted">Looking for your devices…</p>
        </div>
      ) : !devices.length ? (
        <NoDevices />
      ) : (
        <>
          <DevicePicker devices={devices} current={target} onPick={pick} />
          {target && <Controls key={target.clientId} device={target} send={send} />}
          {target && <Picker device={target} send={send} />}
        </>
      )}
      {!standalone() && <InstallHint />}
    </div>
  );
}

function NoDevices() {
  return (
    <div className="rm-empty">
      <IconRemote className="ico rm-empty-ico" />
      <h2 className="rm-empty-title">No device to steer yet</h2>
      <p className="muted">
        Open AnyCast on the computer or TV you want to control, signed in to this account. It shows up here by itself. On a phone or tablet, turn it on first in Settings › Remote.
      </p>
    </div>
  );
}

function DevicePicker(props: { devices: SeenDevice[]; current: SeenDevice | null; onPick: (d: SeenDevice) => void }) {
  return (
    <div className="rm-devices" role="radiogroup" aria-label="Device to control">
      {props.devices.map((d) => {
        const on = d.clientId === props.current?.clientId;
        return (
          <button key={d.clientId} type="button" role="radio" aria-checked={on} className="rm-device" onClick={() => props.onPick(d)}>
            <FormIcon form={d.form} />
            <span className="rm-device-text">
              <span className="rm-device-name ellipsis">{d.name}</span>
              <span className="rm-device-state ellipsis">
                {d.playing ? <span className={`rm-dot${d.playing.paused ? ' paused' : ''}`} aria-hidden="true" /> : null}
                {d.playing ? (d.playing.paused ? 'Paused' : 'Playing') : 'Idle'}
                {d.profileName ? ` · ${d.profileName}` : ''}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

type Send = (c: RemoteCommand, optimistic?: (p: RemoteNowPlaying) => RemoteNowPlaying) => Promise<void>;

function Controls({ device, send }: { device: SeenDevice; send: Send }) {
  const p = device.playing;
  useTick(!!p && !p.paused && !p.waiting);
  const live = p?.kind === 'live';
  const pos = positionNow(device);
  const off = !p;

  const toggle = () => void send({ type: 'toggle' }, (x) => ({ ...x, paused: !x.paused }));
  const skip = (dir: -1 | 1) =>
    void send({ type: 'seekBy', seconds: dir * SKIP_S }, (x) =>
      x.kind === 'live'
        ? { ...x, position: Math.min(Date.now(), x.position + dir * SKIP_S * 1000), behindMs: Math.max(0, (x.behindMs ?? 0) - dir * SKIP_S * 1000) }
        : { ...x, position: Math.max(0, Math.min(x.duration || Infinity, x.position + dir * SKIP_S)) },
    );
  const volume = (dir: -1 | 1) => void send({ type: 'volumeBy', delta: dir * VOL_STEP }, (x) => ({ ...x, muted: false, volume: Math.max(0, Math.min(1, Math.round((x.volume + dir * VOL_STEP) * 100) / 100)) }));
  const mute = () => p && void send({ type: 'mute', muted: !p.muted }, (x) => ({ ...x, muted: !x.muted }));
  const step = (dir: 1 | -1) => void send({ type: 'step', dir });

  return (
    <section className="rm-now" aria-label={`On ${device.name}`}>
      <NowCard device={device} pos={pos} send={send} />
      <div className="rm-pad" data-off={off ? '' : undefined}>
        <Rocker
          label="Volume"
          short="VOL"
          up={{ label: 'Volume up', onClick: () => volume(1), icon: <IconUp /> }}
          down={{ label: 'Volume down', onClick: () => volume(-1), icon: <IconDown /> }}
          disabled={off}
          meter={p ? (p.muted ? 0 : p.volume) : null}
        />
        <div className="rm-center">
          <div className="rm-transport">
            <button type="button" className="rm-btn" onClick={() => skip(-1)} disabled={off} aria-label={`Back ${SKIP_S} seconds`}>
              <IconSkip dir={-1} label={String(SKIP_S)} />
            </button>
            <button type="button" className="rm-play" onClick={toggle} disabled={off} aria-label={p && !p.paused ? 'Pause' : 'Play'}>
              {p && !p.paused ? <IconPause /> : <IconPlay />}
            </button>
            <button type="button" className="rm-btn" onClick={() => skip(1)} disabled={off || (live && (p?.behindMs ?? 0) <= 0)} aria-label={`Forward ${SKIP_S} seconds`}>
              <IconSkip dir={1} label={String(SKIP_S)} />
            </button>
          </div>
          <div className="rm-row">
            <button type="button" className={`rm-pill${p?.muted ? ' on' : ''}`} onClick={mute} disabled={off} aria-pressed={!!p?.muted}>
              {p?.muted ? <IconMuted /> : <IconVolume />}
              {p?.muted ? 'Muted' : 'Mute'}
            </button>
            <button type="button" className="rm-pill" onClick={() => void send({ type: 'stop' }, (x) => ({ ...x, paused: true }))} disabled={off}>
              <IconStop />
              Stop
            </button>
          </div>
        </div>
        <Rocker
          label={p?.kind === 'episode' ? 'Episode' : 'Channel'}
          short={p?.kind === 'episode' ? 'EP' : 'CH'}
          up={{ label: p?.kind === 'episode' ? 'Next episode' : 'Next channel', onClick: () => step(1), icon: <IconUp />, disabled: !p?.canNext }}
          down={{ label: p?.kind === 'episode' ? 'Previous episode' : 'Previous channel', onClick: () => step(-1), icon: <IconDown />, disabled: !p?.canPrev }}
          disabled={off || p?.kind === 'movie'}
        />
      </div>
    </section>
  );
}

function Rocker(props: {
  label: string;
  short: string;
  up: { label: string; onClick: () => void; icon: ReactNode; disabled?: boolean };
  down: { label: string; onClick: () => void; icon: ReactNode; disabled?: boolean };
  disabled?: boolean;
  /** volume: 0..1 shown along the rocker */
  meter?: number | null;
}) {
  return (
    <div className="rm-rocker" role="group" aria-label={props.label} data-off={props.disabled ? '' : undefined}>
      <button type="button" onClick={props.up.onClick} disabled={props.disabled || props.up.disabled} aria-label={props.up.label}>
        {props.up.icon}
      </button>
      <span className="rm-rocker-label" aria-hidden="true">
        {props.short}
        {props.meter !== undefined && props.meter !== null && (
          <span className="rm-meter">
            <span style={{ transform: `scaleY(${props.meter})` }} />
          </span>
        )}
      </span>
      <button type="button" onClick={props.down.onClick} disabled={props.disabled || props.down.disabled} aria-label={props.down.label}>
        {props.down.icon}
      </button>
    </div>
  );
}

function NowCard({ device, pos, send }: { device: SeenDevice; pos: number; send: Send }) {
  const p = device.playing;
  const showArt = useApp((s) => s.prefs.appearance.showArtwork);
  if (!p) {
    return (
      <div className="rm-card idle">
        <div className="rm-card-text">
          <p className="rm-kicker">{device.name}</p>
          <p className="rm-card-title">Nothing playing</p>
          <p className="rm-card-sub muted">Pick a channel or a title below to start it there.</p>
        </div>
      </div>
    );
  }
  const live = p.kind === 'live';
  return (
    <div className="rm-card">
      <div className={`rm-art${live ? ' logo' : ''}`}>{live || !p.image || !showArt ? <LogoTile name={p.subtitle ?? p.title} logo={p.image ?? null} show={showArt} /> : <img src={p.image} alt="" />}</div>
      <div className="rm-card-text">
        <p className="rm-kicker ellipsis">
          {live ? (
            (p.behindMs ?? 0) > 0 ? (
              <span className="rm-behind tabnum">{fmtBehind(p.behindMs ?? 0)}</span>
            ) : (
              <span className="rm-live">Live</span>
            )
          ) : null}
          {p.casting ? 'On the Chromecast' : `On ${device.name}`}
        </p>
        <p className="rm-card-title">{p.title}</p>
        {p.subtitle && <p className="rm-card-sub muted ellipsis">{p.subtitle}</p>}
      </div>
      {p.needsTap ? (
        <p className="rm-note">The browser on {device.name} waits for one tap on its screen before it plays with sound.</p>
      ) : p.waiting ? (
        <p className="rm-note quiet">Loading…</p>
      ) : null}
      {live ? <LiveBar p={p} pos={pos} send={send} /> : <Scrubber p={p} pos={pos} send={send} />}
    </div>
  );
}

function LiveBar({ p, pos, send }: { p: RemoteNowPlaying; pos: number; send: Send }) {
  const prog = p.program;
  const frac = prog && prog.end > prog.start ? Math.max(0, Math.min(1, (pos - prog.start) / (prog.end - prog.start))) : null;
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="rm-live-bar">
      {frac !== null && prog ? (
        <>
          <div className="rm-track" aria-hidden="true">
            <span style={{ transform: `scaleX(${frac})` }} />
          </div>
          <div className="rm-times tabnum muted">
            <span>{fmt(prog.start)}</span>
            <span>{fmt(prog.end)}</span>
          </div>
        </>
      ) : null}
      {(p.behindMs ?? 0) > 0 && (
        <button type="button" className="rm-golive" onClick={() => void send({ type: 'live' }, (x) => ({ ...x, behindMs: 0, position: Date.now() }))}>
          Back to live
        </button>
      )}
    </div>
  );
}

function Scrubber({ p, pos, send }: { p: RemoteNowPlaying; pos: number; send: Send }) {
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? pos;
  const dur = p.duration;
  if (!dur) return null;
  const commit = () => {
    if (drag === null) return;
    const t = drag;
    setDrag(null);
    void send({ type: 'seekTo', position: t }, (x) => ({ ...x, position: t }));
  };
  return (
    <div className="rm-scrub">
      <input
        type="range"
        min={0}
        max={Math.round(dur)}
        step={1}
        value={Math.round(shown)}
        aria-label="Position"
        aria-valuetext={`${fmtDuration(shown)} of ${fmtDuration(dur)}`}
        style={{ ['--f' as string]: String(Math.max(0, Math.min(1, shown / dur))) }}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
      />
      <div className="rm-times tabnum muted">
        <span>{fmtDuration(shown)}</span>
        <span>−{fmtDuration(Math.max(0, dur - shown))}</span>
      </div>
    </div>
  );
}

/* ---------------- start something on the device ---------------- */

type Tab = 'channels' | 'continue' | 'search';
const TAB_KEY = 'anycast.remote.tab';

interface Row {
  key: string;
  title: string;
  sub?: string | null;
  logo?: string | null;
  poster?: string | null;
  open: RemoteCommand & { type: 'open' };
  active: boolean;
}

function Picker({ device, send }: { device: SeenDevice; send: Send }) {
  const [tab, setTab] = useState<Tab>(() => (readLocal(TAB_KEY) as Tab | null) ?? 'channels');
  const choose = (t: Tab) => {
    setTab(t);
    writeLocal(TAB_KEY, t);
  };
  const playing = device.playing;
  const isActive = (kind: string, id: string) => !!playing && playing.kind === kind && playing.id === id;
  const open = (r: Row) => {
    void send(r.open);
    toast(`Starting ${r.title} on ${device.name}`);
  };
  return (
    <section className="rm-pick" aria-label={`Play on ${device.name}`}>
      <h2 className="rm-pick-title">Play on {device.name}</h2>
      <div className="rm-tabs" role="tablist">
        {(
          [
            ['channels', 'Channels'],
            ['continue', 'Continue'],
            ['search', 'Search'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'channels' ? <ChannelRows isActive={isActive} onOpen={open} /> : tab === 'continue' ? <ContinueRows isActive={isActive} onOpen={open} /> : <SearchRows isActive={isActive} onOpen={open} />}
    </section>
  );
}

type RowsProps = { isActive: (kind: string, id: string) => boolean; onOpen: (r: Row) => void };

const channelRow = (c: Channel, isActive: RowsProps['isActive'], sub?: string | null): Row => ({
  key: `live:${c.id}`,
  title: c.name,
  sub,
  logo: c.logo,
  open: { type: 'open', kind: 'live', id: c.id },
  active: isActive('live', c.id),
});

function ChannelRows({ isActive, onOpen }: RowsProps) {
  const favorites = useApp((s) => s.favorites);
  const recent = useApp((s) => s.recentChannels);
  const favIds = useMemo(() => favorites.filter((f) => f.kind === 'live').map((f) => f.id), [favorites]);
  const recentIds = useMemo(() => recent.map((r) => r.id).filter((id) => !favIds.includes(id)).slice(0, 12), [recent, favIds]);
  const [items, setItems] = useState<{ fav: Channel[]; recent: Channel[] } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    resolveItems('live', [...favIds, ...recentIds], { signal: ac.signal, fresh: true }).then(
      (list) => {
        const byId = new Map(list.map((c) => [c.id, c as Channel & { now?: { title: string } | null }]));
        setItems({ fav: favIds.map((id) => byId.get(id)).filter((c): c is Channel => !!c), recent: recentIds.map((id) => byId.get(id)).filter((c): c is Channel => !!c) });
      },
      () => setItems({ fav: [], recent: [] }),
    );
    return () => ac.abort();
  }, [favIds, recentIds]);
  if (!items) return <ListSkeleton />;
  const nowOf = (c: Channel) => (c as Channel & { now?: { title: string } | null }).now?.title ?? null;
  if (!items.fav.length && !items.recent.length) return <p className="rm-list-empty muted">Your favorite and recently watched channels show up here.</p>;
  return (
    <>
      {items.fav.length > 0 && <Rows label="Favorites" rows={items.fav.map((c) => channelRow(c, isActive, nowOf(c)))} onOpen={onOpen} />}
      {items.recent.length > 0 && <Rows label="Recently watched" rows={items.recent.map((c) => channelRow(c, isActive, nowOf(c)))} onOpen={onOpen} />}
    </>
  );
}

function ContinueRows({ isActive, onOpen }: RowsProps) {
  const [data, setData] = useState<{ movies: Movie[]; episodes: (Episode & { series: Series })[] } | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    call('GET /api/continue', { signal: ac.signal }).then(setData, () => setData({ movies: [], episodes: [] }));
    return () => ac.abort();
  }, []);
  if (!data) return <ListSkeleton />;
  const rows: Row[] = [
    ...data.episodes.map((e) => ({
      key: `episode:${e.id}`,
      title: e.series.name,
      sub: `S${e.season} E${e.episode}${e.title ? ` · ${e.title}` : ''}`,
      poster: e.series.poster,
      open: { type: 'open' as const, kind: 'episode' as const, id: e.id, seriesId: e.seriesId },
      active: isActive('episode', e.id),
    })),
    ...data.movies.map((m) => ({
      key: `movie:${m.id}`,
      title: m.name,
      sub: m.year ? String(m.year) : null,
      poster: m.poster,
      open: { type: 'open' as const, kind: 'movie' as const, id: m.id },
      active: isActive('movie', m.id),
    })),
  ];
  if (!rows.length) return <p className="rm-list-empty muted">Movies and episodes you started show up here.</p>;
  return <Rows rows={rows} onOpen={onOpen} />;
}

function SearchRows({ isActive, onOpen }: RowsProps) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ live: Channel[]; movies: Movie[]; series: Series[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = useApp((s) => s.progress);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return void setRes(null);
    const n = ++seq.current;
    const ac = new AbortController();
    const t = setTimeout(() => {
      setBusy(true);
      call('GET /api/search', { query: { q: term }, signal: ac.signal })
        .then((r) => n === seq.current && setRes(r), () => undefined)
        .finally(() => n === seq.current && setBusy(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q]);

  /** a series starts where the profile left it, else at its first episode */
  const openSeries = async (s: Series) => {
    try {
      const d = await call('GET /api/series/:id', { params: { id: s.id } });
      const eps = d.seasons.flatMap((x) => x.episodes);
      const started = eps
        .map((e) => ({ e, p: progress[progressKey('episode', e.id)] }))
        .filter((x) => x.p)
        .sort((a, b) => (b.p!.updatedAt ?? 0) - (a.p!.updatedAt ?? 0))[0];
      const ep = started ? (started.p!.finished ? (eps[eps.indexOf(started.e) + 1] ?? started.e) : started.e) : eps[0];
      if (!ep) return toast(`${s.name} has no episodes`, 'error');
      onOpen({ key: `series:${s.id}`, title: s.name, open: { type: 'open', kind: 'episode', id: ep.id, seriesId: s.id }, active: false });
    } catch (e) {
      toast(`Couldn't open ${s.name}: ${errorMessage(e)}`, 'error');
    }
  };

  return (
    <>
      <label className="rm-search">
        <IconSearch />
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Channels, movies, series" aria-label="Search" enterKeyHint="search" autoCapitalize="off" autoCorrect="off" />
      </label>
      {busy && !res ? <ListSkeleton /> : null}
      {res && !res.live.length && !res.movies.length && !res.series.length && <p className="rm-list-empty muted">Nothing found for “{q.trim()}”.</p>}
      {res && res.live.length > 0 && <Rows label="Channels" rows={res.live.slice(0, 8).map((c) => channelRow(c, isActive))} onOpen={onOpen} />}
      {res && res.movies.length > 0 && (
        <Rows
          label="Movies"
          rows={res.movies.slice(0, 8).map((m) => ({ key: `movie:${m.id}`, title: m.name, sub: m.year ? String(m.year) : null, poster: m.poster, open: { type: 'open', kind: 'movie', id: m.id }, active: isActive('movie', m.id) }))}
          onOpen={onOpen}
        />
      )}
      {res && res.series.length > 0 && (
        <Rows
          label="Series"
          rows={res.series.slice(0, 8).map((s) => ({ key: `series:${s.id}`, title: s.name, sub: s.year ? String(s.year) : 'Series', poster: s.poster, open: { type: 'open', kind: 'episode', id: '', seriesId: s.id }, active: false }))}
          onOpen={(r) => {
            const s = res.series.find((x) => `series:${x.id}` === r.key);
            if (s) void openSeries(s);
          }}
        />
      )}
    </>
  );
}

function Rows({ label, rows, onOpen }: { label?: string; rows: Row[]; onOpen: (r: Row) => void }) {
  const showArt = useApp((s) => s.prefs.appearance.showArtwork);
  return (
    <div className="rm-list">
      {label && <h3 className="rm-list-label">{label}</h3>}
      {rows.map((r) => (
        <button key={r.key} type="button" className="rm-item" onClick={() => onOpen(r)} aria-current={r.active ? 'true' : undefined}>
          {r.poster !== undefined ? (
            <span className="rm-poster">{r.poster && showArt ? <img src={r.poster} alt="" loading="lazy" /> : null}</span>
          ) : (
            <LogoTile name={r.title} logo={r.logo ?? null} small show={showArt} />
          )}
          <span className="rm-item-text">
            <span className="rm-item-title ellipsis">{r.title}</span>
            {r.sub && <span className="rm-item-sub ellipsis muted">{r.sub}</span>}
          </span>
          <span className="rm-item-go">{r.active ? 'Playing' : <IconPlay />}</span>
        </button>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="rm-list" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rm-item skeleton-row" />
      ))}
    </div>
  );
}

/** Not installed: how to put the remote on the home screen. */
function InstallHint() {
  const [hidden, setHidden] = useState(() => readLocal('anycast.remote.hintClosed') === '1');
  if (hidden) return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return (
    <aside className="rm-install">
      <IconRemote className="ico" />
      <p>
        <strong>Keep the remote one tap away.</strong>{' '}
        {ios ? 'Tap Share, then Add to Home Screen. It gets its own Remote icon.' : 'Use your browser’s menu, then Add to Home screen or Install. It gets its own Remote icon.'}
      </p>
      <button
        type="button"
        className="icon-btn"
        aria-label="Hide this tip"
        onClick={() => {
          writeLocal('anycast.remote.hintClosed', '1');
          setHidden(true);
        }}
      >
        ×
      </button>
    </aside>
  );
}
