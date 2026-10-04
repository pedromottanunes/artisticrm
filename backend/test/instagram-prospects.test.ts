import { test } from 'node:test';
import { openDatabase, migrate } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo } from '../src/seed.js';
import type { User } from '../src/types.js';
import { checkProspects } from './prospect-checks.js';
import { prospectRegressions } from './prospect-regression-checks.js';

for (const [name, check] of prospectRegressions)
  test(`${name} (SQL)`, async () => {
    const db = await openDatabase();
    try {
      await migrate(db);
      await seedDemo(new CRM(db), false);
      const users = (
        await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST')
      ).rows;
      await check(db, users[0], users.slice(1));
    } finally {
      await db.close();
    }
  });

test('Instagram profile reservations, routing, recovery and permissions (SQL)', async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    await seedDemo(new CRM(db), false);
    const users = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
      .rows;
    await checkProspects(db, users[0], users.slice(1));
  } finally {
    await db.close();
  }
});
