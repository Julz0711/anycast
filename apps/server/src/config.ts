import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface XtreamCredentials {
  url: string;
  username: string;
  password: string;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  bufferDir: string;
  webDist: string | null;
  secret: string;
  admin: { username: string; password: string } | null;
  xtream: XtreamCredentials | null;
  logLevel: string;
  /** trust X-Forwarded-* (set when running behind a reverse proxy) */
  trustProxy: boolean;
  /** background sync scheduler; tests turn it off */
  scheduler: boolean;
}

export const VERSION = '0.1.0';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(serverDir, '../..');

/** Loads .env from the working directory, then from the repo root (first value wins). */
export function loadEnvFiles(): void {
  for (const file of [path.resolve('.env'), path.join(repoRoot, '.env')]) {
    if (existsSync(file)) loadDotenv({ path: file, quiet: true } as Parameters<typeof loadDotenv>[0]);
  }
}

export function xtreamFromEnv(env: NodeJS.ProcessEnv): XtreamCredentials | null {
  const url = env.XTREAM_URL?.trim();
  const username = env.XTREAM_USERNAME?.trim();
  const password = env.XTREAM_PASSWORD?.trim();
  if (!url || !username || !password) return null;
  return { url: url.replace(/\/+$/, ''), username, password };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.ANYCAST_SECRET?.trim() ?? '';
  if (secret.length < 16) {
    throw new Error('ANYCAST_SECRET must be set to a random string of at least 16 characters');
  }
  const resolveDir = (v: string | undefined, fallback: string) => path.resolve(v?.trim() || fallback);
  const webDist = env.WEB_DIST?.trim() ? path.resolve(env.WEB_DIST.trim()) : path.join(repoRoot, 'apps/web/dist');
  const adminUser = env.ANYCAST_ADMIN_USER?.trim();
  const adminPassword = env.ANYCAST_ADMIN_PASSWORD;
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST?.trim() || '0.0.0.0',
    dataDir: resolveDir(env.DATA_DIR, './data'),
    bufferDir: resolveDir(env.BUFFER_DIR, './buffer'),
    webDist: existsSync(webDist) ? webDist : null,
    secret,
    admin: adminUser && adminPassword ? { username: adminUser, password: adminPassword } : null,
    xtream: xtreamFromEnv(env),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? ''),
    scheduler: true,
  };
}
