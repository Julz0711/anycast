/**
 * Audio and subtitle tracks (PB-3) on the mock's multi-track MKV (German + English audio and
 * subtitles): English audio and no subtitles by default, then, with the keyboard, German audio
 * (the server restarts the stream with that track, playback goes on where it was) and English
 * subtitles on, shown at the right times. The choice is remembered for the movie.
 */
import type { Page } from '@playwright/test';
import { currentTime, expect, expectPlaying, fx, test, video } from './fixtures';

/** The subtitle track the video shows and the text of its cue on screen now, with the cue's start. */
const showing = (page: Page) =>
  video(page).evaluate((v: HTMLVideoElement) => {
    const t = Array.from(v.textTracks).find((x) => x.mode === 'showing');
    const cue = t?.activeCues?.[0] as VTTCue | undefined;
    return { track: t ? t.language || t.label : null, text: cue?.text ?? null, start: cue?.startTime ?? null, now: v.currentTime };
  });

test('switch the audio track and turn subtitles on with the keyboard; the choice is kept for the movie', async ({ profile }) => {
  test.setTimeout(120_000);
  const page = await profile.device();
  const streams: string[] = [];
  page.on('request', (r) => {
    if (/\/api\/stream\/movie\/[^/]+\/[\w-]+\/(?:a\d+\/)?master\.m3u8$/.test(r.url())) streams.push(new URL(r.url()).pathname);
  });
  await page.goto(`/play/movie/${fx.tracksMovie.id}`);
  await expectPlaying(page);
  // English audio by default (preferences), so the stream maps the second track
  expect(streams.at(-1)).toMatch(/\/a1\/master\.m3u8$/);

  const button = page.getByRole('button', { name: 'Audio & subtitles' });
  await button.click();
  const menu = page.getByRole('dialog', { name: 'Audio and subtitles' });
  const audio = menu.getByRole('radiogroup', { name: 'Audio' });
  const subs = menu.getByRole('radiogroup', { name: 'Subtitles' });
  await expect(audio.getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
  await expect(audio.getByRole('radio', { name: /German/ })).toHaveAttribute('aria-checked', 'false');
  await expect(subs.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
  // the checked audio track has focus
  await expect(audio.getByRole('radio', { name: /English/ })).toBeFocused();

  // German audio: up, Enter. Playback continues near where it was, from the first audio track's stream
  await video(page).evaluate((v: HTMLVideoElement) => (v.currentTime = 40));
  await expect.poll(() => currentTime(page)).toBeGreaterThan(40);
  await audio.getByRole('radio', { name: /English/ }).focus();
  await page.keyboard.press('ArrowUp');
  await expect(audio.getByRole('radio', { name: /German/ })).toBeFocused();
  const before = await currentTime(page);
  await page.keyboard.press('Enter');
  await expect(audio.getByRole('radio', { name: /German/ })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => streams.at(-1)).toMatch(/\/transcode-audio\/master\.m3u8$/);
  await expectPlaying(page);
  expect(await currentTime(page)).toBeGreaterThan(before - 8);

  // English subtitles: right (to "Off"), down twice (German, English), Enter
  await audio.getByRole('radio', { name: /German/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(subs.getByRole('radio', { name: 'Off' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(subs.getByRole('radio', { name: /English/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(subs.getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // the mock's cues run 4 s every 10 s and say their own time: "Subtitle 00:01:10"
  await expect
    .poll(async () => (await showing(page)).text, { timeout: 30_000, message: 'an English cue should be on screen' })
    .toMatch(/^Subtitle \d\d:\d\d:\d0$/);
  const s = await showing(page);
  expect(s.track).toBe('en');
  const [, h, m, sec] = /(\d\d):(\d\d):(\d\d)$/.exec(s.text!)!;
  const labelled = Number(h) * 3600 + Number(m) * 60 + Number(sec);
  // shown at its true time: the cue starts at the time it names, and the playhead is inside it
  expect(Math.abs(s.start! - labelled)).toBeLessThan(0.75);
  expect(s.now).toBeGreaterThanOrEqual(labelled - 0.75);
  expect(s.now).toBeLessThan(labelled + 4.75);

  // opening the movie again starts with German audio and English subtitles
  await page.goto(`/play/movie/${fx.tracksMovie.id}`);
  await expectPlaying(page);
  expect(streams.at(-1)).toMatch(/\/transcode-audio\/master\.m3u8$/);
  await button.click();
  await expect(audio.getByRole('radio', { name: /German/ })).toHaveAttribute('aria-checked', 'true');
  await expect(subs.getByRole('radio', { name: /English/ })).toHaveAttribute('aria-checked', 'true');
});
