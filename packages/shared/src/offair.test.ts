import { describe, expect, it } from 'vitest';
import { isOffAir } from './catalog';

describe('isOffAir', () => {
  it('knows the usual off air titles', () => {
    for (const t of ['Sendepause', 'SENDEPAUSE', ' Off Air ', 'Offair', 'No Event', 'No event today', 'Kein Programm', 'Keine Sendung', 'Event not started', 'Programmpause.']) expect(isOffAir(t), t).toBe(true);
  });
  it('leaves real programmes alone', () => {
    for (const t of ['2. BL - Samstags-Konferenz', 'BL', 'Sendepause vorbei: Die Show', 'Fußball: Bundesliga', null, '']) expect(isOffAir(t), String(t)).toBe(false);
  });
});
