/**
 * Who watches what. Each playback client (an app instance, sent as x-anycast-client) has at most
 * one claim: the provider connection key of what it last asked to play (`live:<id>`,
 * `ts:<id>:<start>`, `movie:<id>`, `episode:<id>`; null for the rolling buffer, which needs no
 * connection). Claims let the server release a client's previous stream the moment it asks for
 * the next one, and name the holder when the provider's connections are all taken.
 */
import type { ConnectionHolder } from '@anycast/shared';

export interface Viewer {
  clientId: string;
  profileId: string;
  profileName: string;
  /** the client's own label ("Chrome on Mac"), if it sent one */
  device: string | null;
}

export interface Claim extends Viewer {
  key: string | null;
  /** channel, movie or episode name */
  title: string;
  at: number;
}

export class Claims {
  private readonly byClient = new Map<string, Claim>();

  get(clientId: string): Claim | undefined {
    return this.byClient.get(clientId);
  }

  /** Sets the client's claim; returns the one it replaces. */
  set(viewer: Viewer, key: string | null, title: string): Claim | undefined {
    const prev = this.byClient.get(viewer.clientId);
    this.byClient.set(viewer.clientId, { ...viewer, key, title, at: Date.now() });
    return prev;
  }

  delete(clientId: string): Claim | undefined {
    const prev = this.byClient.get(clientId);
    this.byClient.delete(clientId);
    return prev;
  }

  /** Clients that claim `key`, most recent first. */
  holders(key: string, except?: string): Claim[] {
    return [...this.byClient.values()].filter((c) => c.key === key && c.clientId !== except).sort((a, b) => b.at - a.at);
  }
}

export function holderOf(c: Claim): ConnectionHolder {
  return { profileName: c.profileName, channelName: c.title, ...(c.device ? { device: c.device } : {}) };
}

/** 409: the provider connections are taken by other clients watching something else. */
export class ConnectionBusyError extends Error {
  readonly code = 'connection_busy';
  constructor(readonly holder: ConnectionHolder) {
    super(`${holder.profileName} is watching ${holder.channelName}${holder.device ? ` on ${holder.device}` : ''}. Your subscription allows no more streams at the same time.`);
  }
}

/** 409: this playback was stopped because another client took its connection over. */
export class TakenOverError extends Error {
  readonly code = 'taken_over';
  constructor() {
    super('Playback moved to another device');
  }
}
