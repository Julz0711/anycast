/**
 * Live buffer: on a live channel the server sends the stream as fast as the provider does, so the
 * only way to have seconds of picture in hand is to wait for them before playing. The gate holds
 * playback until `target` seconds are buffered: when a channel starts, and again after a stall, so
 * playback resumes with a cushion instead of stuttering from one frame to the next.
 */
import { bufferAhead } from './stats/sample';

type GateVideo = Pick<HTMLMediaElement, 'buffered' | 'currentTime' | 'paused' | 'seeking' | 'pause' | 'addEventListener' | 'removeEventListener'>;

/**
 * What the gate does next, from what it sees. Pure, for tests.
 * - 'play': the cushion is there (or as much as there will be): play
 * - 'wait': keep holding
 */
export function gateStep(s: { ahead: number; target: number; heldMs: number; stuckMs: number }): 'play' | 'wait' {
  if (s.ahead >= s.target) return 'play';
  // never hold forever: a slow stream plays with what it has after a while
  if (s.heldMs >= Math.max(10_000, s.target * 2_000 + 5_000)) return 'play';
  // the buffer stopped growing with something in it: waiting longer won't help
  if (s.ahead > 0.5 && s.stuckMs >= 4_000) return 'play';
  return 'wait';
}

export class LiveBufferGate {
  /** true while the gate holds playback (the pause it makes is not the viewer's) */
  holding = false;
  private cancel: (() => void) | null = null;

  constructor(
    private readonly video: GateVideo,
    private readonly target: number,
    private readonly onHolding: (holding: boolean) => void = () => undefined,
  ) {}

  /**
   * Holds until the cushion is buffered, then resolves true (the caller plays). Resolves false
   * when the gate was cancelled or the viewer pressed play themselves.
   */
  hold(): Promise<boolean> {
    this.release();
    if (this.target <= 0) return Promise.resolve(true);
    const v = this.video;
    this.holding = true;
    this.onHolding(true);
    if (!v.paused) v.pause();
    return new Promise<boolean>((resolve) => {
      const started = Date.now();
      let lastAhead = -1;
      let lastGrowth = started;
      const done = (play: boolean) => {
        window.clearInterval(timer);
        v.removeEventListener('play', onPlay);
        this.cancel = null;
        this.holding = false;
        this.onHolding(false);
        resolve(play);
      };
      // the viewer pressed play: they'd rather watch now
      const onPlay = () => done(false);
      const tick = () => {
        const now = Date.now();
        const ahead = bufferAhead(v);
        if (ahead > lastAhead + 0.05) {
          lastAhead = ahead;
          lastGrowth = now;
        }
        if (gateStep({ ahead, target: this.target, heldMs: now - started, stuckMs: now - lastGrowth }) === 'play') done(true);
      };
      const timer = window.setInterval(tick, 200);
      v.addEventListener('play', onPlay);
      this.cancel = () => done(false);
      tick();
    });
  }

  /**
   * A stall while playing: hold for the cushion again. Not for seeks (they wait for their own
   * data) or a stall in the first seconds, nor while already holding.
   */
  shouldRebuffer(): boolean {
    const v = this.video;
    return this.target > 0 && !this.holding && !v.seeking && !v.paused && bufferAhead(v) < 0.5;
  }

  release(): void {
    this.cancel?.();
  }
}
