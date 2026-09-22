import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { WhatsAppCentral, whatsappConfig } from '../src/whatsapp.js';
import type { User } from '../src/types.js';

// Synthetic identifiers only. Never reach Meta or send messages.
const config = {
  appSecret: 'test-secret-not-a-real-meta-secret',
  verifyToken: 'test-verify-token-with-at-least-32-chars',
  wabaId: '100000000000001',
  phoneNumberId: '100000000000002',
};
const payload = (id = 'wamid.synthetic-1') => ({
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
            contacts: [{ wa_id: '19995550101', profile: { name: 'Contato fictício' } }],
            messages: [
              {
                id,
                from: '19995550101',
                type: 'text',
                text: { body: 'Mensagem privada não deve ser armazenada' },
              },
            ],
          },
        },
      ],
    },
  ],
});
const raw = (data: unknown) => Buffer.from(JSON.stringify(data));
const signature = (body: Buffer) =>
  `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;
let db: Database, crm: CRM, central: WhatsAppCentral;
let admin: Database | undefined,
  schema = '';
before(async () => {
  if (process.env.TEST_DATABASE_URL) {
    schema = `artisti_wa_${randomUUID().replaceAll('-', '')}`;
    admin = await openDatabase('memory://', process.env.TEST_DATABASE_URL);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    db = await openDatabase('memory://', url.toString());
  } else db = await openDatabase();
  await migrate(db);
  crm = new CRM(db);
  central = new WhatsAppCentral(crm, config);
  await seedDemo(crm, false);
});
beforeEach(async () => {
  await db.query(
    'TRUNCATE whatsapp_inbox,claims,appointments,lead_attributions,inbound_events,audit_events,opportunities,contacts,sessions',
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10');
  await db.query('UPDATE users SET queue_weight=1,queue_credit=0');
});
after(async () => {
  await db.close();
  if (admin) {
    assert.match(schema, /^artisti_wa_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});

test('central desligada por padrão e ativação parcial falha sem revelar segredos', () => {
  assert.equal(whatsappConfig({}), undefined);
  assert.throws(() => whatsappConfig({ WHATSAPP_ENABLED: 'true' }), /incompleta/);
});

test('HTTP valida desafio e HMAC nos bytes originais, sem exigir sessão', async () => {
  const { app } = await buildApp(db, { whatsapp: config, reconcile: false });
  try {
    const url = '/webhooks/whatsapp?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=';
    assert.equal((await app.inject({ url: url + 'wrong' })).statusCode, 403);
    const verified = await app.inject({ url: url + config.verifyToken });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body, '12345');
    const bytes = Buffer.from(JSON.stringify(payload(), null, 2));
    const post = (body: Buffer, sig?: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: {
          'content-type': 'application/json',
          ...(sig ? { 'x-hub-signature-256': sig } : {}),
        },
        payload: body,
      });
    assert.equal((await post(bytes)).statusCode, 401);
    assert.equal((await post(raw(payload()), signature(bytes))).statusCode, 401);
    assert.equal((await post(bytes, signature(bytes))).statusCode, 200);
    const invalid = Buffer.from('{');
    assert.equal((await post(invalid, signature(invalid))).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/whatsapp/status' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/v1/workspace' })).statusCode, 401);
  } finally {
    await app.close();
  }
});

test('configuração ausente não aceita webhook nem cria leads', async () => {
  const { app } = await buildApp(db, { reconcile: false });
  try {
    assert.equal(
      (await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe' })).statusCode,
      503,
    );
    const body = raw(payload());
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/whatsapp',
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature(body) },
          payload: body,
        })
      ).statusCode,
      503,
    );
  } finally {
    await app.close();
  }
});

test('falha ao persistir devolve erro à Meta em vez de confirmar recebimento', async () => {
  const failing: Database = {
    ...db,
    transaction: async () => {
      throw new Error('Simulated database outage');
    },
  };
  const { app } = await buildApp(failing, { whatsapp: config, reconcile: false });
  try {
    const body = raw(payload());
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature(body) },
      payload: body,
    });
    assert.equal(response.statusCode, 500);
    assert.ok(!response.body.includes('database outage'));
    assert.equal((await db.query('SELECT * FROM whatsapp_inbox')).rows.length, 0);
  } finally {
    await app.close();
  }
});

test('lote com mensagens distintas distribui todas e identifica referência de anúncio', async () => {
  const data = payload();
  const value = data.entry[0].changes[0].value;
  value.messages.push({
    id: 'wamid.synthetic-2',
    from: '19995550102',
    type: 'text',
    text: { body: 'Texto fictício' },
  });
  Object.assign(value.messages[1], {
    referral: {
      source_type: 'ad',
      source_id: 'synthetic-ad',
      source_url: 'https://example.test/meta-ad',
      ctwa_clid: 'synthetic-click-id',
      headline: 'Criativo sintético',
      body: 'Texto publicitário sintético',
      media_type: 'image',
      image_url: 'https://example.test/ad.jpg',
      unknown_field: 'não deve ser persistido',
    },
  });
  const body = raw(data);
  await central.receive(body, signature(body));
  await central.drain();
  const rows = (await db.query('SELECT source,reserved_to FROM opportunities')).rows;
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.reserved_to)).size, 2);
  assert.equal(rows.filter((r) => r.source === 'Meta Ads').length, 1);
  const attribution = (await db.query<Record<string, string>>('SELECT * FROM lead_attributions'))
    .rows[0];
  assert.equal(attribution.provider, 'meta');
  assert.equal(attribution.channel, 'whatsapp');
  assert.equal(attribution.source_id, 'synthetic-ad');
  assert.equal(attribution.source_url, 'https://example.test/meta-ad');
  assert.equal(attribution.ctwa_clid, 'synthetic-click-id');
  assert.equal(attribution.headline, 'Criativo sintético');
  assert.equal(attribution.body, 'Texto publicitário sintético');
  assert.equal(attribution.media_type, 'image');
  assert.equal(attribution.image_url, 'https://example.test/ad.jpg');
  assert.ok(!JSON.stringify(attribution).includes('unknown_field'));
  const manager = (
    await db.query<User>(
      `SELECT id,name,email,role,active,queue_enabled,queue_position,color,version,
        auth_version,must_change_password FROM users WHERE role='manager' LIMIT 1`,
    )
  ).rows[0];
  const detail = await crm.detail(manager, attribution.opportunity_id);
  assert.equal(detail.attributions.length, 1);
  assert.equal(detail.attributions[0].source_id, 'synthetic-ad');
  assert.ok(!JSON.stringify(detail).includes('synthetic-click-id'));
  const reserved = (
    await db.query<User>(
      `SELECT u.id,u.name,u.email,u.role,u.active,u.queue_enabled,u.queue_position,u.color,
        u.version,u.auth_version,u.must_change_password FROM users u
       JOIN opportunities o ON o.reserved_to=u.id WHERE o.id=$1`,
      [attribution.opportunity_id],
    )
  ).rows[0];
  assert.deepEqual((await crm.detail(reserved, attribution.opportunity_id)).attributions, []);
});

test('nova referência de anúncio no mesmo atendimento preserva o histórico', async () => {
  const first = payload('wamid.synthetic-history-1');
  Object.assign(first.entry[0].changes[0].value.messages[0], {
    referral: { source_type: 'ad', source_id: 'ad-first', ctwa_clid: 'click-first' },
  });
  const second = payload('wamid.synthetic-history-2');
  Object.assign(second.entry[0].changes[0].value.messages[0], {
    referral: { source_type: 'ad', source_id: 'ad-second', ctwa_clid: 'click-second' },
  });
  for (const data of [first, second]) {
    const body = raw(data);
    await central.receive(body, signature(body));
    await central.drain();
  }
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 1);
  const attributions = (
    await db.query<{ source_id: string }>(
      'SELECT source_id FROM lead_attributions ORDER BY received_at,id',
    )
  ).rows;
  assert.deepEqual(attributions.map((item) => item.source_id).sort(), ['ad-first', 'ad-second']);
});

test('referência sem identidade ou que não é anúncio não é atribuída', async () => {
  const data = payload('wamid.synthetic-not-ad');
  Object.assign(data.entry[0].changes[0].value.messages[0], {
    referral: { source_type: 'post', source_id: 'synthetic-post' },
  });
  const body = raw(data);
  await central.receive(body, signature(body));
  await central.drain();
  assert.equal(
    (await db.query('SELECT source FROM opportunities')).rows[0].source,
    'Não identificada',
  );
  assert.equal((await db.query('SELECT * FROM lead_attributions')).rows.length, 0);
});

test('lote persistido antes de processar; reenvios concorrentes criam uma reserva apenas', async () => {
  const body = raw(payload());
  await Promise.all(Array.from({ length: 4 }, () => central.receive(body, signature(body))));
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
  const inbox = (await db.query('SELECT * FROM whatsapp_inbox')).rows;
  assert.equal(inbox.length, 1);
  assert.ok(!JSON.stringify(inbox).includes('Mensagem privada'));
  // New processor instance models recovery after receipt was committed.
  await Promise.all([central.drain(), new WhatsAppCentral(crm, config).drain()]);
  const rows = (await db.query('SELECT * FROM opportunities')).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'RESERVED');
  assert.equal(rows[0].source, 'Não identificada');
  assert.equal(
    new Date(rows[0].expires_at as string).getTime() -
      new Date(rows[0].created_at as string).getTime(),
    600_000,
  );
  assert.equal((await central.status()).pending, 0);
});

test('status, echoes e outra central não entram no rodízio', async () => {
  const values: unknown[] = [];
  const wrongWaba = payload();
  wrongWaba.entry[0].id = '9';
  values.push(wrongWaba);
  const wrongPhone = payload();
  wrongPhone.entry[0].changes[0].value.metadata.phone_number_id = '9';
  values.push(wrongPhone);
  const echoes = payload();
  echoes.entry[0].changes[0].field = 'smb_message_echoes';
  values.push(echoes);
  const statuses = payload();
  statuses.entry[0].changes[0].value.messages = [];
  values.push(statuses);
  for (const data of values) {
    const body = raw(data);
    await central.receive(body, signature(body));
  }
  await central.drain();
  assert.equal((await db.query('SELECT * FROM whatsapp_inbox')).rows.length, 0);
});

test('primeira entrada de áudio sem nome cria lead e referência Meta não é inferida do texto', async () => {
  const data = payload();
  data.entry[0].changes[0].value.contacts = [];
  data.entry[0].changes[0].value.messages[0].type = 'audio';
  const body = raw(data);
  await central.receive(body, signature(body));
  await central.drain();
  assert.equal((await db.query('SELECT name FROM contacts')).rows[0].name, 'Contato WhatsApp');
  assert.equal(
    (await db.query('SELECT source FROM opportunities')).rows[0].source,
    'Não identificada',
  );
});

test('falha após ingestão é recuperada sem nova oportunidade ou avanço de fila', async () => {
  const body = raw(payload());
  await central.receive(body, signature(body));
  const row = (
    await db.query<{ event_id: string; lead: Parameters<CRM['ingest']>[0] }>(
      'SELECT * FROM whatsapp_inbox',
    )
  ).rows[0];
  await crm.ingest(row.lead, row.event_id, null);
  await db.query(
    "UPDATE whatsapp_inbox SET lease_id=$1,available_at=clock_timestamp()-interval '1 second'",
    [randomUUID()],
  );
  await central.drain();
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 1);
  assert.equal(
    (await db.query('SELECT last_position FROM distribution_settings')).rows[0].last_position,
    1,
  );
  assert.equal((await central.status()).pending, 0);
});

test('falha transitória é reprocessada e diagnóstico não revela dados ou segredos', async () => {
  const body = raw(payload());
  await central.receive(body, signature(body));
  const broken = new CRM(db);
  broken.ingest = async () => {
    throw new Error('segredo que não deve persistir');
  };
  await new WhatsAppCentral(broken, config).drain();
  assert.equal((await central.status()).retrying, 1);
  const row = (await db.query('SELECT * FROM whatsapp_inbox')).rows[0];
  assert.equal(row.last_error, 'PROCESSING_FAILED');
  await db.query("UPDATE whatsapp_inbox SET available_at=clock_timestamp()-interval '1 second'");
  await central.drain();
  assert.equal((await central.status()).retrying, 0);
  const { app } = await buildApp(db, { whatsapp: config, reconcile: false });
  try {
    for (const [email, expected] of [
      ['cadu@demo.artisti.local', 200],
      ['vanessa@demo.artisti.local', 403],
    ] as const) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-artisti-client': 'web' },
        payload: { email, password: DEMO_PASSWORD },
      });
      const response = await app.inject({
        url: '/api/v1/whatsapp/status',
        headers: { cookie: `artisti_session=${login.cookies[0].value}` },
      });
      assert.equal(response.statusCode, expected);
      assert.ok(!response.body.includes(config.appSecret));
      assert.ok(!response.body.includes(config.phoneNumberId));
    }
  } finally {
    await app.close();
  }
});
