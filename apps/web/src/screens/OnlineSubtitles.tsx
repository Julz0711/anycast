/**
 * Settings › Online subtitles (admins): the OpenSubtitles API key, and optionally an account for
 * more downloads a day. The server keeps both encrypted and never sends them back.
 */
import { useState, type FormEvent } from 'react';
import { SUBTITLE_LIMITS, type SubtitleSettings } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { useAsync } from '../lib/hooks';
import { fmtRelativeAgo } from '../lib/time';
import { Skeleton } from '../components/ui';

export function OnlineSubtitlesSection() {
  const st = useAsync(() => call('GET /api/subtitles/settings'), []);
  const [saved, setSaved] = useState<SubtitleSettings | null>(null);
  const s = saved ?? st.data;
  if (!s && st.error) return <p className="notice error">Couldn't read the subtitle settings: {errorMessage(st.error)}</p>;
  if (!s) return <Skeleton h="10rem" />;
  return <OnlineSubtitlesForm key={s.updatedAt ?? 0} current={s} onSaved={setSaved} />;
}

function OnlineSubtitlesForm({ current, onSaved }: { current: SubtitleSettings; onSaved: (s: SubtitleSettings) => void }) {
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState(current.username ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const has = current.configured;
  const accountChanged = username.trim() !== (current.username ?? '');

  const from =
    !has ? 'Not set up. Titles without their own subtitles can still use a file from your device.'
    : current.origin === 'app' ? `Set up in the app${current.updatedAt ? ` ${fmtRelativeAgo(current.updatedAt)}` : ''}.`
    : "From the server's .env file (OPENSUBTITLES_API_KEY).";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setResult(null);
    try {
      const r = await call('PUT /api/subtitles/settings', {
        body: { ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), username: username.trim(), ...(password ? { password } : {}) },
      });
      setApiKey('');
      setPassword('');
      setResult({ kind: 'ok', text: r.test.message });
      const { test: _t, ...rest } = r;
      onSaved(rest);
    } catch (err) {
      setResult({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    setResult(null);
    try {
      onSaved(await call('DELETE /api/subtitles/settings'));
    } catch (err) {
      setResult({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const canSave = busy === null && (has || apiKey.trim() !== '') && (!username.trim() || !accountChanged || password !== '');

  return (
    <form className="provider-form" onSubmit={save} aria-label="Online subtitles" data-testid="subtitle-settings">
      <p className="muted provider-intro">
        When a movie or episode has no subtitles of its own, AnyCast can find some on OpenSubtitles: automatically with the Subtitles setting
        (Settings › Player), or with Find subtitles online in the player. {from}
      </p>
      <label className="field">
        API key
        <input
          className="input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={SUBTITLE_LIMITS.apiKey}
          placeholder={has ? 'Saved. Leave empty to keep it.' : ''}
          value={apiKey}
          onChange={(e) => (setApiKey(e.target.value), setResult(null))}
        />
        <span className="field-hint">
          Free: sign up on opensubtitles.com, then open your profile › API consumers › New consumer and copy its API key.
        </span>
      </label>
      <label className="field">
        Account (optional)
        <input
          className="input"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={SUBTITLE_LIMITS.username}
          placeholder="OpenSubtitles username"
          value={username}
          onChange={(e) => (setUsername(e.target.value), setResult(null))}
        />
        <span className="field-hint">The key alone allows only a few downloads a day. With your free account it's 20. Subtitles AnyCast has downloaded once are kept and don't count again.</span>
      </label>
      {username.trim() !== '' && (
        <label className="field">
          Password
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            maxLength={SUBTITLE_LIMITS.password}
            placeholder={current.username && !accountChanged ? 'Saved. Leave empty to keep it.' : ''}
            value={password}
            onChange={(e) => (setPassword(e.target.value), setResult(null))}
          />
        </label>
      )}
      {result && (
        <p className={result.kind === 'ok' ? 'provider-ok' : 'form-error'} role={result.kind === 'ok' ? 'status' : 'alert'}>
          {result.text}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={!canSave}>
          {busy === 'save' ? 'Checking…' : 'Save'}
        </button>
        {current.origin === 'app' && (
          <button type="button" className="btn" disabled={busy !== null} onClick={() => void remove()}>
            {busy === 'remove' ? 'Removing…' : 'Remove'}
          </button>
        )}
      </div>
    </form>
  );
}
