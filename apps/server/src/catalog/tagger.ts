/**
 * Derives country (ISO 3166-1 alpha-2) and language (ISO 639-1) from provider names such as
 * "DE | ARD HD", "UK: BBC One", "[FR] TF1", "|EN| Sky Sports", "ES ▎ Cine", "🇩🇪 ZDF".
 * Items without their own tag inherit their category's tag (see `tagItem`).
 */

export interface Tag {
  country: string | null;
  language: string | null;
}

export interface TagResult extends Tag {
  /** name with the detected prefix/suffix removed */
  name: string;
  matched: boolean;
}

const t = (country: string | null, language: string | null): Tag => ({ country, language });

/** Upper-case tokens that panels use as region tags. */
const CODES: Record<string, Tag> = {
  DE: t('de', 'de'), GER: t('de', 'de'), DEU: t('de', 'de'), AT: t('at', 'de'), CH: t('ch', 'de'),
  UK: t('gb', 'en'), GB: t('gb', 'en'), US: t('us', 'en'), USA: t('us', 'en'), CA: t('ca', 'en'),
  AU: t('au', 'en'), NZ: t('nz', 'en'), IE: t('ie', 'en'), ZA: t('za', 'en'), NG: t('ng', 'en'),
  EN: t(null, 'en'), ENG: t(null, 'en'),
  FR: t('fr', 'fr'), BE: t('be', 'nl'), NL: t('nl', 'nl'), IT: t('it', 'it'), ES: t('es', 'es'),
  PT: t('pt', 'pt'), BR: t('br', 'pt'), MX: t('mx', 'es'), CO: t('co', 'es'), CL: t('cl', 'es'),
  LAT: t(null, 'es'), LATINO: t(null, 'es'), LATAM: t(null, 'es'),
  AR: t(null, 'ar'), ARA: t(null, 'ar'), ARAB: t(null, 'ar'), ARABIC: t(null, 'ar'),
  PL: t('pl', 'pl'), TR: t('tr', 'tr'), RU: t('ru', 'ru'), UA: t('ua', 'uk'), GR: t('gr', 'el'),
  RO: t('ro', 'ro'), BG: t('bg', 'bg'), HU: t('hu', 'hu'), CZ: t('cz', 'cs'), SK: t('sk', 'sk'),
  SI: t('si', 'sl'), HR: t('hr', 'hr'), RS: t('rs', 'sr'), BA: t('ba', 'bs'), MK: t('mk', 'mk'),
  AL: t('al', 'sq'), ALB: t('al', 'sq'), XK: t('xk', 'sq'), ME: t('me', 'sr'),
  'EX-YU': t(null, 'sr'), EXYU: t(null, 'sr'), YU: t(null, 'sr'),
  SE: t('se', 'sv'), SW: t('se', 'sv'), NO: t('no', 'no'), DK: t('dk', 'da'), FI: t('fi', 'fi'), IS: t('is', 'is'),
  LT: t('lt', 'lt'), LV: t('lv', 'lv'), EE: t('ee', 'et'),
  IN: t('in', 'hi'), PK: t('pk', 'ur'), BD: t('bd', 'bn'), IR: t('ir', 'fa'), AF: t('af', 'ps'),
  IL: t('il', 'he'), CN: t('cn', 'zh'), HK: t('hk', 'zh'), TW: t('tw', 'zh'), JP: t('jp', 'ja'),
  KR: t('kr', 'ko'), TH: t('th', 'th'), VN: t('vn', 'vi'), PH: t('ph', 'tl'), ID: t('id', 'id'), MY: t('my', 'ms'),
  EG: t('eg', 'ar'), MA: t('ma', 'ar'), DZ: t('dz', 'ar'), TN: t('tn', 'ar'), SA: t('sa', 'ar'), AE: t('ae', 'ar'),
  QA: t('qa', 'ar'), KW: t('kw', 'ar'), LB: t('lb', 'ar'), IQ: t('iq', 'ar'), SY: t('sy', 'ar'), JO: t('jo', 'ar'),
  KU: t(null, 'ku'), KURD: t(null, 'ku'), AM: t('am', 'hy'), GE: t('ge', 'ka'), AZ: t('az', 'az'),
};

