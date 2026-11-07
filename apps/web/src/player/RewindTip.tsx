/**
 * Why channels can't keep a rewind buffer in the background (one provider connection): shown once
 * as a tip, then behind an info button so it no longer sits among the controls.
 */
import { useEffect, useRef, useState } from 'react';
import { readLocal, writeLocal } from '../lib/storage';
import { IconInfo } from '../components/Icons';

const SEEN = 'anycast.tip.rewindOneStream';
const TEXT = "Rewind works while you watch. Your subscription plays one stream at a time, so channels can't keep a buffer in the background.";

export function RewindTip() {
  const [first] = useState(() => readLocal(SEEN) !== '1');
  const [open, setOpen] = useState(first);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open || first) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, first]);
  const dismiss = () => {
    writeLocal(SEEN, '1');
    setOpen(false);
  };
  if (first && open) {
    return (
      <span className="pl-tip" role="note" data-testid="pin-unavailable">
        <IconInfo className="ico" /> {TEXT}{' '}
        <button type="button" className="link-btn" onClick={dismiss}>
          Got it
        </button>
      </span>
    );
  }
  return (
    <span ref={box} className="pl-info" data-testid="pin-unavailable">
      <button type="button" className="icon-btn" aria-label="About rewinding" aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconInfo />
      </button>
      {open && (
        <span className="pl-info-pop" role="note">
          {TEXT}
        </span>
      )}
    </span>
  );
}
