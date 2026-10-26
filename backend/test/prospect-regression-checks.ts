import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Operations } from '../src/operations.js';
import { MongoOperations } from '../src/mongo-crm.js';
import { migrate, type Database } from '../src/db.js';
import { initializeMongo, type MongoStore } from '../src/mongo-store.js';
import type { LeadInput } from '../src/crm.js';
import type { User } from '../src/types.js';
import { InstagramCentral, type InstagramConfig, type InstagramFetch } from '../src/instagram.js';
import { InstagramProspects } from '../src/instagram-prospects.js';

function fixture(db: Database | MongoStore) {
  const crm = db.kind === 'mongo' ? new MongoOperations(db) : new Operations(db);
  const config: InstagramConfig = {
    accountId: '17841433333222222',
    appSecret: 'isolated-regression-secret',
    verifyToken: 'test-only',
    accessToken: 'synthetic-never-sent',
    graphApiVersion: 'v26.0',
  };
  const prospects = new InstagramProspects(db, config.accountId);
  const central = (request: InstagramFetch) => new InstagramCentral(crm, config, request);
  const rows = async (table: string) =>
    db.kind === 'mongo'
      ? db.many<Record<string, any>>(table)
      : (await db.query<Record<string, any>>(`SELECT * FROM ${table}`)).rows;
  const set = async (table: string, id: string, values: Record<string, unknown>, key = 'id') => {
    if (db.kind === 'mongo') await db.update(table, { [key]: id }, { $set: values });
    else
      await db.query(
        `UPDATE ${table} SET ${Object.keys(values)
          .map((name, i) => `${name}=$${i + 1}`)
          .join(',')} WHERE ${key}=$${Object.keys(values).length + 1}`,
        [...Object.values(values), id],
      );
  };
  const lead = async (sender: string) => {
    const identity = (await rows('contact_identities')).find(
      (row) => row.external_user_id === sender,
    );
    return (await rows('opportunities')).find((row) => row.contact_id === identity?.contact_id);
  };
  const receive = async (worker: InstagramCentral, sender: string) => {
    const body = Buffer.from(
      JSON.stringify({
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
                message: { mid: randomUUID(), text: 'Resposta sintética' },
              },
            ],
          },
        ],
      }),
    );
    await worker.receive(
      body,
      `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
    );
    await worker.drain();
  };
  const advanceRetries = async () => {
    for (const row of (await rows('instagram_webhook_inbox')).filter((row) => !row.processed_at))
      await set('instagram_webhook_inbox', row.event_id, { available_at: new Date(0) }, 'event_id');
  };
  const queue = async () => ({
    settings: (await rows('distribution_settings')).map(
      ({ last_position, timeout_minutes, version }) => ({
        last_position,
        timeout_minutes,
        version,
      }),
    ),
    credits: (await rows('users'))
      .filter((user) => user.role === 'attendant')
      .map(({ id, queue_credit }) => ({ id, queue_credit }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return { crm, config, prospects, central, rows, set, lead, receive, advanceRetries, queue };
}

export async function checkProspectCooldown(
  db: Database | MongoStore,
  _manager: User,
  users: User[],
) {
  const f = fixture(db);
  await f.prospects.create(users[0], { profile: '@pausa.meta', source: 'Curtida' });
  let calls = 0;
  let fail = true;
  const request: InstagramFetch = async (url) => {
    calls++;
    return fail
      ? new Response('', { status: 503 })
      : Response.json({
          id: new URL(String(url)).pathname.split('/').pop(),
          username: 'pausa.meta',
        });
  };
  const worker = f.central(request);
  await f.receive(worker, '20001');
  fail = false;
  // Even if another poll selects the record while the circuit is open, it cannot exhaust attempts.
  for (let i = 0; i < 4; i++) {
    await f.advanceRetries();
    await worker.drain();
  }
  assert.equal(calls, 1);
  assert.equal(
    await f.lead('20001'),
    undefined,
    'A cooldown must not turn a recoverable response into an unassigned lead',
  );
  const waiting = (await f.rows('instagram_webhook_inbox'))[0];
  assert.equal(waiting.prospect_profile_attempts, 1);
  assert.ok(
    new Date(waiting.available_at).getTime() > Date.now() + 30_000,
    'Next run must respect the circuit cooldown',
  );
  // Restart retains the scheduled time and the actual request counter.
  const restarted = f.central(request);
  await restarted.drain();
  assert.equal(calls, 1);
  await f.advanceRetries(); // Simulate the persisted cooldown having elapsed.
  await restarted.drain();
  assert.equal(calls, 2);
  assert.equal((await f.lead('20001'))?.owner_id, users[0].id);
  assert.equal((await f.prospects.list(users[0])).items[0].status, 'matched');

  await f.prospects.create(users[0], { profile: '@falha.persistente', source: 'Curtida' });
  fail = true;
  const beforePermanent = calls;
  await f.receive(f.central(request), '20002');
  for (let i = 0; i < 2; i++) {
    await f.advanceRetries();
    await f.central(request).drain();
  }
  assert.equal(
    calls - beforePermanent,
    3,
    'The fallback requires three actual profile requests, across restarts',
  );
  assert.equal((await f.lead('20002'))?.needs_review, true);
  assert.equal((await f.lead('20002'))?.owner_id, null);
  assert.equal(
    (await f.rows('messages')).filter((row) => row.sender_external_id === '20002').length,
    1,
  );
}

export async function checkProspectReviewTransfer(
  db: Database | MongoStore,
  manager: User,
  users: User[],
) {
  const f = fixture(db);
  const saved = await f.prospects.create(users[0], {
    profile: '@consultor.pausado',
    source: 'Novo seguidor',
  });
  await f.set('users', users[0].id, { active: false });
  const worker = f.central(async (url) =>
    Response.json({
      id: new URL(String(url)).pathname.split('/').pop(),
      username: 'consultor.pausado',
    }),
  );
  await f.receive(worker, '20003');
  const lead = (await f.lead('20003'))!;
  assert.equal(lead.needs_review, true);
  await f.crm.transfer(
    manager,
    lead.id,
    {
      target_id: users[1].id,
      expected_version: lead.version,
      reason: 'Revisão de vínculo na gestão',
    },
    randomUUID(),
  );
  const reservation = (await f.prospects.list(manager)).items.find((row) => row.id === saved.id)!;
  assert.equal(
    reservation.owner_id,
    users[1].id,
    'Review reservations must move together with the lead',
  );
  assert.equal(
    reservation.status,
    'matched',
    'A verified identity is resolved by the administrative assignment',
  );
  assert.equal(reservation.opportunity_id, lead.id);
  await f.receive(worker, '20003');
  assert.equal((await f.lead('20003'))?.owner_id, users[1].id);
  assert.equal((await f.prospects.list(users[1])).items[0].status, 'matched');
}

export async function checkProspectIdentityConflict(
  db: Database | MongoStore,
  manager: User,
  users: User[],
) {
  const f = fixture(db);
  const saved = await f.prospects.create(users[0], {
    profile: '@perfil.reutilizado',
    source: 'Curtida',
  });
  const worker = f.central(async (url) =>
    Response.json({
      id: new URL(String(url)).pathname.split('/').pop(),
      username: 'perfil.reutilizado',
    }),
  );
  await f.receive(worker, '20004');
  const original = (await f.lead('20004'))!;
  const before = (await f.rows('instagram_prospects')).find((row) => row.id === saved.id)!;
  await f.receive(worker, '20005');
  const conflicting = (await f.lead('20005'))!;
  assert.equal(conflicting.needs_review, true);
  assert.equal(conflicting.owner_id, null);
  assert.deepEqual(
    (await f.rows('instagram_prospects')).find((row) => row.id === saved.id),
    before,
    'Another ID must never overwrite the confirmed reservation',
  );
  await f.receive(worker, '20005');
  const conflicts = (await f.rows('audit_events')).filter(
    (row) => row.kind === 'prospect.identity_conflict',
  );
  assert.equal(conflicts.length, 1, 'Record the conflict separately, once per identity and lead');
  assert.equal(conflicts[0].opportunity_id, conflicting.id);
  assert.equal(conflicts[0].details.prospect_id, saved.id);
  const current = (await f.lead('20005'))!;
  await f.crm.transfer(
    manager,
    current.id,
    {
      target_id: users[1].id,
      expected_version: current.version,
      reason: 'Atendimento distinto confirmado pela gestão',
    },
    randomUUID(),
  );
  await f.receive(worker, '20004');
  assert.equal((await f.lead('20004'))?.owner_id, users[0].id);
  assert.equal((await f.lead('20005'))?.owner_id, users[1].id);
  assert.deepEqual(
    (await f.rows('instagram_prospects')).find((row) => row.id === saved.id),
    before,
  );
  assert.equal((await f.prospects.list(users[0])).items[0].opportunity_id, original.id);
}

export async function checkPermanentReservationMigration(
  db: Database | MongoStore,
  _manager: User,
  users: User[],
) {
  const f = fixture(db);
  const ordinary = await f.crm.ingest(
    { name: 'Rodízio de teste', phone: '5548999911111', interest: '', unit: '', source: 'Teste' },
    randomUUID(),
    null,
  );
  const oldDeadline = new Date('2025-02-01T12:00:00Z');
  for (const status of ['waiting', 'matched', 'review', 'cancelled']) {
    const saved = await f.prospects.create(users[0], {
      profile: `@migracao.${status}`,
      source: 'Curtida',
    });
    await f.set('instagram_prospects', saved.id, {
      status,
      created_at: new Date('2025-01-01T12:00:00Z'),
      expires_at: oldDeadline,
    });
  }
  const snapshot = () =>
    f.rows('instagram_prospects').then((rows) => rows.sort((a, b) => a.id.localeCompare(b.id)));
  const before = await snapshot();
  const leadBefore = (await f.rows('opportunities')).find((row) => row.id === ordinary.id);
  const queueBefore = await f.queue();
  assert.equal(
    await f.prospects.hasReservationsToResolve(),
    true,
    'An account with only old deadlines must still resolve incoming identities',
  );

  // Recreate an upgrade from the previous release in this isolated test database.
  if (db.kind === 'mongo')
    await db.remove('schema_migrations', { id: '042_permanent_instagram_prospects' });
  else await db.query("DELETE FROM schema_migrations WHERE version='042'");
  const initialize = () => (db.kind === 'mongo' ? initializeMongo(db) : migrate(db));
  await initialize();
  const after = await snapshot();
  for (const prior of before) {
    const current = after.find((row) => row.id === prior.id)!;
    assert.deepEqual(
      current,
      {
        ...prior,
        expires_at:
          prior.status === 'cancelled' ? oldDeadline : new Date('9999-12-31T23:59:59.999Z'),
      },
      'Migration must preserve ownership, status, versions, and history',
    );
  }
  assert.deepEqual(
    (await f.rows('opportunities')).find((row) => row.id === ordinary.id),
    leadBefore,
  );
  assert.deepEqual(await f.queue(), queueBefore);
  await initialize();
  assert.deepEqual(await snapshot(), after, 'Restart must be idempotent');
  const listed = await f.prospects.list(users[0]);
  assert.ok(listed.items.every((row) => row.expires_at === null));
  assert.equal(listed.items.find((row) => row.username === 'migracao.waiting')?.status, 'waiting');
  if (db.kind === 'mongo') {
    const indexes = await db.collection('instagram_prospects').listIndexes().toArray();
    assert.ok(
      indexes.every((index) => index.expireAfterSeconds === undefined),
      'Prospect records must not have automatic TTL deletion',
    );
  }
}

export async function checkLatePermanentResponse(
  db: Database | MongoStore,
  _manager: User,
  users: User[],
) {
  const f = fixture(db);
  const saved = await f.prospects.create(users[0], {
    profile: '@resposta.tardia',
    source: 'Curtida',
  });
  await f.set('instagram_prospects', saved.id, {
    created_at: new Date(Date.now() - 400 * 86400_000),
    expires_at: new Date(Date.now() - 370 * 86400_000),
  });
  assert.equal(await f.prospects.hasReservationsToResolve(), true);
  await assert.rejects(
    f.prospects.create(users[1], { profile: '@resposta.tardia', source: 'Curtida' }),
    { code: 'PROFILE_RESERVED' },
  );
  const queueBefore = await f.queue();
  await f.receive(
    f.central(async (url) =>
      Response.json({
        id: new URL(String(url)).pathname.split('/').pop(),
        username: 'resposta.tardia',
      }),
    ),
    '20006',
  );
  const lead = (await f.lead('20006'))!;
  assert.equal(lead.owner_id, users[0].id);
  assert.equal(lead.state, 'CLAIMED');
  assert.equal(lead.needs_review, false);
  assert.equal(lead.expires_at, null);
  assert.deepEqual(await f.queue(), queueBefore);
}

export async function checkOwnedContactsAcrossChannels(
  db: Database | MongoStore,
  _manager: User,
  users: User[],
) {
  const f = fixture(db);
  let now = new Date();
  const crm =
    db.kind === 'mongo' ? new MongoOperations(db, () => now) : new Operations(db, () => now);
  for (const [index, provider] of (['instagram', 'whatsapp', 'messenger'] as const).entries()) {
    const input: LeadInput = {
      name: `Contato ${provider}`,
      interest: '',
      unit: '',
      source: 'Teste',
      ...(provider === 'whatsapp' ? { phone: '5548999922222' } : {}),
      identity: {
        provider,
        account_id: `account-${provider}`,
        external_user_id: `sender-${index}`,
      },
    };
    const first = await crm.ingest(input, randomUUID(), null);
    const reserved = (await f.rows('opportunities')).find((row) => row.id === first.id)!;
    const owner = users.find((user) => user.id === reserved.reserved_to)!;
    await crm.claim(owner, first.id, 'reservation', reserved.version, randomUUID());
    const queueBefore = await f.queue();
    now = new Date(now.getTime() + 120 * 86400_000);
    await crm.expire();
    const returned = await crm.ingest(input, randomUUID(), null);
    assert.equal(returned.id, first.id);
    const current = (await f.rows('opportunities')).find((row) => row.id === first.id)!;
    assert.equal(current.owner_id, owner.id, `${provider}: ownership survives a late response`);
    assert.equal(current.state, 'CLAIMED');
    assert.deepEqual(await f.queue(), queueBefore);
  }
}

export async function checkChannelChangeIdentification(
  db: Database | MongoStore,
  _manager: User,
  users: User[],
) {
  const f = fixture(db);
  await f.prospects.create(users[0], { profile: '@paciente.multicanal', source: 'Curtida' });
  await f.receive(
    f.central(async (url) =>
      Response.json({
        id: new URL(String(url)).pathname.split('/').pop(),
        username: 'paciente.multicanal',
      }),
    ),
    '20007',
  );
  const original = (await f.lead('20007'))!;
  // Use the normal edit flow to record the phone given to the consultant.
  await f.crm.update(users[0], original.id, {
    version: original.version,
    name: 'Paciente multicanal',
    phone: '5548999933333',
    instagram: 'paciente.multicanal',
    interest: '',
    unit: '',
    stage: 'NEW_LEAD',
    procedure_date: null,
    next_action: '',
  });
  const queueBefore = await f.queue();
  const future = new Date(Date.now() + 120 * 86400_000);
  const crm =
    db.kind === 'mongo' ? new MongoOperations(db, () => future) : new Operations(db, () => future);
  const whatsapp = await crm.ingest(
    {
      name: 'Paciente multicanal',
      phone: '5548999933333',
      interest: '',
      unit: '',
      source: 'Teste',
      identity: {
        provider: 'whatsapp',
        account_id: 'whatsapp-test',
        external_user_id: '5548999933333',
      },
    },
    randomUUID(),
    null,
  );
  assert.equal(
    whatsapp.id,
    original.id,
    'Saved phone links a first WhatsApp message to the existing owner',
  );
  assert.equal((await f.lead('20007'))?.owner_id, users[0].id);
  assert.deepEqual(await f.queue(), queueBefore);

  // Messenger input carries a page-scoped ID, without an Instagram ID or phone.
  // An identical display name alone must not silently merge unrelated patients.
  const messenger = await crm.ingest(
    {
      name: 'Paciente multicanal',
      interest: '',
      unit: '',
      source: 'Teste',
      identity: {
        provider: 'messenger',
        account_id: 'messenger-test',
        external_user_id: 'unlinked-facebook-id',
      },
    },
    randomUUID(),
    null,
  );
  assert.notEqual(messenger.id, original.id);
  assert.equal((await f.lead('20007'))?.owner_id, users[0].id);
}

export const prospectRegressions = [
  [
    'prospect regression: channel changes require a shared contact identifier',
    checkChannelChangeIdentification,
  ],
  [
    'prospect regression: permanent reservation migration preserves existing data',
    checkPermanentReservationMigration,
  ],
  [
    'prospect regression: sole legacy reservation routes response after 400 days',
    checkLatePermanentResponse,
  ],
  [
    'prospect regression: owned contacts stay with consultant after 120 days in every channel',
    checkOwnedContactsAcrossChannels,
  ],
  [
    'prospect regression: cooldown counts real requests and survives restart',
    checkProspectCooldown,
  ],
  [
    'prospect regression: management transfer resolves verified review reservation',
    checkProspectReviewTransfer,
  ],
  [
    'prospect regression: a different ID cannot overwrite a confirmed binding',
    checkProspectIdentityConflict,
  ],
] as const;
