/** Stable small hash for deterministic placeholder art. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Quiet, dark placeholder tones (like the mockups) chosen by hash. */
const TONES = ['#2B3A3F', '#3F2E2B', '#2B2F3F', '#33403A', '#3A3340', '#40392E', '#402E2E', '#2E3A40', '#36402E', '#3B2E40'];
export function toneFor(key: string): string {
  return TONES[hashString(key) % TONES.length]!;
}

/** Quality and codec words that say nothing about the channel ("ABC HD" is "ABC"). */
const NOISE = /^(u?hd|fhd|sd|4k|8k|uhd|hq|lq|low|raw|hevc|h26[45]|1080p?|720p?|2160p?|50fps|60fps|backup|vip|multi|ᴴᴰ)$/i;

/** "Arena Sport 1" -> "AS1", "News 24" -> "N24", "ABC HD" -> "ABC" */
export function initials(name: string): string {
  const all = name.replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  const kept = all.filter((w) => !NOISE.test(w));
  const words = kept.length ? kept : all;
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((w) => (/^\d+$/.test(w) ? w : w[0]!.toUpperCase()))
    .join('')
    .slice(0, 4);
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(t.type);
  }
  return false;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const d = (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => t && clearTimeout(t);
  return d;
}
