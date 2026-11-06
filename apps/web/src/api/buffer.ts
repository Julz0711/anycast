/** Rolling live buffer: which channels keep a rewind buffer all the time (admin only), and how much space it uses. */
import { useCallback, useEffect, useState } from 'react';
import type { BufferPins } from '@anycast/shared';
import { ApiError, call, errorMessage } from './client';

/** Pins or unpins a channel. Throws an Error with a message fit to show as is (pin_limit, forbidden, ...). */
export async function setBufferPin(channelId: string, pinned: boolean): Promise<BufferPins> {
  try {
    return await call('PUT /api/buffer/pins', { body: { channelId, pinned } });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && (e.body as { error?: string } | undefined)?.error === 'buffer_disabled') {
      throw new Error('The rewind buffer is turned off on this server.');
    }
    throw new Error(errorMessage(e));
  }
}

/** Current pins; `null` while loading or when the server has no buffer (404). */
export function useBufferPins(enabled = true) {
  const [pins, setPins] = useState<BufferPins | null>(null);
  const reload = useCallback(() => {
    call('GET /api/buffer/pins').then(setPins, () => setPins(null));
  }, []);
  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);
  return { pins, setPins, reload };
}

/** "1.4 GB", "820 MB" */
export function fmtBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
}
