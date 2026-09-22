import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';
import { distributionBoard, distributionQuery } from '../src/distribution.js';
import { buildApp } from '../src/app.js';

export async function checkDistribution(
  db: Database | MongoStore,
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  password: string,
  getNow: () => Date,
  advance: () => void,
) {
  const first = await crm.ingest(
    {
      name: 'Prioridade [literal]',
      phone: '5548998877000',
      source: 'Cadastro manual',
      unit: 'Teste',
      interest: '',
    },
    randomUUID(),
    manager.id,
  );
  // More than the legacy workspace limit: old pending/reserved contacts must remain visible.
  const contacts = Array.from({ length: 505 }, (_, i) => ({
    id: randomUUID(),
    name: `Volume ${i}`,
    phone: `554899${String(i).padStart(7, '0')}`,
  }));
  if (db.kind === 'mongo') {
    const original = (await db.one('opportunities', { id: first.id }))!;
    await db.collection('contacts').insertMany(contacts);
    await db.collection('opportunities').insertMany(
      contacts.map((c) => ({
        ...original,
        id: randomUUID(),
        contact_id: c.id,
        created_at: new Date(getNow().getTime() + 1),
      })),
    );
  } else
    await db.transaction(async (tx) => {
      for (const c of contacts) {
        await tx.query('INSERT INTO contacts(id,name,phone) VALUES ($1,$2,$3)', [
          c.id,
          c.name,
          c.phone,
        ]);
        await tx.query(
          "INSERT INTO opportunities(id,contact_id,state,reserved_to,created_at,expires_at,last_message_at) VALUES ($1,$2,'RESERVED',$3,$4,$5,$4)",
          [
            randomUUID(),
            c.id,
            users[0].id,
            new Date(getNow().getTime() + 1),
            new Date(getNow().getTime() + 600000),
          ],
        );
      }
    });
  const board = (query: Record<string, unknown> = {}) =>
    distributionBoard(db, manager, distributionQuery.parse(query), async () => getNow());
  const all = await board();
  assert.equal(all.total, 506);
  assert.equal(all.counts.RESERVED, 506);
  assert.equal(all.rows.length, 25);
  assert.equal(all.settings.timeout_minutes, 10);
  assert.equal(all.settings.last_position, users[0].queue_position);
  assert.equal(all.users.length, users.length + 1);
  assert.equal(all.users.find((u) => u.id === users[0].id)?.name, users[0].name);
  assert.ok(
    all.users.every(
      (u) => !('password_hash' in u) && !('auth_version' in u) && !('queue_credit' in u),
    ),
  );
  assert.ok(all.users.every((u) => typeof u.queue_weight === 'number'));
  assert.equal(all.team.find((t) => t.user_id === users[0].id)?.count, 506);
  assert.equal(all.attendants.length, users.length);
  assert.equal(all.attendants.find((u) => u.id === users[0].id)?.reserved_count, 506);
  assert.equal(all.attendants.find((u) => u.id === users[0].id)?.claimed_count, 0);
  assert.equal(all.attendants.find((u) => u.id === users[1].id)?.is_next, true);
  const next = await board({ page: 2 });
  assert.ok(next.rows.every((r) => !all.rows.some((a) => a.id === r.id)));
  const last = await board({ page: 999 });
  assert.equal(last.page, 21);
  assert.equal(last.rows.length, 6);
  assert.equal((await board({ attendant: users[1].id })).total, 0);
  assert.equal((await board({ search: '[literal]' })).rows[0].id, first.id);
  assert.equal((await board({ search: '[literal]' })).counts.RESERVED, 506);
  assert.equal((await board({ search: '.*' })).total, 0);
  assert.equal((await board({ source: 'Meta Ads' })).total, 0);
  await assert.rejects(
    () => distributionBoard(db, users[0], distributionQuery.parse({}), async () => getNow()),
    { code: 'FORBIDDEN' },
  );

  const { app } = await buildApp(db, { clock: getNow, reconcile: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/distribution/board' })).statusCode, 401);
    const login = async (user: User) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-artisti-client': 'web' },
        payload: { email: user.email, password },
      });
      assert.equal(response.statusCode, 200);
      return { cookie: `artisti_session=${response.cookies[0].value}` };
    };
    const managerHeaders = await login(manager);
    const attendantHeaders = await login(users[0]);
    assert.equal(
      (await app.inject({ url: '/api/v1/distribution/board', headers: attendantHeaders }))
        .statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/distribution/board?page=-1', headers: managerHeaders }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/distribution/board?state=INVALID',
          headers: managerHeaders,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/v1/distribution/board?stage=INVALID',
          headers: managerHeaders,
        })
      ).statusCode,
      400,
    );
    advance();
    // GET reconciles persistent deadlines, including after the server was asleep.
    const expired = await app.inject({
      url: '/api/v1/distribution/board?state=POOL',
      headers: managerHeaders,
    });
    assert.equal(expired.statusCode, 200, expired.body);
    assert.equal(expired.json().counts.POOL, 506);
    assert.equal(expired.json().counts.RESERVED, 0);
    assert.equal(
      expired.json().attendants.find((u: { id: string }) => u.id === users[0].id).expired_today,
      506,
    );
    assert.equal(await crm.expire(), 0);
    const expiredEvents =
      db.kind === 'mongo'
        ? await db.count('audit_events', { kind: 'reservation.expired' })
        : Number(
            (
              await db.query<{ count: string }>(
                "SELECT count(*) FROM audit_events WHERE kind='reservation.expired'",
              )
            ).rows[0].count,
          );
    assert.equal(expiredEvents, 506);
    assert.equal(expired.json().events.length, 20);
    assert.ok(
      expired.json().events.some((e: { kind: string }) => e.kind === 'reservation.expired'),
    );
    // The manager's attendant filter must not mistake the expired reserved_to for ownership.
    assert.equal((await board({ attendant: users[0].id })).total, 0);
    await crm.claim(users[2], first.id, 'pool', 2, randomUUID());
    const claimed = await board({ state: 'CLAIMED', attendant: users[2].id });
    assert.equal(claimed.rows.length, 1);
    assert.equal(claimed.rows[0].owner_id, users[2].id);
    assert.equal(claimed.counts.POOL, 505);
    assert.equal(claimed.counts.CLAIMED, 1);
    assert.ok(!JSON.stringify(claimed).includes('password_hash'));

    const detail = await crm.detail(manager, first.id);
    await crm.update(manager, first.id, {
      version: detail.version,
      name: detail.name,
      email: detail.email ?? '',
      instagram: detail.instagram ?? '',
      interest: detail.interest,
      unit: detail.unit,
      stage: 'DECLINED',
      procedure_date: null,
      next_action: detail.next_action,
    });
    const openAfterClose = await board({ scope: 'OPEN' });
    assert.equal(openAfterClose.total, 505);
    const closed = await board({ scope: 'CLOSED' });
    assert.equal(closed.total, 1);
    assert.equal(closed.rows[0].id, first.id);
    assert.equal(closed.rows[0].stage, 'DECLINED');
    assert.equal((await board({ scope: 'ALL' })).total, 506);
    assert.equal((await board({ scope: 'ALL', stage: 'DECLINED' })).total, 1);
    assert.equal((await board({ scope: 'ALL', stage: 'CONSULTATION_NOT_SCHEDULED' })).total, 505);
    const recent = await board({ scope: 'ALL', order: 'RECENT' });
    assert.notEqual(recent.rows[0].id, first.id);
    assert.equal((await board({ scope: 'CLOSED', attendant: users[2].id })).total, 1);
  } finally {
    await app.close();
  }
}
