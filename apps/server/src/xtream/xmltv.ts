/**
 * Minimal streaming XMLTV parser: emits <programme> entries without buffering the document.
 * Handles attributes, CDATA, entities and chunk boundaries anywhere; ignores everything else.
 */
import type { Readable } from 'node:stream';

export interface XmltvProgramme {
  channel: string;
  start: number;
  stop: number;
  title: string;
  description: string | null;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** A valid IANA zone name, or null (unknown or not understood: times are taken as UTC). */
export function validZone(timezone: string | null | undefined): string | null {
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();
/** Offset of `zone` from UTC at instant `ms`, in ms (Amsterdam in summer: +2 h). */
function zoneOffsetAt(ms: number, zone: string): number {
  let f = zoneFormats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    zoneFormats.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(ms))) if (part.type !== 'literal') p[part.type] = +part.value;
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `zone` (given as if it were UTC) to an instant. Offsets are cached
 * per zone and hour, since an EPG sync converts millions of times.
 */
export function zonedToUtc(wallMs: number, zone: string, cache?: Map<number, number>): number {
  const offsetAt = (ms: number) => {
    const key = Math.floor(ms / 3_600_000);
    let off = cache?.get(key);
    if (off === undefined) {
      off = zoneOffsetAt(key * 3_600_000, zone);
      cache?.set(key, off);
    }
    return off;
  };
  const guess = wallMs - offsetAt(wallMs);
  const off = offsetAt(guess);
  return wallMs - off;
}

/**
 * "20240101120000 +0100" (offset optional, seconds optional) -> epoch ms. A time without an
 * offset is wall-clock time in `zone` (the provider's timezone) when given, else UTC.
 */
export function parseXmltvTime(s: string, zone?: string | null, cache?: Map<number, number>): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, off] = m;
  let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, sec ? +sec : 0);
  if (!off) return zone ? zonedToUtc(ms, zone, cache) : ms;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    ms -= sign * (+digits.slice(0, 2) * 60 + +digits.slice(2, 4)) * 60_000;
  }
  return ms;
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  return out;
}

function textOf(inner: string): string {
  return inner
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstElement(xml: string, name: string): string | null {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`);
  const m = re.exec(xml);
  if (!m) return null;
  const t = decodeEntities(textOf(m[1]!));
  return t || null;
}

/** Parses one complete <programme ...>...</programme> element. */
function parseProgramme(xml: string, zone: string | null, cache: Map<number, number>): XmltvProgramme | null {
  const open = /^<programme\b([^>]*)>/.exec(xml);
  if (!open) return null;
  const a = attrs(open[1]!);
  const start = a.start ? parseXmltvTime(a.start, zone, cache) : null;
  const stop = a.stop ? parseXmltvTime(a.stop, zone, cache) : null;
  const title = firstElement(xml, 'title');
  if (!a.channel || start === null || stop === null || stop <= start || !title) return null;
  return { channel: a.channel, start, stop, title, description: firstElement(xml, 'desc') };
}

/**
 * Yields programmes from a byte stream. Memory stays bounded by the largest single element.
 * `timezone` is the provider's (server_info.timezone): times written without an offset are in it.
 */
export async function* parseXmltv(stream: Readable | AsyncIterable<Buffer | string>, timezone?: string | null): AsyncGenerator<XmltvProgramme> {
  const zone = validZone(timezone);
  const cache = new Map<number, number>();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let pos = 0;
    for (;;) {
      const start = buf.indexOf('<programme', pos);
      if (start < 0) {
        // keep a tail in case "<programme" is split across chunks
        pos = Math.max(pos, buf.length - 10);
        break;
      }
      const end = buf.indexOf('</programme>', start);
      if (end < 0) {
        pos = start;
        break;
      }
      const p = parseProgramme(buf.slice(start, end + 12), zone, cache);
      if (p) yield p;
      pos = end + 12;
    }
    buf = buf.slice(pos);
  }
}
