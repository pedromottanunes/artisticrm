import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { openDatabase, migrate, type Database } from '../src/db.js';
import { CRM } from '../src/crm.js';
import { seedDemo, DEMO_PASSWORD } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { InstagramCentral, instagramConfig, type InstagramConfig } from '../src/instagram.js';
import type { User } from '../src/types.js';

const config: InstagramConfig = {
  appSecret: 'instagram-test-secret-only',
  verifyToken: 'instagram-test-verify-token-32-characters',
  accountId: '17841435843172523',
  accessToken: 'IGAA-synthetic-token-never-sent-to-meta',
  graphApiVersion: 'v26.0',
  username: 'fulljob.test',
  profileLookup: false,
};

const payload = (
  mid = 'ig-mid-synthetic-1',
  sender = 'ig-scoped-synthetic-1',
  referral?: Record<string, unknown>,
) => ({
  object: 'instagram',
  entry: [
    {
      id: config.accountId,
      time: 1_789_030_800,
      messaging: [
        {
          sender: { id: sender },
          recipient: { id: config.accountId },
          timestamp: 1_789_030_800_000,
          message: {
            mid,
            text: 'Mensagem sintética de teste',
          },
          ...(referral ? { referral } : {}),
        },
      ],
    },
  ],
});

const raw = (value: unknown) => Buffer.from(JSON.stringify(value));
const signature = (body: Buffer) =>
  `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`;

let db: Database;
let crm: CRM;
let manager: User;
let attendants: User[];

before(async () => {
  db = await openDatabase();
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
    'TRUNCATE conversation_reads,messages,instagram_pending_referrals,instagram_webhook_inbox,conversations,contact_identities,channel_accounts,push_records,whatsapp_inbox,claims,appointments,lead_attributions,inbound_events,audit_events,opportunities,contacts,sessions',
  );
  await db.query('UPDATE distribution_settings SET last_position=0,timeout_minutes=10');
  await db.query('UPDATE users SET queue_weight=1,queue_credit=0');
});

after(async () => db.close());

test('Instagram fica desligado por padrão e configuração parcial falha fechada', () => {
  assert.equal(instagramConfig({}), undefined);
  assert.throws(() => instagramConfig({ INSTAGRAM_ENABLED: 'true' }), /incompleta/);
});

test('webhook HTTP valida desafio e assinatura sem exigir sessão', async () => {
  const { app } = await buildApp(db, { instagram: config, reconcile: false });
  try {
    const url = '/webhooks/instagram?hub.mode=subscribe&hub.challenge=challenge&hub.verify_token=';
    assert.equal((await app.inject({ url: `${url}wrong` })).statusCode, 403);
    const verified = await app.inject({ url: `${url}${config.verifyToken}` });
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body, 'challenge');

    const bytes = raw(payload());
    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: { 'content-type': 'application/json' },
      payload: bytes,
    });
    assert.equal(missing.statusCode, 401);
    const valid = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signature(bytes),
      },
      payload: bytes,
    });
    assert.equal(valid.statusCode, 200);
    assert.equal((await db.query('SELECT * FROM instagram_webhook_inbox')).rows.length, 1);
  } finally {
    await app.close();
  }
});

test('Direct cria identidade sem telefone, conversa e reserva; reentrega não duplica', async () => {
  const central = new InstagramCentral(crm, config);
  const body = raw(payload());
  await Promise.all([
    central.receive(body, signature(body)),
    central.receive(body, signature(body)),
  ]);
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
  await central.drain();
  await central.drain();

  const contacts = (
    await db.query<{ id: string; phone: string | null; name: string }>('SELECT * FROM contacts')
  ).rows;
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].phone, null);
  assert.equal(contacts[0].name, 'Contato Instagram');
  const identity = (await db.query<Record<string, string>>('SELECT * FROM contact_identities'))
    .rows[0];
  assert.equal(identity.provider, 'instagram');
  assert.equal(identity.channel_account_id, config.accountId);
  assert.equal(identity.external_user_id, 'ig-scoped-synthetic-1');

  const opportunities = (
    await db.query<{
      id: string;
      state: string;
      source: string;
      interest: string;
      reserved_to: string;
    }>('SELECT * FROM opportunities')
  ).rows;
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].state, 'RESERVED');
  assert.equal(opportunities[0].source, 'Instagram — origem orgânica');
  assert.equal(opportunities[0].interest, 'Direct do Instagram');
  assert.equal(opportunities[0].reserved_to, attendants[0].id);
  assert.equal((await db.query('SELECT * FROM conversations')).rows.length, 1);
  const messages = (await db.query<{ text: string; direction: string }>('SELECT * FROM messages'))
    .rows;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].direction, 'inbound');
  assert.equal(messages[0].text, 'Mensagem sintética de teste');
  assert.equal((await central.status()).pending, 0);
});

