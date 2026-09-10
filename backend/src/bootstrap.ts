import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './db.js';
import { hashPassword } from './auth.js';

export async function bootstrapManager(db: Database, email?: string, password?: string) {
  if (Number((await db.query<{ count: string }>('SELECT count(*) FROM users')).rows[0].count))
    return;
  const credentials = z
    .object({ email: z.string().email().max(200), password: z.string().min(16).max(128) })
    .safeParse({ email, password });
  if (!credentials.success)
    throw new Error(
      'Banco vazio: configure BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD (mínimo 16 caracteres) no Render.',
    );
  if (credentials.data.email.endsWith('@demo.artisti.local'))
    throw new Error('Contas de demonstração não são permitidas no ambiente publicado.');
  await db.query(
    `INSERT INTO users(id,name,email,password_hash,role) VALUES ($1,'Gestão Artisti',$2,$3,'manager')`,
    [
      randomUUID(),
      credentials.data.email.toLowerCase(),
      await hashPassword(credentials.data.password),
    ],
  );
}
