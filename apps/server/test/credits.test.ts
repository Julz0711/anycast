import { expect, test } from 'vitest';
import { clearCredits, creditsLead, recordCredits } from '../src/catalog/credits';
import { openDb } from '../src/db';

test('the credits estimate is the median of the last samples, clamped, and can be forgotten', () => {
  const db = openDb(':memory:');
  expect(creditsLead(db, 's1')).toBeNull();
  expect(recordCredits(db, 's1', 62)).toBe(62);
  expect(recordCredits(db, 's1', 58)).toBe(60);
  // one odd sample (moved on 10 minutes early) doesn't move it far
  expect(recordCredits(db, 's1', 2000)).toBe(62);
  expect(creditsLead(db, 's1')).toBe(62);
  // only the last five count
  for (const s of [30, 30, 30, 30, 30]) recordCredits(db, 's1', s);
  expect(creditsLead(db, 's1')).toBe(30);
  expect(recordCredits(db, 's2', 1)).toBe(5);
  clearCredits(db, 's1');
  expect(creditsLead(db, 's1')).toBeNull();
  expect(creditsLead(db, 's2')).toBe(5);
});