test('novas mensagens do mesmo IGSID preservam oportunidade e responsável', async () => {
  const central = new InstagramCentral(crm, config);
  for (const mid of ['ig-history-1', 'ig-history-2']) {
    const body = raw(payload(mid));
    await central.receive(body, signature(body));
    await central.drain();
  }
  assert.equal((await db.query('SELECT * FROM contacts')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM conversations')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM messages')).rows.length, 2);
  assert.equal((await db.query('SELECT * FROM inbound_events')).rows.length, 2);
});

test('referência explícita de anúncio é atribuída sem inferir campanhas ausentes', async () => {
  const central = new InstagramCentral(crm, config);
  const body = raw(
    payload('ig-ad-1', 'ig-ad-sender', {
      source_type: 'ad',
      ad_id: 'synthetic-ad-id',
      ads_context_data: {
        ad_id: 'synthetic-ad-id',
        ad_title: 'Criativo sintético',
        photo_url: 'https://example.test/creative.jpg',
      },
      unknown: 'não persistir',
    }),
  );
  await central.receive(body, signature(body));
  await central.drain();
  const opportunity = (await db.query<{ source: string }>('SELECT source FROM opportunities'))
    .rows[0];
  assert.equal(opportunity.source, 'Meta Ads');
  const attribution = (await db.query<Record<string, string>>('SELECT * FROM lead_attributions'))
    .rows[0];
  assert.equal(attribution.channel, 'instagram');
  assert.equal(attribution.source_id, 'synthetic-ad-id');
  assert.equal(attribution.headline, 'Criativo sintético');
  assert.ok(!JSON.stringify(attribution).includes('não persistir'));
});

test('somente responsável que aceitou responde e reuso da chave não envia duas vezes', async () => {
  const requests: { url: string; authorization: string; body: unknown }[] = [];
  let releaseFetch!: () => void;
  let markRequestStarted!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const mockFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      authorization: String((init?.headers as Record<string, string>).Authorization),
      body: JSON.parse(String(init?.body)),
    });
    markRequestStarted();
    await fetchGate;
    return new Response(
      JSON.stringify({ recipient_id: 'ig-scoped-synthetic-1', message_id: 'ig-out-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const central = new InstagramCentral(crm, config, mockFetch);
  const body = raw(payload());
  await central.receive(body, signature(body));
  await central.drain();
  const opportunity = (
    await db.query<{ id: string; version: number; reserved_to: string }>(
      'SELECT id,version,reserved_to FROM opportunities',
    )
  ).rows[0];
  const conversation = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0];

  await assert.rejects(() => central.messages(attendants[0], conversation.id), {
    code: 'FORBIDDEN',
  });
  await assert.rejects(() => central.send(attendants[1], conversation.id, 'Olá', randomUUID()), {
    code: 'FORBIDDEN',
  });
  await crm.claim(attendants[0], opportunity.id, 'reservation', opportunity.version, randomUUID());
  assert.equal((await central.messages(attendants[0], conversation.id)).messages.length, 1);
  const key = randomUUID();
  const firstSend = central.send(attendants[0], conversation.id, 'Olá pelo CRM', key);
  await requestStarted;
  const concurrentReplay = await central.send(attendants[0], conversation.id, 'Olá pelo CRM', key);
  assert.equal(concurrentReplay.status, 'sending');
  releaseFetch();
  const sent = await firstSend;
  assert.equal(sent.status, 'sent');
  assert.equal(sent.external_message_id, 'ig-out-1');
  assert.deepEqual(await central.send(attendants[0], conversation.id, 'Olá pelo CRM', key), sent);
  await assert.rejects(() => central.send(attendants[0], conversation.id, 'Mudou', key), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    `https://graph.instagram.com/${config.graphApiVersion}/${config.accountId}/messages`,
  );
  assert.equal(requests[0].authorization, `Bearer ${config.accessToken}`);
  assert.deepEqual(requests[0].body, {
    recipient: { id: 'ig-scoped-synthetic-1' },
    message: { text: 'Olá pelo CRM' },
  });
  assert.equal((await db.query('SELECT * FROM messages')).rows.length, 2);
});

