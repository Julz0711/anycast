import { describe, expect, it } from 'vitest';
import { upNextDue } from './upNext';

describe('upNextDue', () => {
  it('is due once the lead before the end is reached', () => {
    expect(upNextDue(2400, 2300, 90)).toBe(false);
    expect(upNextDue(2400, 2310, 90)).toBe(true);
    expect(upNextDue(2400, 2400, 90)).toBe(true);
  });
  it('never before the end when the lead is 0 or the length is unknown', () => {
    expect(upNextDue(2400, 2399, 0)).toBe(false);
    expect(upNextDue(0, 10, 30)).toBe(false);
    expect(upNextDue(NaN, 10, 30)).toBe(false);
  });
  it('not on a stream barely longer than the lead', () => {
    expect(upNextDue(80, 70, 30)).toBe(false);
    expect(upNextDue(95, 70, 30)).toBe(true);
  });
});
