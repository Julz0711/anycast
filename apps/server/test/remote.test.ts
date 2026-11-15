import type { Profile, RemoteDevice, RemoteNowPlaying, SyncEvent } from '@anycast/shared';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { RemoteHub } from '../src/remote';
import { EventBus } from '../src/events';
import { login, makeApp } from './helpers';

let built: Awaited<ReturnType<typeof makeApp>>;
let cookie: string;
let kid: Profile;

const TV = { 'x-anycast-client': 'tv-client-00000001', 'x-anycast-device': 'Chrome on Linux' };
const PHONE = { 'x-anycast-client': 'phone-client-0001', 'x-anycast-device': 'Safari on iPhone' };

const call = (opts: InjectOptions) => built.app.inject({ ...opts, headers: { cookie, ...(opts.headers ?? {}) } });

const playing: RemoteNowPlaying = {
  kind: 'movie', id: 'm1', title: 'The Movie', subtitle: '2021', image: null, paused: false, waiting: false,
  position: 120, duration: 5400, volume: 0.8, muted: false, canPrev: false, canNext: false,
};

beforeAll(async () => {
  built = await makeApp(null);
  cookie = await login(built.app);
  kid = (await call({ method: 'POST', url: '/api/profiles', payload: { name: 'Kid' } })).json() as Profile;
});

afterAll(async () => {
  await built.app.close();
});

describe('remote control', () => {
  test('a device announces itself, a phone lists it and steers it', async () => {
    const events: SyncEvent[] = [];
    const off = built.services.bus.subscribe(kid.id, (e) => events.push(e));
    // the TV runs the Kid profile
    const p = await call({ method: 'POST', url: '/api/remote/presence', headers: { ...TV, 'x-anycast-profile': kid.id }, payload: { name: 'Living room', form: 'tv', playing } });
    expect(p.statusCode, p.body).toBe(200);
    // every profile of the account hears about it
    expect(events.some((e) => e.type === 'remote-devices' && e.devices.some((d) => d.clientId === TV['x-anycast-client']))).toBe(true);

    // the phone (first profile) sees it, not itself
    await call({ method: 'POST', url: '/api/remote/presence', headers: PHONE, payload: { form: 'phone', playing: null } });
    const list = (await call({ method: 'GET', url: '/api/remote/devices', headers: PHONE })).json() as RemoteDevice[];
    expect(list.map((d) => d.clientId)).toEqual([TV['x-anycast-client']]);
    expect(list[0]).toMatchObject({ name: 'Living room', device: 'Chrome on Linux', form: 'tv', profileId: kid.id, profileName: 'Kid', playing: { id: 'm1', paused: false } });

    // a command reaches the TV's profile, addressed to the TV
    const c = await call({ method: 'POST', url: '/api/remote/command', headers: PHONE, payload: { clientId: TV['x-anycast-client'], command: { type: 'seekBy', seconds: -10 } } });
    expect(c.statusCode, c.body).toBe(200);
    expect(events.find((e) => e.type === 'remote-command')).toMatchObject({ clientId: TV['x-anycast-client'], command: { type: 'seekBy', seconds: -10 }, from: 'Safari on iPhone' });

    // bad commands and unknown devices
    expect((await call({ method: 'POST', url: '/api/remote/command', headers: PHONE, payload: { clientId: TV['x-anycast-client'], command: { type: 'format-disk' } } })).statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/remote/command', headers: PHONE, payload: { clientId: 'nobody-here-0001', command: { type: 'toggle' } } })).statusCode).toBe(404);

    // closing the app takes it off the list
    await call({ method: 'DELETE', url: '/api/remote/presence', headers: TV });
    expect((await call({ method: 'GET', url: '/api/remote/devices', headers: PHONE })).json()).toEqual([]);
    off();
  });

  test('another account can neither see nor steer the devices', async () => {
    await call({ method: 'POST', url: '/api/remote/presence', headers: TV, payload: { form: 'large', playing: null } });
    const hub = built.services.remote;
    expect(hub.devices('someone-else')).toEqual([]);
    expect(hub.command('someone-else', TV['x-anycast-client'], { type: 'toggle' }, null)).toBe(false);
  });

  test('presence needs a client id and a valid body', async () => {
    expect((await call({ method: 'POST', url: '/api/remote/presence', payload: { form: 'tv', playing: null } })).statusCode).toBe(400);
    expect((await call({ method: 'POST', url: '/api/remote/presence', headers: TV, payload: { form: 'tv', playing: { ...playing, volume: 3 } } })).statusCode).toBe(400);
  });

  test('devices that stop announcing drop out', () => {
    let t = 1_000_000;
    const bus = new EventBus();
    const seen = vi.fn();
    bus.subscribe('p1', seen);
    const hub = new RemoteHub(bus, () => ['p1'], () => t);
    hub.announce({ userId: 'u', clientId: 'c-1', profileId: 'p1', profileName: 'Me', name: null, device: 'Edge on Windows', form: 'large', playing: null });
    expect(hub.devices('u')).toHaveLength(1);
    expect(hub.devices('u')[0]!.name).toBe('Edge on Windows');
    t += 10_000;
    expect(hub.devices('u')[0]!.ageMs).toBe(10_000);
    t += 200_000;
    expect(hub.devices('u')).toEqual([]);
    expect(hub.command('u', 'c-1', { type: 'toggle' }, null)).toBe(false);
    hub.close();
  });
});
