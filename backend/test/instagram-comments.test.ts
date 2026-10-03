import { test } from 'node:test';
import { openDatabase, migrate } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo } from '../src/seed.js';
import type { User } from '../src/types.js';
import { checkComments } from './comment-checks.js';
import { checkPrivateReplyRecovery } from './private-reply-recovery-checks.js';

test('private reply recovery: durable receipt, atomic binding, restart and incoming reply (SQL)', async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    const crm = new CRM(db);
    await seedDemo(crm, false);
    const users = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
      .rows;
    await checkPrivateReplyRecovery(crm, users[1], users[0]);
  } finally {
    await db.close();
  }
});

test('comment pool: ownership, private reply, incoming Direct, expiry, uncertain send and deletion (SQL)', async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    const crm = new CRM(db);
    await seedDemo(crm, false);
    const users = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
      .rows;
    await checkComments(crm, users.slice(1), users[0]);
  } finally {
    await db.close();
  }
});
