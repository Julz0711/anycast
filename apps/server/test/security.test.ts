import type { DeviceCodeStart, SecurityStatus } from '@anycast/shared';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isHomeAddress } from '../src/auth/net';
import { SignInGuard, IP_MAX } from '../src/auth/guard';
import { trustProxyFromEnv } from '../src/config';
import { ADMIN, login, makeApp } from './helpers';

const OUTSIDE = '203.0.113.9';

describe('home or internet', () => {
  test.each([
    ['192.168.0.12', true], ['10.1.2.3', true], ['172.20.0.1', true], ['100.120.236.127', true], ['127.0.0.1', true],
    ['::1', true], ['::ffff:192.168.0.5', true], ['fd7a:115c:a1e0::1', true], ['fe80::1%eth0', true],
    ['203.0.113.9', false], ['8.8.8.8', false], ['172.32.0.1', false], ['100.128.0.1', false], ['2a02:8070::1', false], ['::ffff:8.8.8.8', false], ['', false],
  ])('%s → home %s', (ip, home) => expect(isHomeAddress(ip)).toBe(home));

  test('TRUST_PROXY=true trusts one proxy, not every X-Forwarded-For entry', () => {
    expect(trustProxyFromEnv('true')).toBe(1);
    expect(trustProxyFromEnv('2')).toBe(2);
    expect(trustProxyFromEnv('false')).toBe(false);
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv('172.17.0.0/16')).toBe('172.17.0.0/16');
  });
});

describe('sign-in guard', () => {
  test('locks an address out after too many failures, but the internet never locks out the home network', () => {
    let t = 1_000_000;
    const g = new SignInGuard(() => t);
    for (let i = 0; i < IP_MAX; i++) g.fail(OUTSIDE, 'julz');
    expect(g.retryAfter(OUTSIDE, 'julz')).toBeGreaterThan(0);
    expect(g.retryAfter('192.168.0.5', 'julz')).toBe(0);
    // many addresses guessing the same account: the account closes for the internet only
    for (let i = 0; i < 20; i++) g.fail(`198.51.100.${i}`, 'julz');
    expect(g.retryAfter('198.51.100.200', 'julz')).toBeGreaterThan(0);
    expect(g.retryAfter('198.51.100.200', 'someone')).toBe(0);
    expect(g.retryAfter('192.168.0.5', 'julz')).toBe(0);
    t += 61 * 60_000;
    expect(g.retryAfter('198.51.100.200', 'julz')).toBe(0);
  });
});

