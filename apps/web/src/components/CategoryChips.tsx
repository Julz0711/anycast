/**
 * Category chips that stay usable with hundreds of categories (big panels have 500+ live groups):
 * up to SHOW_ALL categories are plain chips; beyond that the leading chips (fixed entries like
 * "All" or "Favorites"), the first few categories and the selected one stay as chips, and an
 * "All N groups" chip opens a sheet with a filter box over the whole list.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Chips } from './ui';
import { IconClose, IconSearch } from './Icons';

const SHOW_ALL = 60;
const SHOWN = 16;
const MORE = '__more';

export interface ChipItem { id: string; label: string }

export function CategoryChips(props: {
  label: string;
  /** fixed entries before the categories ("All", "Favorites", "Home") */
  lead: ChipItem[];
  categories: ChipItem[];
  value: string;
  onChange: (id: string) => void;
  /** "groups" / "categories", for the picker button and title */
  noun: string;
}) {
  const { lead, categories, value } = props;
  const [open, setOpen] = useState(false);
  const many = categories.length > SHOW_ALL;
  const items = useMemo(() => {
    if (!many) return [...lead, ...categories];
    const shown = categories.slice(0, SHOWN);
    const selected = categories.find((c) => c.id === value);
    if (selected && !shown.includes(selected)) shown.unshift(selected);
    return [...lead, ...shown, { id: MORE, label: `All ${categories.length} ${props.noun}…` }];
  }, [many, lead, categories, value, props.noun]);
  return (
    <>
      <Chips label={props.label} items={items} value={value} onChange={(id) => (id === MORE ? setOpen(true) : props.onChange(id))} />
      {open && (
        <CategorySheet
          title={`${props.noun[0]!.toUpperCase()}${props.noun.slice(1)}`}
          categories={categories}
          value={value}
          onPick={(id) => {
            setOpen(false);
            props.onChange(id);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CategorySheet(props: { title: string; categories: ChipItem[]; value: string; onPick: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = terms.length ? props.categories.filter((c) => terms.every((t) => c.label.toLowerCase().includes(t))) : props.categories;
  useEffect(() => {
    input.current?.focus();
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
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title} data-nav-trap="" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="h2">{props.title}</h2>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <label className="search-box sheet-search">
          <IconSearch />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${props.categories.length} ${props.title.toLowerCase()}`} aria-label={`Filter ${props.title.toLowerCase()}`} />
        </label>
        <div className="sheet-list" role="list" aria-label={props.title}>
          {list.map((c) => (
            <button key={c.id} type="button" role="listitem" className="sheet-item" aria-current={c.id === props.value ? 'true' : undefined} onClick={() => props.onPick(c.id)}>
              {c.label}
            </button>
          ))}
          {!list.length && <p className="muted" style={{ padding: '0.75rem' }}>Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}
