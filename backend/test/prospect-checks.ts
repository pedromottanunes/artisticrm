import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import { InstagramProspects, normalizeInstagramProfile } from '../src/instagram-prospects.js';
import { Operations } from '../src/operations.js';
import { MongoOperations } from '../src/mongo-crm.js';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import type { User } from '../src/types.js';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';

export async function checkProspects(db: Database | MongoStore, manager: User, users: User[]) {
  const crm = db.kind === 'mongo' ? new MongoOperations(db) : new Operations(db);
  const config: InstagramConfig = {
    accountId: '17841455555444444',
    appSecret: 'prospect-test-secret',
    verifyToken: 'prospect-verify-only',
    accessToken: 'fake-token-never-used',
    graphApiVersion: 'v26.0',
  };
  const service = new InstagramProspects(db, config.accountId);
  let fail = false;
  let calls = 0;
  const profiles: Record<string, string> = {
    '10001': 'primeiro.perfil',
    '10002': 'sem.reserva',
    '10003': 'meta.indisponivel',
    '10004': 'consultor.inativo',
    '10005': 'simultaneo',
    '10006': 'entrega.recuperavel',
  };
  const central = new InstagramCentral(crm, config, async (url) => {
    calls++;
    assert.equal(new URL(String(url)).hostname, 'graph.instagram.com');
    if (fail) return new Response('', { status: 503 });
    const id = new URL(String(url)).pathname.split('/').pop()!;
    return Response.json({ id, username: profiles[id], timestamp: new Date().toISOString() });
  });
  const rows = async (table: string) =>
    db.kind === 'mongo'
      ? db.many<Record<string, any>>(table)
      : (await db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows;
  const set = async (table: string, id: string, values: Record<string, unknown>, key = 'id') => {
    if (db.kind === 'mongo') await db.update(table, { [key]: id }, { $set: values });
    else
      await db.query(
        `UPDATE ${table} SET ${Object.keys(values)
          .map((k, i) => `${k}=$${i + 1}`)
          .join(',')} WHERE ${key}=$${Object.keys(values).length + 1}`,
        [...Object.values(values), id],
      );
  };
  const deliver = async (sender: string, mid = randomUUID()) => {
    const payload = {
      object: 'instagram',
      entry: [
        {
          id: config.accountId,
          time: Math.floor(Date.now() / 1000),
          messaging: [
            {
              sender: { id: sender },
              recipient: { id: config.accountId },
              timestamp: Date.now(),
              message: { mid, text: 'Resposta de teste' },
            },
          ],
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(payload));
    await central.receive(
      body,
      `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
    );
    await central.drain();
  };
  const leadFor = async (sender: string) => {
    const identity = (await rows('contact_identities')).find(
      (row) => row.external_user_id === sender,
    );
    return (await rows('opportunities')).find((row) => row.contact_id === identity?.contact_id);
  };

  assert.equal(
    normalizeInstagramProfile(' https://www.instagram.com/Primeiro.Perfil/?igsh=abc '),
    'primeiro.perfil',
  );
  assert.equal(normalizeInstagramProfile('@Primeiro.Perfil'), 'primeiro.perfil');
  for (const bad of [
    'https://instagram.com.evil.test/user',
    'https://instagram.com/p/abc/',
    'https://instagram.com/reel/abc',
    'https://evil.test/',
    '@a/b',
    'https://user@instagram.com/profile',
    'https://instagram.com:444/profile',
    '@a..b',
  ])
    assert.throws(() => normalizeInstagramProfile(bad));
  await assert.rejects(service.create(manager, { profile: '@x', source: 'Curtida' }), /consultor/);
  const countBefore = (await rows('opportunities')).length;
  const reserved = await service.create(users[1], {
    profile: '@Primeiro.Perfil',
    source: 'Curtida',
  });
  assert.equal(
    (await rows('opportunities')).length,
    countBefore,
    'Reservations are not received leads',
  );
  assert.equal(calls, 0, 'Registering a link must never fetch the user supplied URL or call Meta');
  assert.equal(
    (await service.create(users[1], { profile: '@primeiro.perfil', source: 'Curtida' })).id,
    reserved.id,
  );
  await assert.rejects(
    service.create(users[0], { profile: '@primeiro.perfil', source: 'Novo seguidor' }),
    /reserva/,
  );
  assert.equal(
    (await service.list(users[0])).items.length,
    0,
    'Other attendants cannot see reservations',
  );
  assert.equal((await service.list(manager)).items.length, 1);
  await assert.rejects(service.cancel(users[0], reserved.id, 1), /não encontrada/);
  const queue = (await rows('distribution_settings'))[0].last_position;
  const credits = (await rows('users')).map((row) => [row.id, row.queue_credit]);
  await deliver('10001', 'first-response');
  let lead = await leadFor('10001');
  assert.equal(lead?.owner_id, users[1].id);
  assert.equal(lead?.state, 'CLAIMED');
  assert.equal(lead?.expires_at, null);
  assert.equal((await rows('distribution_settings'))[0].last_position, queue);
  assert.deepEqual(
    (await rows('users')).map((row) => [row.id, row.queue_credit]),
    credits,
  );
  assert.equal((await service.list(users[1])).items[0].status, 'matched');
  const afterMatch = calls;
  await deliver('10001', 'first-response');
  await deliver('10001', 'second-response');
  assert.equal(calls, afterMatch, 'Known conversations must not repeat profile lookup');
  assert.equal((await rows('opportunities')).length, countBefore + 1);
  assert.equal((await rows('messages')).length, 2, 'Duplicate webhook must not duplicate messages');
  // A manager can transfer an existing lead without the old reservation stealing it back.
  lead = await leadFor('10001');
  await crm.transfer(
    manager,
    lead!.id,
    {
      target_id: users[0].id,
      expected_version: lead!.version,
      reason: 'Teste de transferência administrativa',
    },
    randomUUID(),
  );
  await deliver('10001', 'after-transfer');
  assert.equal((await leadFor('10001'))?.owner_id, users[0].id);
  assert.equal(
    (await service.list(users[0])).items.find((row) => row.id === reserved.id)?.owner_id,
    users[0].id,
  );

  const cancelled = await service.create(users[0], {
    profile: '@cancelar.teste',
    source: 'Curtida',
  });
  await service.cancel(users[0], cancelled.id, 1);
  const reReserved = await service.create(users[1], {
    profile: '@cancelar.teste',
    source: 'Curtida',
  });
  assert.equal(reReserved.id, cancelled.id);
  await assert.rejects(service.cancel(users[1], cancelled.id, 1), /mudou/);
  const expired = await service.create(users[0], { profile: '@vencida.teste', source: 'Curtida' });
  await set('instagram_prospects', expired.id, { expires_at: new Date(0) });
  assert.equal(
    (await service.list(users[0])).items.find((row) => row.id === expired.id)?.status,
    'expired',
  );
  await service.create(users[1], { profile: '@vencida.teste', source: 'Curtida' });
  assert.equal(
    (await service.list(users[1])).items.find((row) => row.id === expired.id)?.status,
    'waiting',
  );

  // A matching username with a previously verified different ID is NOT enough to assign.
  const mismatch = await service.create(users[0], {
    profile: '@identidade.divergente',
    source: 'Curtida',
  });
  await set('instagram_prospects', mismatch.id, { external_user_id: 'old-scoped-id' });
  profiles['10007'] = 'identidade.divergente';
  await deliver('10007');
  assert.equal((await leadFor('10007'))?.owner_id, null);
  assert.equal((await leadFor('10007'))?.needs_review, true);
  assert.equal(
    (await service.list(users[0])).items.find((row) => row.id === mismatch.id)?.status,
    'review',
  );
  // Another connected account cannot consume this account's reservation.
  const otherAccount = new InstagramProspects(db, '17841411111111111');
  await otherAccount.create(users[0], { profile: '@cancelar.teste', source: 'Curtida' });
  assert.equal((await otherAccount.list(users[0])).items.length, 1);

  const race = await Promise.allSettled(
    users
      .slice(0, 2)
      .map((user) => service.create(user, { profile: '@perfil.concorrente', source: 'Curtida' })),
  );
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  await deliver('10002');
  assert.equal(
    (await leadFor('10002'))?.state,
    'RESERVED',
    'Unmatched response keeps normal distribution',
  );
  await assert.rejects(
    service.create(users[0], { profile: '@sem.reserva', source: 'Curtida' }),
    /atendimento/,
  );

  await service.create(users[0], { profile: '@entrega.recuperavel', source: 'Novo seguidor' });
  const originalPersist = (central as any).persistInbound.bind(central);
  let breakOnce = true;
  (central as any).persistInbound = async (...args: unknown[]) => {
    if (breakOnce) {
      breakOnce = false;
      throw new Error('Crash after ingest');
    }
    return originalPersist(...args);
  };
  await deliver('10006', 'recover');
  const recoverLead = await leadFor('10006');
  const pending = (await rows('instagram_webhook_inbox')).find((row) => !row.processed_at);
  assert.ok(pending?.prospect_routing);
  await set('instagram_webhook_inbox', pending.event_id, { available_at: new Date(0) }, 'event_id');
  const restarted = new InstagramCentral(crm, config, async () => {
    throw new Error('Should use persisted routing');
  });
  await restarted.drain();
  assert.equal((await leadFor('10006'))?.id, recoverLead?.id);
  assert.equal((await leadFor('10006'))?.owner_id, users[0].id);
  assert.equal(
    (await rows('messages')).filter((row) => row.sender_external_id === '10006').length,
    1,
  );

  await service.create(users[0], { profile: '@simultaneo', source: 'Curtida' });
  const commentBody = Buffer.from(
    JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: config.accountId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'comments',
              value: { id: '9001', from: { id: '10005', username: 'simultaneo' }, text: 'Olá' },
            },
          ],
        },
      ],
    }),
  );
  await central.receive(
    commentBody,
    `sha256=${createHmac('sha256', config.appSecret).update(commentBody).digest('hex')}`,
  );
  await central.drain();
  const item = (await central.comments.list(users[1])).comments[0];
  assert.equal(item.can_claim, false);
  await assert.rejects(central.comments.claim(users[1], item.id, item.version), /reserva/);
  await assert.rejects(central.comments.ignore(users[1], item.id, item.version), /reservado/);
  await central.comments.claim(users[0], item.id, item.version);
  const commentLead = await leadFor('10005');
  await deliver('10005');
  assert.equal((await leadFor('10005'))?.id, commentLead?.id);
  assert.equal(
    (await rows('conversations')).filter((row) => row.opportunity_id === commentLead?.id).length,
    1,
  );

  await service.create(users[2], { profile: '@consultor.inativo', source: 'Novo seguidor' });
  await set('users', users[2].id, { active: false });
  await deliver('10004');
  assert.equal((await leadFor('10004'))?.state, 'PENDING');
  assert.equal((await leadFor('10004'))?.needs_review, true);
  await set('users', users[2].id, { active: true });

  await service.create(users[0], { profile: '@meta.indisponivel', source: 'Curtida' });
  fail = true;
  await deliver('10003');
  assert.equal(await leadFor('10003'), undefined, 'Failed lookup must not randomly distribute');
  for (let i = 0; i < 2; i++) {
    for (const row of (await rows('instagram_webhook_inbox')).filter((row) => !row.processed_at))
      await set('instagram_webhook_inbox', row.event_id, { available_at: new Date(0) }, 'event_id');
    // Simulate the scheduled cooldown elapsing and a restarted worker making the next request.
    await new InstagramCentral(crm, config, async () => new Response('', { status: 503 })).drain();
  }
  lead = await leadFor('10003');
  assert.equal(lead?.state, 'PENDING');
  assert.equal(lead?.owner_id, null);
  assert.equal(lead?.needs_review, true);
  assert.equal(
    (await rows('messages')).filter((row) => row.sender_external_id === '10003').length,
    1,
    'Unresolved message is visible to management',
  );

  const { app } = await buildApp(db, { instagram: config, reconcile: false });
  try {
    const token = randomUUID();
    const expires = new Date(Date.now() + 3600_000);
    if (db.kind === 'mongo')
      await db.insert('sessions', {
        token_hash: tokenHash(token),
        user_id: users[0].id,
        auth_version: users[0].auth_version,
        expires_at: expires,
      });
    else
      await db.query(
        'INSERT INTO sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)',
        [tokenHash(token), users[0].id, users[0].auth_version, expires],
      );
    const headers = { cookie: `artisti_session=${token}`, 'x-artisti-client': 'web' };
    const made = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/prospects',
      headers,
      payload: { profile: '@api.test', source: 'Curtida' },
    });
    assert.equal(made.statusCode, 201, made.body);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/instagram/prospects',
      headers,
      payload: { profile: '@forged', owner_id: users[1].id },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/v1/instagram/prospects' })).statusCode,
      401,
    );
    const manual = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      headers,
      payload: { name: 'Manual', phone: '5548999999999', owner_id: users[1].id },
    });
    assert.equal(manual.statusCode, 400, 'Manual creation cannot choose another owner');
    const page = (
      await app.inject({ method: 'GET', url: '/api/v1/instagram/prospects', headers })
    ).json();
    assert.ok(page.items.every((row: any) => row.owner_id === users[0].id));
  } finally {
    await app.close();
  }
}
