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

/** "20240101120000 +0100" (offset optional, seconds optional) -> epoch ms */
export function parseXmltvTime(s: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{2}:?\d{2}|Z)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, off] = m;
  let ms = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, sec ? +sec : 0);
  if (off && off !== 'Z') {
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
function parseProgramme(xml: string): XmltvProgramme | null {
  const open = /^<programme\b([^>]*)>/.exec(xml);
  if (!open) return null;
  const a = attrs(open[1]!);
  const start = a.start ? parseXmltvTime(a.start) : null;
  const stop = a.stop ? parseXmltvTime(a.stop) : null;
  const title = firstElement(xml, 'title');
  if (!a.channel || start === null || stop === null || stop <= start || !title) return null;
  return { channel: a.channel, start, stop, title, description: firstElement(xml, 'desc') };
}

/** Yields programmes from a byte stream. Memory stays bounded by the largest single element. */
export async function* parseXmltv(stream: Readable | AsyncIterable<Buffer | string>): AsyncGenerator<XmltvProgramme> {
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
      const p = parseProgramme(buf.slice(start, end + 12));
      if (p) yield p;
      pos = end + 12;
    }
    buf = buf.slice(pos);
  }
}
