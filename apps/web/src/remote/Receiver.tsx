/**
 * Mounted once while signed in: announces this device to phones' remotes (when allowed) and
 * opens what a remote asks for. The remote screen itself never announces.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { call } from '../api/client';
import { useFormFactor } from '../lib/hooks';
import { useApp } from '../store/app';
import { setRemoteOpener, startAnnouncing, useRemoteAllowed } from './receiver';

export function RemoteReceiver() {
  const form = useFormFactor();
  const allowed = useRemoteAllowed(form);
  const profileId = useApp((s) => s.profileId);
  const onRemote = useLocation().pathname.startsWith('/remote');
  const navigate = useNavigate();
  const on = allowed && !!profileId && !onRemote;

  useEffect(() => {
    if (!on) return;
    setRemoteOpener((c) => navigate(`/play/${c.kind}/${encodeURIComponent(c.id)}${c.kind === 'episode' && c.seriesId ? `?series=${encodeURIComponent(c.seriesId)}` : ''}`));
    const a = startAnnouncing(form, (body) => (body ? call('POST /api/remote/presence', { body }) : call('DELETE /api/remote/presence', { keepalive: true })));
    return () => {
      a.stop();
      setRemoteOpener(null);
    };
  }, [on, form, profileId, navigate]);

  return null;
}
