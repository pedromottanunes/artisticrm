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
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import { MetaMarketing, type MetaMarketingConfig } from '../src/meta-marketing.js';
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
const instagramTestConfig: InstagramConfig = {
  appSecret: 'instagram-mongo-test-secret',
  verifyToken: 'instagram-mongo-test-verify-token-32-chars',
  accountId: '17841435843170000',
  accessToken: 'IGAA-mongo-test-token-never-used',
  graphApiVersion: 'v26.0',
  profileLookup: false,
};
const metaMarketingTestConfig: MetaMarketingConfig = {
  accessToken: 'synthetic-mongo-marketing-token-never-used',
  adAccountId: 'act_1789815972431863',
  graphApiVersion: 'v26.0',
};
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

test('Mongo: peso 2 distribui quatro de dez leads e persiste a configuração', async () => {
  await ops.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: users.map((user, index) => ({
      id: user.id,
      enabled: true,
      weight: index === 0 ? 2 : 1,
    })),
  });
  for (let index = 201; index <= 210; index++) await lead(index);
  const counts = await Promise.all(
    users.map((user) => db.count('opportunities', { reserved_to: user.id })),
  );
  assert.deepEqual(counts, [4, 2, 2, 2]);
  const saved = await db.many('users', { role: 'attendant' }, { queue_position: 1 });
  assert.deepEqual(
    saved.map((user) => user.queue_weight),
    [2, 1, 1, 1],
  );
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
    status: 'attended' as const,
    reason: 'Conclusão de teste',
  };
  await assert.rejects(ops.changeAppointment(users[0], appt.id, change, key()), {
    code: 'INVALID_DATE',
  });
  now = new Date(now.getTime() + 3_600_000);
  await ops.changeAppointment(users[0], appt.id, change, key());
  assert.equal((await db.one('appointments', { id: appt.id }))!.unit, 'Teste');
  assert.equal((await row(id)).consultation_status, 'ATTENDED');
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
test('Mongo: falta mantém follow-up e venda estrutura os dados comerciais', async () => {
  const { id } = await lead(2);
  const appointment = await ops.schedule(manager, id, {
    expected_version: 1,
    starts_at: '2026-09-10T13:00:00Z',
    unit: 'Florianópolis',
  });
  now = new Date('2026-09-10T14:00:00Z');
  await ops.changeAppointment(
    manager,
    appointment.id,
    {
      expected_version: 1,
      status: 'no_show',
      starts_at: '2026-09-10T13:00:00Z',
      unit: 'Florianópolis',
      reason: 'Paciente não compareceu.',
    },
    key(),
  );
  assert.equal((await row(id)).consultation_status, 'NO_SHOW');
  assert.equal((await row(id)).stage, 'FOLLOW_UP');
  await ops.recordSale(
    manager,
    id,
    {
      expected_version: 3,
      name: 'Paciente Mongo',
      phone: '5548999990002',
      residence_city: 'Criciúma',
      consultant: 'Rafa',
      total_value_cents: 1_500_000,
      down_payment_cents: 150_000,
      hair_grade_classification: 'grau 3 A1',
      has_pack: false,
      unit: 'Florianópolis',
      procedure_date: null,
      contract_status: 'awaiting',
    },
    key(),
  );
  const sold = await row(id);
  assert.equal(sold.stage, 'CLOSED_WITHOUT_DATE');
  assert.equal(sold.contract_status, 'awaiting');
  assert.equal(sold.sale_seller_name, manager.name);
  const contact = (await db.one('contacts', { id: sold.contact_id }))!;
  assert.equal(contact.name, 'Paciente Mongo');
  assert.equal(contact.residence_city, 'Criciúma');
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
test('Mongo: exclusão compacta posições e preserva o próximo ponto do rodízio', async () => {
  const removed = await ops.createAttendant(
    manager,
    { name: 'Temporária removida', email: 'temporaria-removida', password: '1', queue_position: 5 },
    key(),
  );
  const trailing = await ops.createAttendant(
    manager,
    { name: 'Temporária final', email: 'temporaria-final', password: '1', queue_position: 6 },
    key(),
  );
  await ops.updateAttendant(
    manager,
    removed.id,
    {
      expected_version: 1,
      name: 'Temporária removida',
      active: false,
      reason: 'Remoção definitiva para testar a compactação da fila.',
    },
    key(),
  );
  await db.update('distribution_settings', { id: 1 }, { $set: { last_position: 5 } });
  await db.update('users', { role: 'attendant' }, { $set: { queue_credit: 7 } });
  await ops.deleteAttendant(
    manager,
    removed.id,
    { expected_version: 2, confirmation: 'EXCLUIR' },
    key(),
  );
  const remaining = await db.many('users', { role: 'attendant' }, { queue_position: 1 });
  assert.deepEqual(
    remaining.map(({ id, queue_position }) => ({ id, queue_position })),
    [...users.map((user) => user.id), trailing.id].map((id, index) => ({
      id,
      queue_position: index + 1,
    })),
  );
  assert.deepEqual(
    remaining.map((user) => user.queue_credit),
    [0, 0, 0, 0, 0],
  );
  assert.equal((await db.one('distribution_settings', { id: 1 }))!.last_position, 4);
});
test('Mongo: inicialização repara posições antigas que já continham lacunas', async () => {
  await db.remove('users', { role: 'attendant' });
  for (let index = 0; index < 4; index++)
    await db.insert(
      'users',
      mongoUser({
        name: `Legada ${index + 1}`,
        email: `legada${index + 1}`,
        password_hash,
        role: 'attendant',
        queue_position: index + 4,
      }),
    );
  await db.update('distribution_settings', { id: 1 }, { $set: { last_position: 5 } });
  await initializeMongo(db);
  assert.deepEqual(
    (await db.many('users', { role: 'attendant' }, { queue_position: 1 })).map(
      (user) => user.queue_position,
    ),
    [1, 2, 3, 4],
  );
  assert.equal((await db.one('distribution_settings', { id: 1 }))!.last_position, 2);
});
test('Mongo: migração classifica leads antigos como novos sem desfazer decisão do vendedor', async () => {
  const legacy = await lead(92);
  const classified = await lead(93);
  await db.update(
    'opportunities',
    { id: legacy.id },
    {
      $set: { stage: 'CONSULTATION_NOT_SCHEDULED' },
      $unset: { consultation_status: '' },
    },
  );
  await db.update(
    'opportunities',
    { id: classified.id },
    {
      $set: {
        stage: 'CONSULTATION_NOT_SCHEDULED',
        consultation_status: 'NOT_SCHEDULED',
      },
    },
  );
  await initializeMongo(db);
  assert.equal((await row(legacy.id)).stage, 'NEW_LEAD');
  assert.equal((await row(legacy.id)).consultation_status, 'UNDEFINED');
  assert.equal((await row(classified.id)).stage, 'CONSULTATION_NOT_SCHEDULED');
  assert.equal((await row(classified.id)).consultation_status, 'NOT_SCHEDULED');
});
test('Mongo: migração de canal preserva manual e reconhece evento legado do WhatsApp', async () => {
  const manual = await ops.ingest(input(90), 'legacy-manual-event', manager.id);
  const whatsapp = await ops.ingest(input(91), 'whatsapp:legacy-account:legacy-message', null);
  await db
    .collection('opportunities')
    .updateMany({ id: { $in: [manual.id, whatsapp.id] } }, { $unset: { channel: '' } });
  await initializeMongo(db);
  assert.equal((await row(manual.id)).channel, 'manual');
  assert.equal((await row(whatsapp.id)).channel, 'whatsapp');
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
test('Mongo: Direct do Instagram cria identidade sem telefone, conversa e mensagem', async () => {
  const profileRequests: string[] = [];
  const profileFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const senderId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    profileRequests.push(senderId);
    assert.equal(
      init?.headers && new Headers(init.headers).get('Authorization'),
      `Bearer ${instagramTestConfig.accessToken}`,
    );
    return new Response(
      JSON.stringify({
        id: senderId,
        name: senderId === 'mongo-ig-scoped-user' ? 'Perfil Mongo' : 'Outro Perfil',
        username: senderId === 'mongo-ig-scoped-user' ? 'perfil.mongo' : 'outro.perfil',
        profile_pic: `https://scontent.example.test/${senderId}.jpg`,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const profileConfig = { ...instagramTestConfig, profileLookup: true };
  const central = new InstagramCentral(ops, profileConfig, profileFetch);
  const body = Buffer.from(
    JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: instagramTestConfig.accountId,
          messaging: [
            {
              sender: { id: 'mongo-ig-scoped-user' },
              recipient: { id: instagramTestConfig.accountId },
              timestamp: now.getTime(),
              message: { mid: 'mongo-ig-message-1', text: 'Mensagem Instagram Mongo' },
            },
          ],
        },
      ],
    }),
  );
  const sig = `sha256=${createHmac('sha256', instagramTestConfig.appSecret)
    .update(body)
    .digest('hex')}`;
  await Promise.all([central.receive(body, sig), central.receive(body, sig)]);
  await Promise.all([
    central.drain(),
    new InstagramCentral(ops, profileConfig, profileFetch).drain(),
  ]);
  assert.equal(await db.count('contacts'), 1);
  assert.equal(await db.count('contact_identities'), 1);
  assert.equal(await db.count('opportunities'), 1);
  assert.equal(await db.count('conversations'), 1);
  assert.equal(await db.count('messages'), 1);
  const contact = await db.one('contacts', {});
  assert.equal(contact?.phone, undefined);
  assert.equal(contact?.name, 'Perfil Mongo');
  assert.equal(contact?.instagram, 'perfil.mongo');
  const identity = await db.one('contact_identities', {});
  assert.equal(identity?.external_user_id, 'mongo-ig-scoped-user');
  assert.equal(identity?.display_name, 'Perfil Mongo');
  assert.equal(identity?.username, 'perfil.mongo');
  assert.equal(
    identity?.profile_picture_url,
    'https://scontent.example.test/mongo-ig-scoped-user.jpg',
  );
  assert.ok(identity?.profile_updated_at);
  const opportunity = await db.one<{ id: string; contact_id: string; version: number }>(
    'opportunities',
    {},
  );
  const conversation = await db.one<{ id: string }>('conversations', {});
  assert.ok(opportunity && conversation);
  assert.equal((await db.one('opportunities', {}))?.interest, 'Direct do Instagram');
  await db.update('contacts', { id: opportunity.contact_id }, { $set: { instagram: '' } });
  const reservedDetail = await ops.detail(users[0], opportunity.id);
  assert.equal(reservedDetail.instagram, 'perfil.mongo');
  assert.equal(
    reservedDetail.profile_picture_url,
    'https://scontent.example.test/mongo-ig-scoped-user.jpg',
  );
  await ops.claim(users[0], opportunity.id, 'reservation', opportunity.version, randomUUID());
  const listed = await central.list(users[0], 'mine');
  assert.equal(listed.conversations.length, 1);
  assert.equal(listed.conversations[0]?.contact_name, 'Perfil Mongo');
  assert.equal(listed.conversations[0]?.instagram_username, 'perfil.mongo');
  assert.equal(
    listed.conversations[0]?.profile_picture_url,
    'https://scontent.example.test/mongo-ig-scoped-user.jpg',
  );
  assert.deepEqual(profileRequests, ['mongo-ig-scoped-user']);
  assert.equal((await central.messages(users[0], conversation.id)).messages.length, 1);
  await db.insert('messages', {
    id: randomUUID(),
    conversation_id: conversation.id,
    direction: 'outbound',
    type: 'text',
    text: 'Envio interrompido',
    status: 'sending',
    sending_started_at: new Date(now.getTime() - 300_000),
    created_at: new Date(now.getTime() - 300_000),
  });
  assert.equal(await central.recoverStaleSends(), 1);
  assert.equal((await db.one('messages', { text: 'Envio interrompido' }))?.status, 'unknown');

  const referralBody = Buffer.from(
    JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: instagramTestConfig.accountId,
          messaging: [
            {
              sender: { id: 'mongo-ig-referral-user' },
              recipient: { id: instagramTestConfig.accountId },
              timestamp: now.getTime() + 1_000,
              referral: {
                source: 'ADS',
                type: 'OPEN_THREAD',
                ad_id: 'mongo-standalone-ad',
                referer_uri: 'https://example.test/mongo-ad',
              },
            },
          ],
        },
      ],
    }),
  );
  const referralSig = `sha256=${createHmac('sha256', instagramTestConfig.appSecret)
    .update(referralBody)
    .digest('hex')}`;
  await central.receive(referralBody, referralSig);
  await central.drain();
  assert.equal(await db.count('instagram_pending_referrals'), 1);
  assert.equal(await db.count('opportunities'), 1);

  const attributedMessage = Buffer.from(
    JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: instagramTestConfig.accountId,
          messaging: [
            {
              sender: { id: 'mongo-ig-referral-user' },
              recipient: { id: instagramTestConfig.accountId },
              timestamp: now.getTime() + 2_000,
              message: { mid: 'mongo-message-after-referral', text: 'Vim pelo anuncio' },
            },
          ],
        },
      ],
    }),
  );
  const attributedSig = `sha256=${createHmac('sha256', instagramTestConfig.appSecret)
    .update(attributedMessage)
    .digest('hex')}`;
  await central.receive(attributedMessage, attributedSig);
  await central.drain();
  assert.equal(await db.count('instagram_pending_referrals'), 0);
  assert.equal(
    (await db.one('lead_attributions', { source_id: 'mongo-standalone-ad' }))?.source_url,
    'https://example.test/mongo-ad',
  );
  assert.equal((await central.status()).pending, 0);
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
test('Mongo: Marketing API persiste insights e cruza somente evidência explícita', async () => {
  const request = (async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            date_start: '2026-09-10',
            date_stop: '2026-09-10',
            account_id: '1789815972431863',
            account_name: 'Conta Mongo',
            account_currency: 'BRL',
            campaign_id: 'mongo-campaign',
            campaign_name: 'Campanha Mongo',
            adset_id: 'mongo-adset',
            adset_name: 'Conjunto Mongo',
            ad_id: 'mongo-ad',
            ad_name: 'Anúncio Mongo',
            spend: '12.50',
            impressions: '100',
            reach: '90',
            clicks: '5',
            actions: [],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const marketing = new MetaMarketing(db, metaMarketingTestConfig, request, () => now);
  await marketing.sync(1);
  await ops.ingest(
    {
      name: 'Contato Instagram Mongo',
      interest: 'Direct do Instagram',
      unit: 'Teste',
      source: 'Meta Ads — Instagram Direct',
      source_evidence: 'Referência explícita de anúncio.',
      identity: {
        provider: 'instagram',
        account_id: instagramTestConfig.accountId,
        external_user_id: 'mongo-marketing-user',
      },
      meta_attribution: {
        provider: 'meta',
        channel: 'instagram',
        source_type: 'ad',
        source_id: 'mongo-ad',
      },
    },
    'mongo-marketing-event',
    null,
  );
  const report = await marketing.report('2026-09-10', '2026-09-10');
  assert.equal(await db.count('meta_marketing_daily_insights'), 1);
  assert.equal(report.spend, 12.5);
  assert.equal(report.instagram_leads, 1);
  assert.equal(report.matched_attributed_leads, 1);
  assert.equal(report.cpl, 12.5);
  const emptyMarketing = new MetaMarketing(
    db,
    metaMarketingTestConfig,
    (async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    () => now,
  );
  await emptyMarketing.sync(1);
  assert.equal(await db.count('meta_marketing_daily_insights'), 0);
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
