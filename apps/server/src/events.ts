import type { SyncEvent } from '@anycast/shared';

type Listener = (event: SyncEvent) => void;

/** In-process pub/sub for SSE: profile events go to that profile, catalog events to everyone. */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly global = new Set<Listener>();

  subscribe(profileId: string, fn: Listener): () => void {
    const set = this.listeners.get(profileId) ?? new Set();
    set.add(fn);
    this.listeners.set(profileId, set);
    this.global.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(profileId);
      this.global.delete(fn);
    };
  }

  emit(event: SyncEvent): void {
    const targets = event.type === 'catalog-updated' ? this.global : this.listeners.get(event.profileId);
    for (const fn of targets ?? []) fn(event);
  }
}