test('imagem e áudio do webhook preservam URLs e imagem pode ser baixada sem armazenamento', async () => {
  const imageUrl = 'https://lookaside.fbsbx.com/instagram-image.jpg';
  const audioUrl = 'https://lookaside.fbsbx.com/instagram-audio.mp4';
  const mediaPayload = {
    object: 'instagram',
    entry: [
      {
        id: config.accountId,
        messaging: [
          {
            sender: { id: 'ig-scoped-media-user' },
            recipient: { id: config.accountId },
            timestamp: 1_789_030_800_000,
            message: {
              mid: 'ig-mid-media',
              attachments: [
                { type: 'image', payload: { url: imageUrl } },
                { type: 'audio', payload: { url: audioUrl } },
              ],
            },
          },
        ],
      },
    ],
  };
  const bytes = raw(mediaPayload);
  const central = new InstagramCentral(crm, config);
  await central.receive(bytes, signature(bytes));
  await central.drain();

  const conversation = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0];
  const history = await central.messages(manager, conversation.id);
  assert.deepEqual(history.messages[0].attachments, [
    { type: 'image', url: imageUrl },
    { type: 'audio', url: audioUrl },
  ]);

  const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const mediaFetch: typeof fetch = async (input) => {
    assert.equal(String(input), imageUrl);
    return new Response(imageBytes, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(imageBytes.length) },
    });
  };
  const { app } = await buildApp(db, {
    instagram: config,
    instagramFetch: mediaFetch,
    reconcile: false,
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: manager.email, password: DEMO_PASSWORD },
    });
    const cookie = `artisti_session=${login.cookies[0].value}`;
    const download = await app.inject({
      url: `/api/v1/conversations/${conversation.id}/messages/${history.messages[0].id}/attachments/0/download`,
      headers: { cookie },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'image/jpeg');
    assert.match(String(download.headers['content-disposition']), /^attachment;/);
    assert.deepEqual(download.rawPayload, Buffer.from(imageBytes));
  } finally {
    await app.close();
  }
});

test('rotas autenticadas listam e leem conversa sem expor token', async () => {
  const central = new InstagramCentral(crm, config);
  const body = raw(payload());
  await central.receive(body, signature(body));
  await central.drain();
  const { app } = await buildApp(db, { instagram: config, reconcile: false });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { email: 'cadu@demo.artisti.local', password: DEMO_PASSWORD },
    });
    const cookie = `artisti_session=${login.cookies[0].value}`;
    const status = await app.inject({ url: '/api/v1/instagram/status', headers: { cookie } });
    assert.equal(status.statusCode, 200);
    assert.ok(!status.body.includes(config.accessToken));
    assert.ok(!status.body.includes(config.appSecret));
    const list = await app.inject({ url: '/api/v1/conversations', headers: { cookie } });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().conversations.length, 1);
  } finally {
    await app.close();
  }
});

