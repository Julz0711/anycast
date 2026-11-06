/** Human names for ISO language / region codes via Intl (no data tables shipped). */
let langNames: Intl.DisplayNames | null = null;
let regionNames: Intl.DisplayNames | null = null;
try {
  langNames = new Intl.DisplayNames(undefined, { type: 'language' });
  regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
} catch {
  /* very old engines: fall back to codes */
}

export function languageName(code: string | null): string {
  if (!code) return 'Unknown';
  try {
    return langNames?.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function countryName(code: string | null): string {
  if (!code) return 'Unknown';
  try {
    return regionNames?.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** A short list offered for preferred audio/subtitle languages. */
export const COMMON_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'tr', 'ar', 'sv', 'da', 'no', 'fi', 'el', 'ru', 'uk', 'ja', 'ko', 'zh', 'hi'];
