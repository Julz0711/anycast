/**
 * The provider login (Xtream Codes), for admins: Settings › Provider and the first-run setup screen.
 * The server keeps the password encrypted and never sends it back, so the password field starts
 * empty; leaving it empty keeps the saved one. Pasting a whole playlist link into the address
 * fills in the username and password from it.
 */
import { useState, type FormEvent } from 'react';
import { parseProviderUrl, PROVIDER_LIMITS, type ProviderSettings, type ProviderTestResult } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { toast } from '../store/actions';
import { fmtRelativeAgo } from '../lib/time';
import { useAsync } from '../lib/hooks';
import { Skeleton } from '../components/ui';

type Result = { kind: 'ok' | 'error'; text: string } | null;

function accountLine(r: ProviderTestResult): string {
  const a = r.account;
  if (!a) return 'The provider accepted the login.';
  const parts = [`Account ${a.status.toLowerCase()}`];
  if (a.expiresAt) parts.push(`expires ${new Date(a.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`);
  if (a.maxConnections) parts.push(`${a.maxConnections} ${a.maxConnections === 1 ? 'stream' : 'streams'} at a time`);
  return `It works. ${parts.join(', ')}.`;
}

export function ProviderForm(props: { current: ProviderSettings | null; onSaved: (s: ProviderSettings) => void; setup?: boolean }) {
  const cur = props.current;
  const [url, setUrl] = useState(cur?.url ?? '');
  const [username, setUsername] = useState(cur?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [result, setResult] = useState<Result>(null);
  const hasSaved = !!cur?.configured;

  const body = () => ({ url: url.trim(), username: username.trim(), ...(password ? { password } : {}) });

  // a pasted playlist link: keep the address, move username and password into their fields
  const onUrl = (v: string) => {
    const p = /[?&](username|password)=/.test(v) ? parseProviderUrl(v) : null;
    if (p) {
      setUrl(p.url);
      if (p.username) setUsername(p.username);
      if (p.password) setPassword(p.password);
      setResult({ kind: 'ok', text: 'Filled in from the link you pasted.' });
    } else {
      setUrl(v);
      setResult(null);
    }
  };

  const test = async () => {
    setBusy('test');
    setResult(null);
    try {
      const r = await call('POST /api/provider/test', { body: body() });
      setResult(r.ok ? { kind: 'ok', text: accountLine(r) } : { kind: 'error', text: r.message ?? "That didn't work." });
    } catch (e) {
      setResult({ kind: 'error', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setResult(null);
    try {
      const s = await call('PUT /api/provider', { body: body() });
      setPassword('');
      setShowPassword(false);
      setUrl(s.url ?? '');
      setUsername(s.username ?? '');
      if (!props.setup) toast('Provider saved. Loading channels…');
      props.onSaved(s);
    } catch (err) {
      setResult({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const canSubmit = url.trim() !== '' && username.trim() !== '' && (hasSaved || password !== '') && busy === null;

  return (
    <form className="provider-form" onSubmit={save} aria-label="Provider login" data-testid="provider-form">
      <label className="field">
        Server address
        <input
          className="input"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="http://provider.example:8080"
          maxLength={PROVIDER_LIMITS.url}
          value={url}
          onChange={(e) => onUrl(e.target.value)}
          required
          autoFocus={props.setup}
        />
        <span className="field-hint">From your provider's Xtream Codes details. You can also paste your whole playlist link.</span>
      </label>
      <label className="field">
        Username
        <input
          className="input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={PROVIDER_LIMITS.username}
          value={username}
          onChange={(e) => (setUsername(e.target.value), setResult(null))}
          required
        />
      </label>
      <label className="field">
        Password
        <span className="provider-pass">
          <input
            className="input"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            maxLength={PROVIDER_LIMITS.password}
            placeholder={hasSaved ? 'Saved. Leave empty to keep it.' : ''}
            value={password}
            onChange={(e) => (setPassword(e.target.value), setResult(null))}
            required={!hasSaved}
          />
          <button type="button" className="btn" onClick={() => setShowPassword((v) => !v)} disabled={!password} aria-pressed={showPassword}>
            {showPassword ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>
      {result && (
        <p className={result.kind === 'ok' ? 'provider-ok' : 'form-error'} role={result.kind === 'ok' ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" className={`btn btn-primary${props.setup ? ' btn-lg' : ''}`} disabled={!canSubmit}>
          {busy === 'save' ? 'Checking…' : props.setup ? 'Connect' : 'Save'}
        </button>
        <button type="button" className={`btn${props.setup ? ' btn-lg' : ''}`} disabled={!canSubmit} onClick={() => void test()}>
          {busy === 'test' ? 'Testing…' : 'Test login'}
        </button>
      </div>
    </form>
  );
}

/** Settings › Provider (admins). */
export function ProviderSection() {
  const st = useAsync(() => call('GET /api/provider'), []);
  const [saved, setSaved] = useState<ProviderSettings | null>(null);
  const s = saved ?? st.data;
  if (!s && st.error) return <p className="notice error">Couldn't read the provider login: {errorMessage(st.error)}</p>;
  if (!s) return <Skeleton h="12rem" />;
  const from =
    !s.configured ? 'No provider yet. Enter the details from your IPTV provider.'
    : s.origin === 'app' ? `Entered in the app${s.updatedAt ? ` ${fmtRelativeAgo(s.updatedAt)}` : ''}.`
    : "From the server's .env file.";
  return (
    <div data-testid="provider-settings">
      <p className="muted provider-intro">
        Every profile watches through this login. {from} The password is stored encrypted on your server and is never shown again.
        {s.envSet && ' If you change XTREAM_* in .env later, that wins at the next restart.'}
      </p>
      <ProviderForm key={s.updatedAt ?? 0} current={s} onSaved={setSaved} />
    </div>
  );
}
