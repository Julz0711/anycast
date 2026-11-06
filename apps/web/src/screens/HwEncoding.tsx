/**
 * Settings › All › Player › Hardware encoding (admins): which H.264 encoder full transcodes use.
 * The server's ANYCAST_HWACCEL is the default; an admin can override it here (stored on the
 * server). A change runs the server's test encodes again and shows what they found.
 */
import { useState, type ReactNode } from 'react';
import type { HwAccelSetting, VideoEncoderStatus } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { useAsync } from '../lib/hooks';
import { Skeleton } from '../components/ui';
import { IconRefresh } from '../components/Icons';

type RowComp = (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => JSX.Element;

export const SETTING_LABEL: Record<HwAccelSetting, string> = {
  auto: 'Automatic',
  off: 'Off (software)',
  vaapi: 'VAAPI (Intel/AMD)',
  qsv: 'Intel Quick Sync',
  nvenc: 'NVIDIA NVENC',
};
const METHOD_NAME: Record<string, string> = { vaapi: 'VAAPI', qsv: 'Quick Sync', nvenc: 'NVENC' };

/** "Tested: NVENC failed (…); VAAPI works." from the last test encodes, or null before any. */
export function probeSummary(s: Pick<VideoEncoderStatus, 'probes'>): string | null {
  if (!s.probes.length) return null;
  return `Tested: ${s.probes.map((p) => `${METHOD_NAME[p.method] ?? p.method} ${p.ok ? 'works' : `failed (${p.error ?? 'error'})`}`).join('; ')}.`;
}

export function HwEncoding({ Row }: { Row: RowComp }) {
  const [tick, setTick] = useState(0);
  const st = useAsync(() => call('GET /api/hwaccel'), [tick]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fresh, setFresh] = useState<VideoEncoderStatus | null>(null);
  const s = fresh ?? st.data;
  if (!s && st.error) return <p className="notice error">Couldn't read the hardware encoding setting: {errorMessage(st.error)}</p>;
  if (!s) return <Skeleton h="4rem" />;
  const run = async (f: () => Promise<VideoEncoderStatus>) => {
    setBusy(true);
    setErr(null);
    try {
      setFresh(await f());
    } catch (e) {
      setErr(errorMessage(e));
      setFresh(null);
      setTick((x) => x + 1);
    } finally {
      setBusy(false);
    }
  };
  const summary = probeSummary(s);
  return (
    <div data-testid="hw-encoding">
      <Row label="Hardware encoding" hint={`Used only when a device can't play a stream's video, so the server converts it. ${s.reason}${summary ? ` ${summary}` : ''}`}>
        <select
          className="input set-select"
          aria-label="Hardware encoding"
          value={s.source === 'admin' ? s.setting : ''}
          disabled={busy}
          onChange={(e) => void run(() => call('PUT /api/hwaccel', { body: { setting: (e.target.value || null) as HwAccelSetting | null } }))}
        >
          <option value="">Server default ({SETTING_LABEL[s.envSetting]})</option>
          {(Object.keys(SETTING_LABEL) as HwAccelSetting[]).map((k) => (
            <option key={k} value={k}>
              {SETTING_LABEL[k]}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Encoder in use" hint={busy ? 'Testing the hardware…' : 'A one second test encode runs at startup, after a change, and when you check again.'}>
        <span className="tabnum" data-testid="hw-encoder-active">
          {s.label} ({s.active})
        </span>{' '}
        <button type="button" className="btn" disabled={busy} onClick={() => void run(() => call('POST /api/hwaccel/check'))}>
          <IconRefresh /> Check again
        </button>
      </Row>
      {err && (
        <p className="notice error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
