/**
 * Remote control (see packages/shared/src/remote.ts). Devices that may be steered announce
 * themselves; the hub keeps them in memory per account and tells every profile of the account
 * when the list changes, so a phone's remote stays current without asking again. Commands go to
 * one device over its realtime stream. Nothing is written to the database.
 */
import { REMOTE_TTL_MS, type RemoteCommand, type RemoteDevice, type RemoteForm, type RemoteNowPlaying } from '@anycast/shared';
import type { EventBus } from './events';

interface Entry {
  userId: string;
  clientId: string;
  profileId: string;
  profileName: string;
  name: string | null;
  device: string | null;
  form: RemoteForm;
  playing: RemoteNowPlaying | null;
  at: number;
}

export interface Announce {
  userId: string;
  clientId: string;
  profileId: string;
  profileName: string;
  name: string | null;
  device: string | null;
  form: RemoteForm;
  playing: RemoteNowPlaying | null;
}

const MAX_PER_USER = 30;

export class RemoteHub {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus: EventBus,
    /** the profiles of an account, to tell each of them */
    private readonly profilesOf: (userId: string) => string[],
    private readonly now: () => number = Date.now,
  ) {}

  private key = (userId: string, clientId: string) => `${userId}\n${clientId}`;

  announce(a: Announce): void {
    this.sweep();
    const k = this.key(a.userId, a.clientId);
    if (!this.entries.has(k)) {
      const mine = [...this.entries.values()].filter((e) => e.userId === a.userId).sort((x, y) => x.at - y.at);
      if (mine.length >= MAX_PER_USER) this.entries.delete(this.key(a.userId, mine[0]!.clientId));
    }
    this.entries.set(k, { ...a, at: this.now() });
    this.ensureTimer();
    this.publish(a.userId);
  }

  leave(userId: string, clientId: string): void {
    if (this.entries.delete(this.key(userId, clientId))) this.publish(userId);
  }

  /** The account's devices, most recently heard from first; `except` (the asking client) left out. */
  devices(userId: string, except?: string | null): RemoteDevice[] {
    this.sweep();
    const t = this.now();
    return [...this.entries.values()]
      .filter((e) => e.userId === userId && e.clientId !== except)
      .sort((x, y) => y.at - x.at)
      .map((e) => ({
        clientId: e.clientId,
        name: e.name || e.device || 'Browser',
        device: e.device,
        form: e.form,
        profileId: e.profileId,
        profileName: e.profileName,
        playing: e.playing,
        ageMs: Math.max(0, t - e.at),
      }));
  }

  /** Sends a command to a device of the account; false when it is not there (any more). */
  command(userId: string, clientId: string, command: RemoteCommand, from: string | null): boolean {
    this.sweep();
    const e = this.entries.get(this.key(userId, clientId));
    if (!e) return false;
    this.bus.emit({ type: 'remote-command', profileId: e.profileId, clientId, command, from });
    return true;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private publish(userId: string): void {
    const devices = this.devices(userId);
    for (const profileId of this.profilesOf(userId)) this.bus.emit({ type: 'remote-devices', profileId, devices });
  }

  /** Drops devices that stopped announcing; true when any went. */
  private sweep(): Set<string> {
    const t = this.now();
    const gone = new Set<string>();
    for (const [k, e] of this.entries) {
      if (t - e.at > REMOTE_TTL_MS) {
        this.entries.delete(k);
        gone.add(e.userId);
      }
    }
    return gone;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const userId of this.sweep()) this.publish(userId);
      if (!this.entries.size) this.close();
    }, 30_000);
    this.timer.unref?.();
  }
}
