/**
 * External subtitles of the playing movie or episode: what the server keeps for it, the one
 * showing (with its cues and timing offset), and fetching one on its own when the Subtitles
 * preference wants subtitles and the stream has none (externalSubs.ts autoLanguage).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExternalSubtitle, ExternalSubtitleState, PlaybackTracks } from '@anycast/shared';
import { SUBTITLE_LIMITS } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { useApp } from '../store/app';
import { autoLanguage, parseVtt, type Cue } from './externalSubs';

export interface ActiveExternal {
  file: ExternalSubtitle;
  cues: Cue[];
  offsetMs: number;
}

export interface ExternalSubtitles {
  state: ExternalSubtitleState | null;
  active: ActiveExternal | null;
  /** what it is doing now ("Loading subtitles…"), for the menu */
  busy: string | null;
  error: string | null;
  /** show a kept file (and remember it for this item) */
  pick: (file: ExternalSubtitle) => Promise<void>;
  /** hide the external subtitle; remember=true keeps it off for this item */
  off: (remember: boolean) => void;
  setOffset: (ms: number) => void;
  /** a file from the device */
  upload: (file: File) => Promise<void>;
  /** a search result was downloaded: show it */
  added: (file: ExternalSubtitle) => Promise<void>;
}

const deviceLanguage = () => (typeof navigator !== 'undefined' ? navigator.language : null);

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function useExternalSubtitles(o: {
  kind: 'movie' | 'episode';
  id: string;
  /** VOD, and the stream info for this item has loaded */
  ready: boolean;
  tracks: PlaybackTracks | undefined;
  /** the stream's own subtitle track showing (null = none) */
  shown: number | null;
  itemLanguage: string | null;
  /** an external subtitle started showing: turn the stream's own off */
  onShow: () => void;
}): ExternalSubtitles {
  const { kind, id, ready } = o;
  const [state, setState] = useState<ExternalSubtitleState | null>(null);
  const [active, setActive] = useState<ActiveExternal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const item = `${kind}:${id}`;
  const itemRef = useRef(item);
  itemRef.current = item;
  const latest = useRef(o);
  latest.current = o;

  const show = useCallback(async (file: ExternalSubtitle, offsetMs: number, forItem: string) => {
    const text = await call('GET /api/subtitles/file/:fileId', { params: { fileId: file.id } });
    if (itemRef.current !== forItem) return false;
    setActive({ file, cues: parseVtt(String(text)), offsetMs });
    latest.current.onShow();
    return true;
  }, []);

  // a new item: nothing shows until its state is read
  useEffect(() => {
    setState(null);
    setActive(null);
    setError(null);
    setBusy(null);
  }, [item]);

  // once per item: the saved pick, else one fetched on its own when the preferences want subtitles
  useEffect(() => {
    if (!ready) return;
    let gone = false;
    const forItem = item;
    void (async () => {
      let st: ExternalSubtitleState;
      try {
        st = await call('GET /api/subtitles/:kind/:id', { params: { kind, id } });
      } catch {
        return;
      }
      if (gone) return;
      setState(st);
      const picked = st.choice?.fileId ? st.files.find((f) => f.id === st.choice!.fileId) : null;
      if (picked) {
        await show(picked, st.choice!.offsetMs, forItem).catch(() => undefined);
        return;
      }
      const cur = latest.current;
      const lang = autoLanguage({
        prefs: useApp.getState().prefs.player, tracks: cur.tracks, shown: cur.shown, state: st, itemLanguage: cur.itemLanguage, deviceLanguage: deviceLanguage(),
      });
      if (!lang) return;
      // a kept one in the language needs no request; otherwise the server finds the best online
      const kept = st.files.find((f) => f.language === lang);
      if (!kept && !st.online) return;
      try {
        if (!kept) setBusy('Finding subtitles…');
        const file = kept ?? (await call('POST /api/subtitles/:kind/:id/auto', { params: { kind, id }, body: { language: lang } })).file;
        if (gone || !file) return;
        if (!kept) setState((s) => (s && !s.files.some((f) => f.id === file.id) ? { ...s, files: [file, ...s.files] } : s));
        await show(file, 0, forItem);
      } catch {
        /* quietly: the menu can still search */
      } finally {
        if (!gone) setBusy(null);
      }
    })();
    return () => {
      gone = true;
    };
  }, [ready, item, kind, id, show]);

  const saveChoice = useCallback(
    (fileId: string | null, offsetMs: number) =>
      void call('PUT /api/subtitles/:kind/:id/choice', { params: { kind, id }, body: { fileId, offsetMs } })
        .then(() => setState((s) => (s ? { ...s, choice: { fileId, offsetMs } } : s)))
        .catch(() => undefined),
    [kind, id],
  );

  const pick = useCallback(
    async (file: ExternalSubtitle) => {
      setError(null);
      setBusy('Loading subtitles…');
      try {
        const offsetMs = state?.choice?.fileId === file.id ? state.choice.offsetMs : 0;
        if (await show(file, offsetMs, item)) saveChoice(file.id, offsetMs);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [show, item, saveChoice, state],
  );

  const added = useCallback(
    async (file: ExternalSubtitle) => {
      setState((s) => (s ? { ...s, files: [file, ...s.files.filter((f) => f.id !== file.id)] } : s));
      await pick(file);
    },
    [pick],
  );

  const off = useCallback(
    (remember: boolean) => {
      setActive(null);
      if (remember) saveChoice(null, 0);
    },
    [saveChoice],
  );

  // the offset saves a moment after the last change
  const offsetTimer = useRef<number | undefined>(undefined);
  const setOffset = useCallback(
    (ms: number) => {
      const v = Math.max(-SUBTITLE_LIMITS.offsetMs, Math.min(SUBTITLE_LIMITS.offsetMs, Math.round(ms)));
      setActive((a) => {
        if (!a) return a;
        window.clearTimeout(offsetTimer.current);
        offsetTimer.current = window.setTimeout(() => saveChoice(a.file.id, v), 800);
        return { ...a, offsetMs: v };
      });
    },
    [saveChoice],
  );
  useEffect(() => () => window.clearTimeout(offsetTimer.current), []);

  const upload = useCallback(
    async (f: File) => {
      setError(null);
      if (f.size > SUBTITLE_LIMITS.uploadBytes) return setError('That file is too big for a subtitle file.');
      setBusy('Loading subtitles…');
      try {
        const data = toBase64(await f.arrayBuffer());
        const r = await call('POST /api/subtitles/:kind/:id/upload', { params: { kind, id }, body: { name: f.name, data } });
        await added(r.file);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    [kind, id, added],
  );

  return { state, active, busy, error, pick, off, setOffset, upload, added };
}
