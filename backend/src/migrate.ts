import { openDatabase, migrate } from './db.js';
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL é obrigatória para migrações no servidor.');
const db = await openDatabase('memory://', process.env.DATABASE_URL);
try {
  await migrate(db);
  console.info('Migrações aplicadas.');
} finally {
  await db.close();
}
