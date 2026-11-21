/**
 * Shows external subtitles over the video. Follows the video's time every frame while it plays
 * (timeupdate alone is 4 times a second, too coarse for subtitles) and re-renders only when the
 * lines change.
 */
import { useEffect, useState, type RefObject } from 'react';
import { activeCues, cueSegments, type Cue } from './externalSubs';

export function SubtitleOverlay(props: { videoRef: RefObject<HTMLVideoElement | null>; cues: Cue[]; offsetMs: number; rate: number }) {
  const { videoRef, cues, offsetMs, rate } = props;
  const [lines, setLines] = useState<Cue[]>([]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let raf = 0;
    let last = '';
    const update = () => {
      const now = activeCues(cues, v.currentTime, offsetMs, rate);
      const key = now.map((c) => `${c.start}:${c.end}`).join('|');
      if (key !== last) {
        last = key;
        setLines(now);
      }
    };
    const loop = () => {
      update();
      raf = v.paused ? 0 : requestAnimationFrame(loop);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(loop);
    };
    loop();
    // paused: seeking and stepping still change what shows
    v.addEventListener('play', start);
    v.addEventListener('seeked', update);
    v.addEventListener('timeupdate', update);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener('play', start);
      v.removeEventListener('seeked', update);
      v.removeEventListener('timeupdate', update);
    };
  }, [videoRef, cues, offsetMs, rate]);

  if (!lines.length) return null;
  return (
    <div className="pl-subs" aria-live="off" data-testid="external-subtitles">
      {lines.map((c) => (
        <span key={`${c.start}:${c.end}`} className="pl-subs-cue">
          {cueSegments(c.text).map((s, i) => {
            const style = s.i || s.b || s.u ? { fontStyle: s.i ? 'italic' : undefined, fontWeight: s.b ? 700 : undefined, textDecoration: s.u ? 'underline' : undefined } : undefined;
            return style ? (
              <span key={i} style={style}>
                {s.text}
              </span>
            ) : (
              s.text
            );
          })}
        </span>
      ))}
    </div>
  );
}
