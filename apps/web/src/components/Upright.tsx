/**
 * Shown over the app on a phone held sideways (unless the viewer let the whole app turn): only
 * the player goes sideways. If something is playing in the now bar, it can be opened from here,
 * which is what turning the phone usually means.
 */
import { useOpenPlayer } from '../player/nowPlaying';
import { IconPlay } from './Icons';

export function UprightNotice() {
  const openPlayer = useOpenPlayer();
  return (
    <div className="upright" role="dialog" aria-modal="true" aria-labelledby="upright-title">
      <svg className="upright-phone" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g className="upright-turn">
          <rect x="16" y="9" width="16" height="30" rx="3.5" />
          <path d="M22 34h4" />
        </g>
      </svg>
      <h2 id="upright-title" className="upright-title">Turn your phone upright</h2>
      <p className="upright-text">
        Only the player goes sideways. To let the whole app turn, see Settings › Appearance.
      </p>
      {openPlayer && (
        <button type="button" className="btn btn-primary" onClick={openPlayer}>
          <IconPlay />
          Watch sideways
        </button>
      )}
    </div>
  );
}
