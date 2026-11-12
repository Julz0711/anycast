import { describe, expect, it } from 'vitest';
import { onNowTicks, onNowWindow, placeProgram, timeLeftText } from './OnNow';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 11, 20, 18);

describe('On now strip', () => {
  it('shows a little of the past and more of what is ahead, as much as the timeline has room for', () => {
    // a phone: about an hour and a half
    const phone = onNowWindow(NOW, 320, false);
    expect(NOW - phone.start).toBe(15 * MIN);
    expect(phone.end - phone.start).toBe(90 * MIN);
    // a narrow phone shows less, so the blocks keep their width
    expect(onNowWindow(NOW, 240, false).end - onNowWindow(NOW, 240, false).start).toBe(60 * MIN);
    // a desktop: up to three hours, with half an hour of the past
    const wide = onNowWindow(NOW, 1100, true);
    expect(wide.end - wide.start).toBe(180 * MIN);
    expect(NOW - wide.start).toBe(30 * MIN);
    expect(onNowWindow(NOW, 500, true).end - onNowWindow(NOW, 500, true).start).toBe(90 * MIN);
    // not measured yet: by the kind of screen
    expect(onNowWindow(NOW, 0, false).end - onNowWindow(NOW, 0, false).start).toBe(90 * MIN);
  });

  it('places a programme by its times and cuts it at the edges of the window', () => {
    const win = { start: 0, end: 100 * MIN };
    expect(placeProgram({ start: 25 * MIN, end: 75 * MIN }, win)).toEqual({ left: 0.25, width: 0.5 });
    expect(placeProgram({ start: -60 * MIN, end: 40 * MIN }, win)).toEqual({ left: 0, width: 0.4 });
    expect(placeProgram({ start: 90 * MIN, end: 400 * MIN }, win)!.width).toBeCloseTo(0.1);
    // outside the window, or only a sliver inside it
    expect(placeProgram({ start: 120 * MIN, end: 150 * MIN }, win)).toBeNull();
    expect(placeProgram({ start: -30 * MIN, end: 0.2 * MIN }, win)).toBeNull();
  });

  it('marks the half hours, but not at the very end', () => {
    const win = onNowWindow(NOW, 320, false); // 20:03 to 21:33
    const ticks = onNowTicks(win);
    expect(ticks.map((k) => new Date(k.t).getUTCMinutes())).toEqual([30, 0]);
    expect(ticks[0]!.at).toBeCloseTo(27 / 90);
    // 21:30 would sit past the edge; a mark in the last eighth is left out
    expect(onNowTicks({ start: 0, end: 33 * MIN })).toEqual([{ t: 0, at: 0 }]);
  });

  it('says how long a programme still runs', () => {
    expect(timeLeftText(NOW + 42 * MIN, NOW)).toBe('42 min left');
    expect(timeLeftText(NOW + 72 * MIN, NOW)).toBe('1 h 12 left');
    expect(timeLeftText(NOW + 10_000, NOW)).toBe('1 min left');
  });
});
