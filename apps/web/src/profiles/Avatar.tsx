/**
 * Profile pictures: an uploaded image, one of the built-in pictures (a calm shape on a tinted
 * tile, see AVATAR_SHAPES), or the first letter of the name on a tile tinted from the profile id.
 */
import type { ReactNode } from 'react';
import { ACCENTS, AVATAR_COLORS, parseAvatar, type AccentId, type AvatarShape, type Profile } from '@anycast/shared';

/** Each shape on a 100×100 canvas, drawn with `c` (the color) and `d` (a darker shade for depth). */
const SHAPES: Record<AvatarShape, (c: string, d: string) => ReactNode> = {
  ribbon: (c, d) => (
    <>
      <path d="M14 62c14-22 30-22 40-6s26 16 34-4" fill="none" stroke={d} strokeWidth="13" strokeLinecap="round" />
      <path d="M14 50c14-22 30-22 40-6s26 16 34-4" fill="none" stroke={c} strokeWidth="13" strokeLinecap="round" />
    </>
  ),
  orbit: (c, d) => (
    <>
      <ellipse cx="50" cy="52" rx="38" ry="13" fill="none" stroke={d} strokeWidth="5" transform="rotate(-18 50 52)" />
      <circle cx="50" cy="52" r="19" fill={c} />
      <circle cx="82" cy="36" r="6" fill={c} />
    </>
  ),
  wave: (c, d) => (
    <>
      <path d="M10 40q10-10 20 0t20 0 20 0 20 0" fill="none" stroke={c} strokeWidth="8" strokeLinecap="round" />
      <path d="M10 56q10-10 20 0t20 0 20 0 20 0" fill="none" stroke={d} strokeWidth="8" strokeLinecap="round" />
      <path d="M10 72q10-10 20 0t20 0 20 0 20 0" fill="none" stroke={c} strokeWidth="8" strokeLinecap="round" opacity="0.55" />
    </>
  ),
  peak: (c, d) => (
    <>
      <path d="M8 80l30-44 20 28 10-14 24 30z" fill={d} />
      <path d="M8 80l30-44 30 44z" fill={c} />
      <circle cx="74" cy="28" r="8" fill={c} />
    </>
  ),
  bloom: (c, d) => (
    <>
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse key={a} cx="50" cy="31" rx="11" ry="17" fill={c} transform={`rotate(${a} 50 50)`} />
      ))}
      <circle cx="50" cy="50" r="10" fill={d} />
    </>
  ),
  moon: (c, d) => (
    <>
      <circle cx="47" cy="52" r="30" fill={c} />
      <circle cx="62" cy="42" r="26" fill={d} />
      <circle cx="78" cy="24" r="3.5" fill={c} />
      <circle cx="86" cy="40" r="2.5" fill={c} />
    </>
  ),
  spark: (c, d) => (
    <>
      <path d="M50 12c3 22 16 35 38 38-22 3-35 16-38 38-3-22-16-35-38-38 22-3 35-16 38-38z" fill={c} />
      <path d="M78 66c1 7 5 11 12 12-7 1-11 5-12 12-1-7-5-11-12-12 7-1 11-5 12-12z" fill={d} />
    </>
  ),
  stack: (c, d) => (
    <>
      <rect x="18" y="24" width="52" height="14" rx="7" fill={c} />
      <rect x="30" y="43" width="52" height="14" rx="7" fill={d} />
      <rect x="18" y="62" width="52" height="14" rx="7" fill={c} opacity="0.7" />
    </>
  ),
  drop: (c, d) => (
    <>
      <path d="M50 12c14 20 28 34 28 50a28 28 0 01-56 0c0-16 14-30 28-50z" fill={c} />
      <path d="M38 62a12 12 0 0012 12" fill="none" stroke={d} strokeWidth="5" strokeLinecap="round" />
    </>
  ),
  leaf: (c, d) => (
    <>
      <path d="M20 80C20 40 44 18 84 16c-2 40-24 64-64 64z" fill={c} />
      <path d="M22 78L66 34" stroke={d} strokeWidth="5" strokeLinecap="round" />
    </>
  ),
  prism: (c, d) => (
    <>
      <path d="M50 14l36 64H14z" fill={c} />
      <path d="M50 14l36 64H50z" fill={d} />
    </>
  ),
  ring: (c, d) => (
    <>
      <circle cx="50" cy="50" r="33" fill="none" stroke={c} strokeWidth="9" />
      <circle cx="50" cy="50" r="17" fill="none" stroke={d} strokeWidth="9" />
      <circle cx="50" cy="50" r="4.5" fill={c} />
    </>
  ),
};

/** #RRGGBB mixed toward black. */
function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** The tile behind a picture: the color, very dark. */
const tile = (hex: string) => shade(hex, 0.2);

export function BuiltinAvatar({ shape, color }: { shape: AvatarShape; color: AccentId }) {
  const hex = ACCENTS[color].hex;
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className="pic-svg">
      <rect width="100" height="100" fill={tile(hex)} />
      {SHAPES[shape](hex, shade(hex, 0.55))}
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
        <BuiltinAvatar shape={parsed.shape} color={parsed.color} />
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
