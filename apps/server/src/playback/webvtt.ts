/** Minimal WebVTT reading and writing for the subtitle files FFmpeg writes (PB-3). */

export interface Cue {
  /** seconds */
  start: number;
  end: number;
  /** cue payload, may span lines; settings after the timing line are dropped */
  text: string;
}

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/;

export function parseTime(s: string): number | null {
  const m = TIME.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/**
 * Cues of a WebVTT text. A file still being written may end in a partial block: unless `complete`,
 * the last block is only taken when a blank line follows it.
 */
export function parseVtt(text: string, complete = false): Cue[] {
  const norm = text.replace(/\r\n?/g, '\n');
  const blocks = norm.split(/\n{2,}/);
  if (!complete && !/\n\n$/.test(norm)) blocks.pop();
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim() !== '');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a = '', rest = ''] = lines[at]!.split('-->');
    const start = parseTime(a);
    const end = parseTime(rest.trim().split(/\s+/)[0] ?? '');
    const body = lines.slice(at + 1).join('\n').trim();
    if (start === null || end === null || end <= start || !body) continue;
    cues.push({ start, end, text: body });
  }
  return cues;
}

export function formatTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** A WebVTT file of the cues, sorted by start. A blank line inside a cue would end it, so those are dropped. */
export function formatVtt(cues: Iterable<Cue>): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = ['WEBVTT', ''];
  for (const c of sorted) out.push(`${formatTime(c.start)} --> ${formatTime(c.end)}`, c.text.replace(/\n\s*\n/g, '\n'), '');
  return out.join('\n');
}

export const cueKey = (c: Cue) => `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
