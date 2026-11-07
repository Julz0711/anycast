/**
 * Display names from provider names: category names in one style ("UK · Sports" for "UK: SPORTS",
 * "|EN| SPORTS" and "UK | SPORTS" alike), movie and series titles without quality and subtitle
 * tags ("Title (1987) 4K" -> "Title", 1987), episode titles without the series name and code
 * ("Show (2018) - S01E01 - Pilot" -> "Pilot"), and the duplicate-channel key and quality label
 * ("BBC One FHD", "BBC One ᴴᴰ" and "BBC One RAW" are one channel in three qualities).
 */
import { tagCategory, tidyName } from './tagger';

/** Short words that read as words, not acronyms, when a provider writes them in capitals. */
const SMALL_WORDS = new Set(['THE', 'AND', 'FOR', 'NEW', 'ALL', 'OLD', 'TOP', 'BIG', 'MIX', 'OF', 'IN', 'ON', 'AT', 'TO', 'BY', 'DE', 'LA', 'LE', 'EL', 'DU', 'ET', 'Y']);
/** Acronyms of four letters or more that stay in capitals. */
const KEEP_UPPER = new Set(['HBO', 'BBC', 'MBC', 'RAI', 'UEFA', 'FIFA', 'NBA', 'NFL', 'NHL', 'MLB', 'UFC', 'WWE', 'ESPN', 'CNN', 'NHK', 'ARTE', 'TVP', 'VIP', 'PPV', 'UHD', 'FHD', 'IMAX', 'NASA', 'BEIN', 'AMC', 'TNT', 'TLC', 'MTV', 'CBS', 'NBC', 'ABC', 'FOX', 'ITV', 'RTL', 'ZDF', 'ARD']);

/** "SPORTS & NEWS" -> "Sports & News"; words in mixed case ("beIN") and short acronyms ("UK", "4K") stay. */
export function titleCase(s: string): string {
  return s.replace(/[\p{L}\p{N}'’]+/gu, (w, offset: number) => {
    if (w !== w.toUpperCase() || !/\p{L}/u.test(w) || /\p{N}/u.test(w)) return w;
    if (KEEP_UPPER.has(w)) return w;
    if (w.length <= 3 && !SMALL_WORDS.has(w)) return w;
    const lower = w.toLowerCase();
    if (offset > 0 && SMALL_WORDS.has(w) && w.length <= 3 && ['THE', 'AND', 'FOR', 'OF', 'IN', 'ON', 'AT', 'TO', 'BY'].includes(w)) return lower;
    return lower[0]!.toUpperCase() + lower.slice(1);
  });
}

const REGION_LABEL: Record<string, string> = { gb: 'UK' };

/** The category name AnyCast shows: the region tag as a short label, then the name in title case. */
export function cleanCategoryName(raw: string): string {
  const trimmed = raw.trim();
  // leading decoration some panels put before the tag ("· EN| SPORTS", "★ UK: SPORTS")
  const bare = trimmed.replace(/^[\s·•●★✪»▎▍▌▏│┃-]+/u, '');
  const tag = tagCategory(bare);
  const tidied = tidyName(bare);
  const rest = titleCase(tag.name);
  const stripped = tag.name !== tidied && tag.name.length < tidied.length;
  const region = tag.country ? (REGION_LABEL[tag.country] ?? tag.country.toUpperCase()) : tag.language?.toUpperCase();
  if (stripped && region && rest) return `${region} · ${rest}`;
  return titleCase(tidied.replace(/\s*\|\s*/g, ' · ').replace(/^ · | · $/g, '')) || trimmed;
}

/** Trailing tags of a movie or series name: quality, subtitles, dubbing. */
const TRAILING_TAG_RE = new RegExp(
  String.raw`\s*(?:` +
    String.raw`[\[(][^\])]*\b(?:multi|subs?|subbed|dubbed?|vost\w*|4k|uhd|fhd|hd|sd|hevc|hdr|1080p?|720p?|2160p?)\b[^\])]*[\])]` +
    String.raw`|\b(?:4K|UHD|FHD|HD|SD|HEVC|HDR10?|DV|H\.?26[45]|1080p|720p|2160p|MULTI(?:-SUBS?)?|SUBBED|DUBBED|VOSTFR|REMASTERED)\b` +
    String.raw`|[-–|]` +
  String.raw`)\s*$`,
  'i',
);

/** "Title (1987) 4K" -> "Title (1987)"; "Title [MULTI-SUB]" -> "Title". */
export function stripTitleTags(name: string): string {
  let s = name.trim();
  for (let i = 0; i < 6; i++) {
    const next = s.replace(TRAILING_TAG_RE, '').trim();
    if (next === s || !next) break;
    s = next;
  }
  return s;
}

/** "Title (2019)", "Title - 2019", "Title [2019]" -> year and the title without it. Tags after the year go too. */
export function splitTitle(name: string): { name: string; year: number | null } {
  const base = stripTitleTags(name);
  const m = /\s*(?:\((\d{4})\)|\[(\d{4})\]|[-–]\s*(\d{4}))\s*$/.exec(base);
  const y = m ? Number(m[1] ?? m[2] ?? m[3]) : NaN;
  if (!m || y < 1900 || y > 2100) return { name: base || name.trim(), year: null };
  return { name: stripTitleTags(base.slice(0, m.index)) || base, year: y };
}

