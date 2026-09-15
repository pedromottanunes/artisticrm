import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { buildApp } from '../src/app.js';
import { PushService, pushConfig, validPushEndpoint, type PushSender } from '../src/push.js';
import { inPushTransaction, readyPush, enqueuePushEvent, type PushDb } from '../src/push-store.js';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';

export async function checkPush(
  db: PushDb,
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  password: string,
  clock: () => Date,
  advance: (ms: number) => void,
) {
  const keys = webpush.generateVAPIDKeys();
  const config = { ...keys, subject: 'mailto:testing@example.test' };
  assert.equal(pushConfig({}), undefined);
  assert.throws(() => pushConfig({ PUSH_ENABLED: 'true' }));
  assert.deepEqual(
    pushConfig({
      PUSH_ENABLED: 'true',
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: config.subject,
    }),
    config,
  );
  for (const endpoint of [
    'http://fcm.googleapis.com/send/x',
    'https://127.0.0.1/private',
    'https://fcm.googleapis.com.attacker.test/send/x',
    'https://fcm.googleapis.com:444/send/x',
    'https://user@fcm.googleapis.com/send/x',
  ])
    assert.equal(validPushEndpoint(endpoint), false);
  assert.equal(validPushEndpoint('https://web.push.apple.com/QH/test'), true);
  const delivered: { endpoint: string; message: { body: string; page: string; tag: string } }[] =
    [];
  let failure = 0;
  const sender: PushSender = async (subscription, payload, options) => {
    assert.ok(options!.TTL! <= 300);
    if (failure) throw Object.assign(new Error('simulated'), { statusCode: failure });
    delivered.push({ endpoint: subscription.endpoint, message: JSON.parse(String(payload)) });
    return { statusCode: 201, body: '', headers: {} };
  };
  const { app, push } = await buildApp(db, {
    reconcile: false,
    clock,
    push: config,
    pushSender: sender,
  });
  const cookies = new Map<string, string>();
  const subscriptions = new Map<
    string,
    { endpoint: string; keys: { p256dh: string; auth: string } }
  >();
  const baseHeaders = { 'x-artisti-client': 'web' };
  const request = async (
    user: User,
    url: string,
    body: unknown,
    method: 'POST' | 'DELETE' = 'POST',
  ) =>
    app.inject({
      method,
      url,
      headers: { ...baseHeaders, cookie: cookies.get(user.id)! },
      payload: body,
    });
  const records = (kind: 'subscription' | 'event' | 'job') =>
    inPushTransaction(db, (tx) => readyPush(tx, kind, clock().toISOString(), 1000));
  try {
    assert.equal((await app.inject('/api/v1/push/config')).statusCode, 401);
    for (const user of [manager, ...users]) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: baseHeaders,
        payload: { email: user.email, password },
      });
      assert.equal(login.statusCode, 200, login.body);
      cookies.set(user.id, String(login.headers['set-cookie']).split(';')[0]);
      const pair = createECDH('prime256v1');
      pair.generateKeys();
      const subscription = {
        endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
        keys: {
          p256dh: pair.getPublicKey().toString('base64url'),
          auth: randomBytes(16).toString('base64url'),
        },
      };
      subscriptions.set(user.id, subscription);
      const response = await request(user, '/api/v1/push/subscriptions', subscription);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        (await request(user, '/api/v1/push/subscriptions', subscription)).statusCode,
        200,
      );
    }
    assert.equal(
      (await records('subscription')).length,
      users.length + 1,
      'same device is upserted, not duplicated',
    );
    const publicConfig = await app.inject({
      url: '/api/v1/push/config',
      headers: { cookie: cookies.get(manager.id)! },
    });
    assert.ok(!publicConfig.body.includes(keys.privateKey));
    assert.equal(
      (
        await request(manager, '/api/v1/push/subscriptions', {
          ...subscriptions.get(manager.id),
          endpoint: 'https://localhost/private',
        })
      ).statusCode,
      400,
    );
    const firstUser = users[0];
    const input = (n: number) => ({
      name: `Privado ${n}`,
      phone: `554899987${String(n).padStart(4, '0')}`,
      interest: 'Privado',
      unit: 'Teste',
      source: 'Cadastro manual',
    });
    const created = await crm.ingest(input(1), 'push-test-1', manager.id);
    const detail = await crm.detail(manager, created.id);
    assert.equal(detail.reserved_to, firstUser.id);
    const before = (await records('event')).length;
    await assert.rejects(() =>
      inPushTransaction(db, async (tx) => {
        await enqueuePushEvent(tx, randomUUID(), created.id, 'lead.created', clock());
        throw new Error('rollback');
      }),
    );
    assert.equal((await records('event')).length, before, 'event is transactional');
    await Promise.all([
      push.tick(),
      new PushService(db, config, async () => clock(), sender).tick(),
    ]);
    assert.equal(
      delivered.length,
      2,
      'only the manager and reserved attendant receive this event, even with two workers',
    );
    assert.deepEqual(new Set(delivered.map((d) => d.message.page)), new Set(['central', 'mine']));
    assert.equal(
      delivered.some((d) => /Privado|554899987/.test(JSON.stringify(d.message))),
      false,
      'no contact PII on lock screen',
    );
    await push.tick();
    assert.equal(delivered.length, 2);
    await crm.ingest(input(1), 'push-test-1', manager.id);
    await push.tick();
    assert.equal(delivered.length, 2, 'idempotent inbound does not duplicate pushes');
    // Jobs are rechecked after retry: claiming invalidates the reserved notification.
    const second = await crm.ingest(input(2), 'push-test-2', manager.id);
    const reserved = await crm.detail(manager, second.id);
    failure = 503;
    await push.tick();
    failure = 0;
    await crm.claim(
      users.find((u) => u.id === reserved.reserved_to)!,
      second.id,
      'reservation',
      reserved.version,
      randomUUID(),
    );
    advance(16000);
    await push.tick();
    assert.equal(delivered.length, 2, 'stale reservation discarded');
    // Closing the app/restarting the worker does not lose the durable retry.
    await request(manager, '/api/v1/push/test', {
      endpoint: subscriptions.get(manager.id)!.endpoint,
    });
    failure = 503;
    await push.tick();
    failure = 0;
    advance(16000);
    await new PushService(db, config, async () => clock(), sender).tick();
    assert.equal(delivered.length, 3);
    assert.equal(delivered[2].message.page, 'settings');
    // Pool notices also reach active attendants paused in the round robin.
    if (db.kind === 'mongo')
      await db.update('users', { id: users[3].id }, { $set: { queue_enabled: false } });
    else await db.query('UPDATE users SET queue_enabled=false WHERE id=$1', [users[3].id]);
    advance(600000);
    await crm.expire();
    const previousCount = delivered.length;
    await push.tick();
    assert.equal(delivered.length - previousCount, users.length + 1);
    assert.ok(
      delivered
        .slice(previousCount)
        .some(
          (d) =>
            d.endpoint === subscriptions.get(users[3].id)!.endpoint && d.message.page === 'pool',
        ),
    );
    // Another account cannot remove/test this device; logging out revokes server delivery.
    const firstEndpoint = subscriptions.get(firstUser.id)!.endpoint;
    await request(manager, '/api/v1/push/subscriptions', { endpoint: firstEndpoint }, 'DELETE');
    assert.equal(
      (await request(manager, '/api/v1/push/test', { endpoint: firstEndpoint })).statusCode,
      409,
    );
    assert.equal(
      (await request(firstUser, '/api/v1/push/test', { endpoint: firstEndpoint })).statusCode,
      200,
    );
    assert.equal((await request(firstUser, '/api/v1/auth/logout', {})).statusCode, 200);
    const afterLogout = delivered.length;
    await push.tick();
    assert.equal(delivered.length, afterLogout);
    assert.ok(!(await records('subscription')).some((s) => s.data.userId === firstUser.id));
    // Revoked access/password versions invalidate pending jobs, even without a browser logout.
    const revoked = users[1];
    assert.equal(
      (
        await request(revoked, '/api/v1/push/test', {
          endpoint: subscriptions.get(revoked.id)!.endpoint,
        })
      ).statusCode,
      200,
    );
    if (db.kind === 'mongo')
      await db.update('users', { id: revoked.id }, { $inc: { auth_version: 1 } });
    else await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [revoked.id]);
    await push.tick();
    assert.equal(delivered.length, afterLogout);
    // An expired push endpoint is pruned, instead of retried forever.
    const removed = users[2];
    await request(removed, '/api/v1/push/test', {
      endpoint: subscriptions.get(removed.id)!.endpoint,
    });
    failure = 410;
    await push.tick();
    failure = 0;
    assert.ok(!(await records('subscription')).some((s) => s.data.userId === removed.id));
  } finally {
    await app.close();
  }
}
