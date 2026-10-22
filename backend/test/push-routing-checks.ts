import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { CRM } from '../src/crm.js';
import { Operations } from '../src/operations.js';
import { MongoOperations } from '../src/mongo-crm.js';
import { MongoTx } from '../src/mongo-store.js';
import { PushService, type PushSender } from '../src/push.js';
import {
  enqueuePushEvent,
  getPush,
  inPushTransaction,
  putPush,
  pushUser,
  readyPush,
  removePush,
  type PushDb,
  type PushRecord,
} from '../src/push-store.js';
import { setLeadNotificationMuted } from '../src/lead-notification-mutes.js';
import type { User } from '../src/types.js';
import type { Sql } from '../src/db.js';

function measureFirstTransaction(db: PushDb) {
  const reads = { users: 0, opportunities: 0, lead_notification_mutes: 0 };
  let capture = true;
  if (db.kind !== 'mongo') {
    const measured = {
      ...db,
      transaction: ((work) =>
        db.transaction((tx) => {
          if (!capture) return work(tx);
          capture = false;
          const traced: Sql = {
            query: (sql, params) => {
              for (const name of Object.keys(reads) as (keyof typeof reads)[])
                if (new RegExp(`^SELECT .* FROM ${name} WHERE`).test(sql)) reads[name]++;
              return tx.query(sql, params);
            },
          };
          return work(traced);
        })) as typeof db.transaction,
    };
    return { measured, reads };
  }
  const measured: typeof db = Object.create(db);
  measured.atomic = ((work, readOnly) =>
    db.atomic((tx) => {
      if (capture) {
        capture = false;
        const one = tx.one.bind(tx);
        tx.one = ((name, filter) => {
          if (name in reads) reads[name as keyof typeof reads]++;
          return one(name, filter);
        }) as typeof tx.one;
      }
      return work(tx);
    }, readOnly)) as typeof db.atomic;
  return { measured, reads };
}

