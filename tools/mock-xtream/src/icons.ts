/** Tiny deterministic PNG icons (solid colour with a darker band), encoded without dependencies. */
import { deflateSync } from 'node:zlib';
import { hashString } from './random.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const cache = new Map<string, Buffer>();

export function iconPng(slug: string, size = 64): Buffer {
  const hit = cache.get(slug);
  if (hit) return hit;
  const h = hashString(slug);
  const rgb = [0x30 + (h & 0x9f), 0x30 + ((h >>> 8) & 0x9f), 0x30 + ((h >>> 16) & 0x9f)];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    const band = y > size * 0.65;
    for (let x = 0; x < size; x++) {
      for (let c = 0; c < 3; c++) raw[row + 1 + x * 3 + c] = band ? Math.floor((rgb[c] ?? 0) / 2) : (rgb[c] ?? 0);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  if (cache.size > 5000) cache.clear();
  cache.set(slug, png);
  return png;
}
