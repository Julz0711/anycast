import { describe, expect, it } from 'vitest';
import { parseMediaTime, parseTimeInput } from './timeParse';

const now = new Date(2026, 10, 1, 21, 46, 0).getTime();
const position = now - 24 * 60_000;
const ctx = { now, position };
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 10, 1 + dayOffset, h, m, 0).getTime();

describe('parseTimeInput', () => {
  it('parses clock times today', () => {
    expect(parseTimeInput('20:15', ctx)).toEqual({ ok: true, at: at(20, 15) });
    expect(parseTimeInput('20.15', ctx)).toEqual({ ok: true, at: at(20, 15) });
    expect(parseTimeInput('2015', ctx)).toEqual({ ok: true, at: at(20, 15) });
    expect(parseTimeInput(' 8:15pm ', ctx)).toEqual({ ok: true, at: at(20, 15) });
    expect(parseTimeInput('9', ctx)).toEqual({ ok: true, at: at(9, 0) });
  });
  it('uses yesterday for a clock time still in the future', () => {
    expect(parseTimeInput('23:30', ctx)).toEqual({ ok: true, at: at(23, 30, -1) });
  });
  it('parses relative amounts from the current position', () => {
    expect(parseTimeInput('-45m', ctx)).toEqual({ ok: true, at: position - 45 * 60_000 });
    expect(parseTimeInput('+10m', ctx)).toEqual({ ok: true, at: position + 10 * 60_000 });
    expect(parseTimeInput('−1h30m', ctx)).toEqual({ ok: true, at: position - 90 * 60_000 });
    expect(parseTimeInput('-90s', ctx)).toEqual({ ok: true, at: position - 90_000 });
    expect(parseTimeInput('+5', ctx)).toEqual({ ok: true, at: position + 5 * 60_000 });
  });
  it('treats unsigned durations as "ago"', () => {
    expect(parseTimeInput('45m', ctx)).toEqual({ ok: true, at: position - 45 * 60_000 });
  });
  it('accepts now / live', () => {
    expect(parseTimeInput('live', ctx)).toEqual({ ok: true, at: now });
  });
  it('rejects nonsense with a helpful message', () => {
    for (const bad of ['', '25:00', '12:75', 'banana', '13pm']) {
      const r = parseTimeInput(bad, ctx);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });
});

describe('parseMediaTime', () => {
  it('parses h:mm:ss, mm:ss and relative', () => {
    expect(parseMediaTime('1:20:00', { position: 0, duration: 7200 })).toEqual({ ok: true, at: 4800 });
    expect(parseMediaTime('45:10', { position: 0, duration: 7200 })).toEqual({ ok: true, at: 2710 });
    expect(parseMediaTime('+10m', { position: 100, duration: 7200 })).toEqual({ ok: true, at: 700 });
    expect(parseMediaTime('-5m', { position: 100, duration: 7200 })).toEqual({ ok: true, at: 0 });
    expect(parseMediaTime('20:15pm', { position: 0, duration: 100 }).ok).toBe(false);
  });
});
