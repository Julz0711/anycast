/**
 * Versions of a live channel ("BBC One" in FHD, HD, 4K, RAW…): the player's Version menu, and
 * the automatic fallback that tries the next version when one does not start.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { Channel } from '@anycast/shared';
import { cachedGet } from '../api/client';
import { useAsync } from '../lib/hooks';
import { toast } from '../store/actions';
import { IconClose } from '../components/Icons';
import type { PlayerErr } from './errors';

/** The versions of channel `id`, best first (one entry when the provider has it once). */
export function useVariants(id: string, enabled: boolean): Channel[] {
  const r = useAsync(() => (enabled ? cachedGet('GET /api/channels/:id/variants', { params: { id } }, 300_000) : Promise.resolve([] as Channel[])), [id, enabled]);
  return r.data ?? [];
}

export const versionLabel = (c: Pick<Channel, 'quality' | 'name'>) => c.quality ?? 'Standard';

/** Versions tried and failed lately, so the fallback never loops between two broken ones. */
const failed = new Map<string, number>();
const FAILED_FOR_MS = 5 * 60_000;

export function nextVersion(variants: Channel[], current: string, now = Date.now()): Channel | null {
  for (const [k, at] of failed) if (now - at > FAILED_FOR_MS) failed.delete(k);
  return variants.find((v) => v.id !== current && !failed.has(v.id) && !v.locked) ?? null;
}

/** An error the next version could fix: the stream itself failed, not the server, the network or the connection limit. */
export const versionCanHelp = (e: PlayerErr) => e.actions.includes('zap') && !e.actions.includes('takeover');

/**
 * When live playback of a channel with other versions fails, plays the next version that has not
 * failed lately, and says so.
 */
export function useVersionFallback(opts: { live: boolean; atLive: boolean; id: string; error: PlayerErr | null; variants: Channel[]; go: (path: string) => void }) {
  const { live, atLive, id, error, variants, go } = opts;
  const handled = useRef<PlayerErr | null>(null);
  useEffect(() => {
    if (!live || !atLive || !error || handled.current === error || !versionCanHelp(error) || variants.length < 2) return;
    handled.current = error;
    failed.set(id, Date.now());
    const next = nextVersion(variants, id);
    if (!next) return;
    const from = variants.find((v) => v.id === id);
    toast(`${from ? versionLabel(from) : 'This version'} didn't start. Playing ${versionLabel(next)} instead.`);
    go(`/play/live/${encodeURIComponent(next.id)}`);
  }, [live, atLive, id, error, variants, go]);
}

export function VersionsMenu(props: { variants: Channel[]; current: string; onPick: (id: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.pl-menu-item[aria-checked="true"]')?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('.pl-menu-item') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    e.stopPropagation();
    items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
  };
  return (
    <div ref={ref} className="pl-menu pl-versions" data-player-keys="off" data-nav-trap="" role="dialog" aria-label="Channel version" onKeyDown={onKeyDown}>
      <div className="pl-menu-col" role="radiogroup" aria-label="Version">
        <h3 className="label">Version</h3>
        <div className="pl-versions-list">
          {props.variants.map((v, i) => (
            <button
              key={v.id}
              type="button"
              role="radio"
              aria-checked={v.id === props.current}
              className="pl-menu-item"
              disabled={v.locked}
              onClick={() => props.onPick(v.id)}
            >
              <span className="pl-menu-text">
                <span>{v.name}</span>
                <span className="pl-menu-detail">
                  {[versionLabel(v), i === 0 ? 'Best' : null, v.archiveDays > 0 ? 'Catch-up' : null, `No. ${v.number}`].filter(Boolean).join(' · ')}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="pl-menu-detail pl-versions-hint">If a version doesn't start, AnyCast plays the next one.</p>
      </div>
      <button type="button" className="icon-btn pl-menu-close" onClick={props.onClose} aria-label="Close">
        <IconClose />
      </button>
    </div>
  );
}
