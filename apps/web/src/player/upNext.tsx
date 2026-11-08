/**
 * The Up next card on episodes. It shows when the end credits start: AnyCast learns where they
 * start for each series (SeriesDetail.creditsLead) from when viewers go on to the next episode;
 * until then it shows Settings › Player › Up next card seconds before the end.
 */
import type { Episode } from '@anycast/shared';
import { IconPlay } from '../components/Icons';

/** Shortest episode that gets the card before its end: a short clip would show it most of the time. */
const MIN_BODY_S = 60;

/** Whether the card is due: `lead` seconds or less left of a stream `duration` long. */
export function upNextDue(duration: number, position: number, lead: number): boolean {
  if (!(duration > 0) || !(lead > 0) || !Number.isFinite(position)) return false;
  if (duration < lead + MIN_BODY_S) return false;
  return duration - position <= lead;
}

export function UpNextCard(props: {
  episode: Episode;
  image: string | null;
  /** seconds left before it plays; null: no autoplay */
  countdown: number | null;
  /** what the countdown started from (the ring) */
  total: number | null;
  /** the episode ended (otherwise: the credits are on) */
  atEnd: boolean;
  /** take focus (TV, or the episode has ended and nothing else is going on) */
  focus: boolean;
  /** the timing comes from this series' learned credits */
  learned: boolean;
  onPlay: () => void;
  onDismiss: () => void;
  onForget: () => void;
}) {
  const { episode: e, countdown, total } = props;
  const frac = countdown !== null && total ? Math.max(0, Math.min(1, 1 - countdown / total)) : null;
  return (
    <div className="pl-next" role="dialog" aria-label="Next episode" data-nav-trap={props.atEnd ? '' : undefined} data-at={props.atEnd ? 'end' : 'credits'}>
      <div className="pl-next-body">
        {props.image && (
          <span className="pl-next-thumb" aria-hidden="true">
            <img src={props.image} alt="" onError={(ev) => (ev.currentTarget.parentElement!.style.display = 'none')} />
          </span>
        )}
        <div style={{ minWidth: 0 }}>
          <div className="pl-next-kicker tabnum">
            Up next · S{e.season} E{e.episode}
          </div>
          <div className="pl-next-title ellipsis">{e.title}</div>
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn-primary pl-next-play"
          onClick={props.onPlay}
          autoFocus={props.focus}
          style={frac !== null ? ({ '--p': frac } as React.CSSProperties) : undefined}
          data-counting={countdown !== null ? '' : undefined}
        >
          <IconPlay /> {countdown !== null ? `Play now · ${countdown}` : 'Play now'}
        </button>
        <button type="button" className="btn" onClick={props.onDismiss}>
          {props.atEnd ? 'Cancel' : 'Watch credits'}
        </button>
      </div>
      {!props.atEnd && props.learned && (
        <p className="pl-next-note">
          Timed to this series' end credits.{' '}
          <button type="button" className="link-btn" onClick={props.onForget}>
            Reset
          </button>
        </p>
      )}
    </div>
  );
}
