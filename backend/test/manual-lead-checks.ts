import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import type { User } from '../src/types.js';

export async function checkManualLeads(db: Database | MongoStore, manager: User, users: User[]) {
  const rows = async (table: string) =>
    db.kind === 'mongo'
      ? db.many<Record<string, any>>(table)
      : (await db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows;
  const set = async (table: string, id: string, values: Record<string, unknown>) => {
    if (db.kind === 'mongo') await db.update(table, { id }, { $set: values });
    else
      await db.query(
        `UPDATE ${table} SET ${Object.keys(values)
          .map((key, i) => `${key}=$${i + 1}`)
          .join(',')} WHERE id=$${Object.keys(values).length + 1}`,
        [...Object.values(values), id],
      );
  };
  const { app, crm } = await buildApp(db, { reconcile: false });
  try {
    const headersFor = async (user: User) => {
      const token = randomUUID();
      const session = {
        token_hash: tokenHash(token),
        user_id: user.id,
        auth_version: user.auth_version,
        expires_at: new Date(Date.now() + 3600_000),
      };
      if (db.kind === 'mongo') await db.insert('sessions', session);
      else
        await db.query(
          'INSERT INTO sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)',
          Object.values(session),
        );
      return { cookie: `artisti_session=${token}`, 'x-artisti-client': 'web' };
    };
    const consultant = await headersFor(users[0]);
    const other = await headersFor(users[1]);
    const master = await headersFor(manager);
    const input = (n: number) => ({
      name: `Indicação Teste ${n}`,
      phone: `554898765${String(n).padStart(4, '0')}`,
      unit: 'Unidade teste',
      source: 'Indicação',
    });
    const post = (headers: typeof consultant, payload: object, key = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/opportunities',
        headers: { ...headers, 'idempotency-key': key },
        payload,
      });
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/opportunities',
          headers: { 'x-artisti-client': 'web' },
          payload: input(1),
        })
      ).statusCode,
      401,
    );
    assert.equal((await post(consultant, { ...input(1), owner_id: users[1].id })).statusCode, 400);
    assert.equal((await post(consultant, { ...input(1), phone: '123' })).statusCode, 400);
    assert.equal(
      (await post(consultant, { ...input(1), identity: { provider: 'instagram' } })).statusCode,
      400,
    );
    await set('users', users[0].id, { queue_enabled: false });
    const queue = (await rows('distribution_settings'))[0].last_position;
    const credits = (await rows('users')).map((row) => [row.id, row.queue_credit]);
    const key = randomUUID();
    const first = await post(consultant, input(1), key);
    assert.equal(first.statusCode, 201, first.body);
    const id = first.json().id;
    const lead = (await rows('opportunities')).find((row) => row.id === id)!;
    assert.equal(lead.owner_id, users[0].id);
    assert.equal(lead.state, 'CLAIMED');
    assert.equal(lead.source, 'Indicação');
    assert.equal(lead.channel, 'manual');
    assert.equal(lead.needs_review, false);
    assert.equal(lead.reserved_to, null);
    assert.equal(lead.expires_at, null);
    assert.ok(lead.claimed_at);
    assert.equal((await rows('distribution_settings'))[0].last_position, queue);
    assert.deepEqual(
      (await rows('users')).map((row) => [row.id, row.queue_credit]),
      credits,
    );
    assert.equal(
      (await app.inject({ url: `/api/v1/opportunities/${id}`, headers: consultant })).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: `/api/v1/opportunities/${id}`, headers: other })).statusCode,
      404,
    );
    const audits = (await rows('audit_events')).length;
    const replay = await post(consultant, input(1), key);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().id, id);
    assert.equal((await rows('audit_events')).length, audits);
    assert.equal(
      (await post(consultant, { ...input(1), name: 'Alteração indevida' }, key)).statusCode,
      409,
    );
    const ownDuplicate = await post(consultant, input(1));
    assert.equal(ownDuplicate.statusCode, 200);
    assert.equal(ownDuplicate.json().id, id);
    const beforeBlocked = (await rows('opportunities')).find((row) => row.id === id);
    const blocked = await post(other, input(1));
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().code, 'LEAD_EXISTS');
    assert.ok(!blocked.body.includes(id));
    assert.deepEqual(
      (await rows('opportunities')).find((row) => row.id === id),
      beforeBlocked,
    );

    const simultaneous = await Promise.all([post(consultant, input(2)), post(other, input(2))]);
    assert.deepEqual(simultaneous.map((r) => r.statusCode).sort(), [201, 409]);
    const sameKey = randomUUID();
    const retried = await Promise.all([
      post(consultant, input(3), sameKey),
      post(consultant, input(3), sameKey),
    ]);
    assert.deepEqual(retried.map((r) => r.statusCode).sort(), [200, 201]);
    assert.equal(retried[0].json().id, retried[1].json().id);

    const assigned = (await rows('opportunities')).find((row) => row.id === id)!;
    await crm.transfer(
      manager,
      id,
      {
        target_id: users[1].id,
        expected_version: assigned.version,
        reason: 'Transferência para teste de replay',
      },
      randomUUID(),
    );
    assert.equal(
      (await post(consultant, input(1), key)).statusCode,
      409,
      'A receipt cannot expose or reclaim a transferred lead',
    );
    assert.equal((await rows('opportunities')).find((row) => row.id === id)?.owner_id, users[1].id);

    const closedId = retried[0].json().id;
    await set('opportunities', closedId, {
      stage: 'DECLINED',
      state: 'CANCELLED',
      ...(db.kind === 'mongo' ? { open: false } : {}),
    });
    const count = (await rows('opportunities')).length;
    assert.equal(
      (await post(consultant, input(3))).statusCode,
      409,
      'A closed contact needs management review',
    );
    assert.equal((await rows('opportunities')).length, count);
    const returned = await post(master, input(3));
    assert.equal(returned.statusCode, 201);
    assert.equal(
      (await rows('opportunities')).find((row) => row.id === returned.json().id)?.needs_review,
      true,
    );

    const distributed = await post(master, input(4));
    assert.equal(distributed.statusCode, 201);
    const reserved = (await rows('opportunities')).find((row) => row.id === distributed.json().id)!;
    assert.equal(reserved.state, 'RESERVED', 'Master keeps the existing distribution workflow');
    assert.equal(reserved.owner_id, null);
    assert.equal(
      (await post(consultant, input(4))).statusCode,
      409,
      'Manual entry cannot bypass claim rules',
    );
    await set('users', users[0].id, { active: false });
    assert.equal((await post(consultant, input(5))).statusCode, 401);
    await assert.rejects(
      crm.ingest(
        { ...input(5), interest: '' },
        `manual:${users[0].id}:${randomUUID()}`,
        users[0].id,
        users[0],
      ),
      { code: 'UNAUTHENTICATED' },
    );
  } finally {
    await app.close();
  }
}
