import { FINISHED_THRESHOLD, type Episode, type Progress } from '@anycast/shared';
import { expect, test } from 'vitest';
import { continueWatching, isFinished } from '../src/progress';

const ep = (id: string, season: number, episode: number): Episode => ({ id, seriesId: 's1', season, episode, title: id, plot: null, duration: 1200, container: 'mkv' });
const EPISODES = [ep('e3', 2, 1), ep('e1', 1, 1), ep('e2', 1, 2), ep('e4', 2, 2)];
const p = (kind: 'movie' | 'episode', id: string, position: number, updatedAt: number, extra: Partial<Progress> = {}): Progress => ({
  kind, id, position, duration: 1000, finished: isFinished(position, 1000), updatedAt, ...(kind === 'episode' ? { seriesId: 's1' } : {}), ...extra,
});

test('finished threshold', () => {
  expect(isFinished(FINISHED_THRESHOLD * 1000, 1000)).toBe(false);
  expect(isFinished(960, 1000)).toBe(true);
  expect(isFinished(10, 0)).toBe(false);
});

test('movies: unfinished with progress, newest first', () => {
  const r = continueWatching([p('movie', 'a', 100, 1), p('movie', 'b', 990, 3), p('movie', 'c', 200, 2), p('movie', 'd', 0, 4)], () => []);
  expect(r.movies.map((m) => m.id)).toEqual(['c', 'a']);
});

test('series: latest unfinished episode is resumed', () => {
  const r = continueWatching([p('episode', 'e1', 990, 1), p('episode', 'e2', 300, 2)], () => EPISODES);
  expect(r.episodes.map((e) => [e.episode.id, e.progress.position])).toEqual([['e2', 300]]);
});

test('series: after a finished episode comes the next one, across seasons', () => {
  const r = continueWatching([p('episode', 'e1', 990, 1), p('episode', 'e2', 999, 2)], () => EPISODES);
  expect(r.episodes[0]!.episode.id).toBe('e3');
  expect(r.episodes[0]!.progress).toMatchObject({ position: 0, finished: false, updatedAt: 2, seriesId: 's1' });
});

test('series: nothing after the last episode', () => {
  const r = continueWatching([p('episode', 'e4', 999, 5)], () => EPISODES);
  expect(r.episodes).toEqual([]);
});

test('series: next-up skips already finished episodes', () => {
  const r = continueWatching([p('episode', 'e3', 999, 1), p('episode', 'e1', 999, 2)], () => EPISODES);
  expect(r.episodes[0]!.episode.id).toBe('e2');
});