/** Full names, matched case-insensitively as whole words (category names only). */
const NAMES: [RegExp, Tag][] = [
  [/\b(germany|german|deutschland|deutsch)\b/i, t('de', 'de')],
  [/\b(austria|österreich)\b/i, t('at', 'de')],
  [/\b(switzerland|schweiz|suisse)\b/i, t('ch', 'de')],
  [/\b(united kingdom|britain|british)\b/i, t('gb', 'en')],
  [/\b(united states|american)\b/i, t('us', 'en')],
  [/\b(english)\b/i, t(null, 'en')],
  [/\b(france|french|française?)\b/i, t('fr', 'fr')],
  [/\b(netherlands|holland|dutch|nederland)\b/i, t('nl', 'nl')],
  [/\b(italy|italia|italian|italiano)\b/i, t('it', 'it')],
  [/\b(spain|españa|espana|spanish|español)\b/i, t('es', 'es')],
  [/\b(latino|latin america|latam)\b/i, t(null, 'es')],
  [/\b(portugal|portuguese|português)\b/i, t('pt', 'pt')],
  [/\b(brazil|brasil)\b/i, t('br', 'pt')],
  [/\b(poland|polska|polish)\b/i, t('pl', 'pl')],
  [/\b(turkey|türkiye|turkish|türk)\b/i, t('tr', 'tr')],
  [/\b(arabic|arab|arabia)\b/i, t(null, 'ar')],
  [/\b(russia|russian)\b/i, t('ru', 'ru')],
  [/\b(ukraine|ukrainian)\b/i, t('ua', 'uk')],
  [/\b(greece|greek)\b/i, t('gr', 'el')],
  [/\b(romania|romanian)\b/i, t('ro', 'ro')],
  [/\b(bulgaria|bulgarian)\b/i, t('bg', 'bg')],
  [/\b(hungary|hungarian|magyar)\b/i, t('hu', 'hu')],
  [/\b(czech)\b/i, t('cz', 'cs')],
  [/\b(albania|albanian|shqip)\b/i, t('al', 'sq')],
  [/\b(ex-?yu|yugoslavia|balkan)\b/i, t(null, 'sr')],
  [/\b(sweden|swedish|sverige)\b/i, t('se', 'sv')],
  [/\b(norway|norwegian|norge)\b/i, t('no', 'no')],
  [/\b(denmark|danish|danmark)\b/i, t('dk', 'da')],
  [/\b(finland|finnish|suomi)\b/i, t('fi', 'fi')],
  [/\b(india|indian|hindi)\b/i, t('in', 'hi')],
  [/\b(pakistan|urdu)\b/i, t('pk', 'ur')],
  [/\b(iran|persian|farsi)\b/i, t('ir', 'fa')],
  [/\b(kurdish|kurdistan)\b/i, t(null, 'ku')],
  [/\b(canada|canadian)\b/i, t('ca', 'en')],
  [/\b(australia|australian)\b/i, t('au', 'en')],
  [/\b(new zealand)\b/i, t('nz', 'en')],
  [/\b(ireland|irish)\b/i, t('ie', 'en')],
  [/\b(belgium|belgian|belgique)\b/i, t('be', null)],
  [/\b(luxembourg)\b/i, t('lu', null)],
  [/\b(mexico|méxico|mexican)\b/i, t('mx', 'es')],
  [/\b(japan|japanese)\b/i, t('jp', 'ja')],
  [/\b(korea|korean)\b/i, t('kr', 'ko')],
  [/\b(china|chinese)\b/i, t('cn', 'zh')],
  [/\b(philippines|filipino)\b/i, t('ph', null)],
];

/**
 * Manual overrides, checked first: names that the generic rules get wrong.
 * Extend this list rather than special-casing the rules.
 */
const TAG_OVERRIDES: [RegExp, Tag][] = [
  [/^\s*(VIP|PPV|4K|UHD|SPORTS?|NETFLIX|XXX|ADULT)\b/i, t(null, null)],
];

