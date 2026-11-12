import { describe, expect, it } from 'vitest';
import { ACCENTS, DEFAULT_PREFERENCES, mergePreferences } from '@anycast/shared';
import { applyTheme, PALETTES, themeVars } from './theme';

const env = { reducedMotion: false, form: 'large' as const };

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
};

describe('themeVars', () => {
  it('maps the accent and derived tints', () => {
    const v = themeVars(mergePreferences({ appearance: { accent: 'sky' } }), env);
    expect(v['--accent']).toBe(ACCENTS.sky.hex);
    expect(v['--accent-tint']).toBe(`${ACCENTS.sky.hex}2E`);
    expect(v['--on-accent']).toBe('#0E0F11');
  });
  it('maps theme, text size, density and animations', () => {
    const p = mergePreferences({ appearance: { theme: 'black', textSize: 'xlarge', density: 'compact', animations: 'off' } });
    const v = themeVars(p, env);
    expect(v['--bg']).toBe(PALETTES.black.bg);
    expect(v['--root-size']).toBe('20px');
    expect(v['--space']).toBe('0.75');
    expect(v['--dur']).toBe('0ms');
  });
  it('honours prefers-reduced-motion when animations are full', () => {
    expect(themeVars(DEFAULT_PREFERENCES, { ...env, reducedMotion: true })['--dur']).toBe('60ms');
    expect(themeVars(DEFAULT_PREFERENCES, env)['--dur']).toBe('180ms');
  });
  it('maps the headline font, falling back to the UI font', () => {
    expect(themeVars(DEFAULT_PREFERENCES, env)['--font-display']).toMatch(/^'Bricolage Grotesque', 'Inter Tight'/);
    expect(themeVars(mergePreferences({ appearance: { headlineFont: 'mono' } }), env)['--font-display']).toMatch(/^'JetBrains Mono'/);
    expect(mergePreferences({ appearance: { headlineFont: 'comic' } }).appearance.headlineFont).toBe('bricolage');
  });
  it('scales type on TV', () => {
    expect(themeVars(DEFAULT_PREFERENCES, { ...env, form: 'tv' })['--root-size']).toMatch(/vw/);
  });
  it('keeps dark text on every accent and readable muted text in every theme (>= 4.5:1)', () => {
    for (const a of Object.values(ACCENTS)) expect(contrast(a.hex, '#0E0F11')).toBeGreaterThanOrEqual(4.5);
    for (const p of Object.values(PALETTES)) {
      expect(contrast(p.muted, p.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.muted, p.surface2)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.text, p.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('applyTheme', () => {
  it('writes CSS custom properties and data attributes on :root', () => {
    const root = document.documentElement;
    applyTheme(mergePreferences({ appearance: { accent: 'mint', theme: 'dim' } }), env, root);
    expect(root.style.getPropertyValue('--accent')).toBe(ACCENTS.mint.hex);
    expect(root.dataset.theme).toBe('dim');
    expect(root.dataset.form).toBe('large');
  });
  it('loads the headline font (not on TV) and swaps it when the choice changes', () => {
    applyTheme(DEFAULT_PREFERENCES, { ...env, form: 'phone' });
    expect(document.getElementById('headline-font')?.getAttribute('href')).toContain('Bricolage+Grotesque');
    applyTheme(mergePreferences({ appearance: { headlineFont: 'serif' } }), env);
    expect(document.querySelectorAll('#headline-font')).toHaveLength(1);
    expect(document.getElementById('headline-font')?.getAttribute('href')).toContain('Fraunces');
    applyTheme(mergePreferences({ appearance: { headlineFont: 'plain' } }), env);
    expect(document.getElementById('headline-font')).toBeNull();
    applyTheme(DEFAULT_PREFERENCES, { ...env, form: 'tv' });
    expect(document.getElementById('headline-font')).toBeNull();
  });
});
