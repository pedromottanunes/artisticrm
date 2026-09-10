import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { bootstrapManager } from '../src/bootstrap.js';
import type { User, Opportunity } from '../src/types.js';

let db: Database;
let crm: CRM;
let manager: User;
let users: User[];
let now = new Date('2026-09-10T12:00:00Z');
let adminDb: Database | undefined;
let schema = '';
before(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    schema = `artisti_test_${randomUUID().replaceAll('-', '')}`;
    adminDb = await openDatabase('memory://', url);
    await adminDb.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    db = await openDatabase('memory://', scoped.toString());
  } else db = await openDatabase();
  await migrate(db);
  crm = new CRM(db, () => now);
  await seedDemo(crm, false);
  const all = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
    .rows;
  manager = all[0];
  users = all.slice(1);
});
after(async () => {
  await db?.close();
  if (adminDb) {
    assert.match(schema, /^artisti_test_[a-f0-9]{32}$/);
    await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminDb.close();
  }
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE whatsapp_inbox,claims,appointments,inbound_events,audit_events,opportunities,contacts,sessions',
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10,version=1');
  await db.query("UPDATE users SET active=true,queue_enabled=(role='attendant')");
  now = new Date('2026-09-10T12:00:00Z');
});
const input = (n = 1) => ({
  name: `Contato Teste ${n}`,
  phone: `554899999${String(n).padStart(4, '0')}`,
  interest: 'Avaliação',
  unit: 'Teste',
  source: 'Cadastro manual',
});
const create = (n = 1, key = `event-${n}`) => crm.ingest(input(n), key, manager.id);
const get = async (id: string) =>
  (await db.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1', [id])).rows[0];
const count = async (table: string) =>
  Number((await db.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows[0].count);

test('oito novos contatos percorrem duas voltas exatas do rodízio', async () => {
  const assigned = [];
  for (let i = 0; i < 8; i++) assigned.push((await get((await create(i)).id)).reserved_to);
  assert.deepEqual(
    assigned,
    [...users, ...users].map((u) => u.id),
  );
});
test('reenvio de evento não duplica contato, oportunidade, histórico ou cursor', async () => {
  const first = await create();
  const second = await create();
  assert.equal(second.id, first.id);
  assert.equal(second.duplicate, true);
  assert.equal(await count('contacts'), 1);
  assert.equal(await count('opportunities'), 1);
  assert.equal(await count('audit_events'), 1);
  assert.equal((await get((await create(2)).id)).reserved_to, users[1].id);
});
test('mensagens simultâneas do mesmo telefone preservam uma oportunidade', async () => {
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => create(1, `msg-${i}`)));
  assert.equal(new Set(results.map((r) => r.id)).size, 1);
  assert.equal(await count('opportunities'), 1);
  assert.equal(await count('inbound_events'), 4);
});
test('mesma chave de cadastro com dados diferentes não registra sucesso falso', async () => {
  await create(1, 'same-request');
  await assert.rejects(() => create(2, 'same-request'), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(await count('contacts'), 1);
});
test('quatro aceites simultâneos geram exatamente um proprietário', async () => {
  const { id } = await create();
  now = new Date(now.getTime() + 600_000);
  await crm.expire();
  const row = await get(id);
  const attempts = await Promise.allSettled(
    users.map((u) => crm.claim(u, id, 'pool', row.version, randomUUID())),
  );
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await get(id)).state, 'CLAIMED');
  assert.equal(await count('claims'), 1);
});
test('reserva vencida perde exclusividade mesmo sem worker; limite exato de 10 minutos', async () => {
  const { id } = await create();
  now = new Date(now.getTime() + 600_000);
  await assert.rejects(() => crm.claim(users[0], id, 'reservation', 1, randomUUID()), {
    code: 'RESERVATION_EXPIRED',
  });
  await crm.claim(users[1], id, 'pool', 1, randomUUID());
  assert.equal((await get(id)).owner_id, users[1].id);
});
test('somente destinatária pode assumir reserva não vencida', async () => {
  const { id } = await create();
  await assert.rejects(() => crm.claim(users[1], id, 'reservation', 1, randomUUID()), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(() => crm.claim(users[1], id, 'pool', 1, randomUUID()), {
    code: 'NOT_AVAILABLE',
  });
  await crm.claim(users[0], id, 'reservation', 1, randomUUID());
});
test('resposta perdida de aceite é recuperada usando a mesma chave', async () => {
  const { id } = await create();
  const key = randomUUID();
  const first = await crm.claim(users[0], id, 'reservation', 1, key);
  const second = await crm.claim(users[0], id, 'reservation', 1, key);
  assert.deepEqual(second, first);
  assert.equal(await count('claims'), 1);
  await assert.rejects(() => crm.claim(users[0], id, 'pool', 2, key), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
});
test('telefone e nome do bolsão não vazam antes do aceite', async () => {
  const { id } = await create();
  let snapshot = await crm.snapshot(users[0]);
  assert.equal(snapshot.opportunities[0].phone, undefined);
  now = new Date(now.getTime() + 600_001);
  snapshot = await crm.snapshot(users[1]);
  assert.equal(snapshot.opportunities[0].name, 'Contato disponível');
  assert.equal(snapshot.opportunities[0].phone, undefined);
  await crm.claim(users[1], id, 'pool', snapshot.opportunities[0].version, randomUUID());
  assert.equal((await crm.detail(users[1], id)).phone, input().phone);
  await assert.rejects(() => crm.detail(users[0], id), { code: 'NOT_FOUND' });
});
test('nova entrada mantém a proprietária da oportunidade aberta', async () => {
  const { id } = await create();
  await crm.claim(users[0], id, 'reservation', 1, randomUUID());
  await create(1, 'new-message');
  assert.equal((await get(id)).owner_id, users[0].id);
  assert.equal(await count('opportunities'), 1);
});
test('nenhuma atendente ativa mantém pendência e reativação distribui', async () => {
  await crm.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: users.map((u) => ({ id: u.id, enabled: false })),
  });
  const { id } = await create();
  assert.equal((await get(id)).state, 'PENDING');
  await crm.configure(manager, {
    version: 2,
    timeout_minutes: 5,
    participants: [{ id: users[2].id, enabled: true }],
  });
  const row = await get(id);
  assert.equal(row.reserved_to, users[2].id);
  assert.equal(row.state, 'RESERVED');
});
test('alterar prazo não reescreve reserva existente; apenas futuras', async () => {
  const { id } = await create();
  const expiry = (await get(id)).expires_at;
  await crm.configure(manager, { version: 1, timeout_minutes: 3, participants: [] });
  assert.deepEqual((await get(id)).expires_at, expiry);
  const next = await get((await create(2)).id);
  assert.equal(new Date(next.expires_at!).getTime() - now.getTime(), 180_000);
});
test('pausa impede novas reservas mas não impede aceite da reserva vigente', async () => {
  const { id } = await create();
  await crm.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: [{ id: users[0].id, enabled: false }],
  });
  await crm.claim({ ...users[0], queue_enabled: false }, id, 'reservation', 1, randomUUID());
  assert.equal((await get(id)).state, 'CLAIMED');
});

