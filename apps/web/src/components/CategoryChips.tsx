/**
 * Category chips that stay usable with hundreds of categories (big panels have 500+ live groups):
 * pinned categories come first, in the profile's order; up to SHOW_ALL categories are plain
 * chips; beyond that the leading chips (fixed entries like "All" or "Favorites"), the first few
 * categories and the selected one stay as chips. The last chip opens a sheet with every category,
 * a filter box, and per category: pin to the front (and move up or down), or hide.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaKind } from '@anycast/shared';
import { Chips } from './ui';
import { IconClose, IconDown, IconEyeOff, IconLock, IconPin, IconSearch, IconUp } from './Icons';
import { whenUnlocked } from '../store/parental';
import { useApp } from '../store/app';
import { saveHideRules, setPref, toast } from '../store/actions';
import { cachedGet } from '../api/client';
import { useAsync } from '../lib/hooks';

const SHOW_ALL = 60;
const SHOWN = 16;
const MORE = '__more';

/** `locked`: an adult category of a locked profile; picking it asks for the PIN first */
export interface ChipItem { id: string; label: string; locked?: boolean }

/** Categories with the pinned ones first, in pin order. */
export function orderPinned<T extends { id: string }>(categories: T[], pinned: string[]): T[] {
  if (!pinned.length) return categories;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const first = pinned.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const set = new Set(first.map((c) => c.id));
  return [...first, ...categories.filter((c) => !set.has(c.id))];
}

