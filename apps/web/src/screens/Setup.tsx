/**
 * First run: pick the languages to keep (English preselected). Saves hide rules that hide every other language.
 * Also covers "no catalog yet" (server still syncing or no source configured).
 */
import { useEffect, useMemo, useState } from 'react';
import type { SourceStatus } from '@anycast/shared';
import { useApp } from '../store/app';
import { markSetupDone, saveHideRules } from '../store/actions';
import { call, errorMessage } from '../api/client';
import { useAsync } from '../lib/hooks';
import { languageName } from '../lib/lang';
import { BrandMark } from '../components/Icons';
import { Skeleton } from '../components/ui';
import { ProviderForm } from './Provider';

export function SetupScreen(props: { status: SourceStatus | null; onRefresh: () => void }) {
  const rules = useApp((s) => s.hideRules);
  const noCatalog = !props.status || !props.status.configured || props.status.counts.live + props.status.counts.movie + props.status.counts.series === 0;

  // While the server syncs, poll every 3 s.
  useEffect(() => {
    if (!noCatalog) return;
    const t = setInterval(props.onRefresh, 3000);
    return () => clearInterval(t);
  }, [noCatalog, props.onRefresh]);

  const tags = useAsync(() => (noCatalog ? Promise.resolve(null) : call('GET /api/tags')), [noCatalog]);
  const langs = useMemo(
    () => (tags.data?.languages ?? []).filter((l) => l.language).sort((a, b) => b.count - a.count),
    [tags.data],
  );
  const [keep, setKeep] = useState<Set<string>>(() => new Set(['en']));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const hide = langs.map((l) => l.language!).filter((l) => !keep.has(l));
    await saveHideRules({ ...rules, languages: hide });
    markSetupDone();
    setBusy(false);
  };

  return (
    <div className="center-screen">
      <div className="setup">
        <div className="brand" style={{ padding: 0 }}>
          <BrandMark />
          AnyCast
        </div>
        {noCatalog ? (
          <NoCatalog status={props.status} onRefresh={props.onRefresh} />
        ) : (
          <>
            <h1 className="h1">Which languages do you watch?</h1>
            <p className="muted">
              Everything in other languages is hidden from Live TV, Movies, Series and search. You can change this any time in Settings › Filters.
            </p>
            {tags.loading && !tags.data ? (
              <div className="lang-grid">
                {Array.from({ length: 10 }, (_, i) => (
                  <Skeleton key={i} w="7rem" h="2.25rem" r="999px" />
                ))}
              </div>
            ) : tags.error ? (
              <p className="notice error">Couldn't load languages: {errorMessage(tags.error)}</p>
            ) : (
              <div className="lang-grid" role="group" aria-label="Languages to keep" data-nav-row="langs">
                {langs.map((l) => (
                  <button
                    key={l.language}
                    type="button"
                    className="chip"
                    aria-pressed={keep.has(l.language!)}
                    onClick={() =>
                      setKeep((s) => {
                        const n = new Set(s);
                        if (n.has(l.language!)) n.delete(l.language!);
                        else n.add(l.language!);
                        return n;
                      })
                    }
                  >
                    {languageName(l.language)} <span className="count">{l.count}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="actions">
              <button type="button" className="btn btn-primary btn-lg" disabled={busy || keep.size === 0} onClick={save} data-nav-autofocus="">
                {keep.size === 0 ? 'Pick at least one' : `Keep ${keep.size} language${keep.size > 1 ? 's' : ''}`}
              </button>
              <button
                type="button"
                className="btn btn-lg"
                onClick={() => {
                  markSetupDone();
                  useApp.setState((s) => ({ catalogVersion: s.catalogVersion + 1 }));
                }}
              >
                Show everything
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function NoCatalog(props: { status: SourceStatus | null; onRefresh: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const isAdmin = useApp((st) => st.me?.user.isAdmin ?? false);
  const s = props.status;
  if (s && !s.configured) {
    if (isAdmin) {
      return (
        <>
          <h1 className="h1">Connect your TV provider</h1>
          <p className="muted">
            Enter the Xtream Codes details from your IPTV provider. AnyCast checks them, then loads your channels, movies and series. The password stays
            encrypted on your server and is never shown again. You can change this later in Settings › Provider.
          </p>
          <ProviderForm setup current={null} onSaved={() => props.onRefresh()} />
        </>
      );
    }
    return (
      <>
        <h1 className="h1">No TV source yet</h1>
        <p className="muted">AnyCast doesn't have a TV provider yet. Ask the person who set up AnyCast to sign in with the admin account and add it.</p>
        <button className="btn btn-lg" type="button" onClick={props.onRefresh}>
          Check again
        </button>
      </>
    );
  }
  return (
    <>
      <h1 className="h1">Getting your channels…</h1>
      <p className="muted">
        {s?.syncing ? 'The server is loading the channel list, movies and series from your provider. This usually takes under a minute.' : 'Nothing has been loaded from your provider yet.'}
      </p>
      <div style={{ display: 'grid', gap: '0.75rem' }} aria-hidden="true">
        <Skeleton h="3.25rem" r="0.875rem" />
        <Skeleton h="3.25rem" r="0.875rem" />
        <Skeleton h="3.25rem" r="0.875rem" w="80%" />
      </div>
      {!s?.syncing && (
        <button
          className="btn btn-primary btn-lg"
          type="button"
          onClick={() =>
            call('POST /api/source/sync').then(
              () => (setMsg('Sync started.'), props.onRefresh()),
              (e) => setMsg(errorMessage(e)),
            )
          }
        >
          Sync now
        </button>
      )}
      {msg && <p className="muted">{msg}</p>}
    </>
  );
}
