/**
 * Audio & subtitles menu (PB-3): two columns of radio items. Arrow keys move within a column
 * (up/down) and between the columns (left/right), on every device; Escape closes (PlayerScreen).
 *
 * Movies and episodes also list external subtitles (kept files, found online or loaded from the
 * device), with a timing control for the one showing, and a search view for finding more.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PlaybackTracks, SubtitleSearchResult } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { IconBack, IconClose } from '../components/Icons';
import { COMMON_LANGUAGES, languageName } from '../lib/lang';
import { fmtOffset } from './externalSubs';
import { audioLabel, subtitleLabel } from './tracks';
import type { ExternalSubtitles } from './useExternalSubtitles';

const NO_TRACKS: PlaybackTracks = { audio: [], subtitles: [], audioIndex: null, subtitleIndex: null, subtitlesInStream: false };
const OFFSET_STEP = 500;

export interface ExternalMenu {
  kind: 'movie' | 'episode';
  id: string;
  ext: ExternalSubtitles;
  /** the language a search starts in */
  language: string;
  /** a file picker makes sense here (not on a TV) */
  canFile: boolean;
  isAdmin: boolean;
}

export function TracksMenu(props: {
  tracks: PlaybackTracks | undefined;
  subtitle: number | null;
  onAudio: (index: number) => void;
  onSubtitle: (index: number | null) => void;
  onClose: () => void;
  external?: ExternalMenu;
}) {
  const tracks = props.tracks ?? NO_TRACKS;
  const { subtitle, external } = props;
  const ext = external?.ext;
  const showing = ext?.active?.file.id ?? null;
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'tracks' | 'search'>('tracks');

  // focus the checked item of the first column on open (and on coming back from the search)
  useEffect(() => {
    if (view === 'tracks') ref.current?.querySelector<HTMLElement>('.pl-menu-item[aria-checked="true"]')?.focus();
  }, [view]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    if ((e.target as HTMLElement).tagName === 'SELECT') return;
    const cols = [...(ref.current?.querySelectorAll<HTMLElement>('.pl-menu-col') ?? [])];
    const col = cols.findIndex((c) => c.contains(document.activeElement));
    if (col < 0) return;
    const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.pl-menu-item:not(:disabled)')];
    let target: HTMLElement | undefined;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const list = items(cols[col]!);
      const i = list.indexOf(document.activeElement as HTMLElement);
      target = list[i + (k === 'ArrowDown' ? 1 : -1)];
    } else {
      const other = cols[col + (k === 'ArrowRight' ? 1 : -1)];
      if (other) target = other.querySelector<HTMLElement>('.pl-menu-item[aria-checked="true"]') ?? items(other)[0];
    }
    e.preventDefault();
    e.stopPropagation();
    target?.focus();
  };

  if (view === 'search' && external) {
    return (
      <div ref={ref} className="pl-menu pl-menu-search" data-player-keys="off" data-nav-trap="" role="dialog" aria-label="Find subtitles" onKeyDown={onKeyDown}>
        <SubtitleSearch menu={external} onBack={() => setView('tracks')} />
        <button type="button" className="icon-btn pl-menu-close" onClick={props.onClose} aria-label="Close">
          <IconClose />
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="pl-menu" data-player-keys="off" data-nav-trap="" role="dialog" aria-label="Audio and subtitles" onKeyDown={onKeyDown}>
      <div className="pl-menu-col" role="radiogroup" aria-label="Audio">
        <h3 className="label">Audio</h3>
        {tracks.audio.length === 0 && <p className="muted">{props.tracks ? 'No audio' : 'Not known yet'}</p>}
        {tracks.audio.map((a) => {
          const l = audioLabel(a);
          const on = a.index === tracks.audioIndex;
          return (
            <button key={a.index} type="button" role="radio" aria-checked={on} className="pl-menu-item" onClick={() => props.onAudio(a.index)}>
              <span className="pl-menu-text">
                <span>{l.main}</span>
                <span className="pl-menu-detail">{l.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="pl-menu-col" role="radiogroup" aria-label="Subtitles">
        <h3 className="label">Subtitles</h3>
        <button type="button" role="radio" aria-checked={subtitle === null && showing === null} className="pl-menu-item" onClick={() => props.onSubtitle(null)}>
          <span className="pl-menu-text">Off</span>
        </button>
        {tracks.subtitles.map((s) => {
          const l = subtitleLabel(s);
          return (
            <button
              key={s.index}
              type="button"
              role="radio"
              aria-checked={s.index === subtitle && showing === null}
              aria-disabled={s.unavailable ? true : undefined}
              className="pl-menu-item"
              onClick={() => !s.unavailable && props.onSubtitle(s.index)}
            >
              <span className="pl-menu-text">
                <span>{l.main}</span>
                {l.detail && <span className="pl-menu-detail">{l.detail}</span>}
              </span>
            </button>
          );
        })}
        {ext?.state?.files.map((f) => (
          <button key={f.id} type="button" role="radio" aria-checked={f.id === showing} className="pl-menu-item" onClick={() => f.id !== showing && void ext.pick(f)}>
            <span className="pl-menu-text">
              <span>{f.language ? languageName(f.language) : 'Subtitles'}</span>
              <span className="pl-menu-detail pl-menu-release" title={f.label}>
                {f.source === 'upload' ? 'From a file' : 'OpenSubtitles'} · {f.label}
              </span>
            </span>
          </button>
        ))}
        {ext?.active && (
          <div className="pl-subs-timing" role="group" aria-label="Subtitle timing">
            <span className="pl-menu-detail">Timing</span>
            <button type="button" className="pl-menu-item pl-subs-step" aria-label="Show subtitles earlier" onClick={() => ext.setOffset(ext.active!.offsetMs - OFFSET_STEP)}>
              −0.5 s
            </button>
            <span className="pl-subs-offset tabnum" aria-live="polite">
              {fmtOffset(ext.active.offsetMs)}
            </span>
            <button type="button" className="pl-menu-item pl-subs-step" aria-label="Show subtitles later" onClick={() => ext.setOffset(ext.active!.offsetMs + OFFSET_STEP)}>
              +0.5 s
            </button>
            {ext.active.offsetMs !== 0 && (
              <button type="button" className="pl-menu-item pl-subs-step" onClick={() => ext.setOffset(0)}>
                Reset
              </button>
            )}
          </div>
        )}
        {external && (
          <>
            <button type="button" className="pl-menu-item pl-menu-action" onClick={() => setView('search')}>
              <span className="pl-menu-text">
                <span>Find subtitles online…</span>
                {!ext?.state?.online && <span className="pl-menu-detail">{external.isAdmin ? 'Needs an OpenSubtitles API key' : 'Not set up yet'}</span>}
              </span>
            </button>
            {external.canFile && (
              <>
                <button type="button" className="pl-menu-item pl-menu-action" onClick={() => fileRef.current?.click()}>
                  <span className="pl-menu-text">
                    <span>Load from a file…</span>
                    <span className="pl-menu-detail">SRT or WebVTT</span>
                  </span>
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".srt,.vtt,.txt,application/x-subrip,text/vtt"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void ext?.upload(f);
                  }}
                />
              </>
            )}
            {ext?.busy && <p className="muted pl-menu-note" role="status">{ext.busy}</p>}
            {ext?.error && <p className="form-error pl-menu-note" role="alert">{ext.error}</p>}
          </>
        )}
      </div>
      <button type="button" className="icon-btn pl-menu-close" onClick={props.onClose} aria-label="Close">
        <IconClose />
      </button>
    </div>
  );
}

/* ---------------- the search view ---------------- */

function resultDetail(r: SubtitleSearchResult): string {
  return [
    `${r.downloads.toLocaleString()} downloads`,
    r.hearingImpaired ? 'with sound descriptions' : null,
    r.machineTranslated ? 'machine translated' : null,
    r.trusted ? 'trusted' : null,
    r.kept ? 'already on your server' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function SubtitleSearch({ menu, onBack }: { menu: ExternalMenu; onBack: () => void }) {
  const { kind, id, ext } = menu;
  const online = ext.state?.online ?? false;
  const [lang, setLang] = useState(menu.language);
  const [res, setRes] = useState<{ lang: string; query: string; results: SubtitleSearchResult[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [getting, setGetting] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const languages = COMMON_LANGUAGES.includes(lang) ? COMMON_LANGUAGES : [lang, ...COMMON_LANGUAGES];

  useEffect(() => {
    if (!online) return backRef.current?.focus();
    let gone = false;
    setLoading(true);
    setErr(null);
    call('GET /api/subtitles/:kind/:id/search', { params: { kind, id }, query: { lang } }).then(
      (r) => !gone && (setRes({ lang, ...r }), setLoading(false)),
      (e) => !gone && (setErr(errorMessage(e)), setLoading(false)),
    );
    return () => {
      gone = true;
    };
  }, [online, kind, id, lang]);

  // focus the first result once they are in (so a TV remote can go straight down the list)
  useEffect(() => {
    if (res) document.querySelector<HTMLElement>('.pl-menu-search .pl-sub-result')?.focus();
  }, [res]);

  const get = async (r: SubtitleSearchResult) => {
    setGetting(r.fileId);
    setErr(null);
    try {
      const d = await call('POST /api/subtitles/:kind/:id/download', { params: { kind, id }, body: { fileId: r.fileId } });
      await ext.added(d.file);
      onBack();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setGetting(null);
    }
  };

  return (
    <div className="pl-menu-col pl-sub-search">
      <div className="pl-sub-head">
        <button ref={backRef} type="button" className="pl-menu-item pl-sub-back" onClick={onBack} aria-label="Back to audio and subtitles">
          <IconBack />
        </button>
        <h3 className="label">Find subtitles</h3>
        {online && (
          <select className="input pl-sub-lang" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
            {languages.map((c) => (
              <option key={c} value={c}>
                {languageName(c)}
              </option>
            ))}
          </select>
        )}
      </div>
      {!online ? (
        <p className="muted pl-menu-note">
          {menu.isAdmin
            ? 'Add a free OpenSubtitles API key in Settings › Online subtitles, and AnyCast finds subtitles for titles that have none.'
            : 'Online subtitles are not set up on this server. Ask the admin to add an OpenSubtitles API key in Settings.'}
          {menu.canFile && ' You can also load a subtitle file from this device.'}
        </p>
      ) : (
        <>
          {res && !loading && <p className="pl-menu-detail">{res.query}</p>}
          {loading && <p className="muted pl-menu-note" role="status">Searching OpenSubtitles…</p>}
          {err && <p className="form-error pl-menu-note" role="alert">{err}</p>}
          {res && !loading && !res.results.length && !err && <p className="muted pl-menu-note">No {languageName(res.lang)} subtitles found for this title. Try another language.</p>}
          {res && !loading && res.results.length > 0 && (
            <div className="pl-sub-results">
              {res.results.map((r) => (
                <button key={r.fileId} type="button" className="pl-menu-item pl-sub-result" disabled={getting !== null} onClick={() => void get(r)}>
                  <span className="pl-menu-text">
                    <span className="pl-menu-release" title={r.release}>
                      {r.release}
                    </span>
                    <span className="pl-menu-detail">{getting === r.fileId ? 'Downloading…' : resultDetail(r)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