// The same scenarios run against SQL and a real local Mongo replica set.
// No network delivery, production data, accounts or device subscriptions are used.
export async function checkPushRouting(
  db: PushDb,
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  clock: () => Date,
  advance: (ms: number) => void,
) {
  const config = { ...webpush.generateVAPIDKeys(), subject: 'mailto:push@example.test' };
  const ops = db.kind === 'mongo' ? new MongoOperations(db, clock) : new Operations(db, clock);
  const subscriptions: PushRecord[] = [];
  const deliveries: {
    endpoint: string;
    userId: string;
    tag: string;
    page: string;
    opportunityId?: string;
  }[] = [];
  let failAttendants = false;
  const sender: PushSender = async (subscription, payload) => {
    const message = JSON.parse(String(payload));
    if (failAttendants && message.userId !== manager.id)
      throw Object.assign(new Error('temporary provider failure'), { statusCode: 503 });
    deliveries.push({ endpoint: subscription.endpoint, ...message });
    return { statusCode: 201, body: '', headers: {} };
  };
  const worker = () => new PushService(db, config, async () => clock(), sender);
  const push = worker();
  await inPushTransaction(db, async (tx) => {
    for (const account of [manager, ...users]) {
      const current = (await pushUser(tx, account.id))!;
      // Two devices on the second attendant catch multi-device duplicate routing.
      for (let device = 0; device < (account.id === users[1].id ? 2 : 1); device++) {
        const subscription: PushRecord = {
          id: `sub:${randomUUID()}`,
          kind: 'subscription',
          available_at: clock().toISOString(),
          expires_at: new Date(clock().getTime() + 86400000).toISOString(),
          data: {
            userId: account.id,
            authVersion: current.auth_version,
            publicKey: config.publicKey,
            revision: randomUUID(),
            createdAt: clock().toISOString(),
            subscription: {
              endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
              keys: {},
            },
          },
        };
        subscriptions.push(subscription);
        await putPush(tx, subscription);
      }
    }
  });
  const create = (n: number) =>
    crm.ingest(
      {
        name: `Push Routing ${n}`,
        phone: `554899976${String(n).padStart(4, '0')}`,
        interest: 'Teste',
        unit: 'Teste',
        source: 'Cadastro manual',
      },
      randomUUID(),
      manager.id,
    );
  const enqueue = async (id: string, kind = 'message.received') => {
    const eventId = randomUUID();
    await inPushTransaction(db, (tx) => enqueuePushEvent(tx, eventId, id, kind, clock()));
    return `event:${eventId}`;
  };
  const sent = (eventId: string) => {
    const tag = `artisti-${createHash('sha256').update(eventId).digest('hex').slice(0, 32)}`;
    return deliveries.filter((item) => item.tag === tag);
  };
  const jobs = (eventId: string) =>
    inPushTransaction(db, async (tx) =>
      tx instanceof MongoTx
        ? tx.many<PushRecord>('push_records', { kind: 'job', 'data.event.id': eventId })
        : (
            await tx.query<PushRecord>(
              "SELECT * FROM push_records WHERE kind='job' AND data->'event'->>'id'=$1",
              [eventId],
            )
          ).rows,
    );
  const transfer = async (id: string, targetId: string) => {
    const lead = await crm.detail(manager, id);
    await ops.transfer(
      manager,
      id,
      {
        expected_version: lead.version,
        target_id: targetId,
        reason: 'Teste de aviso pendente',
      },
      randomUUID(),
    );
  };
  const drain = async () => {
    for (let i = 0; i < 4; i++) await push.tick();
  };
  const devices = (userId: string) => subscriptions.filter((s) => s.data.userId === userId).length;
  const queueState = async () =>
    db.kind === 'mongo'
      ? {
          position: (await db.one('distribution_settings', { id: 1 }))!.last_position,
          credits: (await db.many<User>('users', { role: 'attendant' }, { id: 1 })).map((u) => [
            u.id,
            u.queue_credit,
            u.queue_enabled,
          ]),
        }
      : {
          position: (await db.query('SELECT last_position FROM distribution_settings WHERE id=1'))
            .rows[0].last_position,
          credits: (
            await db.query<User>("SELECT * FROM users WHERE role='attendant' ORDER BY id")
          ).rows.map((u) => [u.id, u.queue_credit, u.queue_enabled]),
        };

  const lead = await create(1);
  const reservation = await crm.detail(manager, lead.id);
  const owner = users.find((u) => u.id === reservation.reserved_to)!;
  await drain();
  failAttendants = true;
  const acceptedMessage = await enqueue(lead.id);
  await push.tick();
  assert.equal(
    sent(acceptedMessage).length,
    1,
    'manager delivered; attendant is waiting for retry',
  );
  await crm.claim(owner, lead.id, 'reservation', reservation.version, randomUUID());
  failAttendants = false;
  advance(16000);
  await drain();
  const afterClaim = sent(acceptedMessage).filter((d) => d.userId === owner.id);
  assert.equal(afterClaim.length, devices(owner.id));
  assert.ok(
    afterClaim.every((d) => d.page === 'inbox' && d.opportunityId === lead.id),
    'retry rebuilds the deep link after acceptance instead of sending stale page=mine',
  );
  assert.equal(sent(acceptedMessage).filter((d) => d.userId === manager.id).length, 1);
  const checkpoint = await inPushTransaction(db, (tx) => getPush(tx, acceptedMessage));
  assert.equal(checkpoint!.available_at, checkpoint!.expires_at, 'routing checkpoint is dormant');
  assert.equal(
    (await inPushTransaction(db, (tx) => readyPush(tx, 'event', clock().toISOString()))).length,
    0,
  );

  for (const [kind, legacy] of [
    ['message.received', false],
    ['comment.received.owned', false],
    ['message.received', true],
  ] as const) {
    const oldOwner = (await crm.detail(manager, lead.id)).owner_id!;
    const target = oldOwner === users[1].id ? users[0] : users[1];
    failAttendants = true;
    const eventId = await enqueue(lead.id, kind);
    await push.tick();
    assert.equal(sent(eventId).length, 1);
    const pending = await jobs(eventId);
    assert.equal(pending.length, devices(oldOwner));
    if (legacy) {
      await inPushTransaction(db, async (tx) => {
        await removePush(tx, eventId);
        for (const job of pending) {
          delete job.data.routing;
          await putPush(tx, job);
        }
      });
    }
    await transfer(lead.id, target.id);
    const queueBefore = await queueState();
    failAttendants = false;
    advance(16000);
    await Promise.all([push.tick(), worker().tick()]);
    await drain();
    assert.deepEqual(
      await queueState(),
      queueBefore,
      'push rerouting cannot consume a queue turn or credit',
    );
    assert.equal(sent(eventId).filter((d) => d.userId === oldOwner).length, 0);
    assert.equal(
      sent(eventId).filter((d) => d.userId === target.id).length,
      devices(target.id),
      `${kind}, legacy=${legacy}: deliver once to each new-owner device`,
    );
    assert.equal(
      sent(eventId).filter((d) => d.userId === manager.id).length,
      1,
      'a manager already notified is not notified again after transfer',
    );
    assert.equal(sent(eventId).length, devices(target.id) + 1);
    assert.ok(sent(eventId).every((d) => d.page === 'inbox' && d.opportunityId === lead.id));
    assert.equal((await jobs(eventId)).length, 0);
  }

  // A -> B -> A while all attendant deliveries are still pending.
  const original = (await crm.detail(manager, lead.id)).owner_id!;
  const intermediate = original === users[1].id ? users[0] : users[1];
  failAttendants = true;
  const returning = await enqueue(lead.id);
  await push.tick();
  await transfer(lead.id, intermediate.id);
  advance(16000);
  await push.tick();
  assert.ok((await jobs(returning)).every((j) => j.data.message.userId === intermediate.id));
  await transfer(lead.id, original);
  advance(16000);
  await push.tick();
  failAttendants = false;
  advance(60000);
  await drain();
  assert.equal(sent(returning).filter((d) => d.userId === original).length, devices(original));
  assert.equal(sent(returning).filter((d) => d.userId === intermediate.id).length, 0);
  assert.equal(sent(returning).filter((d) => d.userId === manager.id).length, 1);

  // The new owner's explicit per-lead mute must prevail over automatic rerouting.
  await inPushTransaction(db, (tx) => setLeadNotificationMuted(tx, intermediate.id, lead.id, true));
  failAttendants = true;
  const muted = await enqueue(lead.id);
  await push.tick();
  await transfer(lead.id, intermediate.id);
  failAttendants = false;
  advance(16000);
  await drain();
  assert.deepEqual(
    sent(muted).map((d) => d.userId),
    [manager.id],
  );
  await inPushTransaction(db, (tx) =>
    setLeadNotificationMuted(tx, intermediate.id, lead.id, false),
  );
  await drain();
  assert.deepEqual(
    sent(muted).map((d) => d.userId),
    [manager.id],
    'unmute does not replay a canceled alert',
  );

  // Pool fan-out was already scheduled for all eligible devices. Accepting must
  // reuse the winner's pending jobs, not create duplicate notices for that winner.
  const pooled = await create(2);
  await drain();
  advance(600001);
  await crm.expire();
  await drain();
  failAttendants = true;
  const poolMessage = await enqueue(pooled.id);
  await push.tick();
  const pooledDetail = await crm.detail(manager, pooled.id);
  await crm.claim(users[1], pooled.id, 'pool', pooledDetail.version, randomUUID());
  failAttendants = false;
  advance(16000);
  const poolQueue = await queueState();
  await drain();
  assert.deepEqual(await queueState(), poolQueue);
  assert.equal(sent(poolMessage).length, devices(users[1].id) + 1);
  assert.ok(sent(poolMessage).every((d) => [manager.id, users[1].id].includes(d.userId)));
  assert.ok(sent(poolMessage).every((d) => d.page === 'inbox' && d.opportunityId === pooled.id));

  // A routing change must neither renew TTL nor revive an expired event.
  failAttendants = true;
  const expired = await enqueue(lead.id);
  await push.tick();
  await transfer(lead.id, original);
  advance(3600001);
  failAttendants = false;
  await drain();
  assert.deepEqual(
    sent(expired).map((d) => d.userId),
    [manager.id],
  );
  assert.equal(await inPushTransaction(db, (tx) => getPush(tx, expired)), null);
  assert.equal((await jobs(expired)).length, 0);

  // 50 devices (within the 10-per-account limit) and 25 simultaneous events.
  // Expansion must read each user/lead/mute once per transaction, and leave
  // excess events queued instead of monopolizing the distribution lock.
  await inPushTransaction(db, async (tx) => {
    for (const account of [manager, ...users]) {
      const template = subscriptions.find((s) => s.data.userId === account.id)!;
      for (let device = devices(account.id); device < 10; device++) {
        const extra: PushRecord = {
          ...template,
          id: `sub:${randomUUID()}`,
          data: {
            ...template.data,
            subscription: {
              endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
              keys: {},
            },
          },
        };
        subscriptions.push(extra);
        await putPush(tx, extra);
      }
    }
  });
  for (let i = 0; i < 25; i++) await enqueue(lead.id);
  const { measured, reads } = measureFirstTransaction(db);
  await new PushService(measured, config, async () => clock(), sender).tick();
  assert.deepEqual(
    reads,
    { users: users.length + 1, opportunities: 1, lead_notification_mutes: 1 },
    'repeated events/devices share reads within expansion, never across transactions',
  );
  const remaining = await inPushTransaction(db, (tx) =>
    readyPush(tx, 'event', clock().toISOString(), 100),
  );
  assert.equal(
    remaining.length,
    15,
    '50 devices expand at most 10 events per transaction; nothing is dropped',
  );
}
