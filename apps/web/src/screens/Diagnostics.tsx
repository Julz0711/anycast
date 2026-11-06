/**
 * Settings › All › Diagnostics (admins): server version and uptime, FFmpeg tools, provider
 * connections in use, and disk use of the rewind buffer and thumbnails. Refreshes every 10 s.
 * Other users see a note that admins can see them.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ServerDiagnostics } from '@anycast/shared';
import { call, errorMessage } from '../api/client';
import { fmtBytes } from '../api/buffer';
import { useAsync } from '../lib/hooks';
import { fmtLength } from '../lib/time';
import { ProgressBar, Skeleton } from '../components/ui';
import { IconRefresh } from '../components/Icons';

type RowComp = (p: { label: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) => JSX.Element;

/** "3 d 4 h", "2 h 5 min", "12 min", "40 s" */
export function fmtUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  if (seconds < 86_400) return fmtLength(seconds);
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

const KIND: Record<string, string> = { live: 'live', timeshift: 'archive', movie: 'movie', episode: 'episode' };
export function connectionsHint(byKind: Record<string, number>): string {
  const parts = Object.entries(byKind).map(([k, n]) => `${n} ${KIND[k] ?? k}`);
  return parts.length ? `In use for: ${parts.join(', ')}.` : 'Nothing is playing from the provider right now.';
}

function Tool({ t }: { t: ServerDiagnostics['ffmpeg'] }) {
  return t.available ? <span className="status-ok tabnum">{t.version ?? 'Available'}</span> : <span className="status-bad">Not found</span>;
}

/** The Diagnostics section: the server's diagnostics for admins, a one-line note for everyone else. */
export function DiagnosticsSection({ isAdmin, Row }: { isAdmin: boolean; Row: RowComp }) {
  if (isAdmin) return <Diagnostics Row={Row} />;
  return (
    <p className="muted" data-testid="diagnostics-admin-only">
      Server diagnostics (FFmpeg, provider connections, disk use) are visible to admins.
    </p>
  );
}

export function Diagnostics({ Row }: { Row: RowComp }) {
  const [tick, setTick] = useState(0);
  const st = useAsync(() => call('GET /api/diagnostics'), [tick]);
  const [last, setLast] = useState<ServerDiagnostics | null>(null);
  useEffect(() => {
    if (st.data) setLast(st.data);
  }, [st.data]);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const d = st.data ?? last;
  if (!d && st.error) return <p className="notice error">Couldn't read the server diagnostics: {errorMessage(st.error)}</p>;
  if (!d) return <Skeleton h="10rem" />;
  const c = d.connections;
  return (
    <div data-testid="diagnostics">
      <Row label="Server" hint={`Node ${d.node} · ${d.platform}`}>
        <span className="tabnum">
          {d.version} · up {fmtUptime(d.uptimeSeconds)}
        </span>
      </Row>
      <Row label="FFmpeg" hint="Repackages and converts streams this device can't play as they are.">
        <Tool t={d.ffmpeg} />
      </Row>
      <Row label="ffprobe" hint="Reads a stream's codecs once, to pick the cheapest way to play it.">
        <Tool t={d.ffprobe} />
      </Row>
      <Row label="Hardware encoders" hint="Listed by this FFmpeg build; the hardware itself may not be present. Conversions use the software H.264 encoder.">
        <span className="muted caps">{d.hwEncoders.length ? d.hwEncoders.join(' · ') : 'None found'}</span>
      </Row>
      <Row label="Provider connections" hint={connectionsHint(c.byKind)}>
        <span className="tabnum">
          {c.active} of {c.max ?? 'unlimited'} in use
        </span>
      </Row>
      <Row label="Conversions running" hint="FFmpeg sessions serving HLS right now.">
        <span className="tabnum">{d.hlsSessions}</span>
      </Row>
      <Row label="Rewind buffer on disk" hint={d.buffer.enabled ? `${d.buffer.recording} channel${d.buffer.recording === 1 ? '' : 's'} recording now.` : 'The rewind buffer is turned off on this server.'}>
        {d.buffer.enabled && d.buffer.maxBytes ? (
          <div className="buf-total">
            <span className="tabnum">
              {fmtBytes(d.buffer.bytes)} of {fmtBytes(d.buffer.maxBytes)}
            </span>
            <ProgressBar value={d.buffer.bytes / d.buffer.maxBytes} label="Rewind buffer disk use" />
          </div>
        ) : (
          <span className="muted">Off</span>
        )}
      </Row>
      {d.thumbnails && (
        <Row label="Scrub thumbnails on disk">
          <span className="tabnum">{fmtBytes(d.thumbnails.bytes)}</span>
        </Row>
      )}
      <Row label="Refresh" hint={st.error ? `Last refresh failed: ${errorMessage(st.error)}` : 'Updates every 10 seconds.'}>
        <button type="button" className="btn" onClick={() => setTick((x) => x + 1)}>
          <IconRefresh /> Refresh
        </button>
      </Row>
    </div>
  );
}
