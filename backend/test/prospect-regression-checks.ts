import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Operations } from '../src/operations.js';
import { MongoOperations } from '../src/mongo-crm.js';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
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
  return { crm, config, prospects, central, rows, set, lead, receive, advanceRetries };
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

export const prospectRegressions = [
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
