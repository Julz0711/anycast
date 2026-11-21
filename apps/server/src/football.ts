/**
 * Bundesliga match names for guide entries that only say "BL".
 *
 * Event channels (Sky Sport Bundesliga 1-10) often carry a guide entry titled "BL" or "2. BL" whose
 * description names only the ground: "Aus der BayArena in Leverkusen, Deutschland." The ground
 * gives the home side; the fixture list (OpenLigaDB, free, no key) gives who they play at that
 * time. Such entries are renamed "BL: Leverkusen – Bayern". Anything unsure stays as it was.
 */
import type { EpgProgram } from '@anycast/shared';

export interface Fixture {
  kickoff: number;
  home: string;
  away: string;
  homeShort: string;
  awayShort: string;
}

/** "Aus der BayArena in Leverkusen, Deutschland." / "Aus dem Deutsche Bank Park, Frankfurt, Deutschland." -> ground, town */
const VENUE = /\b(?:aus|live aus|im|in)\s+(?:dem|der|den)\s+(.+?)(?:\s+in\s+|\s*,\s*)([\p{L}][\p{L}.\- ]*?)\s*(?:[,.(]|$)/iu;

/** grounds whose town alone would be wrong or unclear -> a word of the home side's name */
const GROUNDS: [string, string][] = [
  ['alten forsterei', 'union'],
  ['olympiastadion', 'hertha'],
  ['millerntor', 'pauli'],
  ['volkspark', 'hamburger'],
  ['grunwalder', '1860'],
  ['allianz arena', 'bayern'],
];
/** towns that aren't in the club's name */
const TOWNS: Record<string, string> = { sinsheim: 'hoffenheim', zuzenhausen: 'hoffenheim', gelsenkirchen: 'schalke', 'spiesen-elversberg': 'elversberg', sandhausen: 'sandhausen' };

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').trim();

/** The word to look for in the home side's name, from a programme description; null when it names no ground. */
export function homeKey(description: string | null | undefined): string | null {
  const m = description ? VENUE.exec(description) : null;
  if (!m) return null;
  const ground = norm(m[1]!);
  const town = norm(m[2]!);
  for (const [g, key] of GROUNDS) if (ground.includes(g) && !(g === 'olympiastadion' && town !== 'berlin')) return key;
  if (TOWNS[town]) return TOWNS[town]!;
  // "Frankfurt am Main", "Freiburg im Breisgau", "Mülheim an der Ruhr": the club goes by the first word
  const first = /^(\S{4,})\s+(am|im|an|in|ob|bei|vor)\b/.exec(town)?.[1];
  return first && first !== 'bad' ? first : town;
}

/** kickoff from this long before the programme starts ... */
const BEFORE_MS = 20 * 60_000;
/** ... to this long after (pre-match shows start 15-90 min early) */
const AFTER_MS = 105 * 60_000;

/** The fixture a programme shows, or null when unsure. */
export function findFixture(p: Pick<EpgProgram, 'description' | 'start'>, fixtures: Fixture[]): Fixture | null {
  const key = homeKey(p.description);
  if (!key) return null;
  const hits = fixtures.filter(
    (f) => f.kickoff >= p.start - BEFORE_MS && f.kickoff <= p.start + AFTER_MS && (norm(f.home).includes(key) || norm(f.homeShort).includes(key)),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/** "BL" -> "BL: Leverkusen – Bayern"; unchanged when no fixture fits */
export function withMatch<P extends EpgProgram>(p: P, fixtures: Fixture[]): P {
  if (!fixtures.length || !p.description) return p;
  const f = findFixture(p, fixtures);
  if (!f) return p;
  const match = `${f.homeShort} – ${f.awayShort}`;
  if (p.title.includes(f.homeShort)) return p;
  return { ...p, title: `${p.title}: ${match}` };
}

interface OldbTeam { teamName?: string; shortName?: string }
interface OldbMatch { matchDateTimeUTC?: string; team1?: OldbTeam; team2?: OldbTeam }

const short = (t: OldbTeam) => t.shortName?.trim() || t.teamName?.trim() || '?';

export function parseMatches(json: unknown): Fixture[] {
  if (!Array.isArray(json)) return [];
  const out: Fixture[] = [];
  for (const m of json as OldbMatch[]) {
    const iso = m?.matchDateTimeUTC;
    if (!iso || !m.team1?.teamName || !m.team2?.teamName) continue;
    const kickoff = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (!Number.isFinite(kickoff)) continue;
    out.push({ kickoff, home: m.team1.teamName, away: m.team2.teamName, homeShort: short(m.team1), awayShort: short(m.team2) });
  }
  return out;
}

const LEAGUES = ['bl1', 'bl2', 'dfb'];
const FRESH_MS = 3 * 3600_000;
const RETRY_MS = 15 * 60_000;

/** Current Bundesliga, 2. Bundesliga and DFB-Pokal fixtures, fetched in the background and kept 3 h. */
export class FootballFixtures {
  private fixtures: Fixture[] = [];
  private nextLoad = 0;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly base = 'https://api.openligadb.de',
    private readonly fetcher: typeof fetch = fetch,
    private readonly warn: (msg: string) => void = () => undefined,
  ) {}

  /** Renames programmes that show a known match; starts a fetch when the list is old (this call doesn't wait for it). */
  annotate<P extends EpgProgram>(p: P): P;
  annotate<P extends EpgProgram>(p: P | null): P | null;
  annotate<P extends EpgProgram>(p: P | null): P | null {
    if (!p) return p;
    this.refresh();
    return withMatch(p, this.fixtures);
  }

  refresh(now = Date.now()): Promise<void> {
    if (this.loading || now < this.nextLoad) return this.loading ?? Promise.resolve();
    this.nextLoad = now + RETRY_MS;
    this.loading = (async () => {
      try {
        const lists = await Promise.allSettled(
          LEAGUES.map(async (l) => {
            const res = await this.fetcher(`${this.base}/getmatchdata/${l}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'user-agent': 'AnyCast/0.1' } });
            if (!res.ok) throw new Error(`${l}: HTTP ${res.status}`);
            return parseMatches(await res.json());
          }),
        );
        const failed = lists.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed.length === lists.length) throw failed[0]!.reason;
        this.fixtures = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
        this.nextLoad = Date.now() + (failed.length ? RETRY_MS : FRESH_MS);
      } catch (err) {
        this.warn(`football fixtures: ${(err as Error).message}`);
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }
}
