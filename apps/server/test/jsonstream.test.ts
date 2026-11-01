import { describe, expect, test } from 'vitest';
import { jsonListItems } from '../src/xtream/jsonstream';

async function items(text: string, chunk = 0): Promise<unknown[]> {
  // split the bytes, so multi-byte characters land across chunk boundaries too
  const all = new TextEncoder().encode(text);
  const bytes = chunk ? Array.from({ length: Math.ceil(all.length / chunk) }, (_, i) => all.subarray(i * chunk, (i + 1) * chunk)) : [all];
  const out: unknown[] = [];
  for await (const x of jsonListItems((async function* () { yield* bytes; })())) out.push(x);
  return out;
}

describe('jsonListItems', () => {
  const list = [
    { stream_id: 1, name: 'A, [B] {C}', epg: null },
    { stream_id: '2', name: 'Quote \\" and \\\\ and "', nested: { a: [1, 2, { b: '}' }] } },
    [],
    'plain',
    3.5,
    { name: 'Ünïcødé 🇩🇪 ▎' },
  ];

  test('yields the elements of an array, whatever the chunking', async () => {
    const text = JSON.stringify(list, null, 1);
    for (const chunk of [0, 1, 2, 3, 7, 64]) expect(await items(text, chunk), `chunk ${chunk}`).toEqual(list);
  });

  test('yields the values of an object keyed by id', async () => {
    const obj = { '10': { id: 10, n: 'x,y' }, '11': { id: 11, n: '}' } };
    expect(await items(JSON.stringify(obj), 3)).toEqual(Object.values(obj));
  });

  test('empty, null and scalar bodies yield nothing; broken JSON throws', async () => {
    expect(await items('')).toEqual([]);
    expect(await items('null')).toEqual([]);
    expect(await items('[]')).toEqual([]);
    expect(await items(' [ ] ')).toEqual([]);
    expect(await items('{}')).toEqual([]);
    await expect(items('[{"a":1},{"b":')).rejects.toThrow(/not JSON/);
    await expect(items('[{"a":1},{b:2}]')).rejects.toThrow(/not JSON/);
  });
});