describe('signing in', () => {
  let built: Awaited<ReturnType<typeof makeApp>>;
  let home: string;
  const req = (opts: InjectOptions) => built.app.inject(opts);
  const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)?.value;

  beforeAll(async () => {
    built = await makeApp(null);
    home = await login(built.app);
  });
  afterAll(async () => {
    await built.app.close();
  });

  test('a password signs in at home, but from the internet it is not even checked', async () => {
    const out = await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: OUTSIDE });
    expect(out.statusCode).toBe(403);
    expect(out.json().error).toBe('outside_needs_approval');
    expect(cookieOf(out, 'anycast_session')).toBeUndefined();
    // a wrong password from outside gets the same answer: nothing to learn by guessing
    const wrong = await req({ method: 'POST', url: '/api/auth/login', payload: { ...ADMIN, password: 'guess' }, remoteAddress: OUTSIDE });
    expect(wrong.statusCode).toBe(403);
    // Tailscale counts as home
    expect((await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '100.101.7.3' })).statusCode).toBe(200);
    const st = (await req({ url: '/api/auth/security', headers: { cookie: home } })).json() as SecurityStatus;
    expect(st.here).toEqual({ ip: '127.0.0.1', outside: false });
    expect(st.passwordFromInternet).toBe(false);
  });

  test('wrong passwords lock the address out', async () => {
    const ip = '192.168.0.77';
    for (let i = 0; i < 10; i++) expect((await req({ method: 'POST', url: '/api/auth/login', payload: { ...ADMIN, password: `x${i}` }, remoteAddress: ip })).statusCode).toBe(401);
    const locked = await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: ip });
    expect(locked.statusCode).toBe(429);
    // the guard (10 failures) or the route's rate limit (10 a minute), whichever comes first
    expect(['locked_out', 'rate_limited']).toContain(locked.json().error);
    expect((await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '192.168.0.78' })).statusCode).toBe(200);
  });

  test('a TV signs in with a code that a signed-in phone approves', async () => {
    const start = await req({ method: 'POST', url: '/api/auth/device/start', headers: { 'x-anycast-device': 'Silk on Fire TV' }, remoteAddress: OUTSIDE });
    const s = start.json() as DeviceCodeStart;
    expect(s.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await req({ method: 'POST', url: '/api/auth/device/poll', payload: { pollToken: s.pollToken } })).json()).toEqual({ status: 'pending' });

    // not signed in: no lookup, no approval
    expect((await req({ url: `/api/auth/device/${s.code}` })).statusCode).toBe(401);
    expect((await req({ method: 'POST', url: `/api/auth/device/${s.code}/approve` })).statusCode).toBe(401);

    const typed = s.code.toLowerCase().replace('-', ' ');
    const info = (await req({ url: `/api/auth/device/${encodeURIComponent(typed)}`, headers: { cookie: home } })).json();
    expect(info).toMatchObject({ code: s.code, label: 'Silk on Fire TV', ip: OUTSIDE, outside: true });
    expect((await req({ method: 'POST', url: `/api/auth/device/${s.code}/approve`, headers: { cookie: home } })).statusCode).toBe(200);

    const poll = await req({ method: 'POST', url: '/api/auth/device/poll', payload: { pollToken: s.pollToken }, remoteAddress: OUTSIDE });
    expect(poll.json().status).toBe('approved');
    expect(poll.json().me.user.username).toBe('admin');
    const tv = cookieOf(poll, 'anycast_session')!;
    expect((await req({ url: '/api/me', cookies: { anycast_session: tv } })).statusCode).toBe(200);
    // picked up once
    expect((await req({ method: 'POST', url: '/api/auth/device/poll', payload: { pollToken: s.pollToken } })).json()).toEqual({ status: 'expired' });
    expect((await req({ method: 'POST', url: `/api/auth/device/${s.code}/approve`, headers: { cookie: home } })).statusCode).toBe(404);

    // denied
    const s2 = (await req({ method: 'POST', url: '/api/auth/device/start' })).json() as DeviceCodeStart;
    expect((await req({ method: 'POST', url: `/api/auth/device/${s2.code}/deny`, headers: { cookie: home } })).statusCode).toBe(200);
    expect((await req({ method: 'POST', url: '/api/auth/device/poll', payload: { pollToken: s2.pollToken } })).json()).toEqual({ status: 'denied' });

    // the TV shows up as a signed-in device and can be signed out from the phone
    const st = (await req({ url: '/api/auth/security', headers: { cookie: home } })).json() as SecurityStatus;
    const row = st.devices.find((d) => d.method === 'approved')!;
    expect(row.label).toBe('Silk on Fire TV');
    expect((await req({ method: 'DELETE', url: `/api/auth/sessions/${row.id}`, headers: { cookie: home } })).statusCode).toBe(200);
    expect((await req({ url: '/api/me', cookies: { anycast_session: tv } })).statusCode).toBe(401);
  });

  test('sign out every other device', async () => {
    const other = await login(built.app);
    const res = (await req({ method: 'POST', url: '/api/auth/sessions/sign-out-others', headers: { cookie: home } })).json();
    expect(res.removed).toBeGreaterThan(0);
    expect((await req({ url: '/api/me', headers: { cookie: other } })).statusCode).toBe(401);
    expect((await req({ url: '/api/me', headers: { cookie: home } })).statusCode).toBe(200);
  });
});

describe('behind a proxy', () => {
  test('with one trusted proxy, a client cannot claim a home address in X-Forwarded-For', async () => {
    const built = await makeApp(null, { config: { trustProxy: 1 } });
    try {
      // NPM appends the address it saw: "<what the client sent>, <real address>"
      const spoofed = await built.app.inject({
        method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '172.18.0.2', headers: { 'x-forwarded-for': `192.168.0.5, ${OUTSIDE}` },
      });
      expect(spoofed.statusCode).toBe(403);
      const realHome = await built.app.inject({
        method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '172.18.0.2', headers: { 'x-forwarded-for': '192.168.0.5' },
      });
      expect(realHome.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });
});

describe('through a Cloudflare Tunnel', () => {
  test('a request that came through Cloudflare is the internet, even though cloudflared connects from this machine', async () => {
    const built = await makeApp(null, { config: { trustProxy: 1 } });
    try {
      const viaTunnel = { 'cf-connecting-ip': OUTSIDE, 'cf-ray': '8abc-FRA', 'x-forwarded-for': OUTSIDE };
      const res = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '127.0.0.1', headers: viaTunnel });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('outside_needs_approval');
      // even a faked home address in X-Forwarded-For doesn't help
      const faked = await built.app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '127.0.0.1', headers: { 'cf-ray': 'x', 'x-forwarded-for': '192.168.0.5' } });
      expect(faked.statusCode).toBe(403);

      const start = (await built.app.inject({ method: 'POST', url: '/api/auth/device/start', remoteAddress: '127.0.0.1', headers: viaTunnel })).json() as DeviceCodeStart;
      const home = await login(built.app);
      const info = (await built.app.inject({ url: `/api/auth/device/${start.code}`, headers: { cookie: home } })).json();
      expect(info).toMatchObject({ ip: OUTSIDE, outside: true });
    } finally {
      await built.app.close();
    }
  });
});
