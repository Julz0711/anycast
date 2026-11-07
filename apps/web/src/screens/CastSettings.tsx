/**
 * Settings › Casting: how TVs reach the server (Chromecast and AirPlay open the stream themselves).
 * The address is shared by every profile; only an admin changes it.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { call, errorMessage } from '../api/client';
import { useAsync } from '../lib/hooks';
import { useApp } from '../store/app';
import { isDemo } from '../demo/flag';
import { airPlayApi } from '../player/cast/airplay';
import { castSupported } from '../player/cast/chromecast';
import { unreachableFromTv } from '../player/cast/media';
import { Skeleton } from '../components/ui';

type RowComp = ComponentType<{ label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }>;

/** What this browser can cast with, in a sentence. */
function browserSupport(): string {
  if (airPlayApi()) return 'This browser casts with AirPlay, to an Apple TV or a TV with AirPlay.';
  if (castSupported({ secure: window.isSecureContext, ua: navigator.userAgent, hasChrome: typeof (window as { chrome?: unknown }).chrome === 'object' })) {
    return 'This browser casts to a Chromecast or a TV with Chromecast built in (most Android TVs, including Sony).';
  }
  if (!window.isSecureContext) return 'Casting needs AnyCast opened over https (see the CasaOS guide). This page is plain http.';
  return 'This browser can’t cast. Use Chrome or Edge for Chromecast, or Safari for AirPlay.';
}

export function CastSettings({ Row }: { Row: RowComp }) {
  const isAdmin = useApp((s) => s.me?.user.isAdmin ?? false);
  const st = useAsync(() => (isDemo() ? Promise.resolve({ baseUrl: null }) : call('GET /api/cast/settings')), []);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (st.data) {
      setValue(st.data.baseUrl ?? '');
      setSaved(st.data.baseUrl);
    }
  }, [st.data]);

  if (st.error) return <p className="notice error">Couldn't read the casting settings: {errorMessage(st.error)}</p>;
  if (!st.data) return <Skeleton h="4rem" />;

  const save = async (next: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await call('PUT /api/cast/settings', { body: { baseUrl: next } });
      setSaved(r.baseUrl);
      setValue(r.baseUrl ?? '');
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const warn = !saved && unreachableFromTv(location.origin);
  const hint = (
    <>
      The TV opens the stream from your server itself, so it needs an address it can reach on your home network, such as{' '}
      <span className="tabnum">http://192.168.1.20:8787</span>. Leave it empty to use the address this app is open at
      {` (${location.host})`}.{warn && ` A TV can't open ${location.host}, so set your server's home network address here.`}
    </>
  );

  return (
    <div data-testid="cast-settings">
      <Row label="This browser" hint={browserSupport()}>
        <span />
      </Row>
      <Row label="Server address for TVs" hint={hint} stack>
        {isAdmin ? (
          <form
            className="row-inline"
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
            onSubmit={(e) => {
              e.preventDefault();
              void save(value.trim() || null);
            }}
          >
            <input
              className="input"
              style={{ flex: '1 1 14rem', minWidth: 0 }}
              aria-label="Server address for TVs"
              placeholder={location.origin}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={busy}
              aria-invalid={!!err}
              onChange={(e) => (setValue(e.target.value), setErr(null))}
            />
            <button type="submit" className="btn btn-primary" disabled={busy || value.trim() === (saved ?? '')}>
              Save
            </button>
            {saved && (
              <button type="button" className="btn" disabled={busy} onClick={() => void save(null)}>
                Clear
              </button>
            )}
          </form>
        ) : (
          <span className="muted tabnum">{saved ?? 'Same as this app'}</span>
        )}
      </Row>
      {err && (
        <p className="form-error" role="alert">
          {err}
        </p>
      )}
      <p className="set-hint" style={{ marginTop: '0.5rem' }}>
        Casting plays the stream your server already makes for this app, so it never uses a second provider connection. While a TV plays, this device is the remote.
      </p>
    </div>
  );
}
