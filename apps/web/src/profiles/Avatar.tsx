/**
 * Profile pictures: an uploaded image, one of the built-in characters (see AVATAR_FIGURES) in an
 * accent color, or the first letter of the name on a tile tinted from the profile id.
 */
import { useId, type ReactNode } from 'react';
import { ACCENTS, AVATAR_COLORS, parseAvatar, type AccentId, type AvatarFigure, type Profile } from '@anycast/shared';

/** Colors a character is drawn with, all derived from one accent. */
interface Ink {
  /** the accent */
  c: string;
  /** darker accent, for shading and inner parts */
  d: string;
  /** much darker accent */
  dd: string;
  /** light tint of the accent: muzzles, bellies, eye whites */
  l: string;
  /** near-black for pupils and mouths */
  k: string;
  /** warm white for highlights and teeth */
  w: string;
}

const eye = (x: number, y: number, r: number, i: Ink) => (
  <>
    <circle cx={x} cy={y} r={r} fill={i.k} />
    <circle cx={x + r * 0.35} cy={y - r * 0.4} r={r * 0.38} fill={i.w} />
  </>
);

/** Display names, for the chooser's labels. */
export const FIGURE_NAMES: Record<AvatarFigure, string> = {
  fox: 'Fox', owl: 'Owl', telly: 'Telly', cat: 'Cat', robot: 'Robot', ghost: 'Ghost', frog: 'Frog', alien: 'Alien',
  bear: 'Bear', astro: 'Astronaut', popcorn: 'Popcorn', octo: 'Octopus', shroom: 'Mushroom', cyclops: 'Cyclops', penguin: 'Penguin', dino: 'Dino',
};

