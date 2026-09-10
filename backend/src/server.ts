import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { openDatabase, migrate } from './db.js';
import { CRM } from './crm.js';
import { seedDemo } from './seed.js';
import { buildApp } from './app.js';
import { bootstrapManager } from './bootstrap.js';
import { whatsappConfig } from './whatsapp.js';

const production = process.env.NODE_ENV === 'production';
const whatsapp = whatsappConfig(process.env);
if (production && !process.env.DATABASE_URL)
  throw new Error(
    'DATABASE_URL é obrigatória no ambiente publicado. Banco embarcado não é permitido no Render.',
  );
const appOrigin = process.env.APP_ORIGIN ?? process.env.RENDER_EXTERNAL_URL;
if (production && (!appOrigin || new URL(appOrigin).protocol !== 'https:'))
  throw new Error('APP_ORIGIN ou RENDER_EXTERNAL_URL deve conter a origem HTTPS pública.');
const dataPath = fileURLToPath(new URL('../.data/postgres', import.meta.url));
if (!process.env.DATABASE_URL)
  await mkdir(fileURLToPath(new URL('../.data', import.meta.url)), { recursive: true });
const db = await openDatabase(
  !production && process.env.ARTISTI_EPHEMERAL_DB === '1' ? 'memory://' : dataPath,
  process.env.DATABASE_URL,
);
await migrate(db);
if (production) {
  const demoUsers = await db.query('SELECT id FROM users WHERE email LIKE $1 LIMIT 1', [
    '%@demo.artisti.local',
  ]);
  if (demoUsers.rows.length)
    throw new Error(
      'O banco contém contas de demonstração. Use um banco vazio e exclusivo para homologação.',
    );
  await bootstrapManager(
    db,
    process.env.BOOTSTRAP_ADMIN_EMAIL,
    process.env.BOOTSTRAP_ADMIN_PASSWORD,
  );
} else await seedDemo(new CRM(db));
const { app } = await buildApp(db, {
  production,
  whatsapp,
  appOrigin,
  staticRoot: production
    ? fileURLToPath(new URL('../../frontend/dist', import.meta.url))
    : undefined,
});
await app.listen({
  port: Number(process.env.PORT ?? 3333),
  host: production ? '0.0.0.0' : '127.0.0.1',
});
console.info(
  production
    ? 'Artisti CRM • servidor de homologação iniciado'
    : 'Artisti API • demonstração local • http://127.0.0.1:3333',
);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
