import { describe, expect, it } from 'vitest';
import { gateStep } from './liveBuffer';
import { hlsLiveConfig, mpegtsLiveConfig } from './engine';

describe('live buffer gate', () => {
  it('plays once the cushion is buffered', () => {
    expect(gateStep({ ahead: 3.9, target: 4, heldMs: 3000, stuckMs: 0 })).toBe('wait');
    expect(gateStep({ ahead: 4, target: 4, heldMs: 3000, stuckMs: 0 })).toBe('play');
  });
  it('never holds forever', () => {
    expect(gateStep({ ahead: 0, target: 4, heldMs: 12_000, stuckMs: 0 })).toBe('wait');
    expect(gateStep({ ahead: 0, target: 4, heldMs: 13_000, stuckMs: 0 })).toBe('play');
    expect(gateStep({ ahead: 0, target: 2, heldMs: 10_000, stuckMs: 0 })).toBe('play');
  });
  it('plays what it has when the buffer stops growing', () => {
    expect(gateStep({ ahead: 2, target: 8, heldMs: 6000, stuckMs: 4000 })).toBe('play');
    expect(gateStep({ ahead: 0.2, target: 8, heldMs: 6000, stuckMs: 4000 })).toBe('wait');
  });
});

describe('engine live settings', () => {
  it('mpegts.js never jumps ahead; it catches up by speed, above the buffer', () => {
    const c = mpegtsLiveConfig(4);
    expect(c.liveBufferLatencyChasing).toBe(false);
    expect(c.liveSyncTargetLatency).toBeGreaterThan(4);
    expect(c.liveSyncMaxLatency).toBeGreaterThan(c.liveSyncTargetLatency);
  });
  it('hls.js starts inside the 32 s live window', () => {
    for (const b of [2, 4, 8, 15, 30]) {
      const c = hlsLiveConfig(b);
      expect(c.liveSyncDuration).toBeLessThanOrEqual(24);
      expect(c.liveMaxLatencyDuration).toBeGreaterThan(c.liveSyncDuration);
      expect(c.maxBufferLength).toBeGreaterThanOrEqual(b);
    }
  });
});
