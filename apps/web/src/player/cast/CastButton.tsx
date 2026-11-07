/**
 * The cast button: Chromecast in Chrome and Edge, AirPlay in Safari. Shown only when a TV is
 * there to cast to (or while casting).
 */
import { useEffect } from 'react';
import { endChromecast, initChromecast, requestChromecast, useChromecast } from './chromecast';
import type { AirPlayControl } from './airplay';
import { IconAirPlay, IconCast } from './icons';

export function CastButton({ airplay, className = 'btn', label = false }: { airplay: AirPlayControl; className?: string; label?: boolean }) {
  const sdk = useChromecast((s) => s.sdk);
  const castState = useChromecast((s) => s.castState);
  const device = useChromecast((s) => s.device);
  useEffect(() => void initChromecast(), []);

  if (sdk === 'ready' && castState !== 'NO_DEVICES_AVAILABLE') {
    const on = castState === 'CONNECTED';
    const busy = castState === 'CONNECTING';
    const name = on ? `Stop casting to ${device ?? 'TV'}` : busy ? 'Connecting to TV' : 'Cast to TV';
    return (
      <button
        type="button"
        className={`${className}${on ? ' on' : ''}`}
        aria-pressed={on}
        aria-label={name}
        title={name}
        disabled={busy}
        data-testid="cast-button"
        onClick={() => (on ? endChromecast() : void requestChromecast())}
      >
        <IconCast connected={on} />
        {label && <span>{on ? (device ?? 'TV') : 'Cast'}</span>}
      </button>
    );
  }
  if (airplay.available || airplay.active) {
    const name = airplay.active ? 'AirPlay (playing on TV)' : 'AirPlay';
    return (
      <button type="button" className={`${className}${airplay.active ? ' on' : ''}`} aria-label={name} title={name} data-testid="airplay-button" onClick={airplay.prompt}>
        <IconAirPlay />
        {label && <span>AirPlay</span>}
      </button>
    );
  }
  return null;
}
