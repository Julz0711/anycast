/**
 * Casting to a Chromecast, with a stand-in for Google's Cast SDK (no real TV in CI). The stand-in
 * records what the app asks the TV to play; the test then opens that link the way a TV would,
 * without the session cookie.
 */
import { request, type Page } from '@playwright/test';
import { expect, expectPlaying, fx, test } from './fixtures';

declare global {
  interface Window {
    __fakeCast: { loads: { url: string; contentType: string; streamType: string; currentTime?: number; title: string; hls?: string }[] };
  }
}

/** A Chromecast called "Living Room TV" is on the network; requestSession connects to it. */
const FAKE_SDK = `(() => {
  const ctxListeners = {}; const ctlListeners = [];
  let state = 'NOT_CONNECTED'; let session = null;
  const player = { isPaused: false, currentTime: 0, duration: 0, playerState: 'IDLE' };
  const fire = (t, e) => (ctxListeners[t] || []).forEach((f) => f(e));
  const changed = () => ctlListeners.forEach((f) => f({}));
  window.__fakeCast = { loads: [] };
  const media = {
    MediaInfo: function (url, ct) { this.contentId = url; this.contentType = ct; },
    StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
    HlsSegmentFormat: { FMP4: 'fmp4', TS: 'ts' },
    HlsVideoSegmentFormat: { FMP4: 'fmp4', MPEG2_TS: 'mpeg2_ts' },
    GenericMediaMetadata: function () {},
    LoadRequest: function (info) { this.media = info; },
    DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
  };
  window.chrome = window.chrome || {};
  window.chrome.cast = { media, AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' }, Image: function (u) { this.url = u; } };
  const makeSession = () => ({
    getCastDevice: () => ({ friendlyName: 'Living Room TV' }),
    getMediaSession: () => ({ idleReason: null }),
    loadMedia: async (req) => {
      window.__fakeCast.loads.push({ url: req.media.contentId, contentType: req.media.contentType, streamType: req.media.streamType, currentTime: req.currentTime, title: req.media.metadata.title, hls: req.media.hlsSegmentFormat });
      Object.assign(player, { playerState: 'PLAYING', isPaused: false, currentTime: req.currentTime || 0 });
      changed();
    },
  });
  const ctx = {
    setOptions() {},
    getCastState: () => state,
    addEventListener(t, f) { (ctxListeners[t] = ctxListeners[t] || []).push(f); },
    getCurrentSession: () => session,
    requestSession: async () => {
      state = 'CONNECTED'; session = makeSession();
      fire('caststatechanged', { castState: state }); fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
    },
    endCurrentSession() {
      state = 'NOT_CONNECTED'; session = null;
      Object.assign(player, { playerState: 'IDLE', currentTime: 0 });
      fire('caststatechanged', { castState: state }); fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    },
  };
  window.cast = { framework: {
    CastContext: { getInstance: () => ctx },
    CastContextEventType: { CAST_STATE_CHANGED: 'caststatechanged', SESSION_STATE_CHANGED: 'sessionstatechanged' },
    RemotePlayer: function () { return player; },
    RemotePlayerController: function () { return {
      addEventListener(t, f) { ctlListeners.push(f); },
      playOrPause() { player.isPaused = !player.isPaused; player.playerState = player.isPaused ? 'PAUSED' : 'PLAYING'; changed(); },
      seek() { changed(); },
      stop() { player.playerState = 'IDLE'; changed(); },
    }; },
    RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
  } };
  setTimeout(() => window.__onGCastApiAvailable && window.__onGCastApiAvailable(true), 0);
})();`;

async function withFakeCast(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { chrome?: object }).chrome ??= {};
  });
  await page.route('https://www.gstatic.com/cv/js/sender/**', (route) => route.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }));
}

const loads = (page: Page) => page.evaluate(() => window.__fakeCast.loads);

test('Chromecast: the TV plays the channel through a cookieless link, zaps with the phone, and hands back', async ({ profile }) => {
  test.setTimeout(120_000);
  const page = await profile.device();
  await withFakeCast(page);
  const [first, second] = fx.zapChannels as [string, string];
  await page.goto(`/play/live/${first}`);
  await expectPlaying(page);

  await page.getByRole('button', { name: 'Cast to TV' }).click();
  const overlay = page.getByTestId('cast-overlay');
  await expect(overlay).toContainText('Living Room TV');
  await expect.poll(async () => (await loads(page)).length).toBe(1);
  const [load] = await loads(page);
  expect(load).toMatchObject({ contentType: 'application/x-mpegURL', streamType: 'LIVE', hls: 'fmp4' });
  expect(load!.url).toMatch(new RegExp(`/cast/[A-Za-z0-9_-]{43}/api/stream/live/${first}/remux/index\\.m3u8$`));
  // this device stopped playing: the TV has the stream
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused || !v.currentSrc)).toBe(true);

  // the TV opens the link with no cookie
  const tv = await request.newContext();
  const pl = await tv.get(load!.url);
  expect(pl.status()).toBe(200);
  expect(pl.headers()['access-control-allow-origin']).toBe('*');
  const text = await pl.text();
  expect(text).toContain('#EXTM3U');
  // the playlist names its segments relative to itself, so they keep the token
  const segment = text.split('\n').find((l) => l && !l.startsWith('#'))!;
  expect((await tv.get(new URL(segment, load!.url).href)).status()).toBe(200);
  // but it opens nothing else
  expect((await tv.get(load!.url.replace(`/live/${first}/`, `/live/${second}/`))).status()).toBe(401);

  // zapping on the phone changes the channel on the TV
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(new RegExp(`/play/live/${second}$`));
  await expect.poll(async () => (await loads(page)).at(-1)?.url ?? '').toContain(`/api/stream/live/${second}/`);
  await expect(overlay).toContainText('Living Room TV');

  // stop casting: the phone plays again
  await overlay.getByRole('button', { name: 'Stop casting' }).click();
  await expect(overlay).toHaveCount(0);
  await expectPlaying(page);
  await tv.dispose();
});

test('Chromecast: a movie continues on the TV from where it was', async ({ profile }) => {
  const page = await profile.device();
  await withFakeCast(page);
  await page.goto(`/play/movie/${fx.movie.id}?start=0`);
  await expectPlaying(page);
  await page.locator('video').evaluate((v: HTMLVideoElement) => (v.currentTime = 42));
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(42);

  await page.getByRole('button', { name: 'Cast to TV' }).click();
  await expect.poll(async () => (await loads(page)).length).toBe(1);
  const [load] = await loads(page);
  expect(load).toMatchObject({ contentType: 'video/mp4', streamType: 'BUFFERED', title: fx.movie.name });
  expect(load!.currentTime).toBeGreaterThanOrEqual(42);
  expect(load!.url).toContain(`/api/stream/movie/${fx.movie.id}/video.mp4`);

  // the play button controls the TV
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('cast-overlay')).toContainText('Paused');
});
