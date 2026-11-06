/** Parental lock pieces that live outside Settings: the PIN dialog host and the "Lock now" button. */
import { lazy, Suspense } from 'react';
import { lockNow, useParental } from '../store/parental';
import { IconLock } from './Icons';
import '../theme/locks.css';

const PinDialog = lazy(() => import('./PinDialog'));

/** Renders the PIN dialog while a prompt is open (the dialog's code loads on first use). */
export function PinHost() {
  const prompt = useParental((s) => s.prompt);
  if (!prompt) return null;
  return (
    <Suspense fallback={null}>
      <PinDialog key={prompt.id} prompt={prompt} />
    </Suspense>
  );
}

/** Shown while this device has unlocked adult content: locks it again right away. */
export function LockNowButton(props: { className?: string; label?: string }) {
  const unlocked = useParental((s) => s.status?.unlocked === true);
  if (!unlocked) return null;
  return (
    <button type="button" className={props.className ?? 'btn lock-now'} onClick={() => void lockNow()} aria-label="Lock adult content now">
      <IconLock /> {props.label ?? 'Lock now'}
    </button>
  );
}