test('todas as atendentes ativas acessam o bolsão mesmo com rodízio pausado', async () => {
  const { id } = await create();
  await crm.configure(manager, {
    version: 1,
    timeout_minutes: 10,
    participants: users.map((u) => ({ id: u.id, enabled: false })),
  });
  now = new Date(now.getTime() + 600_000);
  const paused = users.map((u) => ({ ...u, queue_enabled: false }));
  for (const user of paused) {
    const snapshot = await crm.snapshot(user);
    assert.equal(snapshot.opportunities[0].id, id);
    assert.equal(snapshot.opportunities[0].state, 'POOL');
    assert.equal((await crm.detail(user, id)).phone, undefined);
  }
  const row = await get(id);
  const attempts = await Promise.allSettled(
    paused.map((u) => crm.claim(u, id, 'pool', row.version, randomUUID())),
  );
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await count('claims'), 1);
  const winner = (await get(id)).owner_id;
  for (const user of paused) {
    const snapshot = await crm.snapshot(user);
    assert.equal(snapshot.opportunities.length, user.id === winner ? 1 : 0);
  }
  assert.equal((await get((await create(2)).id)).state, 'PENDING');
});

test('conta desativada não assume bolsão mesmo com dados de sessão antigos', async () => {
  const { id } = await create();
  now = new Date(now.getTime() + 600_000);
  await crm.expire();
  await db.query('UPDATE users SET active=false WHERE id=$1', [users[0].id]);
  await assert.rejects(() => crm.claim(users[0], id, 'pool', 2, randomUUID()), {
    code: 'UNAUTHENTICATED',
  });
  await assert.rejects(() => crm.claim(manager, id, 'pool', 2, randomUUID()), {
    code: 'FORBIDDEN',
  });
  assert.equal((await get(id)).state, 'POOL');
  assert.equal(await count('claims'), 0);
});

