import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import type { Operations } from '../src/operations.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';
import { buildApp } from '../src/app.js';
import { WhatsAppCentral } from '../src/whatsapp.js';
import { putPush, getPush } from '../src/push-store.js';

type Ops = Operations | MongoOperations;
const input = (phone = '5548999901234') => ({
  name: 'Excluir teste',
  phone,
  interest: '',
  unit: 'Teste',
  source: 'Teste',
});
const confirmation = (version: number) => ({ expected_version: version, confirmation: 'EXCLUIR' });
const rows = async (ops: Ops, table: string) =>
  ops.db.kind === 'mongo'
    ? ops.db.many(table)
    : (await ops.db.query(`SELECT * FROM ${table}`)).rows;

export async function checkDeletePermissions(
  ops: Ops,
  manager: User,
  users: User[],
  password: string,
  now: () => Date,
) {
  const { id } = await ops.ingest(input(), randomUUID(), manager.id);
  const lead = await ops.detail(manager, id);
  const owner = users.find((u) => u.id === lead.reserved_to)!;
  const other = users.find((u) => u.id !== owner.id)!;
  const remove = (actor: User, version = 1, confirm = 'EXCLUIR') =>
    ops.deleteLead(actor, id, { expected_version: version, confirmation: confirm }, randomUUID());
  await assert.rejects(remove(owner), { code: 'FORBIDDEN' });
  await assert.rejects(remove(manager, 1, 'excluir'), { code: 'CONFIRMATION_REQUIRED' });
  await assert.rejects(remove(manager, 99), { code: 'VERSION_CONFLICT' });
  await assert.rejects(remove({ ...manager, auth_version: manager.auth_version + 1 }), {
    code: 'UNAUTHENTICATED',
  });
  await ops.claim(owner, id, 'reservation', lead.version, randomUUID());
  await assert.rejects(remove(other, 2), { code: 'FORBIDDEN' });
  const { app } = await buildApp(ops.db, { clock: now, reconcile: false });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: owner.email, password },
    });
    assert.equal(login.statusCode, 200);
    const headers = {
      cookie: `artisti_session=${login.cookies[0].value}`,
      'x-artisti-client': 'web',
      'idempotency-key': randomUUID(),
    };
    const url = `/api/v1/opportunities/${id}`;
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { 'x-artisti-client': 'web' },
          payload: confirmation(2),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { ...headers, 'x-artisti-client': '' },
          payload: confirmation(2),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'DELETE', url, headers, payload: { expected_version: 2 } }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url,
          headers: { ...headers, 'idempotency-key': '' },
          payload: confirmation(2),
        })
      ).statusCode,
      400,
    );
    const result = await app.inject({ method: 'DELETE', url, headers, payload: confirmation(2) });
    assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(result.json(), { deleted: true });
    assert.equal(
      (await app.inject({ method: 'DELETE', url, headers, payload: confirmation(2) })).statusCode,
      200,
    );
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
    await assert.rejects(remove(other, 2), { code: 'NOT_FOUND' });
  } finally {
    await app.close();
  }
}

