/** Inline stroke icons (no icon font). */
import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className: 'ico',
  ...p,
});

export const IconLive = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="6" width="18" height="13" rx="2.5" /><path d="M8 2.5l4 3.5 4-3.5" /></svg>
);
export const IconMovie = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" /></svg>
);
export const IconSeries = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="7" width="18" height="13" rx="2.5" /><path d="M6 4h12" /></svg>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
);
export const IconStar = ({ filled, ...p }: SVGProps<SVGSVGElement> & { filled?: boolean }) => (
  <svg {...base(p)} fill={filled ? 'currentColor' : 'none'}><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>
);
export const IconPlay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><path d="M8 5.5v13a1 1 0 001.5.86l10.5-6.5a1 1 0 000-1.72L9.5 4.64A1 1 0 008 5.5z" /></svg>
);
export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
);
export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M15 5l-7 7 7 7" /></svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M9 5l7 7-7 7" /></svg>
);
export const IconUp = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 15l6-6 6 6" /></svg>
);
export const IconDown = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconFullscreen = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 9V5a1 1 0 011-1h4M15 4h4a1 1 0 011 1v4M20 15v4a1 1 0 01-1 1h-4M9 20H5a1 1 0 01-1-1v-4" /></svg>
);
export const IconTracks = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 11h4M13 11h4M7 15h7M16 15h1" /></svg>
);
export const IconClock = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconDrag = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth={3} /></svg>
);
export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6" /></svg>
);
export const IconMore = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth={3.2} /></svg>
);
export const IconListAdd = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}><path d="M4 6h11M4 12h11M4 18h7M17 15v6M14 18h6" /></svg>
);

/** The AnyCast mark: a rounded screen with a thin ribbon under it. */
export const BrandMark = () => (
  <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="5" width="26" height="17" rx="5" fill="none" stroke="var(--text)" strokeWidth="2.5" />
    <rect x="3" y="25.5" width="26" height="2.5" rx="1.25" fill="var(--track-2)" />
    <rect x="3" y="25.5" width="17" height="2.5" rx="1.25" fill="var(--accent)" />
  </svg>
);
