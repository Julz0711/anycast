/** Small shared UI primitives: Segmented, Toggle, Chips, Skeleton, ProgressBar, LogoTile, Empty. */
import { useState, type ReactNode } from 'react';
import { initials } from '../lib/misc';

export function Segmented<T extends string | number>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'lg';
}) {
  return (
    <div className={`seg${props.size ? ' ' + props.size : ''}`} role="radiogroup" aria-label={props.label} data-nav-row={`seg-${props.label}`}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" className="toggle" aria-checked={props.checked} aria-label={props.label} onClick={() => props.onChange(!props.checked)} />
  );
}

export function Chips<T extends string>(props: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="toolbar" aria-label={props.label} data-nav-row={`chips-${props.label}`}>
      {props.items.map((c) => (
        <button key={c.id} type="button" className="chip" aria-pressed={c.id === props.value} onClick={() => props.onChange(c.id)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}

export function Skeleton(props: { w?: string | number; h?: string | number; r?: string; style?: React.CSSProperties; className?: string }) {
  return (
    <div
      className={`skel ${props.className ?? ''}`}
      aria-hidden="true"
      style={{ width: props.w ?? '100%', height: props.h ?? '0.75rem', borderRadius: props.r, ...props.style }}
    />
  );
}

export function ProgressBar(props: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, props.value)) * 100;
  return (
    <div className="progress" role={props.label ? 'progressbar' : undefined} aria-label={props.label} aria-valuenow={props.label ? Math.round(pct) : undefined} aria-hidden={props.label ? undefined : true}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function LogoTile(props: { name: string; logo: string | null; small?: boolean; show?: boolean }) {
  const [broken, setBroken] = useState(false);
  const showImg = props.show !== false && props.logo && !broken;
  return (
    <div className={`logo-tile${props.small ? ' sm' : ''}`} aria-hidden="true">
      {showImg ? <img src={props.logo!} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} /> : initials(props.name)}
    </div>
  );
}

export function Empty(props: { title: string; children?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <h2>{props.title}</h2>
      {props.children}
    </div>
  );
}
