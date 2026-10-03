import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { commandFingerprint, matchesCommandFingerprint } from '../src/command-fingerprint.js';
import { openDatabase, migrate } from '../src/db.js';
import { Operations } from '../src/operations.js';
import { seedDemo } from '../src/seed.js';
import type { User } from '../src/types.js';

test('password command receipts use a salted expensive hash and preserve replay matching', async () => {
  const payload = { kind: 'user.create', password: 'synthetic-test-password' };
  const first = await commandFingerprint(payload);
  const second = await commandFingerprint(payload);
  assert.notEqual(first, second);
  assert.equal(await matchesCommandFingerprint(payload, first), true);
  assert.equal(
    await matchesCommandFingerprint({ ...payload, password: 'different-test-password' }, first),
    false,
  );
  assert.ok(!first.includes(payload.password));
});

test('SQL migration protects legacy receipts without changing passwords or replay behavior', async () => {
  const db = await openDatabase();
  try {
    await migrate(db);
    const ops = new Operations(db);
    await seedDemo(ops, false);
    const users = (
      await db.query<User & { password_hash: string }>('SELECT * FROM users ORDER BY id')
    ).rows;
    const actor = users.find((user) => user.role === 'manager')!;
    const payloads = [
      { kind: 'user.create', password: 'legacy-test-password' },
      { kind: 'lead.edit', name: 'Test' },
    ];
    for (const payload of payloads) {
      const key = randomUUID();
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await db.query('INSERT INTO operation_receipts VALUES($1,$2,$3,$4,$5)', [
        actor.id,
        key,
        digest,
        JSON.stringify({ ok: true }),
        new Date(),
      ]);
      await db.query("DELETE FROM schema_migrations WHERE version='026'");
      await migrate(db);
      const stored = (
        await db.query<{ fingerprint: string }>(
          'SELECT fingerprint FROM operation_receipts WHERE key=$1',
          [key],
        )
      ).rows[0].fingerprint;
      assert.ok(stored.startsWith('scrypt-sha256:'));
      assert.ok(!stored.includes(digest));
      const replay = () => {
        throw new Error('must not execute twice');
      };
      assert.deepEqual(await db.transaction((tx) => ops.command(tx, actor, key, payload, replay)), {
        ok: true,
      });
      await assert.rejects(
        db.transaction((tx) => ops.command(tx, actor, key, { ...payload, changed: true }, replay)),
        { code: 'IDEMPOTENCY_CONFLICT' },
      );
    }
    const after = (
      await db.query<{ id: string; password_hash: string }>(
        'SELECT id,password_hash FROM users ORDER BY id',
      )
    ).rows;
    assert.deepEqual(
      after,
      users.map(({ id, password_hash }) => ({ id, password_hash })),
    );
    await migrate(db);
  } finally {
    await db.close();
  }
});
