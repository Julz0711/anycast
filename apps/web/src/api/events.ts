/**
 * Realtime sync over Server-Sent Events (GET /api/events).
 * Reconnects with exponential backoff (1 s -> 30 s, jittered); after a reconnect `onResync`
 * refetches state so nothing missed while offline is lost.
 * EventSource cannot send headers, so the profile goes in ?profile= (events also carry profileId; the store filters).
 */
import type { SyncEvent } from '@anycast/shared';
import { isDemo } from '../demo/flag';

export function connectEvents(profileId: string, onEvent: (e: SyncEvent) => void, onResync: () => void): () => void {
  if (__DEMO_ALLOWED__ && isDemo()) {
    let off: (() => void) | null = null;
    let closed = false;
    void import('../demo/fake').then((m) => {
      if (!closed) off = m.subscribeFake(onEvent);
    });
    return () => {
      closed = true;
      off?.();
    };
  }
  if (typeof EventSource === 'undefined') return () => {};

  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let hadConnection = false;

  const open = () => {
    if (closed) return;
    es = new EventSource(`/api/events?profile=${encodeURIComponent(profileId)}`, { withCredentials: true });
    es.onopen = () => {
      if (hadConnection || attempt > 0) onResync();
      hadConnection = true;
      attempt = 0;
    };
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as SyncEvent);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (closed) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
      attempt++;
      timer = setTimeout(open, delay);
    };
  };
  open();

  const onOnline = () => {
    if (!es) {
      if (timer) clearTimeout(timer);
      attempt = 0;
      open();
    }
  };
  window.addEventListener('online', onOnline);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
    window.removeEventListener('online', onOnline);
  };
}
