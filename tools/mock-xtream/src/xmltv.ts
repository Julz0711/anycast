/** xmltv.php: streamed XMLTV covering 7 days back to 2 days ahead. */
import { Readable } from 'node:stream';
import type { RequestInfo } from './api.js';
import { nowSec, type MockContext } from './context.js';
import { programmesBetween } from './epg.js';
import { formatXmltv } from './tz.js';

const DAY = 86400;
const CHUNK = 64 * 1024;

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function* generate(ctx: MockContext, req: RequestInfo): AsyncGenerator<string> {
  const now = nowSec(ctx);
  const from = now - 7 * DAY;
  const to = now + 2 * DAY;
  const tz = ctx.timezone;
  // Variants of a channel share their epg_channel_id; XMLTV lists each id once.
  const channels = new Map<string, { name: string; icon: string | null }>();
  for (const c of ctx.catalog.live) {
    if (c.epgChannelId && !channels.has(c.epgChannelId)) channels.set(c.epgChannelId, { name: c.name, icon: c.icon });
  }

  yield '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n' +
    `<tv generator-info-name="AnyCast Mock Xtream" generator-info-url="${xmlEscape(req.baseUrl)}">\n`;

  if (ctx.faults.get().brokenEpg) {
    yield '  <channel id="broken.epg">\n    <display-name>Broken';
    return;
  }

  let buf = '';
  for (const [id, ch] of channels) {
    buf += `  <channel id="${xmlEscape(id)}">\n    <display-name>${xmlEscape(ch.name)}</display-name>\n`;
    if (ch.icon) buf += `    <icon src="${xmlEscape(`${req.baseUrl}/images/${ch.icon}.png`)}" />\n`;
    buf += '  </channel>\n';
    if (buf.length > CHUNK) {
      yield buf;
      buf = '';
    }
  }
  for (const id of channels.keys()) {
    for (const p of programmesBetween(id, from, to)) {
      buf +=
        `  <programme start="${formatXmltv(p.start, tz)}" stop="${formatXmltv(p.stop, tz)}" channel="${xmlEscape(id)}">\n` +
        `    <title lang="en">${xmlEscape(p.title)}</title>\n    <desc lang="en">${xmlEscape(p.description)}</desc>\n  </programme>\n`;
      if (buf.length > CHUNK) {
        yield buf;
        buf = '';
      }
    }
  }
  yield `${buf}</tv>\n`;
}

export function xmltvStream(ctx: MockContext, req: RequestInfo): Readable {
  return Readable.from(generate(ctx, req), { objectMode: false });
}
