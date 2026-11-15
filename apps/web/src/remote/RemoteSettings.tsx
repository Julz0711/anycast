/**
 * Settings › Remote. Every device: whether phones may steer it, and the name they see. Phones:
 * the way to the remote, and its button on Home. All of it stays on this device.
 */
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { deviceLabel } from '../lib/client-id';
import { useFormFactor } from '../lib/hooks';
import { Toggle } from '../components/ui';
import { IconRemote } from '../components/Icons';
import { setRemoteAllowed, setRemoteButton, setRemoteName, useRemoteAllowed, useRemoteButton, useRemoteName } from './receiver';

type RowComp = ComponentType<{ label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }>;

export function RemoteSettings({ Row }: { Row: RowComp }) {
  const form = useFormFactor();
  const navigate = useNavigate();
  const allowed = useRemoteAllowed(form);
  const button = useRemoteButton();
  const saved = useRemoteName();
  const [name, setName] = useState(saved);
  useEffect(() => setName(saved), [saved]);
  const commit = () => name.trim() !== saved && setRemoteName(name);

  return (
    <>
      {form === 'phone' && (
        <>
          <Row label="Remote" hint="Steer AnyCast on your TV or computer from this phone: play, pause, volume, channels, and starting something new.">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/remote')}>
              <IconRemote />
              Open remote
            </button>
          </Row>
          <Row label="Remote button on Home" hint="Next to Search at the top of Home. The remote is also under your profile, and it can have its own icon on the home screen.">
            <Toggle label="Remote button on Home" checked={button} onChange={setRemoteButton} />
          </Row>
        </>
      )}
      <Row label="Let phones control this device" hint="A phone signed in to this account can then play, pause and change what this device plays. Only for this device.">
        <Toggle label="Let phones control this device" checked={allowed} onChange={setRemoteAllowed} />
      </Row>
      {allowed && (
        <Row label="Name on the remote" hint={`What phones call this device. Empty: ${deviceLabel()}.`} stack>
          <input
            className="input"
            value={name}
            maxLength={60}
            placeholder={form === 'tv' ? 'Living room TV' : deviceLabel()}
            aria-label="Name on the remote"
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          />
        </Row>
      )}
    </>
  );
}