const EPISODE_CODE_RE = /\bS(\d{1,3})\s*[ .]?\s*E(\d{1,4})\b/i;
const SEP_RE = /^[\s\-–—:|.·]+|[\s\-–—:|.·]+$/g;

/**
 * "Show (2018) - S01E01 - Pilot" -> "Pilot"; "Show - Pilot" -> "Pilot" (with the series name);
 * a title that is only the code ("S01E01", "Show S01E01") becomes "Episode 1".
 */
export function cleanEpisodeTitle(title: string, seriesName?: string | null, episode?: number | null): string {
  const t = title.trim();
  const code = EPISODE_CODE_RE.exec(t);
  let rest = t;
  if (code) {
    rest = t.slice(code.index + code[0].length).replace(SEP_RE, '');
    if (!rest) return `Episode ${episode ?? Number(code[2])}`;
  } else if (seriesName) {
    const name = seriesName.trim();
    if (name && t.toLowerCase().startsWith(name.toLowerCase())) {
      rest = t.slice(name.length).replace(/^\s*[([]\d{4}[)\]]/, '').replace(SEP_RE, '');
      if (!rest) return episode ? `Episode ${episode}` : t;
    }
  }
  return rest || t;
}

/* ---------------- duplicate channels ---------------- */

/** Quality labels, best first; the order is also how a group picks the channel it shows. */
export const QUALITY_ORDER = ['FHD', 'HD', null, '4K', 'HQ', 'SD', 'LOW', 'RAW'] as const;
export type Quality = (typeof QUALITY_ORDER)[number];

const QUALITY_TOKENS: [RegExp, Exclude<Quality, null> | ''][] = [
  [/^(?:4k|uhd|2160p?|8k)$/i, '4K'],
  [/^(?:fhd|1080p?|fullhd)$/i, 'FHD'],
  [/^(?:hd|720p?|hdr)$/i, 'HD'],
  [/^(?:sd|576p?|480p?)$/i, 'SD'],
  [/^(?:hq)$/i, 'HQ'],
  [/^(?:low|lq|mobile)$/i, 'LOW'],
  [/^(?:raw)$/i, 'RAW'],
  // tags that say nothing about the content: dropped from the key, no label of their own
  [/^(?:hevc|h\.?26[45]|x26[45]|\d{2}fps|backup|geo|vip)$/i, ''],
];
const SUPERSCRIPTS: [RegExp, string][] = [
  [/ᴴᴰ/g, ' HD'],
  [/ᵁᴴᴰ/g, ' 4K'],
  [/ᶠᴴᴰ/g, ' FHD'],
  [/ˢᴰ/g, ' SD'],
  [/[¹²³⁴⁵⁶⁷⁸⁹⁰]+/g, ''],
];

/**
 * The key that ties variants of one channel together, and the variant's quality. Timeshift
 * channels ("+1") and different numbers ("BBC One" and "BBC Two", "Sky Sports 1" and "Sky Sports 2")
 * stay apart; quality words, codec tags, superscripts and a trailing "(2)" do not count.
 */
export function variantKey(name: string): { key: string; quality: Quality; base: string; spare: boolean } {
  let s = name;
  // a backup, an old or a test feed is shown only when nothing better is there
  const spare = /[[(]\s*(?:backup|old|test|alt|\d{1,3})\s*[\])]|\b(?:backup|test)\b/i.test(name);
  for (const [re, to] of SUPERSCRIPTS) s = s.replace(re, to);
  s = s.normalize('NFKC');
  // bracketed tags: "[Geo]", "(Backup)", "(2)"
  s = s.replace(/[[(]\s*(?:\d{1,3}|geo|backup|alt|vip|old|new|test|multi[\w-]*|hevc|h\.?26[45]|4k|uhd|fhd|hd|sd|hq|lq|low|raw|\d{3,4}p)\s*[\])]/gi, (m) => {
    const inner = m.slice(1, -1).trim();
    const q = QUALITY_TOKENS.find(([re]) => re.test(inner));
    return q && q[1] ? ` ${inner} ` : ' ';
  });
  let quality: Quality = null;
  const words: string[] = [];
  for (const w of s.split(/[\s|:·•\-–—_/]+/).filter(Boolean)) {
    const q = QUALITY_TOKENS.find(([re]) => re.test(w));
    if (q) {
      if (q[1] && (quality === null || QUALITY_ORDER.indexOf(q[1]) < QUALITY_ORDER.indexOf(quality))) quality = q[1];
      continue;
    }
    words.push(w);
  }
  const base = words.join(' ').trim();
  const key = base.toLowerCase().replace(/[^\p{L}\p{N}+ ]/gu, '').replace(/\s+/g, ' ').trim();
  return { key: key || name.trim().toLowerCase(), quality, base: base || name.trim(), spare };
}

/** Lower is shown first in a group: not a backup feed, then quality, then catch-up; the provider's number breaks ties. */
export function variantScore(v: { quality: Quality; archiveDays: number; spare?: boolean }): number {
  return (v.spare ? 100 : 0) + QUALITY_ORDER.indexOf(v.quality) * 2 + (v.archiveDays > 0 ? 0 : 1);
}