export async function checkDeleteCleanup(ops: Ops, manager: User, users: User[], now: () => Date) {
  const event = randomUUID();
  const { id } = await ops.ingest(
    {
      ...input(),
      source: 'Meta Ads',
      source_evidence: 'Referência sintética de teste.',
      meta_attribution: {
        provider: 'meta',
        channel: 'whatsapp',
        source_type: 'ad',
        source_id: 'deletion-test-ad',
        ctwa_clid: 'deletion-test-click',
      },
    },
    event,
    manager.id,
  );
  const before = await ops.detail(manager, id);
  const owner = users.find((u) => u.id === before.reserved_to)!;
  await ops.claim(owner, id, 'reservation', before.version, randomUUID());
  const appointment = await ops.schedule(owner, id, {
    expected_version: 2,
    starts_at: new Date(now().getTime() + 3600000).toISOString(),
    unit: 'Teste',
  });
  await ops.changeAppointment(
    owner,
    appointment.id,
    {
      expected_version: 1,
      starts_at: new Date(now().getTime() + 7200000).toISOString(),
      unit: 'Teste',
      status: 'scheduled',
      reason: 'Teste',
    },
    randomUUID(),
  );
  const other = await ops.ingest(input('5548999901235'), randomUUID(), manager.id);
  const otherBefore = await ops.detail(manager, other.id);
  const base = {
    available_at: now().toISOString(),
    expires_at: new Date(now().getTime() + 3600000).toISOString(),
  };
  await putPush(ops.db, {
    ...base,
    id: 'deletion-job',
    kind: 'job',
    data: { event: { data: { opportunityId: id } } },
  });
  await putPush(ops.db, {
    ...base,
    id: 'keep-subscription',
    kind: 'subscription',
    data: { userId: owner.id },
  });
  const current = await ops.detail(manager, id);
  const key = randomUUID();
  await ops.deleteLead(manager, id, confirmation(current.version), key);
  assert.deepEqual(await ops.deleteLead(manager, id, confirmation(current.version), key), {
    deleted: true,
  });
  for (const table of [
    'appointments',
    'audit_events',
    'lead_attributions',
    'inbound_events',
    'opportunities',
    'contacts',
    'claims',
    'operation_receipts',
    'push_records',
  ]) {
    const values = await rows(ops, table);
    assert.ok(!JSON.stringify(values).includes(id), `No deleted opportunity ID in ${table}`);
    assert.ok(
      !JSON.stringify(values).includes(before.contact_id),
      `No deleted contact in ${table}`,
    );
  }
  assert.equal(await getPush(ops.db, 'deletion-job'), null);
  assert.ok(await getPush(ops.db, 'keep-subscription'));
  assert.deepEqual(await ops.detail(manager, other.id), otherBefore);
  await assert.rejects(ops.ingest(input(), event, manager.id), { code: 'EVENT_DELETED' });
  const fresh = await ops.ingest(input(), randomUUID(), manager.id);
  assert.notEqual(fresh.id, id);
  const markers = await rows(ops, 'deleted_inbound_events');
  assert.ok(
    markers.every((m) => Object.keys(m).length === 1 && /^[a-f0-9]{64}$/.test(String(m.hash))),
  );
}

export async function checkDeleteShared(ops: Ops, manager: User, users: User[]) {
  const { id } = await ops.ingest(input(), randomUUID(), manager.id);
  const detail = await ops.detail(manager, id);
  const owner = users.find((u) => u.id === detail.reserved_to)!;
  await ops.claim(owner, id, 'reservation', 1, randomUUID());
  await ops.update(owner, id, {
    ...input(),
    version: 2,
    email: '',
    instagram: '',
    next_action: '',
    stage: 'DECLINED',
    procedure_date: null,
  });
  const returning = await ops.ingest(input(), randomUUID(), manager.id);
  const preserved = await ops.detail(manager, returning.id);
  await ops.deleteLead(owner, id, confirmation(3), randomUUID());
  assert.deepEqual(await ops.detail(manager, returning.id), preserved);
  assert.equal((await rows(ops, 'contacts')).length, 1);
  await assert.rejects(ops.deleteLead(owner, returning.id, confirmation(1), randomUUID()), {
    code: 'FORBIDDEN',
  });
  await ops.deleteLead(manager, returning.id, confirmation(1), randomUUID());
  assert.equal((await rows(ops, 'contacts')).length, 0);
}

export async function checkDeleteWebhook(ops: Ops, manager: User) {
  const config = {
    appSecret: 'isolated-test-secret',
    verifyToken: 'isolated-test-token',
    wabaId: '12345',
    phoneNumberId: '67890',
  };
  const central = new WhatsAppCentral(ops, config);
  const receive = async (id: string) => {
    const raw = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: config.wabaId,
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { phone_number_id: config.phoneNumberId },
                  contacts: [{ wa_id: input().phone, profile: { name: input().name } }],
                  messages: [{ id, from: input().phone, type: 'text' }],
                },
              },
            ],
          },
        ],
      }),
    );
    await central.receive(
      raw,
      'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex'),
    );
  };
  await receive('processed');
  await central.drain();
  const original = (await rows(ops, 'opportunities'))[0];
  assert.ok(original);
  await receive('pending');
  await ops.deleteLead(
    manager,
    String(original.id),
    confirmation(Number(original.version)),
    randomUUID(),
  );
  await receive('processed');
  await receive('pending');
  await central.drain();
  assert.equal((await rows(ops, 'whatsapp_inbox')).length, 0);
  assert.equal((await rows(ops, 'opportunities')).length, 0);
  await assert.rejects(ops.ingest(input(), 'whatsapp:67890:pending', null), {
    code: 'EVENT_DELETED',
  });
  await receive('new-message');
  await central.drain();
  assert.equal((await rows(ops, 'opportunities')).length, 1);
  assert.notEqual((await rows(ops, 'opportunities'))[0].id, original.id);
}
