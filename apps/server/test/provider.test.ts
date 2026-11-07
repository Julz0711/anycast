import { parseProviderUrl, type ProviderSettings, type ProviderTestResult, type SourceStatus } from '@anycast/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createMockXtream, login, makeApp } from './helpers';

const CREDS = { username: 'prov-user-4410', password: 'prov-pass-9931' };
let mock: Awaited<ReturnType<typeof createMockXtream>>;

beforeAll(async () => {
  mock = await createMockXtream({ port: 0, size: 'small', ...CREDS });
});
afterAll(async () => {
  await mock.close();
});

describe('parseProviderUrl', () => {
  test('bare hosts, trailing slashes and pasted playlist links', () => {
    expect(parseProviderUrl('provider.tv:8080')).toEqual({ url: 'http://provider.tv:8080' });
    expect(parseProviderUrl(' https://provider.tv/ ')).toEqual({ url: 'https://provider.tv' });
    expect(parseProviderUrl('http://p.tv:80/sub/')).toEqual({ url: 'http://p.tv/sub' });
    expect(parseProviderUrl('http://p.tv:8080/get.php?username=u1&password=p1&type=m3u_plus&output=ts')).toEqual({ url: 'http://p.tv:8080', username: 'u1', password: 'p1' });
    expect(parseProviderUrl('http://p.tv:8080/player_api.php?username=u1')).toEqual({ url: 'http://p.tv:8080', username: 'u1' });
    expect(parseProviderUrl('ftp://p.tv')).toBeNull();
    expect(parseProviderUrl('')).toBeNull();
    expect(parseProviderUrl('http://')).toBeNull();
  });
});

describe('provider login in the app', () => {
  test('an admin enters, tests and saves it; the password is never shown', async () => {
    const built = await makeApp(null);
    const { app, services } = built;
    const cookie = await login(app);
    const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, c = cookie) => app.inject({ method, url, payload, headers: { cookie: c } });

    expect((await req('GET', '/api/source')).json<SourceStatus>().configured).toBe(false);
    expect((await req('GET', '/api/provider')).json<ProviderSettings>()).toMatchObject({ configured: false, origin: null, envSet: false });

    // a viewer can't see or change it
    await services.users.create('viewer', 'viewer-password-1', false);
    const viewer = await login(app, { username: 'viewer', password: 'viewer-password-1' });
    expect((await req('GET', '/api/provider', undefined, viewer)).statusCode).toBe(403);
    expect((await req('PUT', '/api/provider', { url: mock.url, ...CREDS }, viewer)).statusCode).toBe(403);

    // wrong password: test says why, save refuses and stores nothing
    const bad = await req('POST', '/api/provider/test', { url: mock.url, username: CREDS.username, password: 'nope-nope' });
    expect(bad.json<ProviderTestResult>()).toEqual({ ok: false, message: expect.stringContaining('rejected') });
    expect((await req('PUT', '/api/provider', { url: mock.url, username: CREDS.username, password: 'nope-nope' })).statusCode).toBe(400);
    expect(services.source.credentials()).toBeNull();
    // nothing listening there
    const unreachable = await req('POST', '/api/provider/test', { url: 'http://127.0.0.1:9', ...CREDS });
    expect(unreachable.json<ProviderTestResult>()).toEqual({ ok: false, message: expect.stringContaining('reach') });
    // no password and nothing saved
    expect((await req('POST', '/api/provider/test', { url: mock.url, username: CREDS.username })).statusCode).toBe(400);

    const ok = await req('POST', '/api/provider/test', { url: `${mock.url}/`, ...CREDS });
    expect(ok.json<ProviderTestResult>()).toMatchObject({ ok: true, account: { status: expect.any(String) } });

    // a pasted playlist link works as the address
    const saved = await req('PUT', '/api/provider', { url: `${mock.url}/get.php?username=x&password=y&type=m3u_plus`, ...CREDS });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<ProviderSettings>()).toMatchObject({ configured: true, url: mock.url, username: CREDS.username, origin: 'app', envSet: false });
    expect(saved.body).not.toContain(CREDS.password);
    expect((await req('GET', '/api/provider')).body).not.toContain(CREDS.password);
    expect(services.source.credentials()).toEqual({ url: mock.url, ...CREDS });
    const row = services.db.prepare('SELECT credentials FROM source').get() as { credentials: string };
    expect(row.credentials).not.toContain(CREDS.password);

    // saving started a sync with the new login
    await services.sync.syncAll();
    expect((await req('GET', '/api/source')).json<SourceStatus>().counts.live).toBeGreaterThan(0);

    // keeping the password: fine for the same server, refused for another one
    expect((await req('PUT', '/api/provider', { url: mock.url, username: CREDS.username })).statusCode).toBe(200);
    const moved = await req('POST', '/api/provider/test', { url: 'http://other.example:8080', username: CREDS.username });
    expect(moved.statusCode).toBe(400);
    expect(moved.body).toContain('password again');
    await app.close();
  }, 60_000);

  test('.env stays a fallback: an unchanged .env keeps the login from the app, a changed one wins', async () => {
    const envA = { url: 'http://env-a.example:8080', username: 'env-a', password: 'env-a-pass' };
    const first = await makeApp(envA);
    const dataDir = first.services.config.dataDir;
    expect(first.services.source.settings()).toMatchObject({ origin: 'env', envSet: true, url: envA.url });
    first.services.source.save({ url: mock.url, ...CREDS });
    await first.app.close();

    // restart with the same .env: the login from the app stays
    const second = await makeApp(envA, { config: { dataDir } });
    expect(second.services.source.credentials()).toEqual({ url: mock.url, ...CREDS });
    expect(second.services.source.settings().origin).toBe('app');
    await second.app.close();

    // restart without XTREAM_*: still the login from the app
    const third = await makeApp(null, { config: { dataDir } });
    expect(third.services.source.credentials()?.url).toBe(mock.url);
    expect(third.services.source.settings().envSet).toBe(false);
    await third.app.close();

    // .env edited: it wins
    const envB = { ...envA, password: 'env-b-pass' };
    const fourth = await makeApp(envB, { config: { dataDir } });
    expect(fourth.services.source.credentials()).toEqual(envB);
    expect(fourth.services.source.settings().origin).toBe('env');
    await fourth.app.close();
  });
});
