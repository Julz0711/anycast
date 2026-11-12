/**
 * Preferences -> CSS custom properties on :root. Pure (`themeVars`) + DOM apply (`applyTheme`).
 * Every color in the UI comes from these variables, so changing a preference re-themes live.
 */
import { ACCENTS, type HeadlineFontId, type Preferences } from '@anycast/shared';
import type { FormFactor } from '../lib/device';

export interface Palette {
  bg: string;
  surface: string;
  surface2: string;
  line: string;
  track: string;
  track2: string;
  border: string;
  text: string;
  text2: string;
  muted: string;
}

/** Calm near-black layers from the Ribbon mockups. Muted text stays >= 4.5:1 on surface2 in every theme. */
export const PALETTES: Record<Preferences['appearance']['theme'], Palette> = {
  dark: {
    bg: '#0E0F11', surface: '#17191C', surface2: '#1E2024', line: '#1C1E22', track: '#24272C',
    track2: '#4A4E56', border: '#33363C', text: '#ECEDEE', text2: '#C5CAD0', muted: '#A0A6AD',
  },
  black: {
    bg: '#000000', surface: '#111214', surface2: '#18191C', line: '#16171A', track: '#202226',
    track2: '#454950', border: '#2C2F34', text: '#ECEDEE', text2: '#C5CAD0', muted: '#9CA2A9',
  },
  dim: {
    bg: '#1A1C20', surface: '#24272C', surface2: '#2B2E34', line: '#2A2D32', track: '#33363C',
    track2: '#5A5F68', border: '#43474E', text: '#F0F1F2', text2: '#D0D4D9', muted: '#B0B6BD',
  },
};

export const TEXT_SIZE_PX: Record<Preferences['appearance']['textSize'], number> = {
  small: 14,
  medium: 16,
  large: 18,
  xlarge: 20,
};

/**
 * The headline font (titles, section heads, the clock; not on TV). `css2` is the Google Fonts family
 * query, loaded on demand; 'plain' is the UI font and loads nothing.
 */
export const HEADLINE_FONTS: Record<HeadlineFontId, { name: string; family: string; css2: string | null; tracking: string }> = {
  bricolage: { name: 'Bricolage', family: "'Bricolage Grotesque'", css2: 'Bricolage+Grotesque:opsz,wght@12..96,500..800', tracking: '-0.03em' },
  grotesk: { name: 'Space', family: "'Space Grotesk'", css2: 'Space+Grotesk:wght@500..700', tracking: '-0.03em' },
  serif: { name: 'Serif', family: "'Fraunces'", css2: 'Fraunces:opsz,wght@9..144,500..700', tracking: '-0.02em' },
  mono: { name: 'Mono', family: "'JetBrains Mono'", css2: 'JetBrains+Mono:wght@500..700', tracking: '-0.05em' },
  plain: { name: 'Plain', family: "'Inter Tight'", css2: null, tracking: '-0.02em' },
};
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Loads the headline font's stylesheet once (the service worker keeps Google Fonts for offline use). */
export function loadHeadlineFont(id: HeadlineFontId, doc: Document = document) {
  const css2 = (HEADLINE_FONTS[id] ?? HEADLINE_FONTS.plain).css2;
  const linkId = 'headline-font';
  const old = doc.getElementById(linkId) as HTMLLinkElement | null;
  if (!css2) return old?.remove();
  const href = `https://fonts.googleapis.com/css2?family=${css2}&display=swap`;
  if (old?.getAttribute('href') === href) return;
  const link = old ?? doc.createElement('link');
  link.id = linkId;
  link.rel = 'stylesheet';
  link.setAttribute('href', href);
  if (!old) doc.head.appendChild(link);
}

/** Dark text on accent: every accent in ACCENTS is light. */
export const ON_ACCENT = '#0E0F11';

export interface ThemeEnv {
  reducedMotion: boolean;
  form: FormFactor;
}

export function effectiveAnimations(prefs: Preferences, env: Pick<ThemeEnv, 'reducedMotion'>): 'full' | 'reduced' | 'off' {
  const a = prefs.appearance.animations;
  if (a === 'full' && env.reducedMotion) return 'reduced';
  return a;
}

export function themeVars(prefs: Preferences, env: ThemeEnv): Record<string, string> {
  const ap = prefs.appearance;
  const accent = (ACCENTS[ap.accent] ?? ACCENTS.amber).hex;
  const pal = PALETTES[ap.theme] ?? PALETTES.dark;
  const px = TEXT_SIZE_PX[ap.textSize] ?? 16;
  const anim = effectiveAnimations(prefs, env);
  // TV: scale type with the screen (designed at 1280 wide, ~1.4x desktop size).
  const rootSize = env.form === 'tv' ? `max(${px * 1.2}px, ${((px * 1.3) / 1280) * 100}vw)` : `${px}px`;
  return {
    '--accent': accent,
    '--accent-tint': `${accent}2E`,
    '--accent-glow': `${accent}40`,
    '--on-accent': ON_ACCENT,
    '--bg': pal.bg,
    '--surface': pal.surface,
    '--surface-2': pal.surface2,
    '--line': pal.line,
    '--track': pal.track,
    '--track-2': pal.track2,
    '--border': pal.border,
    '--text': pal.text,
    '--text-2': pal.text2,
    '--muted': pal.muted,
    '--root-size': rootSize,
    '--space': ap.density === 'compact' ? '0.75' : '1',
    '--dur': anim === 'full' ? '180ms' : anim === 'reduced' ? '60ms' : '0ms',
    '--move': anim === 'full' ? '1' : '0',
    '--font-display': `${(HEADLINE_FONTS[ap.headlineFont] ?? HEADLINE_FONTS.plain).family}, 'Inter Tight', ${FONT_STACK}`,
    '--display-tracking': (HEADLINE_FONTS[ap.headlineFont] ?? HEADLINE_FONTS.plain).tracking,
  };
}

export function applyTheme(prefs: Preferences, env: ThemeEnv, root: HTMLElement = document.documentElement) {
  const vars = themeVars(prefs, env);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.theme = prefs.appearance.theme;
  root.dataset.density = prefs.appearance.density;
  root.dataset.anim = effectiveAnimations(prefs, env);
  root.dataset.form = env.form;
  root.dataset.artwork = prefs.appearance.showArtwork ? 'on' : 'off';
  // the TV layout keeps the UI font throughout
  if (root === document.documentElement) loadHeadlineFont(env.form === 'tv' ? 'plain' : prefs.appearance.headlineFont);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', vars['--bg']!);
}
