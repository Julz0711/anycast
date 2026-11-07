/**
 * Customize the Home dashboard: which sections show, their order, and a few display options.
 * Used on Home itself (Customize) and in Settings › Home. Every change syncs to the profile's devices.
 */
import { useState } from 'react';
import { DEFAULT_PREFERENCES, normalizeHomeSections, type HomeSectionId, type Preferences } from '@anycast/shared';
import { useApp } from '../store/app';
import { setPref, toast } from '../store/actions';
import { Segmented, Toggle } from './ui';
import { IconDown, IconDrag, IconUp } from './Icons';
import '../theme/settings.css';

export const HOME_SECTIONS: Record<HomeSectionId, { title: string; hint: string }> = {
  continue: { title: 'Continue watching', hint: 'Movies and episodes you started' },
  recent: { title: 'Jump back in', hint: 'Channels you watched lately' },
  next: { title: 'Up next', hint: 'The next episode of series you follow' },
  favorites: { title: 'Favorite channels', hint: "What's on now on your favorites" },
  watchLater: { title: 'Watch Later', hint: 'Movies and series you saved for later' },
};

type Home = Preferences['home'];

export function HomeEditor(props: { /** Settings shows the options as setting rows */ compact?: boolean }) {
  const h = useApp((s) => s.prefs.home);
  const order = normalizeHomeSections(h.sections);
  const [drag, setDrag] = useState<HomeSectionId | null>(null);
  const move = (id: HomeSectionId, to: number) => {
    const next = order.filter((t) => t !== id);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
    setPref('home', { sections: next });
  };
  const setHidden = (id: HomeSectionId, hide: boolean) => {
    const hidden = hide ? [...h.hiddenSections, id] : h.hiddenSections.filter((t) => t !== id);
    if (hidden.length >= order.length) return toast('Keep at least one section on Home.');
    setPref('home', { hiddenSections: hidden });
  };
  const reset = () => setPref('home', structuredClone(DEFAULT_PREFERENCES.home));
  const option = (label: string, hint: string, control: React.ReactNode) => (
    <div className="set-row">
      <div className="set-text">
        <div className="set-label">{label}</div>
        <div className="set-hint">{hint}</div>
      </div>
      <div className="set-ctl">{control}</div>
    </div>
  );
  return (
    <div className="home-editor">
      <ol className="tab-order" aria-label="Home sections">
        {order.map((id, i) => {
          const s = HOME_SECTIONS[id];
          const shown = !h.hiddenSections.includes(id);
          return (
            <li
              key={id}
              draggable
              onDragStart={(e) => (setDrag(id), e.dataTransfer.setData('text/plain', id))}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => (e.preventDefault(), drag && move(drag, i), setDrag(null))}
              onDragEnd={() => setDrag(null)}
              className={`${drag === id ? 'dragging' : ''}${shown ? '' : ' off'}`}
              data-nav-row={`home-${id}`}
            >
              <IconDrag />
              <span className="to-name">
                {s.title}
                <span className="to-hint">{s.hint}</span>
              </span>
              <button type="button" className="icon-btn sm" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => move(id, i - 1)}>
                <IconUp />
              </button>
              <button type="button" className="icon-btn sm" aria-label={`Move ${s.title} down`} disabled={i === order.length - 1} onClick={() => move(id, i + 1)}>
                <IconDown />
              </button>
              <Toggle label={`Show ${s.title}`} checked={shown} onChange={(v) => setHidden(id, !v)} />
            </li>
          );
        })}
      </ol>
      <div className={props.compact ? undefined : 'home-editor-opts'}>
        {option('Pick up where you left off', 'A large card for the last thing you watched, at the top.', (
          <Toggle label="Show the pick up card" checked={h.showHero} onChange={(v) => setPref('home', { showHero: v })} />
        ))}
        {option('Favorite channels with a guide only', 'Leave out favorites that have no programme information.', (
          <Toggle label="Favorite channels with a guide only" checked={h.favoritesWithGuideOnly} onChange={(v) => setPref('home', { favoritesWithGuideOnly: v })} />
        ))}
        {option('Items per row', 'More than this and the row shows See all.', (
          <Segmented<Home['rowLimit']>
            label="Items per row"
            value={h.rowLimit}
            options={[
              { value: 6, label: '6' },
              { value: 12, label: '12' },
              { value: 24, label: '24' },
            ]}
            onChange={(v) => setPref('home', { rowLimit: v })}
          />
        ))}
      </div>
      <button type="button" className="link-btn home-reset" onClick={reset}>
        Reset Home to default
      </button>
    </div>
  );
}