test('referral independente e postback entram no CRM sem perder a origem do anuncio', async () => {
  const central = new InstagramCentral(crm, config);
  const referralBody = raw({
    object: 'instagram',
    entry: [
      {
        id: config.accountId,
        messaging: [
          {
            sender: { id: 'ig-referral-only-user' },
            recipient: { id: config.accountId },
            timestamp: 1_789_030_800_000,
            referral: {
              source: 'ADS',
              type: 'OPEN_THREAD',
              ad_id: 'synthetic-standalone-ad',
              referer_uri: 'https://example.test/ad',
              ads_context_data: { ad_title: 'Anuncio independente' },
            },
          },
        ],
      },
    ],
  });
  assert.equal(await central.receive(referralBody, signature(referralBody)), 1);
  await central.drain();
  assert.equal((await db.query('SELECT * FROM opportunities')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM instagram_pending_referrals')).rows.length, 1);

  const interactionBody = raw({
    object: 'instagram',
    entry: [
      {
        id: config.accountId,
        messaging: [
          {
            sender: { id: 'ig-referral-only-user' },
            recipient: { id: config.accountId },
            timestamp: 1_789_030_801_000,
            message: { mid: 'message-after-referral', text: 'Vim pelo anuncio' },
          },
          {
            sender: { id: 'ig-postback-user' },
            recipient: { id: config.accountId },
            timestamp: 1_789_030_802_000,
            postback: { mid: 'postback-mid-1', title: 'Quero saber mais', payload: 'INTEREST' },
          },
        ],
      },
    ],
  });
  assert.equal(await central.receive(interactionBody, signature(interactionBody)), 2);
  await central.drain();

  const attribution = (
    await db.query<Record<string, string>>(
      "SELECT * FROM lead_attributions WHERE source_id='synthetic-standalone-ad'",
    )
  ).rows[0];
  assert.equal(attribution.source_url, 'https://example.test/ad');
  assert.equal(attribution.headline, 'Anuncio independente');
  const messages = (
    await db.query<{ type: string; text: string }>(
      'SELECT type,text FROM messages ORDER BY created_at',
    )
  ).rows;
  assert.deepEqual(messages, [
    { type: 'text', text: 'Vim pelo anuncio' },
    { type: 'postback', text: 'Quero saber mais' },
  ]);
  assert.equal((await db.query('SELECT * FROM instagram_pending_referrals')).rows.length, 0);
});

test('caixa filtra a responsavel antes do limite global de cem conversas', async () => {
  const central = new InstagramCentral(crm, config);
  const accountId = randomUUID();
  await db.query(
    `INSERT INTO channel_accounts(id,provider,external_account_id,username,status,graph_api_version)
     VALUES ($1,'instagram',$2,'fulljob.test','active',$3)`,
    [accountId, config.accountId, config.graphApiVersion],
  );
  for (let index = 0; index < 101; index++) {
    const contactId = randomUUID();
    const opportunityId = randomUUID();
    const conversationId = randomUUID();
    const createdAt = new Date(Date.now() + index * 60_000);
    const ownerId = index === 0 ? attendants[0].id : attendants[1].id;
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO contacts(id,name,phone) VALUES ($1,$2,NULL)', [
        contactId,
        `Contato ${index}`,
      ]);
      await tx.query(
        `INSERT INTO opportunities(
           id,contact_id,state,owner_id,created_at,last_message_at,channel
         ) VALUES ($1,$2,'CLAIMED',$3,$4,$4,'instagram')`,
        [opportunityId, contactId, ownerId, createdAt],
      );
      await tx.query(
        `INSERT INTO contact_identities(
           id,contact_id,provider,channel_account_id,external_user_id,last_seen_at
         ) VALUES ($1,$2,'instagram',$3,$4,$5)`,
        [randomUUID(), contactId, config.accountId, `ig-list-user-${index}`, createdAt],
      );
      await tx.query(
        `INSERT INTO conversations(
           id,channel_account_id,contact_id,opportunity_id,last_message_at,created_at,updated_at
         ) VALUES ($1,$2,$3,$4,$5,$5,$5)`,
        [conversationId, accountId, contactId, opportunityId, createdAt],
      );
    });
  }

  const list = await central.list(attendants[0], 'mine');
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].contact_name, 'Contato 0');
});

test('historico limitado retorna as duzentas mensagens mais recentes em ordem cronologica', async () => {
  const central = new InstagramCentral(crm, config);
  const body = raw(payload('ig-history-limit'));
  await central.receive(body, signature(body));
  await central.drain();
  const opportunity = (
    await db.query<{ id: string; version: number }>('SELECT id,version FROM opportunities')
  ).rows[0];
  const conversation = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0];
  await crm.claim(attendants[0], opportunity.id, 'reservation', opportunity.version, randomUUID());
  await db.query('DELETE FROM messages WHERE conversation_id=$1', [conversation.id]);
  for (let index = 0; index < 205; index++)
    await db.query(
      `INSERT INTO messages(id,conversation_id,direction,type,text,status,created_at)
       VALUES ($1,$2,'inbound','text',$3,'received',$4)`,
      [randomUUID(), conversation.id, `Mensagem ${index}`, new Date(Date.now() + index * 1000)],
    );

  const result = await central.messages(attendants[0], conversation.id);
  assert.equal(result.messages.length, 200);
  assert.equal((result.messages[0] as { text: string }).text, 'Mensagem 5');
  assert.equal((result.messages[199] as { text: string }).text, 'Mensagem 204');
});

