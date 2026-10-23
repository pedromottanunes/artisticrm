import { setTimeout } from 'node:timers/promises';
import { openMongo } from './mongo-store.js';
import { openDatabase } from './db.js';
import { commercialConfig, geminiAnalyzer } from './commercial-ai.js';
import { CommercialService } from './commercial-service.js';

// Optional dedicated process. Deploy/migrate the API first; never seed or alter
// distribution settings from the document worker.
const config = commercialConfig(process.env);
if (!config.enabled || !config.aiEnabled)
  throw new Error('Habilite a checagem e configure a IA antes de iniciar o worker.');
if (!!process.env.MONGODB_URI === !!process.env.DATABASE_URL)
  throw new Error('Configure exatamente um banco: MONGODB_URI ou DATABASE_URL.');
const db = process.env.MONGODB_URI
  ? await openMongo(process.env.MONGODB_URI, process.env.MONGODB_DB ?? 'artisti')
  : await openDatabase('memory://', process.env.DATABASE_URL);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  if (db.kind === 'mongo') {
    if (
      !(await db.collection('commercial_records').indexExists('id_1')) ||
      !(await db.collection('commercial_payment_claims').indexExists('id_1'))
    )
      throw new Error('Inicialize a nova versão da API antes do worker.');
  } else await db.query('SELECT id FROM commercial_payment_claims LIMIT 1');
  const service = new CommercialService(db, config, geminiAnalyzer(config));
  while (!controller.signal.aborted) {
    try {
      await service.runOne(controller.signal);
    } catch {
      console.error('Falha temporária no worker documental. Verifique banco e configuração.');
    }
    try {
      await setTimeout(3000, undefined, { signal: controller.signal });
    } catch {
      /* shutdown */
    }
  }
} finally {
  await db.close();
}
