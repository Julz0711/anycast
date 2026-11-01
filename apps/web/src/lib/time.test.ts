import { afterAll, beforeAll, expect, test } from 'vitest';
import { fmtClock, gapText } from './time';

// The viewer is in New York; the server (and the provider) are elsewhere.
const original = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/New_York';
});
afterAll(() => {
  process.env.TZ = original;
});

test('clock times are the viewer’s local time', () => {
  expect(fmtClock(Date.UTC(2024, 0, 1, 18, 30))).toBe('13:30');
  expect(fmtClock(Date.UTC(2024, 6, 1, 18, 30))).toBe('14:30');
});

test('"No archive before HH:MM" uses the viewer’s clock, not the server’s text', () => {
  const at = Date.UTC(2024, 0, 1, 18, 30);
  const gap = { reason: 'This channel has no archive before 19:30', cause: { code: 'no_archive' as const, at } };
  expect(gapText(gap)).toBe('This channel has no archive before 13:30');
  expect(gapText({ reason: 'Stream dropped', cause: { code: 'dropped' as const } })).toBe('Stream dropped');
});
