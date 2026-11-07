import { exportBackup } from '../src/backup/backup';
import type { Me, PinError, Profile } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ADMIN, login, makeApp } from './helpers';

let built: Awaited<ReturnType<typeof makeApp>>;
/** two devices of the same account */
let phone: string;
let tv: string;

async function call(cookie: string, opts: InjectOptions & { profile?: string }) {
  const { profile, ...rest } = opts;
  return built.app.inject({ ...rest, headers: { cookie, ...(profile ? { 'x-anycast-profile': profile } : {}), ...(rest.headers ?? {}) } });
}
const json = async <T>(cookie: string, opts: InjectOptions & { profile?: string }) => (await call(cookie, opts)).json() as T;

// smallest valid images of each type
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

beforeAll(async () => {
  built = await makeApp(null);
  phone = await login(built.app);
  tv = await login(built.app);
});

afterAll(async () => {
  await built.app.close();
});

describe('profile pictures', () => {
  test('new profiles get a built-in picture; it can be changed, cleared and replaced by an upload', async () => {
    const kid = await json<Profile>(phone, { method: 'POST', url: '/api/profiles', payload: { name: 'Kid' } });
    expect(kid.avatar).toMatch(/^[a-z]+\.[a-z]+$/);
    expect(kid).toMatchObject({ image: null, locked: false, needsPin: false });

    expect((await json<Profile>(phone, { method: 'PATCH', url: `/api/profiles/${kid.id}`, payload: { avatar: 'moon.sky' } })).avatar).toBe('moon.sky');
    expect((await call(phone, { method: 'PATCH', url: `/api/profiles/${kid.id}`, payload: { avatar: 'moon.blue' } })).statusCode).toBe(400);
    expect((await call(phone, { method: 'PATCH', url: `/api/profiles/${kid.id}`, payload: { avatar: '../x' } })).statusCode).toBe(400);

    const up = await json<Profile>(phone, { method: 'PUT', url: `/api/profiles/${kid.id}/image`, payload: { type: 'image/png', data: PNG.toString('base64') } });
    expect(up.image).toMatch(new RegExp(`^/api/profiles/${kid.id}/image\\?v=\\d+$`));
    const img = await call(phone, { url: up.image! });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(img.rawPayload, PNG)).toBe(0);

    // picking a built-in picture drops the upload
    const back = await json<Profile>(phone, { method: 'PATCH', url: `/api/profiles/${kid.id}`, payload: { avatar: 'wave.mint' } });
    expect(back).toMatchObject({ avatar: 'wave.mint', image: null });
    expect((await call(phone, { url: `/api/profiles/${kid.id}/image` })).statusCode).toBe(404);
    await call(phone, { method: 'DELETE', url: `/api/profiles/${kid.id}` });
  });

  test('uploads must be what they claim and small', async () => {
    const p = await json<Profile>(phone, { method: 'POST', url: '/api/profiles', payload: { name: 'Pics' } });
    const put = (payload: object) => call(phone, { method: 'PUT', url: `/api/profiles/${p.id}/image`, payload });
    expect((await put({ type: 'image/jpeg', data: PNG.toString('base64') })).statusCode).toBe(400);
    expect((await put({ type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') })).statusCode).toBe(400);
    expect((await put({ type: 'image/png', data: 'not base64!' })).statusCode).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
    expect((await put({ type: 'image/png', data: big.toString('base64') })).statusCode).toBe(413);
    await call(phone, { method: 'DELETE', url: `/api/profiles/${p.id}` });
  });
});

describe('profile lock', () => {
  test('a locked profile needs its PIN on each session; switching profiles asks again', async () => {
    const p = await json<Profile>(phone, { method: 'POST', url: '/api/profiles', payload: { name: 'Locked' } });
    const locked = await json<Profile>(phone, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: '2468' } });
    expect(locked).toMatchObject({ locked: true, needsPin: false });

    // the phone that set it stays in; the TV has to enter it
    expect((await call(phone, { url: '/api/preferences', profile: p.id })).statusCode).toBe(200);
    const refused = await call(tv, { url: '/api/preferences', profile: p.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('profile_locked');
    expect((await json<Me>(tv, { url: '/api/me' })).profiles.find((x) => x.id === p.id)).toMatchObject({ locked: true, needsPin: true });
    // the picker still works, the TV cannot change or delete it
    expect((await call(tv, { url: '/api/profiles', profile: p.id })).statusCode).toBe(200);
    expect((await call(tv, { method: 'PATCH', url: `/api/profiles/${p.id}`, payload: { name: 'Mine' } })).json().error).toBe('profile_locked');
    expect((await call(tv, { method: 'DELETE', url: `/api/profiles/${p.id}` })).json().error).toBe('profile_locked');
    expect((await call(tv, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: null } })).json().error).toBe('pin_required');

    const wrong = await call(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter`, payload: { pin: '1111' } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json<PinError>()).toMatchObject({ error: 'wrong_pin', attemptsLeft: 4 });
    expect((await call(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter` })).json().error).toBe('pin_required');
    expect(await json<Profile>(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter`, payload: { pin: '2468' } })).toMatchObject({ needsPin: false });
    expect((await call(tv, { url: '/api/preferences', profile: p.id })).statusCode).toBe(200);

    // a sent PIN is always checked, even once entered
    expect((await call(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter`, payload: { pin: '0000' } })).json().error).toBe('wrong_pin');
    // switching to another profile but keeping this one open
    await call(tv, { method: 'POST', url: '/api/profiles/leave', payload: { keep: p.id } });
    expect((await call(tv, { url: '/api/preferences', profile: p.id })).statusCode).toBe(200);
    // leaving (switching profiles) ends the TV's entry, not the phone's
    await call(tv, { method: 'POST', url: '/api/profiles/leave' });
    expect((await call(tv, { url: '/api/preferences', profile: p.id })).statusCode).toBe(403);
    expect((await call(phone, { url: '/api/preferences', profile: p.id })).statusCode).toBe(200);

    // removing it needs the PIN (or the password)
    expect((await call(phone, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: null, currentPin: '0000' } })).statusCode).toBe(403);
    const open = await json<Profile>(phone, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: null, password: ADMIN.password } });
    expect(open).toMatchObject({ locked: false, needsPin: false });
    expect((await call(tv, { url: '/api/preferences', profile: p.id })).statusCode).toBe(200);
    await call(phone, { method: 'DELETE', url: `/api/profiles/${p.id}` });
  });

  test('five wrong PINs lock the profile out for a while', async () => {
    const p = await json<Profile>(phone, { method: 'POST', url: '/api/profiles', payload: { name: 'Guarded' } });
    await call(phone, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: '1357' } });
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter`, payload: { pin: '9999' } })).statusCode;
    expect(last).toBe(429);
    const right = await call(tv, { method: 'POST', url: `/api/profiles/${p.id}/enter`, payload: { pin: '1357' } });
    expect(right.statusCode).toBe(429);
    expect(right.json<PinError>().lockedOutUntil).toBeGreaterThan(Date.now());
  });

  test('pictures and the lock are in a backup', async () => {
    const p = await json<Profile>(phone, { method: 'POST', url: '/api/profiles', payload: { name: 'Backed', avatar: 'leaf.lime' } });
    await call(phone, { method: 'PUT', url: `/api/profiles/${p.id}/image`, payload: { type: 'image/png', data: PNG.toString('base64') } });
    await call(phone, { method: 'PUT', url: `/api/profiles/${p.id}/lock`, payload: { pin: '4321' } });
    const b = exportBackup(built.services.db).users.flatMap((u) => u.profiles).find((x) => x.id === p.id)!;
    expect(b.avatar).toBe('leaf.lime');
    expect(b.image).toMatchObject({ type: 'image/png', data: PNG.toString('base64') });
    expect(b.lockHash).toMatch(/^\$argon2/);
  });
});
