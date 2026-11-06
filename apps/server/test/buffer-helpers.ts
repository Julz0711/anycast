import type { BufferStatus } from '../src/playback/buffer';
import { execFileSync } from 'node:child_process';

export const BUFFER_TEST = { enabled: true, segmentSeconds: 2, graceMs: 1500, retryMs: 500, maxMsPerChannel: 3600_000, maxBytes: 1024 ** 3 };

export const until = async (fn: () => boolean | Promise<boolean>, ms = 15_000, step = 100): Promise<boolean> => {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, step));
  }
};

/** Seconds since local midnight in the mock's panel timezone (the mock's PTS-of-day convention). */
export function berlinSecondsOfDay(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(ms);
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value) % 24;
  return n('hour') * 3600 + Number(parts.find((p) => p.type === 'minute')!.value) * 60 + Number(parts.find((p) => p.type === 'second')!.value) + (ms % 1000) / 1000;
}

export function firstVideoPts(file: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-read_intervals', '%+#1', '-of', 'csv=p=0', file]);
  return Number(String(out).trim().split('\n')[0]!.replace(/,$/, ''));
}

/** |a - b| on a 24 h circle, in seconds */
export const dayDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 86400;
  return Math.min(d, 86400 - d);
};

export const channelStatus = (s: BufferStatus, id: string) => s.channels.find((c) => c.channelId === id);