test('um milissegundo antes do prazo a reserva ainda é exclusiva', async () => {
  const { id } = await create();
  now = new Date(now.getTime() + 599_999);
  assert.equal(await crm.expire(), 0);
  await assert.rejects(() => crm.claim(users[1], id, 'pool', 1, randomUUID()), {
    code: 'NOT_AVAILABLE',
  });
  await crm.claim(users[0], id, 'reservation', 1, randomUUID());
  now = new Date(now.getTime() + 1);
  assert.equal(await crm.expire(), 0);
  assert.equal((await get(id)).owner_id, users[0].id);
});

test('nova mensagem não renova o prazo nem retira o contato do bolsão', async () => {
  const { id } = await create();
  const expires = (await get(id)).expires_at;
  now = new Date(now.getTime() + 300_000);
  await create(1, 'follow-up-before-expiry');
  assert.deepEqual((await get(id)).expires_at, expires);
  now = new Date(now.getTime() + 300_000);
  await crm.expire();
  await create(1, 'follow-up-in-pool');
  assert.equal((await get(id)).state, 'POOL');
  assert.equal((await get((await create(2)).id)).reserved_to, users[1].id);
});

test('aceite no vencimento sem worker registra expiração uma única vez', async () => {
  const { id } = await create();
  now = new Date(now.getTime() + 600_000);
  const key = randomUUID();
  await crm.claim(users[1], id, 'pool', 1, key);
  await crm.claim(users[1], id, 'pool', 1, key);
  await Promise.all([crm.expire(), crm.expire()]);
  const events = (
    await db.query<{ kind: string }>('SELECT kind FROM audit_events WHERE opportunity_id=$1', [id])
  ).rows;
  assert.equal(events.filter((e) => e.kind === 'reservation.expired').length, 1);
  assert.equal(events.filter((e) => e.kind === 'opportunity.claimed').length, 1);
});

test('entradas concorrentes mantêm rodízio equilibrado entre instâncias', async () => {
  const other = new CRM(db, () => now);
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      (i % 2 ? crm : other).ingest(input(i), `parallel-${i}`, null),
    ),
  );
  const rows = await Promise.all(results.map((r) => get(r.id)));
  for (const user of users) assert.equal(rows.filter((r) => r.reserved_to === user.id).length, 6);
  assert.equal(new Set(rows.map((r) => r.id)).size, 24);
});

