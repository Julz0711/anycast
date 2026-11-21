import { describe, expect, test } from 'vitest';
import { FootballFixtures, homeKey, parseMatches, withMatch, type Fixture } from '../src/football';

const at = (iso: string) => Date.parse(iso);
const fx = (kickoff: string, home: string, homeShort: string, away: string, awayShort: string): Fixture => ({ kickoff: at(kickoff), home, homeShort, away, awayShort });

const SATURDAY: Fixture[] = [
  fx('2026-11-21T14:30:00Z', 'Bayer 04 Leverkusen', 'Leverkusen', 'FC Bayern München', 'Bayern'),
  fx('2026-11-21T14:30:00Z', 'Borussia Dortmund', 'Dortmund', 'SC Freiburg', 'Freiburg'),
  fx('2026-11-21T14:30:00Z', 'TSG Hoffenheim', 'Hoffenheim', 'Werder Bremen', 'Bremen'),
  fx('2026-11-21T14:30:00Z', 'Hertha BSC', 'Hertha', 'Hamburger SV', 'HSV'),
  fx('2026-11-21T17:30:00Z', 'FC St. Pauli', 'St. Pauli', 'VfB Stuttgart', 'Stuttgart'),
];
const prog = (title: string, description: string | null, start: string) => ({ channelId: 'c1', title, description, start: at(start), end: at(start) + 2.25 * 3600_000 });

describe('football fixtures', () => {
  test('the ground in the description names the home side', () => {
    expect(homeKey('Aus der BayArena in Leverkusen, Deutschland.')).toBe('leverkusen');
    expect(homeKey('Aus der PreZero Arena in Sinsheim, Deutschland.')).toBe('hoffenheim');
    expect(homeKey('Aus dem Olympiastadion in Berlin, Deutschland.')).toBe('hertha');
    expect(homeKey('Aus dem Millerntor-Stadion in Hamburg, Deutschland.')).toBe('pauli');
    expect(homeKey('Aus dem Signal Iduna Park in Dortmund')).toBe('dortmund');
    expect(homeKey('Alle Spiele, alle Tore.')).toBeNull();
    expect(homeKey(null)).toBeNull();
  });

  test('"BL" gets the match that kicks off at that ground', () => {
    expect(withMatch(prog('BL', 'Aus der BayArena in Leverkusen, Deutschland.', '2026-11-21T14:15:00Z'), SATURDAY).title).toBe('BL: Leverkusen – Bayern');
    expect(withMatch(prog('BL', 'Aus der PreZero Arena in Sinsheim, Deutschland.', '2026-11-21T14:15:00Z'), SATURDAY).title).toBe('BL: Hoffenheim – Bremen');
    expect(withMatch(prog('BL', 'Aus dem Olympiastadion in Berlin, Deutschland.', '2026-11-21T14:15:00Z'), SATURDAY).title).toBe('BL: Hertha – HSV');
  });

  test('unsure stays unchanged: other time, no ground, already named', () => {
    const p = prog('BL', 'Aus der BayArena in Leverkusen, Deutschland.', '2026-11-21T17:15:00Z');
    expect(withMatch(p, SATURDAY)).toBe(p);
    const q = prog('BL: NEO.bet Countdown', 'Die Vorberichte.', '2026-11-21T14:00:00Z');
    expect(withMatch(q, SATURDAY)).toBe(q);
    const r = prog('Leverkusen - Bayern', 'Aus der BayArena in Leverkusen.', '2026-11-21T14:15:00Z');
    expect(withMatch(r, SATURDAY)).toBe(r);
  });

  test('parses OpenLigaDB matches', () => {
    const list = parseMatches([
      { matchDateTimeUTC: '2026-11-21T14:30:00Z', team1: { teamName: 'Bayer 04 Leverkusen', shortName: 'Leverkusen' }, team2: { teamName: 'FC Bayern München', shortName: '' } },
      { matchDateTimeUTC: '2026-11-21T14:30:00', team1: { teamName: 'A' }, team2: { teamName: 'B', shortName: 'Bee' } },
      { team1: { teamName: 'no date' } },
    ]);
    expect(list).toEqual([
      { kickoff: at('2026-11-21T14:30:00Z'), home: 'Bayer 04 Leverkusen', homeShort: 'Leverkusen', away: 'FC Bayern München', awayShort: 'FC Bayern München' },
      { kickoff: at('2026-11-21T14:30:00Z'), home: 'A', homeShort: 'A', away: 'B', awayShort: 'Bee' },
    ]);
    expect(parseMatches({ error: 1 })).toEqual([]);
  });

  test('fetches in the background and keeps a failed league from spoiling the rest', async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/dfb')) return new Response('nope', { status: 500 });
      if (url.endsWith('/bl1'))
        return Response.json([{ matchDateTimeUTC: '2026-11-21T14:30:00Z', team1: { teamName: 'Bayer 04 Leverkusen', shortName: 'Leverkusen' }, team2: { teamName: 'FC Bayern München', shortName: 'Bayern' } }]);
      return Response.json([]);
    }) as typeof fetch;
    const f = new FootballFixtures('http://oldb', fetcher);
    const p = prog('BL', 'Aus der BayArena in Leverkusen, Deutschland.', '2026-11-21T14:15:00Z');
    expect(f.annotate(p).title).toBe('BL'); // first call starts the fetch
    await f.refresh();
    expect(urls.sort()).toEqual(['http://oldb/getmatchdata/bl1', 'http://oldb/getmatchdata/bl2', 'http://oldb/getmatchdata/dfb']);
    expect(f.annotate(p).title).toBe('BL: Leverkusen – Bayern');
  });
});
