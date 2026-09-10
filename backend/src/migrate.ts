import { openDatabase, migrate } from './db.js';
import { openMongo, initializeMongo } from './mongo-store.js';
if (process.env.MONGODB_URI && process.env.DATABASE_URL)
  throw new Error('Configure apenas um banco: MONGODB_URI ou DATABASE_URL.');
if (!process.env.DATABASE_URL && !process.env.MONGODB_URI)
  throw new Error('MONGODB_URI é obrigatória para inicializar o MongoDB.');
const db = process.env.MONGODB_URI
  ? await openMongo(process.env.MONGODB_URI, process.env.MONGODB_DB ?? 'artisti')
  : await openDatabase('memory://', process.env.DATABASE_URL);
try {
  if (db.kind === 'mongo') await initializeMongo(db);
  else await migrate(db);
  console.info('Estrutura do banco inicializada.');
} finally {
  await db.close();
}
