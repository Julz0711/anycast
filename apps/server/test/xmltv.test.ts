import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { decodeEntities, parseXmltv, parseXmltvTime } from '../src/xtream/xmltv';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="x">
  <channel id="ard.de"><display-name>ARD</display-name></channel>
  <programme start="20240101120000 +0100" stop="20240101130000 +0100" channel="ard.de">
    <title lang="de">Tagesschau &amp; Wetter</title>
    <desc lang="de"><![CDATA[News <live> & more]]></desc>
  </programme>
  <programme channel='zdf.de' start="20240101110000" stop="20240101113000 -0030"><title>Heute &#8211; Journal &#x263A;</title></programme>
  <programme start="20240101110000 +0000" stop="20240101100000 +0000" channel="bad"><title>Ends before start</title></programme>
  <programme start="20240101110000 +0000" stop="20240101120000 +0000" channel="notitle"></programme>
</tv>`;

test('times with offsets', () => {
  expect(parseXmltvTime('20240101120000 +0100')).toBe(Date.UTC(2024, 0, 1, 11));
  expect(parseXmltvTime('20240101120000 -0230')).toBe(Date.UTC(2024, 0, 1, 14, 30));
  expect(parseXmltvTime('202401011200')).toBe(Date.UTC(2024, 0, 1, 12));
  expect(parseXmltvTime('garbage')).toBeNull();
});

test('times without an offset are in the provider timezone', () => {
  const ams = 'Europe/Amsterdam';
  expect(parseXmltvTime('20240101120000', ams)).toBe(Date.UTC(2024, 0, 1, 11)); // winter, +01:00
  expect(parseXmltvTime('20240701120000', ams)).toBe(Date.UTC(2024, 6, 1, 10)); // summer, +02:00
  // around the spring change (02:00 -> 03:00 on 31 March 2024) and the autumn one (27 October)
  expect(parseXmltvTime('20240331013000', ams)).toBe(Date.UTC(2024, 2, 31, 0, 30));
  expect(parseXmltvTime('20240331033000', ams)).toBe(Date.UTC(2024, 2, 31, 1, 30));
  expect(parseXmltvTime('20241027040000', ams)).toBe(Date.UTC(2024, 9, 27, 3));
  expect(parseXmltvTime('20240101120000', 'America/New_York')).toBe(Date.UTC(2024, 0, 1, 17));
  // an explicit offset wins over the zone
  expect(parseXmltvTime('20240101120000 +0000', ams)).toBe(Date.UTC(2024, 0, 1, 12));
});

test('entities', () => {
  expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &unknown;')).toBe('a & b <c> AB &unknown;');
});

test.each([1, 7, 64, 100000])('streams programmes split into %i-byte chunks', async (size) => {
  const chunks: Buffer[] = [];
  const buf = Buffer.from(DOC, 'utf8');
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.subarray(i, i + size));
  const out = [];
  for await (const p of parseXmltv(Readable.from(chunks))) out.push(p);
  expect(out).toEqual([
    { channel: 'ard.de', start: Date.UTC(2024, 0, 1, 11), stop: Date.UTC(2024, 0, 1, 12), title: 'Tagesschau & Wetter', description: 'News <live> & more' },
    { channel: 'zdf.de', start: Date.UTC(2024, 0, 1, 11), stop: Date.UTC(2024, 0, 1, 12), title: 'Heute – Journal ☺', description: null },
  ]);
});

test('parseXmltv reads offset-less times in the given timezone (unknown zone: UTC)', async () => {
  const doc = '<tv><programme start="20240701200000" stop="20240701210000" channel="a"><title>T</title></programme></tv>';
  const read = async (tz?: string | null) => {
    const out = [];
    for await (const p of parseXmltv(Readable.from([doc]), tz)) out.push(p);
    return out[0]!;
  };
  expect((await read('Europe/Amsterdam')).start).toBe(Date.UTC(2024, 6, 1, 18));
  expect((await read('Not/AZone')).start).toBe(Date.UTC(2024, 6, 1, 20));
  expect((await read(null)).stop).toBe(Date.UTC(2024, 6, 1, 21));
});
