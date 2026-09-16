import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import { reportPeriod, reportsOverview } from '../src/reports.js';
import type { User } from '../src/types.js';

export async function checkReports(
  db: Database | MongoStore,
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  now: () => Date,
  advance: (milliseconds: number) => void,
) {
  const first = await crm.ingest(
    {
      name: 'Resposta rápida',
      phone: '5548999910001',
      interest: 'Avaliação',
      unit: 'Centro',
      source: 'Meta Ads',
    },
    `report-${randomUUID()}`,
    manager.id,
  );
  advance(2 * 60_000);
  await crm.claim(users[0], first.id, 'reservation', 1, randomUUID());
  await crm.update(users[0], first.id, {
    name: 'Resposta rápida',
    email: '',
    instagram: '',
    interest: 'Avaliação',
    unit: 'Centro',
    stage: 'TO_QUALIFY',
    next_action: 'Retornar contato',
    version: 2,
  });

  const second = await crm.ingest(
    {
      name: 'Lead do bolsão',
      phone: '5548999910002',
      interest: 'Avaliação',
      unit: 'Centro',
      source: 'Meta Ads',
    },
    `report-${randomUUID()}`,
    manager.id,
  );
  advance(11 * 60_000);
  assert.equal(await crm.expire(), 1);
  await crm.claim(users[2], second.id, 'pool', 2, randomUUID());

  const result = await reportsOverview(
    db,
    manager,
    { from: '2026-09-10', to: '2026-09-10' },
    async () => now(),
  );
  assert.deepEqual(result.period, { from: '2026-09-10', to: '2026-09-10', days: 1 });
  assert.equal(result.top_sources[0].source, 'Meta Ads');
  assert.equal(result.top_sources[0].count, 2);
  assert.equal(result.funnel.find((item) => item.key === 'RECEIVED')?.count, 2);
  assert.equal(result.funnel.find((item) => item.key === 'IN_SERVICE')?.count, 2);
  assert.equal(result.unanswered_by_user[0].user_id, users[1].id);
  assert.equal(result.unanswered_by_user[0].count, 1);
  assert.equal(result.pool_lost_by_user[0].user_id, users[1].id);
  assert.equal(result.pool_claimed_by_user[0].user_id, users[2].id);
  assert.equal(result.fastest_response_by_user[0].user_id, users[0].id);
  assert.equal(result.fastest_response_by_user[0].average_minutes, 2);
  assert.equal(result.average_response_minutes, 7);
  assert.equal(result.same_day_interactions[0].count, 2);
  assert.equal(result.open_activities_by_user[0].user_id, users[0].id);
  assert.equal(result.open_activities_by_user[0].count, 1);
  assert.equal(Object.keys(result.leads).length, 2);

  await assert.rejects(
    () =>
      reportsOverview(db, users[0], { from: '2026-09-10', to: '2026-09-10' }, async () => now()),
    { code: 'FORBIDDEN' },
  );
  assert.throws(() => reportPeriod({ from: '2026-08-01', to: '2026-09-10' }, now()), {
    code: 'INVALID_PERIOD',
  });
  assert.doesNotThrow(() => reportPeriod({ from: '2026-08-12', to: '2026-09-11' }, now()));
  assert.throws(() => reportPeriod({ from: '2026-02-30', to: '2026-03-01' }, now()), {
    code: 'INVALID_PERIOD',
  });
  const beforeMidnight = reportPeriod({}, new Date('2026-09-16T02:59:59Z'));
  assert.equal(beforeMidnight.from, '2026-08-16');
  assert.equal(beforeMidnight.to, '2026-09-15');
  assert.equal(beforeMidnight.start.toISOString(), '2026-08-16T03:00:00.000Z');
  assert.equal(beforeMidnight.end.toISOString(), '2026-09-16T03:00:00.000Z');
}
