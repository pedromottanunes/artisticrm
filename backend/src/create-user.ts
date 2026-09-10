import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { hashPassword } from './auth.js';
import { openMongo, mongoUser } from './mongo-store.js';
if (process.env.MONGODB_URI && process.env.DATABASE_URL)
  throw new Error('Configure apenas um banco: MONGODB_URI ou DATABASE_URL.');
if (!process.env.DATABASE_URL && !process.env.MONGODB_URI)
  throw new Error('Configure MONGODB_URI. Execute apenas no ambiente autorizado.');
const parsed = z
  .object({
    email: z.string().email(),
    name: z.string().min(2).max(160),
    password: z.string().min(6).max(128),
    position: z.coerce.number().int().min(1).max(99),
  })
  .safeParse({
    email: process.env.CREATE_USER_EMAIL,
    name: process.env.CREATE_USER_NAME,
    password: process.env.CREATE_USER_PASSWORD,
    position: process.env.CREATE_USER_POSITION,
  });
if (!parsed.success)
  throw new Error(
    'Configure CREATE_USER_EMAIL, CREATE_USER_NAME, CREATE_USER_PASSWORD (6+ caracteres), CREATE_USER_POSITION (1–99).',
  );
const input = parsed.data;
if (input.email.endsWith('@demo.artisti.local'))
  throw new Error('E-mail de demonstração não permitido.');
const db = process.env.MONGODB_URI
  ? await openMongo(process.env.MONGODB_URI, process.env.MONGODB_DB ?? 'artisti')
  : await openDatabase('memory://', process.env.DATABASE_URL);
try {
  if (db.kind === 'mongo') {
    const password_hash = await hashPassword(input.password);
    await db.atomic(async (tx) => {
      if (!(await tx.one('distribution_settings', { id: 1 })))
        throw new Error('Inicialize o banco antes de criar usuários.');
      await tx.insert(
        'users',
        mongoUser({
          name: input.name,
          email: input.email,
          password_hash,
          role: 'attendant',
          queue_position: input.position,
          must_change_password: true,
        }),
      );
      await tx.update('distribution_settings', { id: 1 }, { $inc: { version: 1 } });
    });
  } else
    await db.query(
      `INSERT INTO users(id,name,email,password_hash,role,queue_enabled,queue_position,must_change_password) VALUES ($1,$2,$3,$4,'attendant',true,$5,true)`,
      [
        randomUUID(),
        input.name,
        input.email.toLowerCase(),
        await hashPassword(input.password),
        input.position,
      ],
    );
  console.info(
    'Atendente criada. Nenhuma senha foi registrada no log. Remova as variáveis CREATE_USER_* após o uso.',
  );
} finally {
  await db.close();
}
