import { BACKUP_MAX_BYTES, backupFileName, summarizeBackup, type AutoBackups, type RestoreResult } from '@anycast/shared';
import { verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { announceRestore, exportBackup, restoreBackup } from '../backup/backup';
import { parseBackup } from '../backup/format';
import { auth, type Services } from '../context';

const RestoreBody = z.object({
  backup: z.unknown(),
  mode: z.enum(['replace', 'merge']).default('replace'),
  password: z.string().min(1).max(500),
});

const attachment = (reply: FastifyReply, name: string) =>
  reply.header('content-type', 'application/json; charset=utf-8').header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'no-store');

/** Backup and restore of the user data (backup/*.ts). Admin only. */
export function backupRoutes(app: FastifyInstance, s: Services): void {
  const adminOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (auth(req).user.is_admin === 1) return true;
    void reply.code(403).send({ error: 'forbidden', message: 'Only an admin can back up and restore AnyCast' });
    return false;
  };

  app.get('/api/admin/backup', async (req, reply) => {
    if (!adminOnly(req, reply)) return reply;
    const now = Date.now();
    return attachment(reply, backupFileName(now)).send(JSON.stringify(exportBackup(s.db, now)));
  });

  app.get('/api/admin/backups', async (req, reply): Promise<AutoBackups | FastifyReply> => {
    if (!adminOnly(req, reply)) return reply;
    reply.header('cache-control', 'no-store');
    return { keep: s.backups.keep, files: s.backups.list() };
  });

  app.get<{ Params: { name: string } }>('/api/admin/backups/:name', async (req, reply) => {
    if (!adminOnly(req, reply)) return reply;
    const file = s.backups.file(req.params.name);
    if (!file) return reply.code(404).send({ error: 'not_found', message: 'Backup not found' });
    return attachment(reply, req.params.name).send(createReadStream(file));
  });

  app.post(
    '/api/admin/restore',
    { bodyLimit: BACKUP_MAX_BYTES + 64 * 1024, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply): Promise<RestoreResult | FastifyReply> => {
      if (!adminOnly(req, reply)) return reply;
      const body = RestoreBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_request', message: 'A backup file and your password are required' });
      const me = auth(req).user;
      if (!(await verify(me.password_hash, body.data.password).catch(() => false))) {
        return reply.code(403).send({ error: 'wrong_password', message: 'Wrong password' });
      }
      const backup = parseBackup(body.data.backup);
      const safetyBackup = s.backups.beforeRestore();
      const out = restoreBackup(s.db, backup, { mode: body.data.mode, currentUserId: me.id });
      req.log.info({ mode: body.data.mode, profiles: out.touchedProfiles.length, safetyBackup }, 'backup restored');
      announceRestore(s.db, s.bus, s.userData, out.touchedProfiles);
      if (out.pinsChanged) await s.playback.buffer?.pinsChanged().catch((err: Error) => req.log.warn({ err }, 'restoring pinned channels failed'));
      return { ok: true, mode: body.data.mode, summary: summarizeBackup(backup), keptCurrentAccount: out.keptCurrentAccount, safetyBackup };
    },
  );
}
