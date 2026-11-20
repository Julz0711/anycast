import type { FastifyRequest } from 'fastify';
import type { Users, UserRow } from './auth/users';
import type { SignInGuard } from './auth/guard';
import type { DeviceCodes } from './auth/pending';
import type { CastLinks } from './cast';
import type { RemoteHub } from './remote';
import type { AutoBackups } from './backup/auto';
import type { CatalogSync } from './catalog/sync';
import type { Config } from './config';
import type { Db } from './db';
import type { EventBus } from './events';
import type { Parental } from './parental';
import type { PlaybackService } from './playback/service';
import type { SourceService } from './source';
import type { SubtitleService } from './subtitles/service';
import type { UserData } from './userdata';

export interface Services {
  config: Config;
  db: Db;
  users: Users;
  source: SourceService;
  sync: CatalogSync;
  bus: EventBus;
  userData: UserData;
  playback: PlaybackService;
  parental: Parental;
  backups: AutoBackups;
  cast: CastLinks;
  remote: RemoteHub;
  security: { guard: SignInGuard; devices: DeviceCodes };
  subtitles: SubtitleService;
}

export interface AuthContext {
  user: UserRow;
  profileId: string;
  token: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw new Error('route requires authentication');
  return req.auth;
}
