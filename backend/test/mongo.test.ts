import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { MongoClient } from 'mongodb';
import {
  openMongo,
  initializeMongo,
  bootstrapMongo,
  mongoUser,
  type MongoStore,
} from '../src/mongo-store.js';
import { MongoOperations, publicUser } from '../src/mongo-crm.js';
import { buildApp } from '../src/app.js';
import { WhatsAppCentral } from '../src/whatsapp.js';
import { hashPassword } from '../src/auth.js';
import type { User } from '../src/types.js';
import { checkDistribution } from './distribution-checks.js';
import { checkPush } from './push-checks.js';
import { checkReports } from './report-checks.js';
import {
  checkDeletePermissions,
  checkDeleteCleanup,
  checkDeleteShared,
  checkDeleteWebhook,
} from './deletion-checks.js';

let replica: MongoMemoryReplSet, db: MongoStore, ops: MongoOperations, manager: User, users: User[];
let now: Date;
const database = `artisti_test_${randomUUID().replaceAll('-', '')}`;
const password = 'test-password-only';
let password_hash: string;
before(
  async () => {
    // A real, isolated mongod replica set: tests never use an Atlas URI or a live database.
    replica = await MongoMemoryReplSet.create({
      binary: { version: '8.0.12' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    db = await openMongo(replica.getUri(), database);
    await initializeMongo(db);
    password_hash = await hashPassword(password);
  },
  { timeout: 180_000 },
);
beforeEach(async () => {
  assert.match(db.database.databaseName, /^artisti_test_[a-f0-9]{32}$/);
  for (const c of await db.database.listCollections().toArray()) await db.remove(c.name, {});
  await initializeMongo(db);
  manager = publicUser(
    mongoUser({
      name: 'Gestão Teste',
      email: 'manager@example.test',
      password_hash,
      role: 'manager',
    }),
  );
  await db.insert('users', { ...manager, password_hash });
  users = [];
  for (let i = 1; i <= 4; i++) {
    const u = mongoUser({
      name: `Atendente ${i}`,
      email: `atendente${i}@example.test`,
      password_hash,
      role: 'attendant',
      queue_position: i,
    });
    await db.insert('users', u);
    users.push(publicUser(u));
  }
  now = new Date('2026-09-10T12:00:00Z');
  ops = new MongoOperations(db, () => now);
});
after(async () => {
  await db?.close();
  await replica?.stop();
});
const input = (n = 1) => ({
  name: `Contato Teste ${n}`,
  phone: `554899998${String(n).padStart(4, '0')}`,
  interest: 'Avaliação',
  unit: 'Teste',
  source: 'Cadastro manual',
});
const lead = (n = 1) => ops.ingest(input(n), `event-${n}`, manager.id);
test('exclusão Mongo: autorização, confirmação, versão e API idempotente', () =>
  checkDeletePermissions(ops, manager, users, password, () => now));
test('exclusão Mongo: remove dados relacionados e preserva outros leads', () =>
  checkDeleteCleanup(ops, manager, users, () => now));
test('exclusão Mongo: contato compartilhado e atendimento encerrado', () =>
  checkDeleteShared(ops, manager, users));
test('exclusão Mongo: reentrega WhatsApp não recria lead excluído', () =>
  checkDeleteWebhook(ops, manager));
const row = async (id: string) => (await db.one('opportunities', { id }))!;
const lose = {
  name: 'Contato Teste',
  email: '',
  instagram: '',
  interest: 'Avaliação',
  unit: 'Teste',
  stage: 'DECLINED',
  procedure_date: null,
  next_action: '',
};
const key = () => randomUUID();
test('push: entrega privada, fila durável, concorrência, expiração e revogação em MongoDB', async () => {
  await checkPush(
    db,
    ops,
    manager,
    users,
    password,
    () => now,
    (ms) => {
      now = new Date(now.getTime() + ms);
    },
  );
});

test('relatórios Mongo: período, equipe, bolsão, funil e acesso administrativo', async () => {
  await checkReports(
    db,
    ops,
    manager,
    users,
    () => now,
    (milliseconds) => {
      now = new Date(now.getTime() + milliseconds);
    },
  );
});
const headers = { 'x-artisti-client': 'web' };
const config = {
  appSecret: 'test-secret-only-123456',
  verifyToken: 'test-verify-token-only-1234567890123456',
  wabaId: '111',
  phoneNumberId: '222',
};
const payload = (id = 'message-1') =>
  Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '111',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '222' },
                contacts: [{ wa_id: input().phone, profile: { name: 'Contato Teste' } }],
                messages: [
                  {
                    id,
                    from: input().phone,
                    type: 'text',
                    text: { body: 'private-message-not-stored' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
const sign = (raw: Buffer) =>
  `sha256=${createHmac('sha256', config.appSecret).update(raw).digest('hex')}`;

test('Mongo: painel de distribuição, paginação acima de 500, filtros, prazo e acesso', async () => {
  await checkDistribution(
    db,
    ops,
    manager,
    users,
    password,
    () => now,
    () => {
      now = new Date(now.getTime() + 600000);
    },
  );
});

test('Mongo: rodízio sequencial 1→2→3→4→1 e prazo persistente', async () => {
  for (let i = 1; i <= 9; i++) {
    const r = await row((await lead(i)).id);
    assert.equal(r.reserved_to, users[(i - 1) % 4].id);
    assert.equal(r.expires_at.getTime(), now.getTime() + 600_000);
  }
  assert.equal((await db.one('distribution_settings', { id: 1 }))!.last_position, 1);
});
test('Mongo: entradas simultâneas distribuem sem perder cursor e retries não duplicam', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => lead(i + 1)));
  assert.equal(new Set(results.map((r) => r.id)).size, 12);
  for (const u of users) assert.equal(await db.count('opportunities', { reserved_to: u.id }), 3);
  const repeats = await Promise.all(Array.from({ length: 6 }, () => lead(1)));
  assert.ok(repeats.every((r) => r.id === results[0].id && r.duplicate));
  assert.equal(await db.count('opportunities'), 12);
  assert.equal(await db.count('inbound_events'), 12);
  await assert.rejects(ops.ingest({ ...input(1), name: 'Mudou' }, 'event-1', null), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});
test('Mongo: contato repetido preserva reserva e não reinicia dez minutos', async () => {
  const { id } = await lead();
  const before = await row(id);
  now = new Date(now.getTime() + 100_000);
  assert.equal((await ops.ingest(input(), 'other-event', null)).id, id);
  const after = await row(id);
  assert.deepEqual(after.expires_at, before.expires_at);
  assert.equal(after.reserved_to, before.reserved_to);
  assert.equal(await db.count('contacts'), 1);
});
test('Mongo: prazo exato, reinício do cliente e bolsão com um único vencedor', async () => {
  const { id } = await lead();
  now = new Date(now.getTime() + 599_999);
  assert.equal(await ops.expire(), 0);
  now = new Date(now.getTime() + 1);
  await db.close();
  db = await openMongo(replica.getUri(), database);
  ops = new MongoOperations(db, () => now);
  await assert.rejects(ops.claim(users[0], id, 'reservation', 1, key()), {
    code: 'RESERVATION_EXPIRED',
  });
  assert.equal(await ops.expire(), 1);
  assert.equal(await ops.expire(), 0);
  const results = await Promise.allSettled(users.map((u) => ops.claim(u, id, 'pool', 2, key())));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    await db.count('audit_events', { kind: 'reservation.expired', opportunity_id: id }),
    1,
  );
  assert.equal(await db.count('claims'), 1);
});
test('Mongo: aceite antes do sweep registra vencimento apenas uma vez', async () => {
  const { id } = await lead();
  now = new Date(now.getTime() + 600_000);
  await ops.claim(users[2], id, 'pool', 1, key());
  assert.equal(await ops.expire(), 0);
  assert.equal(
    await db.count('audit_events', { opportunity_id: id, kind: 'reservation.expired' }),
    1,
  );
});
test('Mongo: reserva protege contato e bolsão libera dados para a equipe ativa', async () => {
  const { id } = await lead();
  const reserved = await ops.detail(users[0], id);
  assert.equal(reserved.phone, undefined);
  assert.deepEqual(reserved.history, []);
  await assert.rejects(ops.detail(users[1], id), { code: 'NOT_FOUND' });
  now = new Date(now.getTime() + 600_000);
  const pool = await ops.snapshot(users[1]);
  assert.equal(pool.opportunities[0].name, input().name);
  assert.equal(pool.opportunities[0].phone, input().phone);
  assert.ok(!JSON.stringify(pool).includes('password_hash'));
  assert.equal((await ops.detail(users[1], id)).phone, input().phone);
  await ops.claim(users[1], id, 'pool', 2, key());
  assert.equal((await ops.detail(users[1], id)).phone, input().phone);
  assert.equal((await ops.snapshot(users[0])).opportunities.length, 0);
});
test('Mongo: pausa exclui do rodízio, preserva reserva e permite disputar bolsão', async () => {
  const { id } = await lead();
  await ops.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: [{ id: users[0].id, enabled: false }],
  });
  await ops.claim(users[0], id, 'reservation', 1, key());
  for (let i = 2; i <= 5; i++)
    assert.notEqual((await row((await lead(i)).id)).reserved_to, users[0].id);
  now = new Date(now.getTime() + 600_000);
  await ops.expire();
  const pooled = (await db.one('opportunities', { state: 'POOL' }))!;
  await ops.claim(users[0], pooled.id, 'pool', pooled.version, key());
});
test('Mongo: pendências são distribuídas ao habilitar equipe, sem mudar reservas antigas', async () => {
  await ops.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: users.map((u) => ({ id: u.id, enabled: false })),
  });
  const { id } = await lead();
  assert.equal((await row(id)).state, 'PENDING');
  await ops.configure(manager, {
    version: 2,
    timeout_minutes: 7,
    participants: [{ id: users[2].id, enabled: true }],
  });
  const r = await row(id);
  assert.equal(r.reserved_to, users[2].id);
  assert.equal(r.expires_at.getTime(), now.getTime() + 420_000);
  await ops.configure(manager, { version: 3, timeout_minutes: 20, participants: [] });
  assert.deepEqual((await row(id)).expires_at, r.expires_at);
  await assert.rejects(
    ops.configure(manager, { version: 1, timeout_minutes: 10, participants: [] }),
    { code: 'VERSION_CONFLICT' },
  );
});
test('Mongo: transferência idempotente e replay de aceite antigo não recupera contato', async () => {
  const { id } = await lead();
  const claimKey = key();
  await ops.claim(users[0], id, 'reservation', 1, claimKey);
  assert.deepEqual(await ops.claim(users[0], id, 'reservation', 1, claimKey), { id, version: 2 });
  const transferKey = key(),
    input = { expected_version: 2, target_id: users[1].id, reason: 'Transferência de teste' };
  await ops.transfer(manager, id, input, transferKey);
  await ops.transfer(manager, id, input, transferKey);
  assert.equal((await row(id)).version, 3);
  assert.equal((await row(id)).claimed_at, null);
  assert.equal((await db.one('distribution_settings', { id: 1 }))!.last_position, 1);
  await assert.rejects(ops.claim(users[0], id, 'reservation', 1, claimKey), {
    code: 'CLAIM_SUPERSEDED',
  });
  await assert.rejects(ops.detail(users[0], id), { code: 'NOT_FOUND' });
});
test('Mongo: desativação exige substituta, transfere em transação e revoga acesso', async () => {
  const { id } = await lead();
  const input = {
    expected_version: 1,
    name: users[0].name,
    active: false,
    reason: 'Desativação de teste',
  };
  await assert.rejects(ops.updateAttendant(manager, users[0].id, input, key()), {
    code: 'REPLACEMENT_REQUIRED',
  });
  assert.equal((await row(id)).reserved_to, users[0].id);
  await db.insert('sessions', {
    token_hash: 'test-session',
    user_id: users[0].id,
    auth_version: 1,
    expires_at: new Date(Date.now() + 100000),
  });
  await ops.updateAttendant(manager, users[0].id, { ...input, replacement_id: users[1].id }, key());
  assert.equal((await row(id)).owner_id, users[1].id);
  assert.equal(await db.count('sessions', { user_id: users[0].id }), 0);
  await assert.rejects(ops.claim(users[0], id, 'reservation', 1, key()), {
    code: 'UNAUTHENTICATED',
  });
  await assert.rejects(ops.snapshot(users[0]), { code: 'UNAUTHENTICATED' });
});
test('Mongo: atualização e agendamento concorrentes respeitam versões e avaliação única', async () => {
  const { id } = await lead();
  await ops.claim(users[0], id, 'reservation', 1, key());
  const input = {
    expected_version: 2,
    starts_at: new Date(now.getTime() + 3_600_000).toISOString(),
    unit: 'Teste',
  };
  const results = await Promise.allSettled([
    ops.schedule(users[0], id, input),
    ops.schedule(users[0], id, input),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await db.count('appointments'), 1);
  await assert.rejects(ops.update(users[0], id, { ...lose, version: 3 }), {
    code: 'OPEN_APPOINTMENTS',
  });
  const appt = (await db.one('appointments', { opportunity_id: id }))!;
  const change = {
    expected_version: 1,
    starts_at: input.starts_at,
    unit: 'Alterado',
    status: 'completed' as const,
    reason: 'Conclusão de teste',
  };
  await assert.rejects(ops.changeAppointment(users[0], appt.id, change, key()), {
    code: 'INVALID_DATE',
  });
  now = new Date(now.getTime() + 3_600_000);
  await ops.changeAppointment(users[0], appt.id, change, key());
  assert.equal((await db.one('appointments', { id: appt.id }))!.unit, 'Teste');
  await assert.rejects(
    ops.changeAppointment(users[0], appt.id, { ...change, expected_version: 2 }, key()),
    { code: 'APPOINTMENT_CLOSED' },
  );
  await ops.update(users[0], id, {
    ...lose,
    version: 4,
    stage: 'CLOSED_WITH_DATE',
    procedure_date: '2026-10-20',
  });
  assert.equal((await row(id)).open, false);
  assert.equal((await row(id)).procedure_date, '2026-10-20');
});
test('Mongo: retorno após perdido preserva histórico e exige revisão', async () => {
  const { id } = await lead();
  await ops.update(manager, id, { ...lose, version: 1 });
  const returned = await ops.ingest(input(), 'new-return', null);
  assert.notEqual(returned.id, id);
  assert.equal((await row(returned.id)).needs_review, true);
  await ops.configure(manager, { version: 1, timeout_minutes: 10, participants: [] });
  assert.equal((await row(returned.id)).state, 'PENDING');
  assert.equal(await db.count('contacts'), 1);
  assert.equal(await db.count('opportunities'), 2);
  await assert.rejects(ops.update(manager, id, { ...lose, version: 2, stage: 'FOLLOW_UP' }), {
    code: 'REENTRY_PENDING',
  });
  await assert.rejects(
    ops.update(manager, returned.id, {
      ...lose,
      version: 1,
      stage: 'CLOSED_WITH_DATE',
      procedure_date: null,
    }),
    { code: 'PROCEDURE_DATE_REQUIRED' },
  );
});
test('Mongo: criação com login simples, senha curta, reset e revogação', async () => {
  const createKey = key(),
    input = {
      name: 'Nova Teste',
      email: 'atendente5',
      password: '1',
      queue_position: 5,
    };
  const created = await ops.createAttendant(manager, input, createKey);
  assert.deepEqual(await ops.createAttendant(manager, input, createKey), created);
  let user = publicUser((await db.one('users', { id: created.id }))!);
  assert.equal(user.must_change_password, false);
  assert.equal((await ops.snapshot(user)).user.id, user.id);
  assert.equal(user.must_change_password, false);
  await ops.resetPassword(manager, user.id, '2', user.version, key());
  await assert.rejects(ops.snapshot(user), { code: 'UNAUTHENTICATED' });
  assert.ok(!JSON.stringify(await db.many('operation_receipts')).includes('"password":"1"'));
  assert.ok(!JSON.stringify(await db.many('audit_events')).includes('"password":"2"'));
});
test('Mongo: exclusão permanente exige conta inativa e remove a atendente', async () => {
  const created = await ops.createAttendant(
    manager,
    {
      name: 'Conta Temporária',
      email: 'temporaria',
      password: '1',
      queue_position: 8,
    },
    key(),
  );
  await assert.rejects(
    ops.deleteAttendant(
      manager,
      created.id,
      { expected_version: 1, confirmation: 'EXCLUIR' },
      key(),
    ),
    { code: 'ACTIVE_USER' },
  );
  await ops.updateAttendant(
    manager,
    created.id,
    {
      expected_version: 1,
      name: 'Conta Temporária',
      active: false,
      reason: 'Encerramento da conta temporária.',
    },
    key(),
  );
  const deleteKey = key();
  assert.deepEqual(
    await ops.deleteAttendant(
      manager,
      created.id,
      { expected_version: 2, confirmation: 'EXCLUIR' },
      deleteKey,
    ),
    { deleted: true },
  );
  assert.deepEqual(
    await ops.deleteAttendant(
      manager,
      created.id,
      { expected_version: 2, confirmation: 'EXCLUIR' },
      deleteKey,
    ),
    { deleted: true },
  );
  assert.equal(await db.count('users', { id: created.id }), 0);
});
test('Mongo: transação abortada não deixa escrita parcial e índices impedem duplicatas', async () => {
  await assert.rejects(
    db.atomic(async (tx) => {
      await tx.insert('contacts', { id: key(), phone: input().phone });
      throw new Error('forced rollback');
    }),
    /forced rollback/,
  );
  assert.equal(await db.count('contacts'), 0);
  await lead();
  await assert.rejects(db.insert('contacts', { id: key(), phone: input().phone }), { code: 11000 });
  await initializeMongo(db);
  assert.equal(await db.count('opportunities'), 1);
});
test('Mongo: HTTP login, cookie seguro, dados persistidos, origem e logout', async () => {
  const { app } = await buildApp(db, {
    clock: () => now,
    production: true,
    appOrigin: 'https://test.example',
    reconcile: false,
  });
  try {
    assert.equal((await app.inject({ url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/workspace' })).statusCode, 401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers,
      payload: { email: manager.email.toUpperCase(), password },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.match(String(login.headers['set-cookie']), /Secure/);
    const authenticated = { ...headers, cookie: `artisti_session=${login.cookies[0].value}` };
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      headers: { ...authenticated, 'idempotency-key': key() },
      payload: input(),
    });
    assert.equal(create.statusCode, 201, create.body);
    const workspace = await app.inject({ url: '/api/v1/workspace', headers: authenticated });
    assert.equal(workspace.statusCode, 200, workspace.body);
    assert.equal(workspace.json().opportunities.length, 1);
    assert.equal(workspace.json().demo, false);
    assert.ok(!workspace.body.includes('password_hash'));
    assert.doesNotMatch(workspace.body, /"_id":/);
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...authenticated, origin: 'https://other.example' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authenticated }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/workspace', headers: authenticated })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test('Mongo: webhook assinado persiste lote, deduplica e retoma após nova conexão', async () => {
  let central = new WhatsAppCentral(ops, config);
  const raw = payload();
  await assert.rejects(central.receive(raw, 'invalid'), { code: 'INVALID_SIGNATURE' });
  await Promise.all([central.receive(raw, sign(raw)), central.receive(raw, sign(raw))]);
  assert.equal((await central.status()).pending, 1);
  assert.equal(await db.count('opportunities'), 0);
  assert.ok(
    !JSON.stringify(await db.many('whatsapp_inbox')).includes('private-message-not-stored'),
  );
  await db.close();
  db = await openMongo(replica.getUri(), database);
  ops = new MongoOperations(db, () => now);
  central = new WhatsAppCentral(ops, config);
  await Promise.all([central.drain(), new WhatsAppCentral(ops, config).drain()]);
  assert.equal((await central.status()).pending, 0);
  assert.equal(await db.count('opportunities'), 1);
  await central.receive(raw, sign(raw));
  await central.drain();
  assert.equal(await db.count('opportunities'), 1);
  const unknown = Buffer.from(raw.toString().replace('"id":"111"', '"id":"999"'));
  await central.receive(unknown, sign(unknown));
  assert.equal(await db.count('whatsapp_inbox'), 1);
});
test('Mongo: mantém o histórico de referências Meta sem consultar serviços externos', async () => {
  const first = await ops.ingest(
    {
      ...input(20),
      source: 'Meta Ads',
      source_evidence: 'Referência sintética recebida no webhook.',
      meta_attribution: {
        provider: 'meta',
        channel: 'whatsapp',
        source_type: 'ad',
        source_id: 'mongo-ad-1',
        ctwa_clid: 'mongo-click-1',
      },
    },
    'mongo-meta-event-1',
    null,
  );
  await ops.ingest(
    {
      ...input(20),
      source: 'Meta Ads',
      source_evidence: 'Referência sintética recebida no webhook.',
      meta_attribution: {
        provider: 'meta',
        channel: 'whatsapp',
        source_type: 'ad',
        source_id: 'mongo-ad-2',
        ctwa_clid: 'mongo-click-2',
      },
    },
    'mongo-meta-event-2',
    null,
  );
  const detail = await ops.detail(manager, first.id);
  assert.deepEqual(detail.attributions.map((item) => item.source_id).sort(), [
    'mongo-ad-1',
    'mongo-ad-2',
  ]);
  const serialized = JSON.stringify(detail.attributions);
  assert.ok(!serialized.includes('mongo-click'));
  assert.ok(!serialized.includes('mongo-meta-event'));
  assert.ok(!serialized.includes(first.id));
  const reserved = users.find((user) => user.id === detail.reserved_to)!;
  assert.deepEqual((await ops.detail(reserved, first.id)).attributions, []);
});
test('Mongo: falha de processamento mantém inbox para retry e lease vencida é recuperada', async () => {
  const central = new WhatsAppCentral(ops, config);
  const raw = payload();
  await central.receive(raw, sign(raw));
  const original = ops.ingest.bind(ops);
  ops.ingest = async () => {
    throw new Error('test failure');
  };
  await central.drain();
  assert.equal((await central.status()).retrying, 1);
  assert.equal(await db.count('opportunities'), 0);
  ops.ingest = original;
  await db.update(
    'whatsapp_inbox',
    {},
    { $set: { available_at: new Date(0), lease_id: 'crashed-worker' } },
  );
  await central.drain();
  assert.equal((await central.status()).pending, 0);
  assert.equal(await db.count('opportunities'), 1);
});
test('Mongo: bootstrap é idempotente, banco vazio exige credenciais próprias', async () => {
  await db.remove('users', {});
  await assert.rejects(bootstrapMongo(db), /Banco vazio/);
  await bootstrapMongo(db, 'bootstrap@example.test', '123abc');
  await bootstrapMongo(db, 'other@example.test', '987zyx');
  assert.equal(await db.count('users'), 1);
  assert.equal((await db.one('users', {}))!.email, 'bootstrap@example.test');
  assert.equal((await db.one('users', {}))!.must_change_password, false);
});
test(
  'Mongo: usuário readWrite somente em artisti pode inicializar e operar',
  { timeout: 120_000 },
  async () => {
    // Atlas-equivalent authorization is verified by an authenticated client on a separate replica set.
    const secured = await MongoMemoryReplSet.create({
      binary: { version: '8.0.12' },
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
        auth: { enable: true, customRootName: 'rootTest', customRootPwd: 'testRootOnly' },
      },
    });
    let limited: MongoStore | undefined;
    const root = new MongoClient(secured.getUri(), {
      auth: { username: 'rootTest', password: 'testRootOnly' },
      authSource: 'admin',
    });
    try {
      await root.connect();
      await root.db('admin').command({
        createUser: 'crmTest',
        pwd: 'testOnly',
        roles: [{ role: 'readWrite', db: 'artisti' }],
      });
      const uri = new URL(secured.getUri());
      uri.username = 'crmTest';
      uri.password = 'testOnly';
      uri.searchParams.set('authSource', 'admin');
      limited = await openMongo(uri.toString(), 'artisti');
      await initializeMongo(limited);
      await bootstrapMongo(limited, 'admin@example.test', '123abc');
      assert.equal(await limited.count('users'), 1);
      const crm = new MongoOperations(limited);
      const result = await crm.ingest(input(), 'event', null);
      assert.ok(result.id);
    } finally {
      await limited?.close();
      await root.close();
      await secured.stop();
    }
  },
);
