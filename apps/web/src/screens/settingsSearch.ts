/**
 * Settings search: which sections and rows match what the user typed.
 * Every word must start a word (in any order) in the row's text: its name, hint and the names of its choices,
 * so "lock" finds Parental lock but not "clock".
 * A few German and everyday words find the English option too ("Untertitel" finds Subtitles).
 */

/** word (or the start of one, 3+ letters) → English words it stands for */
const SYNONYMS: Record<string, string[]> = {
  // German
  aussehen: ['appearance', 'theme'],
  farbe: ['color', 'accent'],
  akzent: ['accent'],
  dunkel: ['dark', 'black', 'theme'],
  schwarz: ['black'],
  hell: ['dim', 'theme'],
  design: ['theme', 'appearance'],
  schrift: ['font', 'text size'],
  textgröße: ['text size'],
  größe: ['size'],
  dichte: ['density'],
  animation: ['animations', 'motion'],
  bewegung: ['animations', 'motion'],
  gerät: ['device'],
  drehen: ['turn', 'sideways'],
  querformat: ['sideways', 'turn'],
  bild: ['picture', 'artwork'],
  sender: ['channel'],
  kanal: ['channel'],
  programm: ['guide', 'programme'],
  fernsehprogramm: ['guide'],
  epg: ['guide'],
  liste: ['list'],
  favoriten: ['favorite'],
  sprache: ['language'],
  ton: ['audio', 'sound'],
  tonspur: ['audio'],
  untertitel: ['subtitle'],
  wiedergabe: ['player', 'play'],
  abspielen: ['play'],
  nächste: ['next'],
  folge: ['episode'],
  automatisch: ['auto'],
  steuerung: ['controls'],
  ausblenden: ['hide'],
  verstecken: ['hide'],
  puffer: ['buffer'],
  zurückspulen: ['rewind', 'skip back'],
  spulen: ['skip', 'rewind'],
  vorspulen: ['skip forward'],
  überspringen: ['skip'],
  streamen: ['cast', 'stream'],
  fernbedienung: ['remote'],
  handy: ['phone', 'remote'],
  fernseher: ['tv'],
  start: ['start', 'open the app'],
  startseite: ['home'],
  reiter: ['tab'],
  verlauf: ['history'],
  rückblick: ['recap'],
  wischen: ['swipe'],
  filter: ['filter', 'hide'],
  land: ['countr'],
  länder: ['countr'],
  kategorie: ['categor'],
  kinder: ['parental', 'kids'],
  kindersicherung: ['parental'],
  jugendschutz: ['parental'],
  sperre: ['lock', 'pin'],
  profil: ['profile'],
  sicherheit: ['security', 'sign-in', 'sign in'],
  anmelden: ['sign in', 'sign-in', 'login'],
  abmelden: ['sign out'],
  passwort: ['password'],
  kennwort: ['password'],
  konto: ['account'],
  anbieter: ['provider'],
  zugang: ['login', 'provider'],
  quelle: ['source'],
  aktualisieren: ['sync', 'update'],
  sicherung: ['backup'],
  wiederherstellen: ['restore'],
  zurücksetzen: ['reset'],
  version: ['version', 'about'],
  hilfe: ['diagnostics', 'about'],
  fehler: ['diagnostics'],
  speicher: ['space', 'buffer'],
  // everyday English
  colour: ['color'],
  dark: ['theme', 'dark'],
  mode: ['theme', 'mode'],
  language: ['language', 'audio', 'subtitle'],
  captions: ['subtitle'],
  cc: ['subtitle'],
  sound: ['audio'],
  logout: ['sign out'],
  login: ['login', 'sign in'],
  password: ['password'],
  kids: ['parental'],
  pin: ['pin', 'lock'],
  epgs: ['guide'],
  chromecast: ['cast'],
  airplay: ['cast', 'airplay'],
  transcode: ['convert', 'encoding'],
  hardware: ['encoding', 'hardware'],
  gpu: ['encoding', 'hardware'],
  timeshift: ['rewind', 'buffer'],
  catchup: ['archive', 'rewind'],
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const SYN = Object.entries(SYNONYMS).map(([k, v]) => [normalize(k), v.map(normalize)] as const);

/** the words of a query, each with the English words it may also stand for */
export function queryTerms(q: string): string[][] {
  return normalize(q)
    .split(' ')
    .filter(Boolean)
    .map((w) => {
      const alts = new Set([w]);
      if (w.length >= 3) for (const [k, v] of SYN) if (k.startsWith(w) || (w.startsWith(k) && k.length >= 4)) v.forEach((x) => alts.add(x));
      return [...alts];
    });
}

/** true when every word of the query (or a word it stands for) starts a word in the text */
export function matches(text: string, terms: string[][]): boolean {
  if (!terms.length) return true;
  const t = ' ' + normalize(text);
  return terms.every((alts) => alts.some((a) => t.includes(' ' + a)));
}
