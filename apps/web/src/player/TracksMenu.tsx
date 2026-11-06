/**
 * Audio & subtitles menu (PB-3): two columns of radio items. Arrow keys move within a column
 * (up/down) and between the columns (left/right), on every device; Escape closes (PlayerScreen).
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { PlaybackTracks } from '@anycast/shared';
import { IconClose } from '../components/Icons';
import { audioLabel, subtitleLabel } from './tracks';

export function TracksMenu(props: {
  tracks: PlaybackTracks;
  subtitle: number | null;
  onAudio: (index: number) => void;
  onSubtitle: (index: number | null) => void;
  onClose: () => void;
}) {
  const { tracks, subtitle } = props;
  const ref = useRef<HTMLDivElement>(null);

  // focus the checked item of the first column on open
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.pl-menu-item[aria-checked="true"]')?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    const cols = [...(ref.current?.querySelectorAll<HTMLElement>('.pl-menu-col') ?? [])];
    const col = cols.findIndex((c) => c.contains(document.activeElement));
    if (col < 0) return;
    const items = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('.pl-menu-item')];
    let target: HTMLElement | undefined;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      const list = items(cols[col]!);
      const i = list.indexOf(document.activeElement as HTMLElement);
      target = list[i + (k === 'ArrowDown' ? 1 : -1)];
    } else {
      const other = cols[col + (k === 'ArrowRight' ? 1 : -1)];
      if (other) target = other.querySelector<HTMLElement>('.pl-menu-item[aria-checked="true"]') ?? items(other)[0];
    }
    e.preventDefault();
    e.stopPropagation();
    target?.focus();
  };

  return (
    <div ref={ref} className="pl-menu" data-player-keys="off" data-nav-trap="" role="dialog" aria-label="Audio and subtitles" onKeyDown={onKeyDown}>
      <div className="pl-menu-col" role="radiogroup" aria-label="Audio">
        <h3 className="label">Audio</h3>
        {tracks.audio.length === 0 && <p className="muted">No audio</p>}
        {tracks.audio.map((a) => {
          const l = audioLabel(a);
          const on = a.index === tracks.audioIndex;
          return (
            <button key={a.index} type="button" role="radio" aria-checked={on} className="pl-menu-item" onClick={() => props.onAudio(a.index)}>
              <span className="pl-menu-text">
                <span>{l.main}</span>
                <span className="pl-menu-detail">{l.detail}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="pl-menu-col" role="radiogroup" aria-label="Subtitles">
        <h3 className="label">Subtitles</h3>
        <button type="button" role="radio" aria-checked={subtitle === null} className="pl-menu-item" onClick={() => props.onSubtitle(null)}>
          <span className="pl-menu-text">Off</span>
        </button>
        {tracks.subtitles.map((s) => {
          const l = subtitleLabel(s);
          return (
            <button
              key={s.index}
              type="button"
              role="radio"
              aria-checked={s.index === subtitle}
              aria-disabled={s.unavailable ? true : undefined}
              className="pl-menu-item"
              onClick={() => !s.unavailable && props.onSubtitle(s.index)}
            >
              <span className="pl-menu-text">
                <span>{l.main}</span>
                {l.detail && <span className="pl-menu-detail">{l.detail}</span>}
              </span>
            </button>
          );
        })}
      </div>
      <button type="button" className="icon-btn pl-menu-close" onClick={props.onClose} aria-label="Close">
        <IconClose />
      </button>
    </div>
  );
}
