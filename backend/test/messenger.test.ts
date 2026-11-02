import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { Operations } from '../src/operations.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import {
  MessengerCentral,
  messengerConfig,
  registerMessenger,
  type MessengerConfig,
} from '../src/messenger.js';
import type { User } from '../src/types.js';
import {
  checkMessengerProfileBackoff,
  checkMessengerSendAuthorization,
  messengerProfileCases,
  checkMessengerProfileRecovery,
  checkMessengerProfileMigration,
  checkMessengerProfileDeployRecovery,
} from './messenger-resilience-checks.js';

const config: MessengerConfig = {
  appSecret: 'messenger-test-secret-only',
  verifyToken: 'messenger-test-verify-token-32-characters',
  pageId: '366748579845081',
  pageAccessToken: 'EAA-synthetic-page-token-never-sent-to-meta',
  graphApiVersion: 'v26.0',
};

const payload = (mid = 'mid.synthetic-messenger-1', sender = 'psid-synthetic-1') => ({
  object: 'page',
  entry: [
    {
      id: config.pageId,
      time: Date.now(),
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: config.pageId },
          timestamp: Date.now(),
          message: { mid, text: 'Mensagem sintética do Messenger' },
        },
      ],
    },
  ],
});

const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const signature = (body: Buffer) =>
  `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;

const profileFetch: typeof fetch = async (input, init) => {
  assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${config.pageAccessToken}`);
  assert.match(String(input), new RegExp(`/${config.graphApiVersion}/psid-synthetic-`));
  return new Response(
    JSON.stringify({
      id: String(input).match(/psid-synthetic-[^?]+/)?.[0],
      name: 'Maria Messenger',
      profile_pic: 'https://lookaside.fbsbx.com/messenger-profile.jpg',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

let db: Database;
let crm: CRM;
let manager: User;
let attendants: User[];
let admin: Database | undefined;
let schema = '';

before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    schema = `artisti_messenger_${randomUUID().replaceAll('-', '')}`;
    admin = await openDatabase('memory://', process.env.TEST_DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = await openDatabase('memory://', url.toString());
  } else db = await openDatabase();
  await migrate(db);
  crm = new CRM(db);
  await seedDemo(crm, false);
  const users = (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST'))
    .rows;
  manager = users[0];
  attendants = users.slice(1);
});

beforeEach(async () => {
  await db.query(
    'TRUNCATE conversation_portfolio_shares,lead_notification_mutes,conversation_reads,messages,messenger_webhook_inbox,instagram_pending_referrals,instagram_webhook_inbox,conversations,contact_identities,channel_accounts,push_records,whatsapp_inbox,claims,appointments,lead_attributions,inbound_events,audit_events,lead_compensations,opportunities,contacts,sessions',
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10');
  await db.query('UPDATE users SET queue_weight=1,queue_credit=0');
});

after(async () => {
  await db.close();
  if (admin) {
    assert.match(schema, /^artisti_messenger_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});

test('Messenger fica desligado por padrão e configuração parcial falha fechada', () => {
  assert.equal(messengerConfig({}), undefined);
  assert.throws(() => messengerConfig({ MESSENGER_ENABLED: 'true' }), /incompleta/);
});

test('Messenger SQL: envio revalida responsável, sessão e janela dentro da transação', () =>
  checkMessengerSendAuthorization(crm, manager, attendants));

test('Messenger SQL: workers concorrentes, edição manual e reinício após falha no banco', () =>
  checkMessengerProfileDeployRecovery(crm));

test('Messenger: falha de perfil aparece no nível de log de produção sem dados sensíveis', async () => {
  let output = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const app = Fastify({ logger: { level: 'error', stream } });
  try {
    const central = await registerMessenger(app, crm, config, false, async () =>
      Response.json(
        { error: { code: 10, message: `Paciente privado ${config.pageAccessToken}` } },
        { status: 400 },
      ),
    );
    const body = raw(payload());
    await central.receive(body, signature(body));
    await central.drain();
    await central.drainProfiles();
    const logs = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 50);
    assert.equal(logs[0].msg, 'Messenger profile lookup deferred');
    assert.equal(logs[0].code, 'META_PERMISSION_DENIED:HTTP_400:CODE_10:SUBCODE_0');
    assert.ok(new Date(logs[0].retry_at).getTime() > Date.now());
    for (const secret of [
      config.pageAccessToken,
      config.appSecret,
      'Paciente privado',
      'psid-synthetic-1',
    ])
      assert.ok(!output.includes(secret));
  } finally {
    await app.close();
  }
});

test('Messenger: nome atualizado invalida a revisão da lista sem precisar de nova mensagem', async () => {
  const { app, messenger } = await buildApp(db, {
    messenger: config,
    messengerFetch: profileFetch,
    reconcile: false,
  });
  try {
    const body = raw(payload());
    await messenger.receive(body, signature(body));
    await messenger.drain();
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: manager.email, password: DEMO_PASSWORD },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: `artisti_session=${login.cookies[0].value}` };
    const first = await app.inject({ url: '/api/v1/conversations?view=all', headers });
    assert.equal(first.statusCode, 200);
    const original = first.json();
    assert.equal(original.conversations[0].contact_name, 'Contato Messenger');
    const url = `/api/v1/conversations?view=all&revision=${original.revision}`;
    assert.equal((await app.inject({ url, headers })).json().unchanged, true);
    await messenger.drainProfiles();
    const refreshed = (await app.inject({ url, headers })).json();
    assert.notEqual(refreshed.revision, original.revision);
    assert.equal(refreshed.conversations[0].contact_name, 'Maria Messenger');
    assert.equal(refreshed.conversations[0].id, original.conversations[0].id);
    assert.equal(
      refreshed.conversations[0].last_message_at,
      original.conversations[0].last_message_at,
    );
  } finally {
    await app.close();
  }
});

for (const [name, response, error] of messengerProfileCases)
  test(`Messenger SQL: nome do contato — ${name}`, () =>
    checkMessengerProfileRecovery(crm, manager, attendants, response, error));

test('Messenger SQL: migração recupera nomes antigos sem alterar atendimento', async () => {
  await db.query('ALTER TABLE contact_identities DROP COLUMN profile_last_error');
  await db.query("DELETE FROM schema_migrations WHERE version='044'");
  try {
    await checkMessengerProfileMigration(crm, manager, () => migrate(db));
  } finally {
    await migrate(db);
  }
});

for (const [name, failure, minimumPauseMs] of [
  [
    'HTTP 429 com Retry-After',
    () => new Response('', { status: 429, headers: { 'Retry-After': '1800' } }),
    30 * 60_000,
  ],
  [
    'HTTP 429 com Retry-After em data',
    () =>
      new Response('', {
        status: 429,
        headers: { 'Retry-After': new Date(Date.now() + 30 * 60_000).toUTCString() },
      }),
    29 * 60_000,
  ],
  [
    'Graph code 4 em HTTP 400',
    () => Response.json({ error: { code: 4 } }, { status: 400 }),
    15 * 60_000,
  ],
  [
    'permissão Graph code 10 em HTTP 400',
    () => Response.json({ error: { code: 10 } }, { status: 400 }),
    15 * 60_000,
  ],
  ['falha transitória HTTP 503', () => new Response('', { status: 503 }), 15 * 60_000],
  [
    'erro de rede',
    () => {
      throw new Error('synthetic network failure');
    },
    15 * 60_000,
  ],
] as const)
  test(`Messenger SQL: pausa persistente e recuperação de perfis — ${name}`, () =>
    checkMessengerProfileBackoff(crm, manager, failure, minimumPauseMs));

test('webhook valida desafio e HMAC nos bytes originais sem exigir sessão', async () => {
  const { app } = await buildApp(db, { messenger: config, reconcile: false });
  try {
    const url = '/webhooks/messenger?hub.mode=subscribe&hub.challenge=challenge&hub.verify_token=';
    assert.equal((await app.inject({ url: `${url}wrong` })).statusCode, 403);
    const verified = await app.inject({ url: `${url}${config.verifyToken}` });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body, 'challenge');

    const bytes = Buffer.from(JSON.stringify(payload(), null, 2));
    const post = (body: Buffer, hmac?: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/messenger',
        headers: {
          'content-type': 'application/json',
          ...(hmac ? { 'x-hub-signature-256': hmac } : {}),
        },
        payload: body,
      });
    assert.equal((await post(bytes)).statusCode, 401);
    assert.equal((await post(raw(payload()), signature(bytes))).statusCode, 401);
    assert.equal((await post(bytes, signature(bytes))).statusCode, 200);
    assert.equal((await db.query('SELECT * FROM messenger_webhook_inbox')).rows.length, 1);
    assert.equal((await app.inject({ url: '/api/v1/messenger/status' })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('mensagem cria lead no rodízio, identidade e conversa sem duplicar reentregas', async () => {
  const central = new MessengerCentral(crm, config, profileFetch);
  const body = raw(payload());
  await Promise.all([
    central.receive(body, signature(body)),
    central.receive(body, signature(body)),
  ]);
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
  await central.drain();
  await central.drain();
  await central.drainProfiles();

  const contact = (
    await db.query<{ name: string; phone: string | null }>('SELECT name,phone FROM contacts')
  ).rows[0];
  assert.deepEqual(contact, { name: 'Maria Messenger', phone: null });
  const identity = (await db.query<Record<string, string>>('SELECT * FROM contact_identities'))
    .rows[0];
  assert.equal(identity.provider, 'messenger');
  assert.equal(identity.channel_account_id, config.pageId);
  assert.equal(identity.external_user_id, 'psid-synthetic-1');
  assert.equal(identity.profile_picture_url, 'https://lookaside.fbsbx.com/messenger-profile.jpg');

  const opportunity = (
    await db.query<{
      id: string;
      channel: string;
      state: string;
      source: string;
      reserved_to: string;
    }>('SELECT id,channel,state,source,reserved_to FROM opportunities')
  ).rows[0];
  assert.equal(opportunity.channel, 'messenger');
  assert.equal(opportunity.state, 'RESERVED');
  assert.equal(opportunity.source, 'Facebook Messenger — origem orgânica');
  assert.equal(opportunity.reserved_to, attendants[0].id);
  assert.equal(
    (await crm.detail(attendants[0], opportunity.id)).profile_picture_url,
    'https://lookaside.fbsbx.com/messenger-profile.jpg',
  );
  assert.equal((await db.query('SELECT * FROM conversations')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM messages')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM inbound_events')).rows.length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT * FROM push_records WHERE kind='event' AND data->>'kind'='message.received'",
      )
    ).rows.length,
    1,
  );
  assert.equal(
    (await db.query("SELECT * FROM push_records WHERE kind='event'")).rows.length,
    1,
    'a primeira mensagem gera um único aviso, sem duplicar lead e mensagem',
  );
  const listed = await central.list(manager, 'all');
  assert.equal(listed.conversations[0].channel, 'messenger');
  assert.equal(listed.conversations[0].contact_name, 'Maria Messenger');
  assert.equal(listed.conversations[0].unread, true);
});

test('responsável responde pela caixa uma única vez e a rota usa o token da Página', async () => {
  const requests: Array<{ url: string; authorization: string; body: unknown }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    if ((init?.method ?? 'GET') !== 'POST') return profileFetch(input, init);
    requests.push({
      url: String(input),
      authorization: String(new Headers(init.headers).get('Authorization')),
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({ recipient_id: 'psid-synthetic-1', message_id: 'mid.outbound-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const receiver = new MessengerCentral(crm, config, mockFetch);
  const body = raw(payload());
  await receiver.receive(body, signature(body));
  await receiver.drain();
  const opportunity = (
    await db.query<{ id: string; version: number; reserved_to: string }>(
      'SELECT id,version,reserved_to FROM opportunities',
    )
  ).rows[0];
  const responsible = attendants.find((user) => user.id === opportunity.reserved_to)!;
  await crm.claim(responsible, opportunity.id, 'reservation', opportunity.version, randomUUID());

  const { app } = await buildApp(db, {
    messenger: config,
    messengerFetch: mockFetch,
    reconcile: false,
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: responsible.email, password: DEMO_PASSWORD },
    });
    const cookie = `artisti_session=${login.cookies[0].value}`;
    const headers = { cookie, 'x-artisti-client': 'web' };
    const list = await app.inject({ url: '/api/v1/conversations', headers: { cookie } });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().conversations.length, 1);
    assert.equal(list.json().conversations[0].channel, 'messenger');
    assert.equal(list.json().conversations[0].can_send, true);
    const conversationId = list.json().conversations[0].id;
    const key = randomUUID();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { text: 'Olá pelo CRM' },
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().status, 'sent');
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { text: 'Olá pelo CRM' },
    });
    assert.deepEqual(replay.json(), first.json());
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      `https://graph.facebook.com/${config.graphApiVersion}/${config.pageId}/messages`,
    );
    assert.equal(requests[0].authorization, `Bearer ${config.pageAccessToken}`);
    assert.deepEqual(requests[0].body, {
      recipient: { id: 'psid-synthetic-1' },
      messaging_type: 'RESPONSE',
      message: { text: 'Olá pelo CRM' },
    });
    assert.ok(!list.body.includes(config.pageAccessToken));
    assert.ok(!list.body.includes(config.appSecret));
  } finally {
    await app.close();
  }
});

