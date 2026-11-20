/**
 * Subtitle files to clean WebVTT: SRT and WebVTT in, in UTF-8 (with or without BOM), UTF-16 or
 * Windows-1252 (old SRT files often are). Formatting other than <i>, <b> and <u> is dropped
 * (font colors, ASS position tags like {\an8}), as the player shows plain lines.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Bytes to text: UTF-16 by its BOM, UTF-8 when it is valid UTF-8, else Windows-1252. */
export function decodeSubtitle(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** "00:01:02,500", "01:02.5", "1:02:03.25" -> seconds; null when it isn't a time. */
export function parseTime(s: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,:](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

function cleanText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/\{\\[^}]*\}/g, '') // ASS override tags in SRT: {\an8}, {\i1}
    .replace(/<(\/?)([ibu])(?:\s[^>]*)?>/gi, (_m, close: string, tag: string) => `\u0001${close}${tag.toLowerCase()}\u0002`)
    .replace(/<[^>]*>/g, '') // <font color=…>, <c.yellow>, <v Name>
    .replace(/\u0001/g, '<')
    .replace(/\u0002/g, '>')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .join('\n');
}

const ARROW = /^\s*(\S+)\s+-->\s+(\S+)/;

/** Cues of an SRT or WebVTT text, in time order. Blocks it can't read are skipped. */
export function parseCues(text: string): Cue[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0 || at > 2) continue; // WEBVTT header, NOTE, STYLE, or not a cue
    const m = ARROW.exec(lines[at]!)!;
    const start = parseTime(m[1]!);
    const end = parseTime(m[2]!);
    if (start === null || end === null || end <= start) continue;
    const body = cleanText(lines.slice(at + 1));
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function vttTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms % 1000, 3)}`;
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n')}\n`;
}

/** A subtitle file's bytes as WebVTT, with its cue count; null when it has no cues it can read. */
export function convertSubtitle(buf: Uint8Array): { vtt: string; cues: number } | null {
  const cues = parseCues(decodeSubtitle(buf));
  if (!cues.length) return null;
  return { vtt: toVtt(cues), cues: cues.length };
}
