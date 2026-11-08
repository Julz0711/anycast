/** Player volume: a mute button plus a slider, remembered per device. */
import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { readLocal, writeLocal } from '../lib/storage';

const KEY_LEVEL = 'anycast.volume';
const KEY_MUTED = 'anycast.muted';
/** one arrow-key press */
export const VOLUME_STEP = 0.05;

export function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, Math.round(v * 100) / 100));
}

function storedLevel(): number {
  const raw = readLocal(KEY_LEVEL);
  return raw === null ? 1 : clampVolume(Number(raw));
}

export interface Volume {
  level: number;
  muted: boolean;
  /** set the level; any level above 0 also unmutes */
  set: (level: number) => void;
  /** nudge by `delta` (e.g. ±VOLUME_STEP); returns the new level */
  nudge: (delta: number) => number;
  toggleMute: () => void;
}

/**
 * Keeps the <video>'s volume in sync with what this device last used. The element stays
 * mounted for the whole app (mini player), so applying it once is enough; volumechange
 * events catch changes from elsewhere (the browser's own controls, PiP, the M key).
 */
export function useVolume(videoRef: RefObject<HTMLVideoElement>): Volume {
  const [level, setLevel] = useState(storedLevel);
  const [muted, setMuted] = useState(() => readLocal(KEY_MUTED) === '1');

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = storedLevel();
    v.muted = readLocal(KEY_MUTED) === '1';
    const sync = () => {
      const lv = clampVolume(v.volume);
      setLevel(lv);
      setMuted(v.muted);
      writeLocal(KEY_LEVEL, String(lv));
      writeLocal(KEY_MUTED, v.muted ? '1' : null);
    };
    v.addEventListener('volumechange', sync);
    return () => v.removeEventListener('volumechange', sync);
  }, [videoRef]);

  const set = useCallback(
    (lv: number) => {
      const v = videoRef.current;
      if (!v) return;
      const next = clampVolume(lv);
      v.volume = next;
      if (next > 0) v.muted = false;
      else v.muted = true;
    },
    [videoRef],
  );
  const nudge = useCallback(
    (delta: number) => {
      const v = videoRef.current;
      if (!v) return 0;
      const from = v.muted ? 0 : v.volume;
      const next = clampVolume(from + delta);
      set(next);
      return next;
    },
    [videoRef, set],
  );
  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.muted || v.volume === 0) {
      // unmuting at 0 would stay silent: come back at a sensible level
      if (v.volume === 0) v.volume = 0.5;
      v.muted = false;
    } else v.muted = true;
  }, [videoRef]);

  return useMemo(() => ({ level, muted, set, nudge, toggleMute }), [level, muted, set, nudge, toggleMute]);
}

export function volumeLabel(level: number, muted: boolean): string {
  return muted || level === 0 ? 'Muted' : `Volume ${Math.round(level * 100)}%`;
}

const IconSpeaker = ({ level, muted }: { level: number; muted: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ico">
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    {muted || level === 0 ? (
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    ) : (
      <>
        <path d="M15.5 9.5a3.5 3.5 0 010 5" />
        {level > 0.5 && <path d="M18 7a7 7 0 010 10" />}
      </>
    )}
  </svg>
);

/**
 * Mute button + slider. `onHold` keeps the player controls on screen while the slider is
 * being dragged, so they don't fade away under the pointer.
 */
export function VolumeControl({ vol, onHold }: { vol: Volume; onHold: (holding: boolean) => void }) {
  const silent = vol.muted || vol.level === 0;
  const pct = Math.round((silent ? 0 : vol.level) * 100);
  return (
    <div className="pl-vol">
      <button type="button" className="btn pl-vol-btn" onClick={vol.toggleMute} aria-pressed={silent} aria-label={silent ? 'Unmute' : 'Mute'} title={silent ? 'Unmute (M)' : 'Mute (M)'}>
        <IconSpeaker level={vol.level} muted={vol.muted} />
      </button>
      <input
        type="range"
        className="pl-vol-range"
        min={0}
        max={100}
        step={1}
        value={pct}
        aria-label="Volume"
        aria-valuetext={volumeLabel(vol.level, vol.muted)}
        style={{ ['--vol' as string]: `${pct}%` }}
        onChange={(e) => vol.set(Number(e.target.value) / 100)}
        onPointerDown={() => onHold(true)}
        onPointerUp={() => onHold(false)}
        onPointerCancel={() => onHold(false)}
        onLostPointerCapture={() => onHold(false)}
        onBlur={() => onHold(false)}
        onWheel={(e) => vol.nudge(e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP)}
      />
    </div>
  );
}
