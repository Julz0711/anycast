/**
 * Where a series' end credits start, as seconds before the end of an episode. Providers don't say,
 * so the player learns it: when a viewer goes on to the next episode before the Up next card showed
 * (or after waving it away), the time that was left is a sample. Credits are about the same length
 * in every episode of a series, so the median of the last few samples is a good guess for the rest.
 */
import type { Db } from '../db';

/** samples kept per series */
const KEEP = 5;
/** what counts as end credits: from a few seconds to a long "previously on" and preview block */
export const CREDITS_MIN_S = 5;
export const CREDITS_MAX_S = 600;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function creditsLead(db: Db, seriesId: string): number | null {
  const r = db.prepare('SELECT seconds FROM series_credits WHERE series_id = ?').pluck().get(seriesId) as number | undefined;
  return r ?? null;
}

/** Adds a sample (seconds left when the viewer moved on); returns the new estimate. */
export function recordCredits(db: Db, seriesId: string, seconds: number): number {
  const s = Math.round(Math.min(CREDITS_MAX_S, Math.max(CREDITS_MIN_S, seconds)));
  const row = db.prepare('SELECT samples FROM series_credits WHERE series_id = ?').pluck().get(seriesId) as string | undefined;
  let samples: number[] = [];
  try {
    const parsed: unknown = row ? JSON.parse(row) : [];
    if (Array.isArray(parsed)) samples = parsed.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  } catch {
    /* start over */
  }
  samples = [...samples, s].slice(-KEEP);
  const est = Math.round(median(samples));
  db.prepare(
    `INSERT INTO series_credits (series_id, seconds, samples, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(series_id) DO UPDATE SET seconds = excluded.seconds, samples = excluded.samples, updated_at = excluded.updated_at`,
  ).run(seriesId, est, JSON.stringify(samples), Date.now());
  return est;
}

export function clearCredits(db: Db, seriesId: string): void {
  db.prepare('DELETE FROM series_credits WHERE series_id = ?').run(seriesId);
}
