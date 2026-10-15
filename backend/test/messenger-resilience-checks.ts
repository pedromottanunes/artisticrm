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
