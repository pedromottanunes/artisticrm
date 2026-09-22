import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { Operations } from '../src/operations.js';
import {
  checkDeletePermissions,
  checkDeleteCleanup,
  checkDeleteShared,
  checkDeleteWebhook,
} from './deletion-checks.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import type { User, Opportunity } from '../src/types.js';

let db: Database, ops: Operations, manager: User, users: User[];
let now = new Date('2026-09-10T12:00:00Z');
let admin: Database | undefined,
  schema = '';
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    schema = `artisti_ops_${randomUUID().replaceAll('-', '')}`;
    admin = await openDatabase('memory://', process.env.TEST_DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = await openDatabase('memory://', url.toString());
  } else db = await openDatabase();
  await migrate(db);
  ops = new Operations(db, () => now);
  await seedDemo(ops, false);
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE deleted_inbound_events,push_records,whatsapp_inbox,operation_receipts,claims,appointments,lead_attributions,inbound_events,audit_events,opportunities,contacts,sessions',
  );
  await db.query("DELETE FROM users WHERE email NOT LIKE '%@demo.artisti.local'");
  const { hashPassword } = await import('../src/auth.js');
  const hash = await hashPassword(DEMO_PASSWORD);
  await db.query(
    "UPDATE users SET active=true,queue_enabled=(role='attendant'),version=1,auth_version=1,must_change_password=false,password_hash=$1",
    [hash],
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10,version=1');
  [manager, ...users] = (
    await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST')
  ).rows;
  now = new Date('2026-09-10T12:00:00Z');
});
after(async () => {
  await db.close();
  if (admin) {
    assert.match(schema, /^artisti_ops_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
const lead = async (n = 1) =>
  await ops.ingest(
    {
      name: 'Contato Teste',
      phone: `554899998${String(n).padStart(4, '0')}`,
      interest: 'Avaliação',
      unit: 'Teste',
      source: 'Cadastro manual',
    },
    `lead-${n}`,
    manager.id,
  );
const row = async (id: string) =>
  (await db.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1', [id])).rows[0];
const update = {
  name: 'Contato Teste',
  email: '',
  instagram: '',
  interest: 'Avaliação',
  unit: 'Teste',
  stage: 'DECLINED',
  procedure_date: null,
  next_action: '',
};

test('exclusão SQL: autorização, confirmação, versão e API idempotente', () =>
  checkDeletePermissions(ops, manager, users, DEMO_PASSWORD, () => now));
test('exclusão SQL: remove dados relacionados e preserva outros leads', () =>
  checkDeleteCleanup(ops, manager, users, () => now));
test('exclusão SQL: contato compartilhado e atendimento encerrado', () =>
  checkDeleteShared(ops, manager, users));
test('exclusão SQL: reentrega WhatsApp não recria lead excluído', () =>
  checkDeleteWebhook(ops, manager));

test('transferência é auditada, idempotente e não muda cursor nem marca aceite', async () => {
  const { id } = await lead();
  const key = randomUUID();
  const input = {
    expected_version: 1,
    target_id: users[1].id,
    reason: 'Transferência solicitada pela gestão',
  };
  const first = await ops.transfer(manager, id, input, key);
  assert.deepEqual(await ops.transfer(manager, id, input, key), first);
  const assigned = await row(id);
  assert.equal(assigned.owner_id, users[1].id);
  assert.equal(assigned.claimed_at, null);
  assert.equal(
    (await db.query<{ last_position: number }>('SELECT last_position FROM distribution_settings'))
      .rows[0].last_position,
    1,
  );
  assert.equal(
    Number(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) FROM audit_events WHERE kind='opportunity.transferred'",
        )
      ).rows[0].count,
    ),
    1,
  );
  await assert.rejects(() => ops.detail(users[0], id), { code: 'NOT_FOUND' });
  await assert.rejects(() => ops.claim(users[0], id, 'reservation', 1, randomUUID()));
});
test('transferência concorrente com aceite não produz dois sucessos na mesma versão', async () => {
  const { id } = await lead();
  const results = await Promise.allSettled([
    ops.claim(users[0], id, 'reservation', 1, randomUUID()),
    ops.transfer(
      manager,
      id,
      { expected_version: 1, target_id: users[1].id, reason: 'Teste de concorrência' },
      randomUUID(),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await row(id)).version, 2);
});
test('repetição de aceite antigo após transferência não devolve posse falsa', async () => {
  const { id } = await lead();
  const key = randomUUID();
  await ops.claim(users[0], id, 'reservation', 1, key);
  await ops.transfer(
    manager,
    id,
    { expected_version: 2, target_id: users[1].id, reason: 'Responsabilidade transferida' },
    randomUUID(),
  );
  await assert.rejects(() => ops.claim(users[0], id, 'reservation', 1, key), {
    code: 'CLAIM_SUPERSEDED',
  });
  assert.equal((await row(id)).owner_id, users[1].id);
});
test('atendente não transfere, cria usuários nem redefine senha alheia', async () => {
  const { id } = await lead();
  await assert.rejects(
    () =>
      ops.transfer(
        users[0],
        id,
        { expected_version: 1, target_id: users[1].id, reason: 'Sem permissão' },
        randomUUID(),
      ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    () =>
      ops.createAttendant(
        users[0],
        {
          name: 'Intruso',
          email: 'x@test.dev',
          password: 'temporary-long-password',
          queue_position: 9,
        },
        randomUUID(),
      ),
    { code: 'FORBIDDEN' },
  );
  await assert.rejects(
    () => ops.resetPassword(users[0], users[1].id, 'temporary-long-password', 1, randomUUID()),
    { code: 'FORBIDDEN' },
  );
});
test('desativação sem destino falha sem alterar conta ou lead', async () => {
  await lead();
  await assert.rejects(
    () =>
      ops.updateAttendant(
        manager,
        users[0].id,
        {
          expected_version: 1,
          name: users[0].name,
          active: false,
          reason: 'Desligamento solicitado',
        },
        randomUUID(),
      ),
    { code: 'REPLACEMENT_REQUIRED' },
  );
  assert.equal(
    (await db.query<User>('SELECT * FROM users WHERE id=$1', [users[0].id])).rows[0].active,
    true,
  );
});
test('desativação transfere trabalho, revoga sessões e bloqueia comando autenticado antigo', async () => {
  const { id } = await lead();
  await ops.claim(users[0], id, 'reservation', 1, randomUUID());
  await db.query('INSERT INTO sessions VALUES($1,$2,$3,1)', [
    'test-token',
    users[0].id,
    new Date(now.getTime() + 600_000),
  ]);
  await ops.updateAttendant(
    manager,
    users[0].id,
    {
      expected_version: 1,
      name: users[0].name,
      active: false,
      replacement_id: users[1].id,
      reason: 'Mudança de equipe',
    },
    randomUUID(),
  );
  assert.equal((await row(id)).owner_id, users[1].id);
  assert.equal(
    (await db.query('SELECT * FROM sessions WHERE user_id=$1', [users[0].id])).rows.length,
    0,
  );
  await assert.rejects(() => ops.update(users[0], id, { ...update, version: 3 }), {
    code: 'UNAUTHENTICATED',
  });
});
test('retorno de encerrado aguarda revisão e não é liberado ao salvar fila', async () => {
  const { id } = await lead();
  await ops.update(manager, id, { ...update, version: 1 });
  const returning = await ops.ingest(
    {
      name: 'Contato Teste',
      phone: '5548999980001',
      interest: 'Avaliação',
      unit: 'Teste',
      source: 'Cadastro manual',
    },
    'new-return',
    manager.id,
  );
  assert.notEqual(returning.id, id);
  assert.equal((await row(returning.id)).state, 'PENDING');
  await ops.configure(manager, { version: 1, timeout_minutes: 10, participants: [] });
  assert.equal((await row(returning.id)).state, 'PENDING');
  await ops.transfer(
    manager,
    returning.id,
    { expected_version: 1, target_id: users[1].id, reason: 'Retorno revisado com o paciente' },
    randomUUID(),
  );
  assert.equal((await row(returning.id)).state, 'CLAIMED');
  assert.equal((await row(id)).stage, 'DECLINED');
});
test('remarcação preserva antes/depois, cancelamento não pode ser reescrito', async () => {
  const { id } = await lead();
  const a = await ops.schedule(manager, id, {
    expected_version: 1,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
  });
  const input = {
    expected_version: 1,
    status: 'scheduled' as const,
    starts_at: '2026-09-12T12:00:00Z',
    unit: 'Outra unidade',
    reason: 'Pedido do paciente',
  };
  const key = randomUUID();
  await ops.changeAppointment(manager, a.id, input, key);
  await ops.changeAppointment(manager, a.id, input, key);
  const audit = (
    await db.query<{ details: { before: { unit: string }; after: { unit: string } } }>(
      "SELECT details FROM audit_events WHERE kind='appointment.updated'",
    )
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.before.unit, 'Teste');
  assert.equal(audit[0].details.after.unit, 'Outra unidade');
  await ops.changeAppointment(
    manager,
    a.id,
    { ...input, expected_version: 2, status: 'cancelled' },
    randomUUID(),
  );
  await assert.rejects(
    () => ops.changeAppointment(manager, a.id, { ...input, expected_version: 3 }, randomUUID()),
    { code: 'APPOINTMENT_CLOSED' },
  );
});
test('agenda protege contra duplicação, conclusão futura e encerramento com avaliação aberta', async () => {
  const { id } = await lead();
  const a = await ops.schedule(manager, id, {
    expected_version: 1,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
  });
  await assert.rejects(
    () =>
      ops.schedule(manager, id, {
        expected_version: 2,
        starts_at: '2026-09-12T12:00:00Z',
        unit: 'Teste',
      }),
    { code: 'OPEN_APPOINTMENT' },
  );
  await assert.rejects(() => ops.update(manager, id, { ...update, version: 2 }), {
    code: 'OPEN_APPOINTMENTS',
  });
  const input = {
    expected_version: 1,
    status: 'completed' as const,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
    reason: 'Avaliação realizada',
  };
  await assert.rejects(() => ops.changeAppointment(manager, a.id, input, randomUUID()), {
    code: 'INVALID_DATE',
  });
  now = new Date('2026-09-11T13:00:00Z');
  await ops.changeAppointment(manager, a.id, input, randomUUID());
});
test('edições concorrentes de agenda confirmam uma única versão', async () => {
  const { id } = await lead();
  const a = await ops.schedule(manager, id, {
    expected_version: 1,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
  });
  const input = {
    expected_version: 1,
    status: 'cancelled' as const,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
    reason: 'Cancelamento no teste',
  };
  const results = await Promise.allSettled([
    ops.changeAppointment(manager, a.id, input, randomUUID()),
    ops.changeAppointment(manager, a.id, input, randomUUID()),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
test('atendente alheia não altera avaliação de outra responsável', async () => {
  const { id } = await lead();
  const a = await ops.schedule(manager, id, {
    expected_version: 1,
    starts_at: '2026-09-11T12:00:00Z',
    unit: 'Teste',
  });
  await assert.rejects(
    () =>
      ops.changeAppointment(
        users[1],
        a.id,
        {
          expected_version: 1,
          status: 'cancelled',
          starts_at: '2026-09-11T12:00:00Z',
          unit: 'Teste',
          reason: 'Tentativa sem permissão',
        },
        randomUUID(),
      ),
    { code: 'NOT_FOUND' },
  );
});
test('novo acesso aceita login simples e senha curta sem exigir troca', async () => {
  const created = await ops.createAttendant(
    manager,
    {
      name: 'Nova Atendente',
      email: 'atendente5',
      password: '1',
      queue_position: 5,
    },
    randomUUID(),
  );
  const { app } = await buildApp(db, { clock: () => now, reconcile: false });
  const login = async (password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { login: 'ATENDENTE5', password },
    });
  try {
    const first = await login('1');
    assert.equal(first.statusCode, 200);
    const headers = {
      'x-artisti-client': 'web',
      cookie: `artisti_session=${first.cookies[0].value}`,
    };
    const snapshot = await app.inject({ url: '/api/v1/workspace', headers });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().user.must_change_password, false);
    assert.equal((await login('senha-errada')).statusCode, 401);
    assert.equal(
      (await db.query<User>('SELECT * FROM users WHERE id=$1', [created.id])).rows[0]
        .must_change_password,
      false,
    );
  } finally {
    await app.close();
  }
});
test('reset de senha revoga sessão, protege segredo e libera o próximo acesso', async () => {
  await db.query('INSERT INTO sessions VALUES($1,$2,$3,1)', [
    'reset-token',
    users[0].id,
    new Date(now.getTime() + 600_000),
  ]);
  await ops.resetPassword(manager, users[0].id, 'Secret-temporary-password-2026', 1, randomUUID());
  const target = (await db.query<User>('SELECT * FROM users WHERE id=$1', [users[0].id])).rows[0];
  assert.equal(target.must_change_password, false);
  assert.equal(target.auth_version, 2);
  assert.equal((await db.query('SELECT * FROM sessions')).rows.length, 0);
  assert.doesNotMatch(
    JSON.stringify((await db.query('SELECT * FROM audit_events')).rows),
    /Secret-temporary-password/,
  );
  assert.doesNotMatch(
    JSON.stringify((await db.query('SELECT * FROM operation_receipts')).rows),
    /Secret-temporary-password/,
  );
});
test('criação repetida é idempotente e conflito de login ignora caixa', async () => {
  const input = {
      name: 'Nova Pessoa',
      email: 'person@example.test',
      password: 'Secret-temporary-password-2026',
      queue_position: 8,
    },
    key = randomUUID();
  const first = await ops.createAttendant(manager, input, key);
  assert.deepEqual(await ops.createAttendant(manager, input, key), first);
  await assert.rejects(
    () =>
      ops.createAttendant(
        manager,
        { ...input, email: 'PERSON@example.test', queue_position: 9 },
        randomUUID(),
      ),
    { code: 'USER_CONFLICT' },
  );
});
test('exclusão permanente exige conta inativa e remove a atendente', async () => {
  const created = await ops.createAttendant(
    manager,
    {
      name: 'Conta Temporária',
      email: 'temporaria',
      password: '1',
      queue_position: 8,
    },
    randomUUID(),
  );
  await assert.rejects(
    ops.deleteAttendant(
      manager,
      created.id,
      { expected_version: 1, confirmation: 'EXCLUIR' },
      randomUUID(),
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
    randomUUID(),
  );
  const deleteKey = randomUUID();
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
  assert.equal((await db.query('SELECT id FROM users WHERE id=$1', [created.id])).rows.length, 0);
});
