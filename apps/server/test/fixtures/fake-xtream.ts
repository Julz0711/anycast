/**
 * Hand-written Xtream fixture server with real-panel quirks (numbers as strings, `[]` for empty
 * objects, episodes keyed by season) and a configurable catalog size for speed tests.
 */
import Fastify from 'fastify';

export const FAKE = { username: 'fixture-user', password: 'fixture-pass' };

const PREFIXES = ['DE | ', 'UK: ', '[FR] ', '|EN| ', 'NL - ', 'ES ▎ ', 'PL ● ', 'AR | ', 'IT: ', 'TR - '];

export async function startFakeXtream(size: { live: number; movies: number; series: number }) {
  const app = Fastify();
  const catName = (i: number, kind: string) => `${PREFIXES[i % PREFIXES.length]}${kind} ${i}`;
  const cats = (kind: string, offset: number) =>
    Array.from({ length: 20 }, (_, i) => ({ category_id: String(offset + i), category_name: catName(i, kind), parent_id: 0 }));
  const words = ['Café', 'Crème', 'Night', 'River', 'Señor', 'Über', 'Garden', 'Signal', 'Winter', 'Echo'];
  const title = (i: number) => `${words[i % 10]} ${words[(i * 7) % 10]} ${i}`;

  app.get('/player_api.php', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.username !== FAKE.username || q.password !== FAKE.password) return reply.code(403).send('');
    reply.type('text/html'); // some panels mislabel JSON
    switch (q.action) {
      case undefined:
        return JSON.stringify({
          user_info: { username: FAKE.username, auth: 1, status: 'Active', exp_date: '1900000000', is_trial: '0', active_cons: '0', max_connections: '2' },
          server_info: { timezone: 'Europe/Berlin', timestamp_now: Math.floor(Date.now() / 1000) },
        });
      case 'get_live_categories': return JSON.stringify(cats('TV', 1));
      case 'get_vod_categories': return JSON.stringify(cats('FILMS', 100));
      case 'get_series_categories': return JSON.stringify([]); // empty is fine; series point at unknown categories
      case 'get_live_streams':
        return JSON.stringify(
          Array.from({ length: size.live }, (_, i) => ({
            num: String(i + 1), name: `${PREFIXES[i % 10]}${title(i)} HD`, stream_id: String(i + 1), stream_icon: '',
            epg_channel_id: i % 5 ? `ch${i}.fx` : null, category_id: String(1 + (i % 20)), tv_archive: i % 2, tv_archive_duration: String(i % 8),
          })),
        );
      case 'get_vod_streams':
        return JSON.stringify(
          Array.from({ length: size.movies }, (_, i) => ({
            num: i + 1, name: `${title(i)} (${1990 + (i % 30)})`, stream_id: 100000 + i, stream_icon: null, rating: i % 3 ? String(5 + (i % 5)) : '',
            category_id: String(100 + (i % 20)), container_extension: i % 2 ? 'mkv' : 'mp4', added: String(1600000000 + i),
          })),
        );
      case 'get_series':
        return JSON.stringify(
          Array.from({ length: size.series }, (_, i) => ({
            num: i + 1, name: `${PREFIXES[i % 10]}${title(i)}`, series_id: 1 + i, cover: '', plot: 'Plot', releaseDate: '2019-05-01',
            last_modified: String(1600000000 + i), rating: '7.5', category_id: '900',
          })),
        );
      case 'get_series_info':
        return JSON.stringify({
          info: { name: 'x', plot: 'p' },
          seasons: [],
          episodes: {
            '1': [
              { id: `${q.series_id}01`, episode_num: '1', title: 'Pilot', container_extension: 'mkv', info: { duration_secs: '1500' } },
              { id: `${q.series_id}02`, episode_num: 2, title: 'Second', container_extension: 'mkv', info: [] },
            ],
            '2': { '0': { id: `${q.series_id}03`, episode_num: '1', title: 'Return', container_extension: 'mp4', season: '2', info: { duration: '00:45:00' } } },
          },
        });
      default:
        return '[]';
    }
  });

  app.get('/xmltv.php', async (_req, reply) => {
    const now = Date.now();
    const fmt = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    let xml = '<?xml version="1.0" encoding="UTF-8"?><tv>';
    for (let c = 1; c < Math.min(size.live, 200); c += 5) {
      for (let h = -3; h < 3; h++) {
        const s = Math.floor(now / 3600_000) * 3600_000 + h * 3600_000;
        xml += `<programme start="${fmt(s)}" stop="${fmt(s + 3600_000)}" channel="ch${c}.fx"><title lang="en">Show ${c}/${h} &amp; more</title><desc>About &lt;it&gt;</desc></programme>`;
      }
    }
    reply.type('application/xml');
    return xml + '</tv>';
  });

  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url, close: () => app.close() };
}
