import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from './auth.js';
import { loginSchema, passwordSchema } from './credentials.js';
import { migrate, openDatabase } from './db.js';
import { initializeMongo, mongoUser, openMongo } from './mongo-store.js';
import type { User } from './types.js';

const credentials = z
  .object({
    login: loginSchema,
    password: passwordSchema,
    name: z.string().trim().min(2).max(160).default('Master Artisti'),
  })
  .parse({
    login: process.env.MASTER_LOGIN,
    password: process.env.MASTER_PASSWORD,
    name: process.env.MASTER_NAME,
  });

if (process.env.MONGODB_URI && process.env.DATABASE_URL)
  throw new Error('Configure apenas MONGODB_URI ou DATABASE_URL, nunca ambos.');
if (!process.env.MONGODB_URI && !process.env.DATABASE_URL)
  throw new Error('Configure o banco e execute este comando somente no ambiente autorizado.');

const passwordHash = await hashPassword(credentials.password);
const db = process.env.MONGODB_URI
  ? await openMongo(process.env.MONGODB_URI, process.env.MONGODB_DB ?? 'artisti')
  : await openDatabase('memory://', process.env.DATABASE_URL);

try {
  if (db.kind === 'mongo') {
    await initializeMongo(db);
    await db.atomic(async (tx) => {
      const managers = await tx.many<User>('users', { role: 'manager' });
      const target =
        managers.find((user) => user.email.toLowerCase() === credentials.login) ??
        managers.find((user) => user.active) ??
        managers[0];
      const conflict = await tx.one<User>('users', { email: credentials.login });
      if (conflict && conflict.id !== target?.id)
        throw new Error('O login informado já pertence a outro usuário.');

      let targetId: string;
      if (target) {
        targetId = target.id;
        await tx.update(
          'users',
          { id: target.id },
          {
            $set: {
              name: credentials.name,
              email: credentials.login,
              password_hash: passwordHash,
              active: true,
              must_change_password: false,
            },
            $inc: { version: 1, auth_version: 1 },
          },
        );
      } else {
        const user = mongoUser({
          name: credentials.name,
          email: credentials.login,
          password_hash: passwordHash,
          role: 'manager',
        });
        targetId = user.id;
        await tx.insert('users', user);
      }

      await tx.update(
        'users',
        { role: 'manager', id: { $ne: targetId } },
        { $set: { active: false }, $inc: { version: 1, auth_version: 1 } },
      );
      await tx.remove('sessions', {
        user_id: { $in: [...managers.map((user) => user.id), targetId] },
      });
    });
  } else {
    await migrate(db);
    await db.transaction(async (tx) => {
      const managers = (
        await tx.query<User>(
          "SELECT * FROM users WHERE role='manager' ORDER BY active DESC, id FOR UPDATE",
        )
      ).rows;
      const target =
        managers.find((user) => user.email.toLowerCase() === credentials.login) ?? managers[0];
      const conflict = (
        await tx.query<User>('SELECT * FROM users WHERE lower(email)=$1 FOR UPDATE', [
          credentials.login,
        ])
      ).rows[0];
      if (conflict && conflict.id !== target?.id)
        throw new Error('O login informado já pertence a outro usuário.');

      const targetId = target?.id ?? randomUUID();
      if (target)
        await tx.query(
          `UPDATE users SET name=$2,email=$3,password_hash=$4,active=true,must_change_password=false,
            version=version+1,auth_version=auth_version+1 WHERE id=$1`,
          [targetId, credentials.name, credentials.login, passwordHash],
        );
      else
        await tx.query(
          `INSERT INTO users(id,name,email,password_hash,role,active,must_change_password)
            VALUES($1,$2,$3,$4,'manager',true,false)`,
          [targetId, credentials.name, credentials.login, passwordHash],
        );

      await tx.query(
        "UPDATE users SET active=false,version=version+1,auth_version=auth_version+1 WHERE role='manager' AND id<>$1",
        [targetId],
      );
      await tx.query(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='manager')",
      );
    });
  }

  console.info(
    `Acesso master atualizado com o login "${credentials.login}". Sessões antigas foram encerradas.`,
  );
} finally {
  await db.close();
}
