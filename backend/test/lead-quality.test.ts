import { test } from 'node:test';
import { openDatabase, migrate } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo } from '../src/seed.js';
import type { User } from '../src/types.js';
import { checkLeadQuality } from './lead-quality-checks.js';

test('Lead quality: compensation, pool, archive, notifications and restoration (SQL)', async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    await seedDemo(new CRM(db), false);
    const users = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
      .rows;
    await checkLeadQuality(db, users[0], users.slice(1));
  } finally {
    await db.close();
  }
});
