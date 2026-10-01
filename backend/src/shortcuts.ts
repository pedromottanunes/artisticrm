import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database, Sql } from './db.js';
import type { MongoStore, MongoTx } from './mongo-store.js';
import { DomainError, type User } from './types.js';

export interface MessageShortcut {
  id: string;
  user_id: string;
  name: string;
  body: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const uuid = z.string().uuid();
const paramsSchema = z.object({ id: uuid });
const contentSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do atalho.').max(60),
  body: z.string().trim().min(1, 'Informe a mensagem do atalho.').max(1000),
});
const createSchema = contentSchema.extend({ id: uuid }).strict();
const updateSchema = contentSchema
  .extend({ expected_version: z.number().int().positive() })
  .strict();
const deleteSchema = z.object({ expected_version: z.number().int().positive() }).strict();

function requireAttendant(user: User) {
  if (user.role !== 'attendant')
    throw new DomainError('FORBIDDEN', 'Atalhos são exclusivos dos atendentes.', 403);
}

async function currentMongoAttendant(tx: MongoTx, user: User) {
  const current = await tx.one<User>('users', {
    id: user.id,
    role: 'attendant',
    active: true,
    auth_version: user.auth_version,
  });
  if (!current) throw new DomainError('UNAUTHENTICATED', 'Sua sessão expirou.', 401);
}

async function currentSqlAttendant(tx: Sql, user: User) {
  const current = (
    await tx.query<{ id: string }>(
      `SELECT id FROM users
       WHERE id=$1 AND role='attendant' AND active AND auth_version=$2
       FOR SHARE`,
      [user.id, user.auth_version],
    )
  ).rows[0];
  if (!current) throw new DomainError('UNAUTHENTICATED', 'Sua sessão expirou.', 401);
}

