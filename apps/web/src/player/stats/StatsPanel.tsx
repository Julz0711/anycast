/**
 * Player Stats panel (lazy chunk): how this stream is served and how it plays right now.
 * Server side facts come from PlaybackInfo.diagnostics; the rest is sampled off the <video> once a second.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PlaybackInfo } from '@anycast/shared';
import type { EngineKind } from '../engine';
import { IconClose } from '../../components/Icons';
import { convertedCodecs } from '../caps';
import {
  audioLine, bufferAhead, convertedByChoice, decodedBytes, ENGINE_LABEL, fmtBitrate, fmtSeconds, frameCounts, pictureFix, pipelineLine, RateMeter, SOURCE_LABEL, sourceOf,
  streamBytes, videoLine, type FrameCounts,
} from './sample';
import '../../theme/player-extras.css';

export interface StatsPanelProps {
  video: HTMLVideoElement | null;
  info: PlaybackInfo | null;
  /** live | movie | episode (the player route) */
  routeKind: string;
  engine: EngineKind | null;
  /** live: how far the playhead is behind real time, in ms */
  behindLiveMs: number | null;
  onClose: () => void;
  /** the picture looks wrong: convert this codec on this device from now on, and play again */
  onConvert?: (codec: string) => void;
  /** undoes onConvert: this device plays the codec itself again, and the stream comes again */
  onPlayDirect?: (codec: string) => void;
}

interface Live {
  ahead: number;
  frames: FrameCounts | null;
  fps: number | null;
  bps: number | null;
  decoded: string | null;
}

function useSampler(video: HTMLVideoElement | null, url: string | undefined): Live | null {
  const [s, setS] = useState<Live | null>(null);
  const meter = useRef(new RateMeter());
  const lastFrames = useRef<{ t: number; total: number } | null>(null);
  useEffect(() => {
    meter.current.reset();
    lastFrames.current = null;
    if (!video) return;
    const sample = () => {
      const t = performance.now();
      const decoded = decodedBytes(video);
      const bytes = decoded ?? (typeof performance.getEntriesByType === 'function' ? streamBytes(performance.getEntriesByType('resource') as PerformanceResourceTiming[]) : 0);
      meter.current.add({ t, bytes });
      const frames = frameCounts(video);
      let fps: number | null = null;
      const lf = lastFrames.current;
      if (frames && lf && t > lf.t && frames.total >= lf.total) fps = ((frames.total - lf.total) * 1000) / (t - lf.t);
      if (frames) lastFrames.current = { t, total: frames.total };
      setS({
        ahead: bufferAhead(video),
        frames,
        fps: video.paused ? null : fps,
        bps: meter.current.bps(),
        decoded: video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : null,
      });
    };
    sample();
    const id = window.setInterval(sample, 1000);
    return () => window.clearInterval(id);
  }, [video, url]);
  return s;
}

function Row({ name, stat, children }: { name: string; stat: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd data-stat={stat}>{children}</dd>
    </>
  );
}

export default function StatsPanel(p: StatsPanelProps) {
  const live = useSampler(p.video, p.info?.url);
  const d = p.info?.diagnostics;
  const forced = p.info ? convertedByChoice(p.info, convertedCodecs()) : null;
  const isLive = p.routeKind === 'live';
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack') {
      e.preventDefault();
      e.stopPropagation();
      p.onClose();
    }
  };
  const dropped = live?.frames ? `${live.frames.dropped.toLocaleString()} / ${live.frames.total.toLocaleString()}` : '—';
  return (
    <section className="pl-stats" role="region" aria-label="Playback stats" data-testid="stats-panel" data-player-keys="off" onKeyDown={onKeyDown}>
      <header className="pl-stats-head">
        <h2 className="label">Stats</h2>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label="Close stats">
          <IconClose />
        </button>
      </header>
      {!p.info ? (
        <p className="muted">Waiting for the stream…</p>
      ) : (
        <dl className="pl-stats-list tabnum">
          <Row name="Source" stat="source">{SOURCE_LABEL[sourceOf(p.info, p.routeKind)]}</Row>
          <Row name="Pipeline" stat="pipeline">{pipelineLine(p.info)}</Row>
          {forced ? (
            <dd className="pl-stats-why pl-stats-fix" data-stat="reason">
              The server converts the {forced.label} video because this device was set to always convert {forced.label} (from this panel). It plays {forced.label} itself, and
              converting in real time costs the server a lot, which can make sound drop out or drift.{' '}
              {p.onPlayDirect && (
                <button type="button" className="btn" onClick={() => p.onPlayDirect!(forced.codec)}>
                  Play {forced.label} directly again
                </button>
              )}
            </dd>
          ) : (
            d && (
              <dd className="pl-stats-why" data-stat="reason">
                {d.reason}
              </dd>
            )
          )}
          <Row name="Engine" stat="engine">{p.engine ? ENGINE_LABEL[p.engine] : '—'}</Row>
          <Row name="Container" stat="container">{d?.probe.container?.toUpperCase() ?? '—'}</Row>
          <Row name="Video" stat="video">{d ? videoLine(d.probe.video) : '—'}{live?.decoded ? <span className="muted"> (playing {live.decoded})</span> : null}</Row>
          <Row name="Audio" stat="audio">{d ? audioLine(d.probe.audio) : '—'}</Row>
          <PictureHelp info={p.info} onConvert={p.onConvert} />
          {d?.assumed && (
            <dd className="pl-stats-why" data-stat="assumed">
              The server couldn't probe this stream; the codecs above are assumed.
            </dd>
          )}
          <Row name="Bitrate" stat="bitrate">{fmtBitrate(live?.bps ?? null)}</Row>
          <Row name="Buffer ahead" stat="buffer">{live ? fmtSeconds(live.ahead) : '—'}</Row>
          <Row name="Dropped frames" stat="frames">
            {dropped}
            {live?.fps ? <span className="muted"> · {Math.round(live.fps)} fps</span> : null}
          </Row>
          {isLive && <Row name="Behind live" stat="latency">{p.behindLiveMs === null ? '—' : fmtSeconds(p.behindLiveMs / 1000)}</Row>}
        </dl>
      )}
      <p className="pl-stats-foot muted">Press I to hide</p>
    </section>
  );
}

function PictureHelp({ info, onConvert }: { info: PlaybackInfo; onConvert?: (codec: string) => void }) {
  const fix = pictureFix(info);
  if (!fix || (fix.kind === 'convert' && !onConvert)) return null;
  return (
    <dd className="pl-stats-why pl-stats-fix" data-stat="picture-fix">
      Picture grey, washed out or full of colored specks?{' '}
      {fix.kind === 'convert' ? (
        <>
          This device decodes the {fix.label} video itself.{' '}
          <button type="button" className="btn" onClick={() => onConvert!(fix.codec)}>
            Convert {fix.label} on this device
          </button>
        </>
      ) : (
        <>The server converts this video on the GPU ({fix.label}). An admin can turn hardware encoding off in Settings, under Playback.</>
      )}
    </dd>
  );
}
