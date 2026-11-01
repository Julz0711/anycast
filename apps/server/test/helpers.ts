import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MockXtreamOptions } from '@anycast/mock-xtream';
import { buildApp, type BuildOptions } from '../src/app';
import type { Config } from '../src/config';

export { createMockXtream, expectedTags, FORMAT_MATRIX, buildCatalog } from '@anycast/mock-xtream';

export const ADMIN = { username: 'admin', password: 'admin-password-123' };

export function testConfig(xtream: Config['xtream'], overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'anycast-test-'));
  return {
    port: 0, host: '127.0.0.1', dataDir: dir, bufferDir: path.join(dir, 'buffer'), webDist: null,
    secret: 'test-secret-0123456789abcdef', admin: ADMIN, xtream, logLevel: 'silent', trustProxy: false, scheduler: false, ...overrides,
  };
}

export async function makeApp(xtream: Config['xtream'], opts: BuildOptions & { config?: Partial<Config> } = {}) {
  const built = await buildApp(testConfig(xtream, opts.config), { logger: false, ...opts });
  return built;
}

/** Logs in and returns a cookie header value. */
export async function login(app: Awaited<ReturnType<typeof makeApp>>['app'], creds = ADMIN): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: creds });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'anycast_session');
  return `anycast_session=${cookie!.value}`;
}

export type MockOpts = MockXtreamOptions;