const SEPARATORS = '|:\\-–—▎▍▌▏│┃●•·★✪»/';
const PREFIX_RE = new RegExp(
  `^\\s*([\\[(|{]?)\\s*([A-Za-z]{2,6}(?:-[A-Za-z]{2,3})?)\\s*([\\])|}]?)\\s*([${SEPARATORS}]*)\\s*`,
);
const SUFFIX_RE = new RegExp(`\\s*(?:[\\[(|]\\s*([A-Z]{2,6}(?:-[A-Z]{2})?)\\s*[\\])|]|[${SEPARATORS}]\\s*([A-Z]{2,6}))\\s*$`);
const FLAG_RE = /^\s*([\u{1F1E6}-\u{1F1FF}]{2})\s*[|:\-–—]?\s*/u;
const ADULT_RE = /\b(xxx|adult|adults|18\+|for adults)\b|18\+/i;

function lookup(code: string): Tag | null {
  return CODES[code] ?? null;
}

function fromFlag(flag: string): Tag | null {
  const letters = [...flag].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join('');
  if (letters === 'GB') return t('gb', 'en');
  const known = lookup(letters);
  return known?.country ? known : t(letters.toLowerCase(), null);
}

/** Decorative provider separators ("UEFA▌ CHAMPIONS LEAGUE", "SPORTS ● REPLAY") read as a middle dot. */
const DECOR_SEP_RE = /\s*[▎▍▌▏│┃●•★✪]+\s*/gu;
export function tidyName(name: string): string {
  return name.replace(DECOR_SEP_RE, ' · ').replace(/^ · | · $/g, '').trim() || name;
}

/** Tag from the name's own prefix/suffix; `matched` is false when the name carries no tag. */
export function parseName(raw: string): TagResult {
  const r = parseTag(raw);
  return { ...r, name: tidyName(r.name) };
}

function parseTag(raw: string): TagResult {
  const name = raw.trim();
  for (const [re, tag] of TAG_OVERRIDES) {
    if (re.test(name)) return { ...tag, name, matched: true };
  }
  const flag = FLAG_RE.exec(name);
  if (flag) {
    const tag = fromFlag(flag[1]!);
    if (tag) return { ...tag, name: name.slice(flag[0].length).trim() || name, matched: true };
  }
  const m = PREFIX_RE.exec(name);
  if (m) {
    const [whole, open, code, close, sep] = m;
    const tag = code === code!.toUpperCase() ? lookup(code!) : null;
    const rest = name.slice(whole!.length).trim();
    const delimited = (open && close) || sep || close === '|';
    if (tag && (delimited || !rest)) return { ...tag, name: rest || name, matched: true };
  }
  const s = SUFFIX_RE.exec(name);
  if (s) {
    const tag = lookup((s[1] ?? s[2])!);
    const rest = name.slice(0, s.index).trim();
    if (tag && rest) return { ...tag, name: rest, matched: true };
  }
  return { country: null, language: null, name, matched: false };
}

/** Category names additionally match full country/language names anywhere ("GERMANY SPORTS"). */
export function tagCategory(raw: string): TagResult & { adult: boolean } {
  const adult = ADULT_RE.test(raw);
  const own = parseName(raw);
  if (own.matched) return { ...own, adult };
  // categories are tag-heavy: a bare leading code counts too ("UK ENTERTAINMENT")
  const bare = /^\s*([A-Z]{2,6}(?:-[A-Z]{2})?)\s+(\S.*)$/.exec(raw);
  const bareTag = bare ? lookup(bare[1]!) : null;
  if (bare && bareTag) return { ...bareTag, name: tidyName(bare[2]!.trim()), matched: true, adult };
  for (const [re, tag] of NAMES) {
    if (re.test(raw)) return { ...tag, name: own.name, matched: true, adult };
  }
  return { ...own, adult };
}

/** Item tag: its own prefix/suffix wins, otherwise it inherits the category's tag. */
export function tagItem(raw: string, category: Tag | null): TagResult {
  const own = parseName(raw);
  if (own.matched || !category) return own;
  return { ...own, country: category.country, language: category.language };
}