export function registerShortcuts(
  app: FastifyInstance,
  db: Database | MongoStore,
  now: () => Promise<Date>,
) {
  app.get('/api/v1/shortcuts', async (request) => {
    requireAttendant(request.user);
    const shortcuts =
      db.kind === 'mongo'
        ? await db.many<MessageShortcut>(
            'message_shortcuts',
            { user_id: request.user.id },
            { created_at: -1, id: 1 },
          )
        : (
            await db.query<MessageShortcut>(
              `SELECT id,user_id,name,body,version,created_at,updated_at
               FROM message_shortcuts WHERE user_id=$1
               ORDER BY created_at DESC,id`,
              [request.user.id],
            )
          ).rows;
    return { shortcuts };
  });

  app.post('/api/v1/shortcuts', async (request, reply) => {
    requireAttendant(request.user);
    const input = createSchema.parse(request.body);
    const createdAt = await now();
    const shortcut: MessageShortcut = {
      ...input,
      user_id: request.user.id,
      version: 1,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const result =
      db.kind === 'mongo'
        ? await db.atomic(async (tx) => {
            await currentMongoAttendant(tx, request.user);
            const existing = await tx.one<MessageShortcut>('message_shortcuts', { id: input.id });
            if (existing) {
              if (
                existing.user_id === request.user.id &&
                existing.name === input.name &&
                existing.body === input.body
              )
                return { shortcut: existing, created: false };
              throw new DomainError('ID_CONFLICT', 'Não foi possível criar este atalho.', 409);
            }
            await tx.insert('message_shortcuts', shortcut);
            return { shortcut, created: true };
          })
        : await db.transaction(async (tx) => {
            await currentSqlAttendant(tx, request.user);
            const row = (
              await tx.query<MessageShortcut>(
                `INSERT INTO message_shortcuts
                 (id,user_id,name,body,version,created_at,updated_at)
                 VALUES($1,$2,$3,$4,1,$5,$5)
                 ON CONFLICT (id) DO NOTHING RETURNING *`,
                [input.id, request.user.id, input.name, input.body, createdAt],
              )
            ).rows[0];
            if (row) return { shortcut: row, created: true };
            const existing = (
              await tx.query<MessageShortcut>('SELECT * FROM message_shortcuts WHERE id=$1', [
                input.id,
              ])
            ).rows[0];
            if (
              existing?.user_id === request.user.id &&
              existing.name === input.name &&
              existing.body === input.body
            )
              return { shortcut: existing, created: false };
            throw new DomainError('ID_CONFLICT', 'Não foi possível criar este atalho.', 409);
          });
    return reply.code(result.created ? 201 : 200).send({ shortcut: result.shortcut });
  });

  app.patch('/api/v1/shortcuts/:id', async (request) => {
    requireAttendant(request.user);
    const { id } = paramsSchema.parse(request.params);
    const input = updateSchema.parse(request.body);
    const updatedAt = await now();
    const shortcut =
      db.kind === 'mongo'
        ? await db.atomic(async (tx) => {
            await currentMongoAttendant(tx, request.user);
            const current = await tx.one<MessageShortcut>('message_shortcuts', {
              id,
              user_id: request.user.id,
            });
            if (!current) throw new DomainError('NOT_FOUND', 'Atalho não encontrado.', 404);
            // A lost response can be retried without overwriting a later edit.
            if (
              current.version === input.expected_version + 1 &&
              current.name === input.name &&
              current.body === input.body
            )
              return current;
            if (current.version !== input.expected_version)
              throw new DomainError(
                'VERSION_CONFLICT',
                'O atalho mudou. Atualize e tente novamente.',
              );
            await tx.update(
              'message_shortcuts',
              { id, user_id: request.user.id, version: input.expected_version },
              {
                $set: { name: input.name, body: input.body, updated_at: updatedAt },
                $inc: { version: 1 },
              },
            );
            return (await tx.one<MessageShortcut>('message_shortcuts', { id }))!;
          })
        : await db.transaction(async (tx) => {
            await currentSqlAttendant(tx, request.user);
            const row = (
              await tx.query<MessageShortcut>(
                `UPDATE message_shortcuts
                 SET name=$1,body=$2,version=version+1,updated_at=$3
                 WHERE id=$4 AND user_id=$5 AND version=$6 RETURNING *`,
                [input.name, input.body, updatedAt, id, request.user.id, input.expected_version],
              )
            ).rows[0];
            if (row) return row;
            const current = (
              await tx.query<MessageShortcut>(
                'SELECT * FROM message_shortcuts WHERE id=$1 AND user_id=$2',
                [id, request.user.id],
              )
            ).rows[0];
            if (!current) throw new DomainError('NOT_FOUND', 'Atalho não encontrado.', 404);
            if (
              current.version === input.expected_version + 1 &&
              current.name === input.name &&
              current.body === input.body
            )
              return current;
            throw new DomainError(
              'VERSION_CONFLICT',
              'O atalho mudou. Atualize e tente novamente.',
            );
          });
    return { shortcut };
  });

  app.delete('/api/v1/shortcuts/:id', async (request) => {
    requireAttendant(request.user);
    const { id } = paramsSchema.parse(request.params);
    const input = deleteSchema.parse(request.body);
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        await currentMongoAttendant(tx, request.user);
        const current = await tx.one<MessageShortcut>('message_shortcuts', {
          id,
          user_id: request.user.id,
        });
        if (!current) return;
        if (current.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'O atalho mudou. Atualize e tente novamente.');
        await tx.remove('message_shortcuts', { id, user_id: request.user.id });
      });
    else
      await db.transaction(async (tx) => {
        await currentSqlAttendant(tx, request.user);
        const current = (
          await tx.query<MessageShortcut>(
            'SELECT * FROM message_shortcuts WHERE id=$1 AND user_id=$2 FOR UPDATE',
            [id, request.user.id],
          )
        ).rows[0];
        if (!current) return;
        if (current.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'O atalho mudou. Atualize e tente novamente.');
        await tx.query('DELETE FROM message_shortcuts WHERE id=$1 AND user_id=$2', [
          id,
          request.user.id,
        ]);
      });
    return { deleted: true };
  });
}
