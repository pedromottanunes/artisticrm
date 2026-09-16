import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { hashPassword } from './auth.js';
import { loginSchema, passwordSchema } from './credentials.js';

export async function bootstrapManager(db: Database, login?: string, password?: string) {
  if (Number((await db.query<{ count: string }>('SELECT count(*) FROM users')).rows[0].count))
    return;
  const credentials = z
    .object({ login: loginSchema, password: passwordSchema })
    .safeParse({ login, password });
  if (!credentials.success)
    throw new Error(
      'Banco vazio: configure BOOTSTRAP_ADMIN_LOGIN e BOOTSTRAP_ADMIN_PASSWORD no Render.',
    );
  if (credentials.data.login.endsWith('@demo.artisti.local'))
    throw new Error('Contas de demonstração não são permitidas no ambiente publicado.');
  await db.query(
    `INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,'Gestão Artisti',$2,$3,'manager')`,
    [randomUUID(), credentials.data.login, await hashPassword(credentials.data.password)],
  );
}
