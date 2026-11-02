import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import { MessengerCentral, type MessengerConfig } from '../src/messenger.js';
import type { User } from '../src/types.js';

const config: MessengerConfig = {
  appSecret: 'synthetic-resilience-secret',
  verifyToken: 'synthetic-resilience-verify-token-32-characters',
  pageId: '123456789000',
  pageAccessToken: 'synthetic-resilience-token-never-sent',
  graphApiVersion: 'v26.0',
};

async function receive(central: MessengerCentral, sender = randomUUID()) {
  const body = Buffer.from(
    JSON.stringify({
      object: 'page',
      entry: [
        {
          id: config.pageId,
          messaging: [
            {
              sender: { id: sender },
              recipient: { id: config.pageId },
              timestamp: Date.now(),
              message: { mid: randomUUID(), text: 'Mensagem sintética' },
            },
          ],
        },
      ],
    }),
  );
  await central.receive(
    body,
    `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
  );
  await central.drain();
}

export async function checkMessengerSendAuthorization(
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
) {
  const db = crm.db;
  let sends = 0;
  const central = new MessengerCentral(crm, config, async () => {
    sends++;
    return Response.json({ recipient_id: 'synthetic', message_id: randomUUID() });
  });
  await receive(central);
  const conversation = (await central.list(manager, 'all')).conversations[0];
  const id = String(conversation.opportunity_id);
  const lead = await crm.detail(manager, id);
  const responsible = users.find((user) => user.id === lead.reserved_to)!;
  await crm.claim(responsible, id, 'reservation', lead.version, randomUUID());

  const change = async (
    table: 'opportunities' | 'users' | 'conversations',
    rowId: string,
    field: string,
    value: unknown,
  ) => {
    if (db.kind === 'mongo') await db.update(table, { id: rowId }, { $set: { [field]: value } });
    else await db.query(`UPDATE ${table} SET ${field}=$2 WHERE id=$1`, [rowId, value]);
  };
  // Deterministically interleave another action after the initial context read,
  // before the transaction that reserves the send. Never contacts Meta.
  const beforeReservation = async (action: () => Promise<void>, run: () => Promise<unknown>) => {
    if (db.kind === 'mongo') {
      const original = db.atomic;
      db.atomic = async function (work, readOnly) {
        db.atomic = original;
        await action();
        return original.call(db, work, readOnly);
      } as typeof db.atomic;
      try {
        return await run();
      } finally {
        db.atomic = original;
      }
    }
    const original = db.transaction;
    db.transaction = async function (work) {
      db.transaction = original;
      await action();
      return original.call(db, work);
    } as typeof db.transaction;
    try {
      return await run();
    } finally {
      db.transaction = original;
    }
  };
  const send = () =>
    central.send(responsible, String(conversation.id), 'Resposta sintética', randomUUID());
  await assert.rejects(
    () =>
      beforeReservation(
        () =>
          change(
            'opportunities',
            id,
            'owner_id',
            users.find((user) => user.id !== responsible.id)!.id,
          ),
        send,
      ),
    { code: 'FORBIDDEN' },
  );
  await change('opportunities', id, 'owner_id', responsible.id);
  await assert.rejects(
    () => beforeReservation(() => change('users', responsible.id, 'active', false), send),
    { code: 'UNAUTHENTICATED' },
  );
  await change('users', responsible.id, 'active', true);
  await assert.rejects(
    () =>
      beforeReservation(
        () => change('users', responsible.id, 'auth_version', responsible.auth_version + 1),
        send,
      ),
    { code: 'UNAUTHENTICATED' },
  );
  await change('users', responsible.id, 'auth_version', responsible.auth_version);
  await assert.rejects(
    () =>
      beforeReservation(
        () =>
          change(
            'conversations',
            String(conversation.id),
            'last_inbound_at',
            new Date(Date.now() - 25 * 3600_000),
          ),
        send,
      ),
    { code: 'MESSENGER_WINDOW_EXPIRED' },
  );
  assert.equal(sends, 0, 'No provider send escapes a revoked authorization or expired window');
  const queued =
    db.kind === 'mongo'
      ? await db.count('messages', { direction: 'outbound' })
      : (await db.query("SELECT id FROM messages WHERE direction='outbound'")).rows.length;
  assert.equal(queued, 0, 'Rejected sends roll back their outgoing reservation');

  await change('conversations', String(conversation.id), 'last_inbound_at', new Date());
  const key = randomUUID();
  const first = await central.send(responsible, String(conversation.id), 'Única', key);
  await change(
    'conversations',
    String(conversation.id),
    'last_inbound_at',
    new Date(Date.now() - 25 * 3600_000),
  );
  assert.deepEqual(await central.send(responsible, String(conversation.id), 'Única', key), first);
  assert.equal(sends, 1, 'A receipt can be replayed after expiry without resending');
}

export async function checkMessengerProfileBackoff(
  crm: CRM | MongoOperations,
  manager: User,
  failure: () => Response | Promise<Response>,
  minimumPauseMs = 15 * 60_000,
) {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return failure();
  };
  const central = new MessengerCentral(crm, config, fetcher);
  for (let index = 0; index < 4; index++) await receive(central);
  const failedAt = Date.now();
  await central.drainProfiles();
  await central.drainProfiles();
  assert.equal(calls, 1, 'A provider failure pauses the entire profile queue');
  await new MessengerCentral(crm, config, fetcher).drainProfiles();
  assert.equal(calls, 1, 'A restarted worker honors the persisted pause');
  await receive(central);
  assert.equal(
    (await central.list(manager, 'all')).conversations.length,
    5,
    'Profile backoff never blocks incoming leads',
  );
  const db = crm.db;
  const account =
    db.kind === 'mongo'
      ? await db.one('channel_accounts', {
          provider: 'messenger',
          external_account_id: config.pageId,
        })
      : (
          await db.query(
            "SELECT * FROM channel_accounts WHERE provider='messenger' AND external_account_id=$1",
            [config.pageId],
          )
        ).rows[0];
  assert.ok(
    new Date(account!.messenger_profile_paused_until as string).getTime() >=
      failedAt + minimumPauseMs,
    'The persisted pause honors Retry-After when longer than the default backoff',
  );
  const retryJobs =
    db.kind === 'mongo'
      ? await db.count('contact_identities', { provider: 'messenger', profile_pending: true })
      : (
          await db.query(
            "SELECT id FROM contact_identities WHERE provider='messenger' AND profile_pending",
          )
        ).rows.length;
  assert.equal(retryJobs, 5, 'The failed job stays pending for recovery');

  if (db.kind === 'mongo') {
    await db.update(
      'channel_accounts',
      { id: account!.id },
      { $set: { messenger_profile_paused_until: new Date(0) } },
    );
    await db.update(
      'contact_identities',
      { provider: 'messenger' },
      { $set: { profile_check_after: new Date(0) } },
    );
  } else {
    await db.query(
      "UPDATE channel_accounts SET messenger_profile_paused_until='1970-01-01' WHERE id=$1",
      [account!.id],
    );
    await db.query(
      "UPDATE contact_identities SET profile_check_after='1970-01-01' WHERE provider='messenger'",
    );
  }
  let recovered = 0;
  const restored = new MessengerCentral(crm, config, async (input) => {
    recovered++;
    return Response.json({
      id: new URL(String(input)).pathname.split('/').at(-1),
      name: 'Perfil recuperado',
    });
  });
  await restored.drainProfiles();
  assert.equal(recovered, 3, 'Recovery keeps a bounded batch of three');
  await restored.drainProfiles();
  assert.equal(recovered, 5);
}

function profileTestStore(crm: CRM | MongoOperations) {
  const db = crm.db;
  return {
    rows: async (table: string) =>
      db.kind === 'mongo'
        ? db.many(table, {}, { id: 1 })
        : (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows,
    set: async (table: string, id: string, field: string, value: unknown) => {
      if (db.kind === 'mongo') await db.update(table, { id }, { $set: { [field]: value } });
      else await db.query(`UPDATE ${table} SET ${field}=$2 WHERE id=$1`, [id, value]);
    },
  };
}

export const messengerProfileCases = [
  [
    'nome e sobrenome sem id',
    () => Response.json({ first_name: 'Maria', last_name: 'Almeida' }),
    null,
  ],
  [
    'nome vazio e foto inválida',
    () =>
      Response.json({
        name: ' ',
        first_name: 'Maria',
        last_name: 'Almeida',
        profile_pic: 'invalid',
      }),
    null,
  ],
  [
    'resposta sem nome',
    () => Response.json({ profile_pic: 'https://example.test/avatar.jpg' }),
    'META_PROFILE_NAME_MISSING',
  ],
  [
    'id de outro contato',
    () => Response.json({ id: 'wrong-person', name: 'Outra pessoa' }),
    'META_INVALID_PROFILE',
  ],
  ['JSON inválido', () => new Response('not json'), 'META_INVALID_PROFILE'],
  [
    'HTTP 400 sem pausa global',
    () =>
      Response.json({ error: { code: 100, message: 'sensitive raw message' } }, { status: 400 }),
    'META_PROFILE_ERROR:HTTP_400:CODE_100:SUBCODE_0',
  ],
] as const;

export async function checkMessengerProfileRecovery(
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  initial: () => Response,
  expectedError: string | null,
) {
  const store = profileTestStore(crm);
  let calls = 0;
  let recover = false;
  const warnings: string[] = [];
  const central = new MessengerCentral(
    crm,
    config,
    async (input, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        `Bearer ${config.pageAccessToken}`,
      );
      assert.equal(new URL(String(input)).hostname, 'graph.facebook.com');
      const identity = (await store.rows('contact_identities'))[0];
      assert.equal(identity.profile_pending, true, 'Work remains durable during the HTTP request');
      assert.ok(new Date(identity.profile_check_after).getTime() > Date.now());
      return recover ? Response.json({ first_name: 'Maria', last_name: 'Almeida' }) : initial();
    },
    (error) => warnings.push(error),
  );
  await receive(central);
  const lead = await crm.detail(
    manager,
    String((await central.list(manager, 'all')).conversations[0].opportunity_id),
  );
  const owner = users.find((user) => user.id === lead.reserved_to)!;
  await crm.claim(owner, lead.id, 'reservation', lead.version, randomUUID());
  const snapshot = () =>
    Promise.all(
      ['opportunities', 'users', 'claims', 'messages', 'conversations', 'push_records'].map(
        store.rows,
      ),
    );
  const before = await snapshot();
  await central.drainProfiles();
  assert.equal(calls, 1);
  if (expectedError) {
    const identity = (await store.rows('contact_identities'))[0];
    assert.equal(identity.profile_pending, true);
    assert.equal(identity.profile_last_error, expectedError);
    assert.deepEqual(warnings, [expectedError]);
    assert.equal((await store.rows('contacts'))[0].name, 'Contato Messenger');
    await central.drainProfiles();
    assert.equal(calls, 1, 'No hot loop while waiting for retry');
    await store.set('contact_identities', identity.id, 'profile_check_after', new Date(0));
    recover = true;
    await central.drainProfiles();
    assert.equal(
      calls,
      2,
      'The same worker retries without a new inbound or a cached empty profile',
    );
  }
  const identity = (await store.rows('contact_identities'))[0];
  assert.equal(identity.profile_pending, false);
  assert.equal(identity.profile_last_error, null);
  assert.equal((await store.rows('contacts'))[0].name, 'Maria Almeida');
  assert.equal((await central.list(manager, 'all')).conversations[0].contact_name, 'Maria Almeida');
  assert.equal((await central.list(owner, 'mine')).conversations[0].contact_name, 'Maria Almeida');
  assert.deepEqual(
    await snapshot(),
    before,
    'Name recovery preserves ownership, queue, messages and notifications',
  );

  // A future refresh must preserve the name deliberately entered by the consultant.
  await store.set('contacts', identity.contact_id, 'name', 'Nome escolhido pela consultora');
  await store.set('contact_identities', identity.id, 'profile_pending', true);
  await store.set('contact_identities', identity.id, 'profile_check_after', new Date(0));
  await central.drainProfiles();
  assert.equal((await store.rows('contacts'))[0].name, 'Nome escolhido pela consultora');
}

export async function checkMessengerProfileMigration(
  crm: CRM | MongoOperations,
  manager: User,
  migrateAgain: () => Promise<void>,
) {
  const store = profileTestStore(crm);
  // The Mongo fixture creates its manager after initializeMongo; mirror the
  // existing queue default so an unrelated initializer doesn't alter the snapshot.
  if (crm.db.kind === 'mongo')
    await crm.db.update(
      'users',
      { queue_credit: { $exists: false } },
      { $set: { queue_credit: 0 } },
    );
  let calls = 0;
  const central = new MessengerCentral(crm, config, async () => {
    calls++;
    return Response.json({ first_name: 'Nome', last_name: 'Recuperado' });
  });
  for (let i = 0; i < 5; i++) await receive(central);
  const identities = await store.rows('contact_identities');
  for (const identity of identities) {
    await store.set('contact_identities', identity.id, 'profile_pending', false);
    await store.set(
      'contact_identities',
      identity.id,
      'profile_check_after',
      new Date(Date.now() + 86_400_000),
    );
  }
  // An old opportunity reference is not necessary to recover the contact's name.
  await store.set('contact_identities', identities[0].id, 'profile_opportunity_id', null);
  const custom = identities.at(-1)!;
  await store.set('contacts', custom.contact_id, 'name', 'Nome manual preservado');
  // Simulate an unrelated Instagram identity. Recovery must leave it unchanged.
  const instagram = {
    ...identities[0],
    id: randomUUID(),
    provider: 'instagram',
    profile_pending: false,
  };
  if (crm.db.kind === 'mongo') await crm.db.insert('contact_identities', instagram);
  else
    await crm.db.query(
      `INSERT INTO contact_identities(id,contact_id,provider,channel_account_id,external_user_id,last_seen_at)
     VALUES($1,$2,'instagram',$3,$4,clock_timestamp())`,
      [
        instagram.id,
        instagram.contact_id,
        instagram.channel_account_id,
        instagram.external_user_id,
      ],
    );
  const snapshot = () =>
    Promise.all(
      ['opportunities', 'users', 'claims', 'messages', 'conversations', 'push_records'].map(
        store.rows,
      ),
    );
  const before = await snapshot();
  const unrelatedBefore = (await store.rows('contact_identities')).find(
    (row) => row.provider === 'instagram',
  );
  await migrateAgain();
  const queued = await store.rows('contact_identities');
  assert.equal(queued.filter((row) => row.profile_pending).length, 4);
  assert.deepEqual(
    queued.find((row) => row.provider === 'instagram'),
    { ...unrelatedBefore, ...(crm.db.kind === 'mongo' ? {} : { profile_last_error: null }) },
  );
  assert.equal(queued.find((row) => row.id === custom.id).profile_pending, false);
  assert.equal(calls, 0, 'Startup only schedules work, never calls Meta');
  await central.drainProfiles();
  assert.equal(calls, 3, 'Historical recovery respects the batch size');
  await central.drainProfiles();
  assert.equal(calls, 4);
  assert.equal(
    (await store.rows('contacts')).filter((row) => row.name === 'Nome Recuperado').length,
    4,
  );
  assert.equal((await central.list(manager, 'all')).conversations.length, 5);
  const recovered = await store.rows('contact_identities');
  await migrateAgain();
  assert.deepEqual(await store.rows('contact_identities'), recovered, 'Migration runs only once');
  assert.deepEqual(await snapshot(), before);
}

export async function checkMessengerProfileDeployRecovery(crm: CRM | MongoOperations) {
  const store = profileTestStore(crm);
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  let duplicateCalls = 0;
  const first = new MessengerCentral(crm, config, async () => {
    started.resolve();
    return response.promise;
  });
  await receive(first);
  const identity = (await store.rows('contact_identities'))[0];
  const running = first.drainProfiles(1);
  try {
    await started.promise;
    await new MessengerCentral(crm, config, async () => {
      duplicateCalls++;
      return Response.json({ name: 'Duplicado' });
    }).drainProfiles();
    assert.equal(duplicateCalls, 0, 'Overlapping workers do not query the same leased profile');
    // A slow provider response must not overwrite a name edited during the request.
    await store.set('contacts', identity.contact_id, 'name', 'Nome manual durante a consulta');
  } finally {
    response.resolve(Response.json({ name: 'Nome da Meta' }));
    await running;
  }
  assert.equal((await store.rows('contacts'))[0].name, 'Nome manual durante a consulta');

  await store.set('contacts', identity.contact_id, 'name', 'Contato Messenger');
  await store.set('contact_identities', identity.id, 'profile_pending', true);
  await store.set('contact_identities', identity.id, 'profile_check_after', new Date(0));
  const db = crm.db;
  let restore = () => {};
  const failing = new MessengerCentral(crm, config, async () => {
    // Fail the commit after Meta responds, rolling back both identity and contact.
    if (db.kind === 'mongo') {
      const original = db.atomic;
      restore = () => {
        db.atomic = original;
      };
      db.atomic = (async (work) => {
        restore();
        return original.call(db, async (tx) => {
          await work(tx);
          throw new Error('synthetic profile commit failure');
        });
      }) as typeof db.atomic;
    } else {
      const original = db.transaction;
      restore = () => {
        db.transaction = original;
      };
      db.transaction = (async (work) => {
        restore();
        return original.call(db, async (tx) => {
          await work(tx);
          throw new Error('synthetic profile commit failure');
        });
      }) as typeof db.transaction;
    }
    return Response.json({ name: 'Nome recuperado após reinício' });
  });
  try {
    await assert.rejects(failing.drainProfiles(), /synthetic profile commit failure/);
  } finally {
    restore();
  }
  assert.equal((await store.rows('contact_identities'))[0].profile_pending, true);
  assert.equal((await store.rows('contacts'))[0].name, 'Contato Messenger');
  const restarted = new MessengerCentral(crm, config, async () => {
    duplicateCalls++;
    return Response.json({ name: 'Nome recuperado após reinício' });
  });
  await restarted.drainProfiles();
  assert.equal(duplicateCalls, 0, 'Restart respects the lease left by the interrupted worker');
  await store.set('contact_identities', identity.id, 'profile_check_after', new Date(0));
  await restarted.drainProfiles();
  assert.equal(duplicateCalls, 1);
  assert.equal((await store.rows('contacts'))[0].name, 'Nome recuperado após reinício');
  assert.equal((await store.rows('contact_identities'))[0].profile_pending, false);
}