export function CategoryChips(props: {
  label: string;
  /** which kind of categories, for pinning and hiding */
  kind: MediaKind;
  /** fixed entries before the categories ("All", "Favorites", "Home") */
  lead: ChipItem[];
  categories: ChipItem[];
  value: string;
  onChange: (id: string) => void;
  /** "groups" / "categories", for the picker button and title */
  noun: string;
}) {
  const { lead, value } = props;
  const pinned = useApp((s) => s.prefs.categories.pinned);
  const categories = useMemo(() => orderPinned(props.categories, pinned), [props.categories, pinned]);
  const [open, setOpen] = useState(false);
  const choose = (id: string) => whenUnlocked(categories.find((c) => c.id === id)?.locked, () => props.onChange(id));
  const many = categories.length > SHOW_ALL;
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const items = useMemo(() => {
    const more = { id: MORE, label: many ? `All ${categories.length} ${props.noun}…` : `Edit ${props.noun}…` };
    if (!many) return [...lead, ...categories, more];
    const shown = categories.slice(0, Math.max(SHOWN, categories.filter((c) => pinnedSet.has(c.id)).length));
    const selected = categories.find((c) => c.id === value);
    if (selected && !shown.includes(selected)) shown.unshift(selected);
    return [...lead, ...shown, more];
  }, [many, lead, categories, value, props.noun, pinnedSet]);
  return (
    <>
      <Chips label={props.label} items={items} value={value} onChange={(id) => (id === MORE ? setOpen(true) : choose(id))} />
      {open && (
        <CategorySheet
          kind={props.kind}
          title={`${props.noun[0]!.toUpperCase()}${props.noun.slice(1)}`}
          categories={categories}
          value={value}
          onPick={(id) => {
            setOpen(false);
            choose(id);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function setPinned(next: string[]) {
  setPref('categories', { pinned: next });
}

function CategorySheet(props: { kind: MediaKind; title: string; categories: ChipItem[]; value: string; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pinned = useApp((s) => s.prefs.categories.pinned);
  const rules = useApp((s) => s.hideRules);
  const noun = props.title.toLowerCase();
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (label: string) => terms.every((t) => label.toLowerCase().includes(t));
  const list = terms.length ? props.categories.filter((c) => matches(c.label)) : props.categories;
  const pinnedHere = props.categories.filter((c) => pinned.includes(c.id));
  // categories this profile hid one by one (not the ones hidden by language or country)
  const all = useAsync(() => cachedGet('GET /api/categories', { query: { kind: props.kind, all: '1' } }, 300_000), [props.kind]);
  const hiddenHere = (all.data ?? []).filter((c) => rules.categoryIds.includes(c.id) && (!terms.length || matches(c.name)));

  const sheet = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // phones: don't open the keyboard over the list straight away, the filter is one tap away
    if (document.documentElement.dataset.form === 'phone') sheet.current?.focus({ preventScroll: true });
    else input.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const togglePin = (id: string) => setPinned(pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]);
  const move = (id: string, by: -1 | 1) => {
    // moves among the pins of this kind; pins of other kinds keep their places
    const mine = pinned.filter((p) => pinnedHere.some((c) => c.id === p));
    const i = mine.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= mine.length) return;
    const swapped = [...mine];
    [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
    let k = 0;
    setPinned(pinned.map((p) => (mine.includes(p) ? swapped[k++]! : p)));
  };
  const hide = (c: ChipItem) => {
    void saveHideRules({ ...rules, categoryIds: [...rules.categoryIds, c.id] });
    if (pinned.includes(c.id)) setPinned(pinned.filter((p) => p !== c.id));
    toast(`${c.label} is hidden. Find it under Hidden ${noun} to show it again.`);
  };
  const unhide = (id: string) => void saveHideRules({ ...rules, categoryIds: rules.categoryIds.filter((x) => x !== id) });

  const row = (c: ChipItem, opts: { pinned: boolean; first?: boolean; last?: boolean }) => (
    <div key={c.id} className="sheet-row" role="listitem">
      <button type="button" className="sheet-item" aria-current={c.id === props.value ? 'true' : undefined} onClick={() => props.onPick(c.id)}>
        {c.locked && <IconLock className="ico lock-mark" />} {c.label}
      </button>
      {opts.pinned && (
        <>
          <button type="button" className="icon-btn" aria-label={`Move ${c.label} up`} disabled={opts.first} onClick={() => move(c.id, -1)}>
            <IconUp />
          </button>
          <button type="button" className="icon-btn" aria-label={`Move ${c.label} down`} disabled={opts.last} onClick={() => move(c.id, 1)}>
            <IconDown />
          </button>
        </>
      )}
      <button type="button" className={`icon-btn${opts.pinned ? ' on' : ''}`} aria-pressed={opts.pinned} aria-label={opts.pinned ? `Unpin ${c.label}` : `Pin ${c.label} to the front`} title={opts.pinned ? 'Unpin' : 'Pin to the front'} onClick={() => togglePin(c.id)}>
        <IconPin filled={opts.pinned} />
      </button>
      <button type="button" className="icon-btn" aria-label={`Hide ${c.label}`} title="Hide" onClick={() => hide(c)}>
        <IconEyeOff />
      </button>
    </div>
  );

  const rest = list.filter((c) => terms.length || !pinned.includes(c.id));
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div ref={sheet} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-label={props.title} data-nav-trap="" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="h2">{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <label className="search-box sheet-search">
          <IconSearch />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${props.categories.length} ${noun}`} aria-label={`Filter ${noun}`} />
        </label>
        <div className="sheet-list" aria-label={props.title}>
          {!terms.length && pinnedHere.length > 0 && (
            <div role="list" aria-label={`Pinned ${noun}`}>
              <div className="sheet-label">Pinned</div>
              {pinnedHere.map((c, i) => row(c, { pinned: true, first: i === 0, last: i === pinnedHere.length - 1 }))}
              <div className="sheet-label">All {noun}</div>
            </div>
          )}
          <div role="list" aria-label={`All ${noun}`}>
            {rest.map((c) => row(c, { pinned: pinned.includes(c.id) }))}
          </div>
          {!list.length && !hiddenHere.length && <p className="muted" style={{ padding: '0.75rem' }}>Nothing matches “{q}”.</p>}
          {hiddenHere.length > 0 && (
            <div role="list" aria-label={`Hidden ${noun}`}>
              <button type="button" className="sheet-label sheet-toggle" aria-expanded={showHidden || terms.length > 0} onClick={() => setShowHidden(!showHidden)}>
                Hidden {noun} · {hiddenHere.length}
              </button>
              {(showHidden || terms.length > 0) &&
                hiddenHere.map((c) => (
                  <div key={c.id} className="sheet-row" role="listitem">
                    <span className="sheet-item muted">{c.name}</span>
                    <button type="button" className="btn small" onClick={() => unhide(c.id)}>
                      Show
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
        <p className="muted sheet-foot">Pinned {noun} come first. Hidden ones disappear from every list and from search, on every device of this profile.</p>
      </div>
    </div>
  );
}
