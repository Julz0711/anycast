/** Icons for the control bar on the video. */
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

/** next episode / next channel */
export const IconNext = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 5.5l9 6.5-9 6.5z" fill="currentColor" />
    <path d="M18.5 5.5v13" />
  </svg>
);

/** circular arrow with the number of seconds inside */
export function IconSkip({ dir, label }: { dir: -1 | 1; label: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden className="ico">
      <g transform={dir < 0 ? 'translate(24 0) scale(-1 1)' : undefined}>
        <path d="M19.5 12a7.5 7.5 0 11-2.2-5.3" />
        <path d="M19.8 3.8v3.4h-3.4" />
      </g>
      <text x="12" y="15.4" textAnchor="middle" fontSize={label.length > 2 ? 6.2 : 7.4} fontWeight={700} fill="currentColor" stroke="none" fontFamily="inherit">
        {label}
      </text>
    </svg>
  );
}

export const IconFullscreenExit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4v4a1 1 0 01-1 1H4M20 9h-4a1 1 0 01-1-1V4M15 20v-4a1 1 0 011-1h4M4 15h4a1 1 0 011 1v4" />
  </svg>
);
