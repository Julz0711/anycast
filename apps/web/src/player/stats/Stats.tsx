/**
 * Stats toggle for the player: a pills button, the `I` shortcut, and the panel itself, which is a
 * lazy chunk loaded the first time it opens.
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { isTypingTarget } from '../../lib/misc';
import { readLocal, writeLocal } from '../../lib/storage';
import { IconStats } from '../ExtrasIcons';
import type { StatsPanelProps } from './StatsPanel';

const StatsPanel = lazy(() => import('./StatsPanel'));
const KEY = 'anycast.playerStats';

/** Open state, remembered on this device, toggled by `I` anywhere in the player (not while typing). */
export function useStatsToggle() {
  const [open, setOpen] = useState(() => readLocal(KEY) === '1');
  const set = useCallback((v: boolean | ((o: boolean) => boolean)) => {
    setOpen((o) => {
      const next = typeof v === 'function' ? v(o) : v;
      writeLocal(KEY, next ? '1' : null);
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'i' && e.key !== 'I') || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      set((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);
  return { open, toggle: useCallback(() => set((o) => !o), [set]), close: useCallback(() => set(false), [set]) };
}

export function StatsButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className={`btn${open ? ' on' : ''}`} aria-pressed={open} aria-keyshortcuts="I" onClick={onToggle} title="Playback stats (I)">
      <IconStats /> Stats
    </button>
  );
}

export function StatsOverlay(props: StatsPanelProps) {
  return (
    <Suspense fallback={null}>
      <StatsPanel {...props} />
    </Suspense>
  );
}
