import { expect, test } from 'vitest';
import { createRedactor, redactDeep } from '../src/redact';

const redact = createRedactor({ url: 'http://line.example-tv.com:8080', username: 'jdoe42', password: 'p@ss:word/1' });

test('removes credentials in raw and encoded form, hosts and URLs', () => {
  expect(redact('login jdoe42 with p@ss:word/1')).toBe('login *** with ***');
  expect(redact('path /live/jdoe42/p%40ss%3Aword%2F1/1.ts')).toBe('path /live/***/***/1.ts');
  expect(redact('connect to line.example-tv.com failed')).toBe('connect to *** failed');
  expect(redact('other.example-tv.com down')).toBe('other.*** down');
  expect(redact('GET http://1.2.3.4/live/a/b/1.ts?token=abc 403')).toBe('GET <url> 403');
  expect(redact('player_api.php?username=x&password=y')).toBe('player_api.php?username=***&password=***');
});

test('case-insensitive and deep', () => {
  const out = redactDeep({ msg: 'JDOE42 failed', nested: [{ err: new Error('at http://line.example-tv.com/x') }] }, redact);
  expect(out.msg).toBe('*** failed');
  expect((out.nested[0]!.err as Error).message).toBe('at <url>');
});

test('no secrets configured: still collapses URLs', () => {
  expect(createRedactor({})('see https://a.b/c')).toBe('see <url>');
});