test('janela vencida bloqueia envio e envio interrompido não fica preso', async () => {
  const central = new MessengerCentral(crm, config, profileFetch);
  const body = raw(payload());
  await central.receive(body, signature(body));
  await central.drain();
  const opportunity = (
    await db.query<{ id: string; version: number; reserved_to: string }>(
      'SELECT id,version,reserved_to FROM opportunities',
    )
  ).rows[0];
  const responsible = attendants.find((user) => user.id === opportunity.reserved_to)!;
  await crm.claim(responsible, opportunity.id, 'reservation', opportunity.version, randomUUID());
  const conversation = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0];
  await db.query(
    "UPDATE conversations SET last_inbound_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
    [conversation.id],
  );
  await assert.rejects(
    () => central.send(responsible, conversation.id, 'Tarde demais', randomUUID()),
    {
      code: 'MESSENGER_WINDOW_EXPIRED',
    },
  );
  await db.query(
    `INSERT INTO messages(
       id,conversation_id,client_request_id,direction,sender_user_id,type,text,status,sending_started_at,created_at
     ) VALUES($1,$2,$3,'outbound',$4,'text','Interrompida','sending',
       clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '3 minutes')`,
    [
      randomUUID(),
      conversation.id,
      `messenger:${conversation.id}:${responsible.id}:stale`,
      responsible.id,
    ],
  );
  assert.equal(await central.recoverStaleSends(), 1);
  const stale = (
    await db.query<{ status: string; error_code: string }>(
      "SELECT status,error_code FROM messages WHERE text='Interrompida'",
    )
  ).rows[0];
  assert.deepEqual(stale, { status: 'unknown', error_code: 'PROCESS_INTERRUPTED' });
});

test('exclusão permanente limpa o inbox e bloqueia reentrega antiga', async () => {
  const operations = new Operations(db);
  const central = new MessengerCentral(operations, config, profileFetch);
  const body = raw(payload('mid.deleted'));
  await central.receive(body, signature(body));
  await central.drain();
  const opportunity = (
    await db.query<{ id: string; version: number }>('SELECT id,version FROM opportunities')
  ).rows[0];
  await operations.deleteLead(
    manager,
    opportunity.id,
    { expected_version: opportunity.version, confirmation: 'EXCLUIR' },
    randomUUID(),
  );
  assert.equal((await db.query('SELECT * FROM messenger_webhook_inbox')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
  await central.receive(body, signature(body));
  await central.drain();
  assert.equal((await db.query('SELECT * FROM messenger_webhook_inbox')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
});
