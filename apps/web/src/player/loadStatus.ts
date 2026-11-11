import type { Pipeline } from '@anycast/shared';

/** What the player is waiting on while a stream starts, shown so a slow start says why. */
export type LoadStep =
  | { stage: 'connecting' }
  | { stage: 'preparing'; pipeline?: Pipeline }
  | { stage: 'buffering' }
  | { stage: 'retrying'; attempt: number; status?: number };

/** The line under the spinner for a load step. */
export function loadStepText(s: LoadStep): string {
  switch (s.stage) {
    case 'connecting':
      return 'Connecting to your server…';
    case 'preparing':
      return s.pipeline === 'transcode' ? 'Your server is converting the video for this device…' : 'Your server is starting the video…';
    case 'buffering':
      return 'Loading the first seconds…';
    case 'retrying':
      return s.status
        ? `Your server answered with an error (HTTP ${s.status}). Trying again (${s.attempt})…`
        : `No answer from your server yet. Trying again (${s.attempt})…`;
  }
}

/** "8 s", "1:05": how long the start has taken so far. */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
