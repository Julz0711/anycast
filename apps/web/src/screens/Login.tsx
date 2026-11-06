import { useState, type FormEvent } from 'react';
import { login } from '../store/actions';
import { ApiError, errorMessage } from '../api/client';
import { BrandMark } from '../components/Icons';
import { isDemo } from '../demo/flag';

export function LoginScreen() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? errorMessage(err) || 'Wrong username or password.'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit} aria-labelledby="login-title">
        <div className="brand">
          <BrandMark />
          AnyCast
        </div>
        <h1 id="login-title" className="h1" style={{ fontSize: '1.5rem' }}>
          Sign in
        </h1>
        <label className="field">
          Username
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          Password
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted" style={{ fontSize: '0.8125rem' }}>
          {isDemo() ? 'Demo mode: any username, password "demo".' : 'Use the account from your AnyCast server. Your provider login never leaves the server.'}
        </p>
      </form>
    </div>
  );
}