test('HTTP libera WhatsApp somente para vencedora, inclusive pausada no rodízio', async () => {
  const { id } = await create();
  await db.query("UPDATE users SET queue_enabled=false WHERE role='attendant'");
  now = new Date(now.getTime() + 600_000);
  const { app } = await buildApp(db, { clock: () => now, reconcile: false });
  try {
    const headers = await Promise.all(
      users.map(async (user) => {
        const login = await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { 'x-artisti-client': 'web' },
          payload: { email: user.email, password: DEMO_PASSWORD },
        });
        assert.equal(login.statusCode, 200);
        return { cookie: `artisti_session=${login.cookies[0].value}`, 'x-artisti-client': 'web' };
      }),
    );
    for (const h of headers) {
      const snapshot = await app.inject({ url: '/api/v1/workspace', headers: h });
      assert.equal(snapshot.json().opportunities[0].id, id);
      assert.equal(snapshot.json().opportunities[0].phone, undefined);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/whatsapp-link`,
            headers: h,
            payload: {},
          })
        ).statusCode,
        403,
      );
    }
    const attempts = await Promise.all(
      headers.map((h) =>
        app.inject({
          method: 'POST',
          url: `/api/v1/opportunities/${id}/claim`,
          headers: { ...h, 'idempotency-key': randomUUID() },
          payload: { mode: 'pool', expected_version: 2 },
        }),
      ),
    );
    assert.equal(attempts.filter((r) => r.statusCode === 200).length, 1);
    assert.equal(attempts.filter((r) => r.statusCode === 409).length, 3);
    const winner = attempts.findIndex((r) => r.statusCode === 200);
    for (let i = 0; i < headers.length; i++) {
      const link = await app.inject({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/whatsapp-link`,
        headers: headers[i],
        payload: {},
      });
      assert.equal(link.statusCode, i === winner ? 200 : 404);
      if (i === winner) assert.equal(link.json().url, `https://wa.me/${input().phone}`);
    }
  } finally {
    await app.close();
  }
});
test('cadastro usa controle de versão e bloqueia venda sem contrato', async () => {
  const { id } = await create();
  const update = {
    version: 1,
    name: 'Nome alterado',
    email: '',
    instagram: '',
    interest: 'Avaliação',
    unit: 'Teste',
    stage: 'NEGOTIATION',
    next_action: 'Retornar amanhã',
  };
  await crm.update(manager, id, update);
  await assert.rejects(() => crm.update(manager, id, update), { code: 'VERSION_CONFLICT' });
  await assert.rejects(() => crm.update(manager, id, { ...update, version: 2, stage: 'WON' }), {
    code: 'CONTRACT_REQUIRED',
  });
});
test('agendamento confirma data futura e mantém histórico', async () => {
  const { id } = await create();
  await assert.rejects(
    () =>
      crm.schedule(manager, id, {
        starts_at: now.toISOString(),
        unit: 'Teste',
        expected_version: 1,
      }),
    { code: 'INVALID_DATE' },
  );
  await crm.schedule(manager, id, {
    starts_at: new Date(now.getTime() + 3_600_000).toISOString(),
    unit: 'Teste',
    expected_version: 1,
  });
  assert.equal(await count('appointments'), 1);
  assert.equal((await get(id)).stage, 'EVALUATION_SCHEDULED');
  assert.equal(await count('audit_events'), 2);
});
test('HTTP exige sessão, protege origem e restringe ações de gestão', async () => {
  const { app } = await buildApp(db, { clock: () => now, reconcile: false });
  try {
    assert.equal((await app.inject({ url: '/api/v1/workspace' })).statusCode, 401);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://attacker.invalid', 'x-artisti-client': 'web' },
      payload: { email: manager.email, password: DEMO_PASSWORD },
    });
    assert.equal(rejected.statusCode, 403);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: users[0].email, password: DEMO_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, 'x-artisti-client': 'web' };
    assert.equal((await app.inject({ url: '/api/v1/workspace', headers })).statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/opportunities',
          headers,
          payload: input(),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/integrations/status', headers })).statusCode,
      403,
    );
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers, payload: {} });
    assert.equal((await app.inject({ url: '/api/v1/workspace', headers })).statusCode, 401);
  } finally {
    await app.close();
  }
});
test('HTTP aceita cadastro válido e rejeita UUID e telefone inválidos', async () => {
  const { app } = await buildApp(db, { clock: () => now, reconcile: false });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: manager.email, password: DEMO_PASSWORD },
    });
    const headers = {
      cookie: `artisti_session=${login.cookies[0].value}`,
      'x-artisti-client': 'web',
      'idempotency-key': randomUUID(),
    };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/opportunities',
          headers,
          payload: input(),
        })
      ).statusCode,
      201,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/opportunities',
          headers,
          payload: { ...input(), phone: 'abc' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/opportunities/not-a-uuid', headers })).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
test('cookie no ambiente publicado é Secure e demo não aparece no snapshot', async () => {
  const { app } = await buildApp(db, {
    clock: () => now,
    reconcile: false,
    production: true,
    appOrigin: 'https://crm.example.test',
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://crm.example.test', 'x-artisti-client': 'web' },
      payload: { email: manager.email, password: DEMO_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    assert.match(String(login.headers['set-cookie']), /Secure/);
    assert.match(String(login.headers['set-cookie']), /HttpOnly/);
    const response = await app.inject({
      url: '/api/v1/workspace',
      headers: { cookie: `artisti_session=${login.cookies[0].value}` },
    });
    assert.equal(response.json().demo, false);
  } finally {
    await app.close();
  }
});
test('banco embarcado persiste reserva e cursor ao fechar e reabrir', async () => {
  const path = await mkdtemp(join(tmpdir(), 'artisti-persistence-test-'));
  let persistent = await openDatabase(path);
  try {
    await migrate(persistent);
    const first = new CRM(persistent, () => now);
    await seedDemo(first, false);
    const { id } = await first.ingest(input(), 'persist', null);
    await persistent.close();
    persistent = await openDatabase(path);
    const restarted = new CRM(persistent, () => new Date(now.getTime() + 600_001));
    await restarted.expire();
    assert.equal(
      (await persistent.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1', [id])).rows[0]
        .state,
      'POOL',
    );
    assert.equal(
      (
        await persistent.query<{ last_position: number }>(
          'SELECT last_position FROM distribution_settings',
        )
      ).rows[0].last_position,
      1,
    );
  } finally {
    await persistent.close();
  }
});
test('bootstrap de homologação não aceita credenciais ausentes nem gera demo', async () => {
  const isolated = await openDatabase();
  try {
    await migrate(isolated);
    await assert.rejects(() => bootstrapManager(isolated));
    await bootstrapManager(isolated, 'gestor@example.test', 'Example-long-password-2026');
    assert.equal(
      Number((await isolated.query<{ count: string }>('SELECT count(*) FROM users')).rows[0].count),
      1,
    );
    assert.equal(
      Number(
        (await isolated.query<{ count: string }>('SELECT count(*) FROM contacts')).rows[0].count,
      ),
      0,
    );
  } finally {
    await isolated.close();
  }
});
