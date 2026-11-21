/**
 * A reorderable list built on dnd-kit: drag the grip with mouse or touch (the rows make room as you
 * go and the row you hold lifts), or focus the grip and use Space + arrows on a keyboard. Up/down
 * buttons stay beside it for one-step moves. On the TV the grip is gone: either the same up/down
 * buttons, or a "Move" mode (OK, then up/down, then OK) for long lists.
 * Used by Settings (tabs, Home sections) and the channel list editor.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type Announcements, type DragEndEvent, type UniqueIdentifier,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { useFormFactor } from '../lib/hooks';
import { IconClose, IconDown, IconDrag, IconUp } from './Icons';
import '../theme/sortable.css';

export interface SortableListProps<T> {
  label: string;
  items: T[];
  keyOf: (item: T) => string;
  nameOf: (item: T) => string;
  render: (item: T) => ReactNode;
  onMove: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  removeLabel?: string;
  /** extra controls per row (before remove), e.g. a switch */
  actions?: (item: T, index: number) => ReactNode;
  /** extra class per row */
  rowClass?: (item: T) => string;
  /** TV: up/down buttons (short lists) or a Move mode (long lists). Default: move */
  tv?: 'arrows' | 'move';
  className?: string;
}

export function SortableList<T>(props: SortableListProps<T>) {
  const form = useFormFactor();
  const tv = form === 'tv';
  const tvMode = props.tv ?? 'move';
  const { items, keyOf } = props;
  const ids = items.map(keyOf);
  const [moving, setMoving] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const rows = useRef(new Map<string, HTMLLIElement>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const nameOfId = (id: UniqueIdentifier) => {
    const it = items.find((x) => keyOf(x) === id);
    return it ? props.nameOf(it) : '';
  };
  const pos = (id: UniqueIdentifier | undefined) => (id === undefined ? -1 : ids.indexOf(String(id)) + 1);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOfId(active.id)}, position ${pos(active.id)} of ${ids.length}.`,
    onDragOver: ({ active, over }) => (over ? `${nameOfId(active.id)} is at position ${pos(over.id)} of ${ids.length}.` : undefined),
    onDragEnd: ({ active, over }) => (over ? `${nameOfId(active.id)} moved to position ${pos(over.id)} of ${ids.length}.` : `${nameOfId(active.id)} dropped.`),
    onDragCancel: ({ active }) => `Moving ${nameOfId(active.id)} was cancelled.`,
  };

  const commit = (from: number, to: number) => {
    if (from === to || to < 0 || to >= items.length) return;
    props.onMove(from, to);
    setAnnounce(`${props.nameOf(items[from]!)} moved to position ${to + 1} of ${items.length}`);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    commit(ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id)));
  };

  /* Move mode (TV remote): up/down move the item, OK / Back finish */
  useEffect(() => {
    if (!moving) return;
    const onKey = (e: KeyboardEvent) => {
      const i = items.findIndex((it) => keyOf(it) === moving);
      if (i < 0) return setMoving(null);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        commit(i, e.key === 'ArrowUp' ? i - 1 : i + 1);
      } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape' || e.key === 'Backspace' || [461, 10009, 4].includes(e.keyCode)) {
        e.preventDefault();
        e.stopPropagation();
        setMoving(null);
        setAnnounce('Done moving');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
        setMoving(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  // keep the moving row's Move button focused and in view as it travels
  useEffect(() => {
    if (!moving) return;
    const el = rows.current.get(moving)?.querySelector<HTMLElement>('[data-move]');
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
        onDragEnd={onDragEnd}
        accessibility={{ announcements, screenReaderInstructions: { draggable: 'To move this item, press Space. Then use the up and down arrows, and press Space again to drop it, or Escape to cancel.' } }}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className={`reorder${props.className ? ' ' + props.className : ''}`} aria-label={props.label}>
            {items.map((it, i) => {
              const k = keyOf(it);
              const name = props.nameOf(it);
              return (
                <SortableRow
                  key={k}
                  id={k}
                  name={name}
                  className={props.rowClass?.(it)}
                  moving={moving === k}
                  grip={!tv && items.length > 1}
                  rowRef={(el) => (el ? rows.current.set(k, el) : rows.current.delete(k))}
                >
                  <div className="reorder-main">{props.render(it)}</div>
                  {tv && tvMode === 'move' ? (
                    <button
                      type="button"
                      className={`btn${moving === k ? ' btn-primary' : ''}`}
                      data-move=""
                      aria-pressed={moving === k}
                      aria-label={moving === k ? `Moving ${name}: up or down, then OK` : `Move ${name}`}
                      onClick={() => {
                        if (moving === k) return setMoving(null);
                        setMoving(k);
                        setAnnounce(`Moving ${name}. Press up or down, then OK.`);
                      }}
                    >
                      {moving === k ? '▲▼ Moving' : 'Move'}
                    </button>
                  ) : (
                    <span className="reorder-arrows">
                      <button type="button" className="icon-btn sm" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => commit(i, i - 1)}>
                        <IconUp />
                      </button>
                      <button type="button" className="icon-btn sm" aria-label={`Move ${name} down`} disabled={i === items.length - 1} onClick={() => commit(i, i + 1)}>
                        <IconDown />
                      </button>
                    </span>
                  )}
                  {props.actions?.(it, i)}
                  {props.onRemove && (
                    <button type="button" className="icon-btn sm reorder-remove" aria-label={`${props.removeLabel ?? 'Remove'} ${name}`} title={props.removeLabel ?? 'Remove'} onClick={() => props.onRemove!(i)}>
                      <IconClose />
                    </button>
                  )}
                </SortableRow>
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  );
}

function SortableRow(props: {
  id: string;
  name: string;
  className?: string;
  moving: boolean;
  grip: boolean;
  rowRef: (el: HTMLLIElement | null) => void;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging, isSorting } = useSortable({ id: props.id });
  const cls = ['reorder-row', isDragging && 'lifted', isSorting && 'sorting', props.moving && 'moving', props.className].filter(Boolean).join(' ');
  return (
    <li
      ref={(el) => (setNodeRef(el), props.rowRef(el))}
      className={cls}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-nav-row={`reorder-${props.id}`}
    >
      {props.grip && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="reorder-handle"
          title="Drag to reorder"
          {...attributes}
          aria-label={`Reorder ${props.name}`}
          aria-roledescription="sortable"
          {...listeners}
        >
          <IconDrag />
        </button>
      )}
      {props.children}
    </li>
  );
}
