import assert from 'node:assert/strict';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import { personalQueueStatus } from '../src/queue-status.js';
import { DomainError, type User } from '../src/types.js';

export async function checkPersonalQueueStatus(
  db: Database | MongoStore,
  manager: User,
  users: User[],
) {
  await assert.rejects(
    () => personalQueueStatus(db, manager),
    (error: unknown) => error instanceof DomainError && error.code === 'FORBIDDEN',
  );

  const first = await personalQueueStatus(db, users[0]);
  const last = await personalQueueStatus(db, users.at(-1)!);
  assert.deepEqual(first, { participating: true, rank: 1 });
  assert.deepEqual(last, { participating: true, rank: users.length });
  assert.deepEqual(Object.keys(first).sort(), ['participating', 'rank']);

  if (db.kind === 'mongo')
    await db.update('distribution_settings', { id: 1 }, { $set: { last_position: 2 } });
  else await db.query('UPDATE distribution_settings SET last_position=2 WHERE id=1');
  assert.deepEqual(await personalQueueStatus(db, users[2]), {
    participating: true,
    rank: 1,
  });

  const favored = users.at(-1)!;
  if (db.kind === 'mongo')
    await db.update('users', { id: favored.id }, { $set: { queue_weight: 3, queue_credit: 10 } });
  else await db.query('UPDATE users SET queue_weight=3,queue_credit=10 WHERE id=$1', [favored.id]);
  assert.deepEqual(await personalQueueStatus(db, favored), {
    participating: true,
    rank: 1,
  });

  if (db.kind === 'mongo')
    await db.update('users', { id: favored.id }, { $set: { queue_enabled: false } });
  else await db.query('UPDATE users SET queue_enabled=false WHERE id=$1', [favored.id]);
  assert.deepEqual(await personalQueueStatus(db, favored), {
    participating: false,
    rank: null,
  });
}