test('envio interrompido deixa de permanecer indefinidamente em sending', async () => {
  const central = new InstagramCentral(crm, config);
  const body = raw(payload('ig-recovery-message'));
  await central.receive(body, signature(body));
  await central.drain();
  const conversation = (await db.query<{ id: string }>('SELECT id FROM conversations')).rows[0];
  const messageId = randomUUID();
  await db.query(
    `INSERT INTO messages(
       id,conversation_id,direction,type,text,status,sending_started_at,created_at
     ) VALUES ($1,$2,'outbound','text','Pendente','sending',clock_timestamp()-interval '5 minutes',clock_timestamp()-interval '5 minutes')`,
    [messageId, conversation.id],
  );
  assert.equal(await central.recoverStaleSends(), 1);
  const recovered = (
    await db.query<{ status: string; error_code: string }>(
      'SELECT status,error_code FROM messages WHERE id=$1',
      [messageId],
    )
  ).rows[0];
  assert.deepEqual(recovered, { status: 'unknown', error_code: 'PROCESS_INTERRUPTED' });
});

test('consulta o perfil do remetente e exibe nome, usuario e foto sem bloquear o Direct', async () => {
  const requests: string[] = [];
  const profileFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.origin, 'https://graph.instagram.com');
    assert.equal(url.pathname, `/${config.graphApiVersion}/ig-profile-sender`);
    assert.equal(url.searchParams.get('fields'), 'id,name,username,profile_pic');
    assert.equal(
      String((init?.headers as Record<string, string>).Authorization),
      `Bearer ${config.accessToken}`,
    );
    return new Response(
      JSON.stringify({
        id: 'ig-profile-sender',
        name: 'Pedro Perfil',
        username: 'pedro.perfil',
        profile_pic: 'https://scontent.cdninstagram.com/profile.jpg',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const central = new InstagramCentral(crm, { ...config, profileLookup: true }, profileFetch);
  const body = raw(payload('ig-profile-message', 'ig-profile-sender'));
  await central.receive(body, signature(body));
  await central.drain();

  const second = raw(payload('ig-profile-message-2', 'ig-profile-sender'));
  await central.receive(second, signature(second));
  await central.drain();

  assert.equal(requests.length, 1);
  assert.equal(
    (await db.query<{ name: string }>('SELECT name FROM contacts')).rows[0].name,
    'Pedro Perfil',
  );
  const identity = (
    await db.query<{
      username: string;
      display_name: string;
      profile_picture_url: string;
      profile_updated_at: Date | null;
    }>(
      'SELECT username,display_name,profile_picture_url,profile_updated_at FROM contact_identities',
    )
  ).rows[0];
  assert.equal(identity.username, 'pedro.perfil');
  assert.equal(identity.display_name, 'Pedro Perfil');
  assert.equal(identity.profile_picture_url, 'https://scontent.cdninstagram.com/profile.jpg');
  assert.ok(identity.profile_updated_at);
  const listed = await central.list(manager, 'all');
  await db.query("UPDATE contacts SET instagram='' WHERE name='Pedro Perfil'");
  const reservedDetail = await crm.detail(attendants[0], listed.conversations[0].opportunity_id);
  assert.equal(reservedDetail.instagram, 'pedro.perfil');
  assert.equal(reservedDetail.profile_picture_url, 'https://scontent.cdninstagram.com/profile.jpg');
  assert.equal(listed.conversations[0].contact_name, 'Pedro Perfil');
  assert.equal(listed.conversations[0].instagram_username, 'pedro.perfil');
  assert.equal(
    listed.conversations[0].profile_picture_url,
    'https://scontent.cdninstagram.com/profile.jpg',
  );
});
