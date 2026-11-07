/** Cast and AirPlay icons, same stroke style as components/Icons. */
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

export const IconCast = ({ connected, ...p }: SVGProps<SVGSVGElement> & { connected?: boolean }) => (
  <svg {...base(p)}>
    <path d="M3 8.5V7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2h-5" />
    <path d="M3 12a7 7 0 017 7M3 15.5A3.5 3.5 0 016.5 19" />
    <path d="M3 19h.01" strokeWidth={2.6} />
    {connected && <path d="M7 9h10v6h-3" fill="currentColor" stroke="none" opacity={0.85} />}
  </svg>
);

export const IconAirPlay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 17H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v9a2 2 0 01-2 2h-1" />
    <path d="M12 14l5 6H7z" fill="currentColor" />
  </svg>
);
