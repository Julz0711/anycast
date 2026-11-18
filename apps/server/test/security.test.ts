import type { DeviceCodeStart, Me, SecurityStatus, TwoFactorSetup } from '@anycast/shared';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isHomeAddress } from '../src/auth/net';
import { SignInGuard, IP_MAX } from '../src/auth/guard';
import { base32Decode, base32Encode, matchTotp, stepAt, totpCode } from '../src/auth/totp';
import { trustProxyFromEnv } from '../src/config';
import { ADMIN, login, makeApp } from './helpers';

const OUTSIDE = '203.0.113.9';

describe('TOTP', () => {
  test('matches the RFC 6238 test vectors (SHA-1, last 6 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, stepAt(59_000))).toBe('287082');
    expect(totpCode(secret, stepAt(1111111109_000))).toBe('081804');
    expect(totpCode(secret, stepAt(2000000000_000))).toBe('279037');
  });
  test('allows one step of drift, and never a step that was already used', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = 1111111109_000;
    const step = stepAt(now);
    expect(matchTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(matchTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
  });
});

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

describe('two-step sign-in', () => {
  let built: Awaited<ReturnType<typeof makeApp>>;
  let home: string;
  const req = (opts: InjectOptions) => built.app.inject(opts);
  const cookieOf = (res: LightMyRequestResponse, name: string) => res.cookies.find((c) => c.name === name)?.value;
  let secret = '';

  beforeAll(async () => {
    built = await makeApp(null);
    home = await login(built.app);
  });
  afterAll(async () => {
    await built.app.close();
  });

  test('without two-step sign-in, a password alone works at home but not from the internet', async () => {
    const out = await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: OUTSIDE });
    expect(out.statusCode).toBe(403);
    expect(out.json().error).toBe('two_factor_required');
    expect(cookieOf(out, 'anycast_session')).toBeUndefined();
    const st = (await req({ url: '/api/auth/security', headers: { cookie: home } })).json() as SecurityStatus;
    expect(st.twoFactor.enabled).toBe(false);
    expect(st.here).toEqual({ ip: '127.0.0.1', outside: false });
    expect(st.outsideNeedsTwoFactor).toBe(true);
  });

  test('setup needs the password and a first code; then recovery codes are shown once', async () => {
    expect((await req({ method: 'POST', url: '/api/auth/2fa/setup', headers: { cookie: home }, payload: { password: 'nope' } })).statusCode).toBe(403);
    const setup = (await req({ method: 'POST', url: '/api/auth/2fa/setup', headers: { cookie: home }, payload: { password: ADMIN.password } })).json() as TwoFactorSetup;
    expect(setup.uri).toBe(`otpauth://totp/AnyCast:admin?secret=${setup.secret}&issuer=AnyCast&algorithm=SHA1&digits=6&period=30`);
    secret = setup.secret;
    // not on until a code confirms it
    expect((await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().user).toBeDefined();
    expect((await req({ method: 'POST', url: '/api/auth/2fa/enable', headers: { cookie: home }, payload: { code: '000000' } })).statusCode).toBe(400);
    const on = await req({ method: 'POST', url: '/api/auth/2fa/enable', headers: { cookie: home }, payload: { code: totpCode(secret, stepAt(Date.now()) - 1) } });
    expect(on.statusCode).toBe(200);
    const codes = on.json().recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
    const st = (await req({ url: '/api/auth/security', headers: { cookie: home } })).json() as SecurityStatus;
    expect(st.twoFactor).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    // the server keeps only an encrypted secret and hashed codes
    const row = built.services.db.prepare('SELECT secret FROM two_factor').get() as { secret: string };
    expect(row.secret).not.toContain(secret);
    expect(JSON.stringify(built.services.db.prepare('SELECT * FROM recovery_codes').all())).not.toContain(codes[0]!.replace('-', ''));

    // a recovery code signs in once, from the internet too
    const first = (await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: OUTSIDE })).json();
    const ok = await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge: first.twoFactor.challenge, code: codes[0]!.toUpperCase().replace('-', ' ') }, remoteAddress: OUTSIDE });
    expect(ok.statusCode).toBe(200);
    const again = (await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json();
    expect((await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge: again.twoFactor.challenge, code: codes[0] } })).statusCode).toBe(401);
  });

  test('the code step: wrong codes count down, a used code is refused, "remember" skips it next time', async () => {
    const res = await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: OUTSIDE });
    expect(res.statusCode).toBe(200);
    const { challenge } = res.json().twoFactor as { challenge: string };
    expect(cookieOf(res, 'anycast_session')).toBeUndefined();

    const wrong = await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge, code: '123456' }, remoteAddress: OUTSIDE });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'wrong_code', attemptsLeft: 4 });

    const code = totpCode(secret, stepAt(Date.now()));
    const ok = await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge, code, remember: true }, remoteAddress: OUTSIDE, headers: { 'x-anycast-device': 'Silk on Fire TV' } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as Me).user.username).toBe('admin');
    const session = cookieOf(ok, 'anycast_session')!;
    const trusted = ok.cookies.find((c) => c.name === 'anycast_trusted')!;
    expect(trusted.path).toBe('/api/auth');
    expect(trusted.httpOnly).toBe(true);
    // the challenge is used up
    expect((await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge, code } })).statusCode).toBe(410);

    // the same code can't sign in twice
    const c2 = (await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().twoFactor.challenge;
    expect((await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge: c2, code } })).statusCode).toBe(401);

    // remembered browser: the password alone signs in, from anywhere
    const remembered = await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: OUTSIDE, cookies: { anycast_trusted: trusted.value } });
    expect((remembered.json() as Me).user.username).toBe('admin');
    // ...but not with a wrong password
    expect((await req({ method: 'POST', url: '/api/auth/login', payload: { ...ADMIN, password: 'x' }, cookies: { anycast_trusted: trusted.value } })).statusCode).toBe(401);

    const st = (await req({ url: '/api/auth/security', cookies: { anycast_session: session }, remoteAddress: OUTSIDE })).json() as SecurityStatus;
    expect(st.trustedDevices).toBe(1);
    expect(st.here).toEqual({ ip: OUTSIDE, outside: true });
    const me = st.devices.find((d) => d.current)!;
    expect(me).toMatchObject({ label: 'Silk on Fire TV', method: 'two_factor', ip: OUTSIDE, outside: true });

    // forgetting remembered browsers brings the code step back
    expect((await req({ method: 'DELETE', url: '/api/auth/trusted', headers: { cookie: home } })).statusCode).toBe(200);
    const after = (await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN, cookies: { anycast_trusted: trusted.value } })).json();
    expect(after.twoFactor).toBeDefined();
  });

  test('five wrong codes end the challenge', async () => {
    const { challenge } = (await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().twoFactor;
    for (let i = 0; i < 4; i++) expect((await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge, code: '111111' }, remoteAddress: '192.168.0.50' })).statusCode).toBe(401);
    const last = await req({ method: 'POST', url: '/api/auth/2fa', payload: { challenge, code: '111111' }, remoteAddress: '192.168.0.50' });
    expect(last.statusCode).toBe(410);
    expect(last.json().error).toBe('challenge_expired');
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

  test('turning it off needs the password and a code', async () => {
    const st = (await req({ url: '/api/auth/security', headers: { cookie: home } })).json() as SecurityStatus;
    expect(st.twoFactor.recoveryCodesLeft).toBe(9);
    expect((await req({ method: 'POST', url: '/api/auth/2fa/disable', headers: { cookie: home }, payload: { password: ADMIN.password, code: '000000' } })).statusCode).toBe(403);
    const code = totpCode(secret, stepAt(Date.now()) + 1);
    expect((await req({ method: 'POST', url: '/api/auth/2fa/disable', headers: { cookie: home }, payload: { password: 'wrong', code } })).statusCode).toBe(403);
    expect((await req({ method: 'POST', url: '/api/auth/2fa/disable', headers: { cookie: home }, payload: { password: ADMIN.password, code } })).statusCode).toBe(200);
    expect((await req({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().user).toBeDefined();
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