/** Each character on a 100×100 canvas, as a bust that runs off the bottom edge. */
const FIGURES: Record<AvatarFigure, (i: Ink) => ReactNode> = {
  fox: (i) => (
    <>
      <path d="M17 46 22 9l24 25z" fill={i.c} />
      <path d="M83 46 78 9 54 34z" fill={i.c} />
      <path d="M23 38 25 19l12 13z M77 38 75 19 63 32z" fill={i.dd} />
      <path d="M12 44q38-22 76 0-2 26-38 52Q14 70 12 44z" fill={i.c} />
      <path d="M14 52q16 6 26 2 6 4 10 4t10-4q10 4 26-2-6 24-36 44Q20 76 14 52z" fill={i.l} />
      <path d="M40 46q-4-4-9 0M60 46q4-4 9 0" fill="none" stroke={i.k} strokeWidth="3.5" strokeLinecap="round" />
      <ellipse cx="50" cy="66" rx="6" ry="4.5" fill={i.k} />
      <path d="M44 75q6 5 12 0" fill="none" stroke={i.dd} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  owl: (i) => (
    <>
      <path d="M16 104V54q0-16 6-26l-4-16 16 9q8-3 16-3t16 3l16-9-4 16q6 10 6 26v50z" fill={i.c} />
      <path d="M30 104q0-22 20-26 20 4 20 26z" fill={i.d} />
      <path d="M38 88q4 3 8 0m8 0q4 3 8 0M44 96q4 3 8 0" fill="none" stroke={i.dd} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="35" cy="50" r="15" fill={i.l} />
      <circle cx="65" cy="50" r="15" fill={i.l} />
      {eye(36, 51, 8, i)}
      {eye(64, 51, 8, i)}
      <path d="M45 62h10l-5 9z" fill={i.dd} />
    </>
  ),
  telly: (i) => (
    <>
      <path d="M50 30 34 10M50 30 68 12" stroke={i.l} strokeWidth="3" strokeLinecap="round" />
      <circle cx="34" cy="10" r="4" fill={i.c} />
      <circle cx="68" cy="12" r="4" fill={i.c} />
      <rect x="28" y="84" width="10" height="16" rx="3" fill={i.d} />
      <rect x="62" y="84" width="10" height="16" rx="3" fill={i.d} />
      <rect x="12" y="28" width="76" height="60" rx="16" fill={i.c} />
      <rect x="20" y="36" width="50" height="44" rx="10" fill={i.k} />
      <path d="M24 44q6-5 14-5" fill="none" stroke={i.w} strokeWidth="2.5" strokeLinecap="round" opacity="0.5" />
      <rect x="32" y="50" width="6" height="10" rx="3" fill={i.c} />
      <rect x="52" y="50" width="6" height="10" rx="3" fill={i.c} />
      <path d="M37 66q8 7 16 0" fill="none" stroke={i.c} strokeWidth="3" strokeLinecap="round" />
      <circle cx="79" cy="46" r="4" fill={i.dd} />
      <circle cx="79" cy="58" r="4" fill={i.dd} />
      <path d="M75 70h8M75 75h8" stroke={i.d} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  cat: (i) => (
    <>
      <path d="M14 104q0-16 12-22h48q12 6 12 22z" fill={i.d} />
      <path d="M16 56 20 14l28 22zM84 56 80 14 52 36z" fill={i.c} />
      <path d="M23 40 25 25l11 9zM77 40 75 25l-11 9z" fill={i.dd} />
      <ellipse cx="50" cy="58" rx="36" ry="30" fill={i.c} />
      <path d="M38 30q4 6 0 12M50 28v12M62 30q-4 6 0 12" fill="none" stroke={i.d} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="36" cy="58" rx="7" ry="8" fill={i.l} />
      <ellipse cx="64" cy="58" rx="7" ry="8" fill={i.l} />
      <ellipse cx="36" cy="58" rx="2.6" ry="7" fill={i.k} />
      <ellipse cx="64" cy="58" rx="2.6" ry="7" fill={i.k} />
      <path d="M46 68h8l-4 4z" fill={i.dd} />
      <path d="M42 75q4 4 8 0 4 4 8 0" fill="none" stroke={i.k} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M8 66l18 2M8 74l18-2M92 66l-18 2M92 74l-18-2" stroke={i.l} strokeWidth="2" strokeLinecap="round" opacity="0.7" />
    </>
  ),
  robot: (i) => (
    <>
      <path d="M50 26V14" stroke={i.l} strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="50" cy="11" r="5.5" fill={i.c} />
      <path d="M18 104q0-14 14-16h36q14 2 14 16z" fill={i.d} />
      <rect x="38" y="80" width="24" height="10" fill={i.dd} />
      <rect x="10" y="44" width="10" height="22" rx="4" fill={i.d} />
      <rect x="80" y="44" width="10" height="22" rx="4" fill={i.d} />
      <rect x="18" y="26" width="64" height="56" rx="14" fill={i.c} />
      <rect x="25" y="38" width="50" height="22" rx="11" fill={i.k} />
      <circle cx="39" cy="49" r="5.5" fill={i.l} />
      <circle cx="61" cy="49" r="5.5" fill={i.l} />
      <rect x="34" y="66" width="32" height="8" rx="4" fill={i.dd} />
      <path d="M42 66v8M50 66v8M58 66v8" stroke={i.c} strokeWidth="2" />
    </>
  ),
  ghost: (i) => (
    <>
      <path d="M20 96V48a30 30 0 0 1 60 0v48l-10-8-10 8-10-8-10 8-10-8z" fill={i.c} />
      <path d="M26 40q4-14 18-18" fill="none" stroke={i.l} strokeWidth="4" strokeLinecap="round" opacity="0.8" />
      <ellipse cx="40" cy="52" rx="5.5" ry="8" fill={i.k} />
      <ellipse cx="60" cy="52" rx="5.5" ry="8" fill={i.k} />
      <circle cx="42" cy="49" r="2" fill={i.w} />
      <circle cx="62" cy="49" r="2" fill={i.w} />
      <ellipse cx="50" cy="69" rx="5" ry="6" fill={i.k} />
      <circle cx="31" cy="64" r="4.5" fill={i.d} />
      <circle cx="69" cy="64" r="4.5" fill={i.d} />
      <path d="M86 18l2 5 5 2-5 2-2 5-2-5-5-2 5-2z M12 72l1.5 3.5 3.5 1.5-3.5 1.5-1.5 3.5-1.5-3.5-3.5-1.5 3.5-1.5z" fill={i.l} />
    </>
  ),
  frog: (i) => (
    <>
      <path d="M10 104q0-20 18-26h44q18 6 18 26z" fill={i.d} />
      <path d="M30 104q0-14 20-16 20 2 20 16z" fill={i.l} opacity="0.85" />
      <ellipse cx="50" cy="62" rx="40" ry="24" fill={i.c} />
      <circle cx="29" cy="40" r="15" fill={i.c} />
      <circle cx="71" cy="40" r="15" fill={i.c} />
      <circle cx="29" cy="40" r="10" fill={i.w} />
      <circle cx="71" cy="40" r="10" fill={i.w} />
      <ellipse cx="30" cy="41" rx="6" ry="4.5" fill={i.k} />
      <ellipse cx="70" cy="41" rx="6" ry="4.5" fill={i.k} />
      <path d="M24 66q26 20 52 0" fill="none" stroke={i.k} strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="22" cy="60" r="5" fill={i.d} />
      <circle cx="78" cy="60" r="5" fill={i.d} />
      <circle cx="45" cy="58" r="1.6" fill={i.dd} />
      <circle cx="55" cy="58" r="1.6" fill={i.dd} />
    </>
  ),
  alien: (i) => (
    <>
      <path d="M36 24Q30 12 20 10M64 24q6-12 16-14" fill="none" stroke={i.d} strokeWidth="3" strokeLinecap="round" />
      <circle cx="20" cy="10" r="5" fill={i.l} />
      <circle cx="80" cy="10" r="5" fill={i.l} />
      <path d="M26 104q0-12 12-14h24q12 2 12 14z" fill={i.d} />
      <path d="M50 18c28 0 38 20 34 40-4 18-18 34-34 34S20 76 16 58c-4-20 6-40 34-40z" fill={i.c} />
      <ellipse cx="34" cy="56" rx="9" ry="12" fill={i.k} transform="rotate(-24 34 56)" />
      <ellipse cx="66" cy="56" rx="9" ry="12" fill={i.k} transform="rotate(24 66 56)" />
      <circle cx="37" cy="51" r="3" fill={i.w} />
      <circle cx="69" cy="51" r="3" fill={i.w} />
      <circle cx="50" cy="36" r="6.5" fill={i.k} />
      <circle cx="52" cy="34" r="2" fill={i.w} />
      <path d="M45 77q5 3 10 0" fill="none" stroke={i.dd} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ),
  bear: (i) => (
    <>
      <circle cx="24" cy="30" r="14" fill={i.c} />
      <circle cx="76" cy="30" r="14" fill={i.c} />
      <circle cx="24" cy="30" r="7" fill={i.dd} />
      <circle cx="76" cy="30" r="7" fill={i.dd} />
      <path d="M12 104q0-18 16-22h44q16 4 16 22z" fill={i.d} />
      <circle cx="50" cy="58" r="34" fill={i.c} />
      <ellipse cx="50" cy="70" rx="16" ry="13" fill={i.l} />
      <ellipse cx="50" cy="64" rx="6.5" ry="4.5" fill={i.k} />
      <path d="M50 68v6m-6 1q6 4 12 0" fill="none" stroke={i.k} strokeWidth="2.5" strokeLinecap="round" />
      {eye(37, 52, 4.5, i)}
      {eye(63, 52, 4.5, i)}
    </>
  ),
  astro: (i) => (
    <>
      <path d="M8 104q2-18 22-22h40q20 4 22 22z" fill={i.l} />
      <rect x="40" y="88" width="20" height="10" rx="3" fill={i.c} />
      <circle cx="50" cy="48" r="38" fill={i.l} />
      <rect x="6" y="40" width="10" height="20" rx="4" fill={i.c} />
      <rect x="84" y="40" width="10" height="20" rx="4" fill={i.c} />
      <rect x="20" y="26" width="60" height="44" rx="22" fill={i.k} />
      <rect x="20" y="26" width="60" height="44" rx="22" fill="none" stroke={i.c} strokeWidth="4" />
      <path d="M30 40q4-6 12-8" fill="none" stroke={i.w} strokeWidth="3" strokeLinecap="round" opacity="0.6" />
      <circle cx="40" cy="52" r="4" fill={i.c} />
      <circle cx="60" cy="52" r="4" fill={i.c} />
      <path d="M45 60q5 4 10 0" fill="none" stroke={i.c} strokeWidth="2.5" strokeLinecap="round" />
      <path d="M68 34l1.2 3 3 1.2-3 1.2-1.2 3-1.2-3-3-1.2 3-1.2z" fill={i.w} />
    </>
  ),
  popcorn: (i) => (
    <>
      <g fill={i.w}>
        <circle cx="28" cy="38" r="11" />
        <circle cx="44" cy="28" r="12" />
        <circle cx="60" cy="30" r="12" />
        <circle cx="74" cy="40" r="11" />
        <circle cx="52" cy="16" r="9" />
        <circle cx="36" cy="44" r="9" />
        <circle cx="64" cy="44" r="9" />
      </g>
      <g fill={i.l} opacity="0.55">
        <circle cx="47" cy="24" r="4" />
        <circle cx="70" cy="36" r="3.5" />
        <circle cx="26" cy="36" r="3.5" />
      </g>
      <path d="M18 46h64l-8 54H26z" fill={i.w} />
      <path d="M26 46h11l2 54h-8zM48 46h4v54h-4zM63 46h11l-5 54h-8z" fill={i.c} />
      <rect x="15" y="44" width="70" height="8" rx="4" fill={i.d} />
      <rect x="30" y="60" width="40" height="22" rx="11" fill={i.k} />
      <circle cx="41" cy="69" r="3" fill={i.w} />
      <circle cx="59" cy="69" r="3" fill={i.w} />
      <path d="M46 75q4 3 8 0" fill="none" stroke={i.w} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  octo: (i) => (
    <>
      <g fill="none" stroke={i.c} strokeWidth="9" strokeLinecap="round">
        <path d="M24 66q-8 14-18 12" />
        <path d="M34 72q-4 16-14 22" />
        <path d="M50 74v26" />
        <path d="M66 72q4 16 14 22" />
        <path d="M76 66q8 14 18 12" />
      </g>
      <g fill={i.l}>
        <circle cx="12" cy="78" r="1.8" />
        <circle cx="25" cy="90" r="1.8" />
        <circle cx="50" cy="92" r="1.8" />
        <circle cx="75" cy="90" r="1.8" />
        <circle cx="88" cy="78" r="1.8" />
      </g>
      <path d="M18 56c0-24 14-40 32-40s32 16 32 40c0 12-14 20-32 20s-32-8-32-20z" fill={i.c} />
      <circle cx="64" cy="32" r="4" fill={i.d} />
      <circle cx="72" cy="42" r="2.5" fill={i.d} />
      <circle cx="30" cy="36" r="3" fill={i.d} />
      {eye(39, 54, 6, i)}
      {eye(61, 54, 6, i)}
      <circle cx="50" cy="67" r="3.5" fill={i.dd} />
    </>
  ),
  shroom: (i) => (
    <>
      <path d="M30 104V66q0-10 20-10t20 10v38z" fill={i.w} />
      <path d="M10 56C10 30 28 12 50 12s40 18 40 44q0 6-6 6H16q-6 0-6-6z" fill={i.c} />
      <circle cx="32" cy="34" r="7" fill={i.l} />
      <circle cx="58" cy="24" r="5.5" fill={i.l} />
      <circle cx="72" cy="44" r="6" fill={i.l} />
      <circle cx="46" cy="48" r="4" fill={i.l} />
      <circle cx="20" cy="50" r="3" fill={i.l} />
      <circle cx="42" cy="76" r="3.5" fill={i.k} />
      <circle cx="58" cy="76" r="3.5" fill={i.k} />
      <path d="M46 84q4 3 8 0" fill="none" stroke={i.k} strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="36" cy="83" r="3" fill={i.c} opacity="0.55" />
      <circle cx="64" cy="83" r="3" fill={i.c} opacity="0.55" />
    </>
  ),
  cyclops: (i) => (
    <>
      <path d="M26 30 20 8l18 14zM74 30l6-22-18 14z" fill={i.l} />
      <path d="M12 104V58c0-24 16-38 38-38s38 14 38 38v46z" fill={i.c} />
      <path d="M16 70q-6 4-6 12M84 70q6 4 6 12" fill="none" stroke={i.d} strokeWidth="5" strokeLinecap="round" />
      <circle cx="50" cy="48" r="17" fill={i.w} />
      <circle cx="50" cy="50" r="9" fill={i.dd} />
      <circle cx="50" cy="50" r="4.5" fill={i.k} />
      <circle cx="54" cy="45" r="3" fill={i.w} />
      <path d="M33 32q17-8 34 0" fill="none" stroke={i.d} strokeWidth="4" strokeLinecap="round" />
      <path d="M30 74q20 18 40 0z" fill={i.k} />
      <path d="M36 76l4 6 4-5zM56 77l4 5 4-6z" fill={i.w} />
    </>
  ),
  penguin: (i) => (
    <>
      <path d="M14 104V56c0-24 16-40 36-40s36 16 36 40v48z" fill={i.c} />
      <path d="M22 104V62c0-12 6-22 16-22 6 0 9 3 12 6 3-3 6-6 12-6 10 0 16 10 16 22v42z" fill={i.l} />
      <path d="M50 17q-9 2-12 9" fill="none" stroke={i.l} strokeWidth="3" strokeLinecap="round" opacity="0.7" />
      {eye(39, 57, 4.5, i)}
      {eye(61, 57, 4.5, i)}
      <path d="M40 66h20l-10 10z" fill={i.d} />
      <circle cx="30" cy="70" r="4" fill={i.c} opacity="0.6" />
      <circle cx="70" cy="70" r="4" fill={i.c} opacity="0.6" />
      <path d="M8 100q4-22 12-30M92 100q-4-22-12-30" fill="none" stroke={i.d} strokeWidth="8" strokeLinecap="round" />
    </>
  ),
  dino: (i) => (
    <>
      <path d="M26 24l6-14 8 12 10-14 10 14 8-12 6 14z" fill={i.d} />
      <path d="M16 104V48c0-18 14-28 34-28s34 10 34 28v56z" fill={i.c} />
      <path d="M30 104q0-18 20-20 20 2 20 20z" fill={i.l} />
      <path d="M36 92h28M38 99h24" stroke={i.c} strokeWidth="2" opacity="0.5" />
      {eye(36, 44, 5, i)}
      {eye(64, 44, 5, i)}
      <path d="M28 58q22 18 44 0z" fill={i.k} />
      <path d="M33 60l4 5 4-4zM46 62l4 5 4-5zM59 61l4 4 4-5z" fill={i.w} />
      <circle cx="44" cy="33" r="1.8" fill={i.dd} />
      <circle cx="56" cy="33" r="1.8" fill={i.dd} />
      <circle cx="24" cy="54" r="2.5" fill={i.d} />
      <circle cx="78" cy="50" r="3" fill={i.d} />
    </>
  ),
};

/** #RRGGBB mixed toward black (k < 1) by factor k. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** #RRGGBB mixed toward white by t (0..1). */
function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** The tile behind a picture: the color, very dark. */
const tile = (hex: string) => shade(hex, 0.2);

export function BuiltinAvatar({ figure, color }: { figure: AvatarFigure; color: AccentId }) {
  const hex = ACCENTS[color].hex;
  const glow = `pg${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const ink: Ink = { c: hex, d: shade(hex, 0.62), dd: shade(hex, 0.36), l: tint(hex, 0.55), k: '#141318', w: '#FFF7EC' };
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className="pic-svg">
      <defs>
        <radialGradient id={glow} cx="50%" cy="38%" r="62%">
          <stop offset="0" stopColor={shade(hex, 0.42)} />
          <stop offset="1" stopColor={tile(hex)} />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#${glow})`} />
      {FIGURES[figure](ink)}
    </svg>
  );
}

/** A stable color for a profile without a picture. */
function colorFor(id: string): AccentId {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * A profile's picture. `preview` overrides what is shown (the picture chooser previews a choice
 * before it is saved): an avatar id, an image URL, or null for the letter.
 */
export function ProfileAvatar(props: {
  profile: Pick<Profile, 'id' | 'name' | 'avatar' | 'image'>;
  size?: AvatarSize;
  preview?: { avatar: string | null; image: string | null };
  className?: string;
}) {
  const { profile, size = 'md' } = props;
  const avatar = props.preview ? props.preview.avatar : profile.avatar;
  const image = props.preview ? props.preview.image : profile.image;
  const parsed = parseAvatar(avatar);
  const cls = `pic pic-${size}${props.className ? ' ' + props.className : ''}`;
  if (image) {
    return (
      <span className={cls} aria-hidden="true">
        <img src={image} alt="" draggable={false} />
      </span>
    );
  }
  if (parsed) {
    return (
      <span className={cls} aria-hidden="true">
        <BuiltinAvatar figure={parsed.figure} color={parsed.color} />
      </span>
    );
  }
  const hex = ACCENTS[colorFor(profile.id || profile.name)].hex;
  return (
    <span className={`${cls} pic-letter`} aria-hidden="true" style={{ background: tile(hex), color: hex }}>
      <span>{(profile.name.trim()[0] ?? '?').toUpperCase()}</span>
    </span>
  );
}
