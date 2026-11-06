import { expect, test } from 'vitest';
import { connectionsHint, fmtUptime } from './Diagnostics';

test('uptime', () => {
  expect(fmtUptime(42)).toBe('42 s');
  expect(fmtUptime(125 * 60)).toBe('2 h 5 min');
  expect(fmtUptime(3 * 86_400 + 4 * 3600 + 59)).toBe('3 d 4 h');
  expect(fmtUptime(86_400)).toBe('1 d');
});

test('connections hint', () => {
  expect(connectionsHint({})).toBe('Nothing is playing from the provider right now.');
  expect(connectionsHint({ live: 1, timeshift: 1 })).toBe('In use for: 1 live, 1 archive.');
});
