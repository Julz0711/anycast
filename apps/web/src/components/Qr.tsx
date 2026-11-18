/** A QR code as crisp SVG (dark modules on a white card, so phones read it on a dark screen too). */
import { encode } from 'uqr';
import { useMemo } from 'react';

export function Qr(props: { value: string; size?: number | string; label: string; className?: string }) {
  const { path, n } = useMemo(() => {
    const { data, size } = encode(props.value, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, n: size };
  }, [props.value]);
  return (
    <svg className={`qr${props.className ? ` ${props.className}` : ''}`} viewBox={`0 0 ${n} ${n}`} width={props.size ?? 200} height={props.size ?? 200} role="img" aria-label={props.label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
