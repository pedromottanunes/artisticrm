import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';
import { buildApp } from '../src/app.js';
import type { User } from '../src/types.js';

export async function checkShortcuts(
  db: Database | MongoStore,
  manager: User,
  attendants: User[],
  password: string,
  now: () => Date,
) {
  const { app } = await buildApp(db, { clock: now, reconcile: false });
  const login = async (user: User) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-artisti-client': 'web' },
      payload: { login: user.email, password },
    });
    assert.equal(response.statusCode, 200, response.body);
    return {
      'x-artisti-client': 'web',
      cookie: `artisti_session=${response.cookies[0].value}`,
    };
  };
  try {
    const managerHeaders = await login(manager);
    const firstHeaders = await login(attendants[0]);
    const secondHeaders = await login(attendants[1]);
    assert.equal(
      (await app.inject({ url: '/api/v1/shortcuts', headers: managerHeaders })).statusCode,
      403,
    );

    const id = randomUUID();
    const payload = { id, name: 'Saudação', body: 'Olá! Como posso ajudar?' };
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/shortcuts',
      headers: firstHeaders,
      payload,
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().shortcut.version, 1);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v1/shortcuts',
      headers: firstHeaders,
      payload,
    });
    assert.equal(repeated.statusCode, 200, repeated.body);

    const own = await app.inject({ url: '/api/v1/shortcuts', headers: firstHeaders });
    const other = await app.inject({ url: '/api/v1/shortcuts', headers: secondHeaders });
    assert.equal(own.json().shortcuts.length, 1);
    assert.equal(other.json().shortcuts.length, 0);

    const foreignUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/shortcuts/${id}`,
      headers: secondHeaders,
      payload: { name: 'Inválido', body: 'Não pode alterar', expected_version: 1 },
    });
    assert.equal(foreignUpdate.statusCode, 404, foreignUpdate.body);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { name: 'Boas-vindas', body: 'Olá! Tudo bem?', expected_version: 1 },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().shortcut.version, 2);
    assert.equal(updated.json().shortcut.body, 'Olá! Tudo bem?');

    const retriedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { name: 'Boas-vindas', body: 'Olá! Tudo bem?', expected_version: 1 },
    });
    assert.equal(retriedUpdate.statusCode, 200, retriedUpdate.body);
    assert.equal(retriedUpdate.json().shortcut.version, 2);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { name: 'Antigo', body: 'Versão antiga', expected_version: 1 },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().code, 'VERSION_CONFLICT');

    const staleDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { expected_version: 1 },
    });
    assert.equal(staleDelete.statusCode, 409, staleDelete.body);

    for (const invalidPayload of [
      { ...payload, user_id: attendants[1].id },
      { ...payload, name: 'a'.repeat(61) },
      { ...payload, body: 'a'.repeat(1001) },
    ]) {
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/shortcuts',
        headers: firstHeaders,
        payload: invalidPayload,
      });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const denied = await app.inject({
        method,
        url: method === 'POST' ? '/api/v1/shortcuts' : `/api/v1/shortcuts/${id}`,
        headers: managerHeaders,
        payload:
          method === 'POST' ? payload : { expected_version: 2, name: 'Outro', body: 'Outro' },
      });
      assert.equal(denied.statusCode, 403, denied.body);
    }

    const concurrentId = randomUUID();
    const concurrent = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/shortcuts',
          headers: firstHeaders,
          payload: { ...payload, id: concurrentId },
        }),
      ),
    );
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [200, 201]);
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/shortcuts/${concurrentId}`,
      headers: firstHeaders,
      payload: { expected_version: 1 },
    });

    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/shortcuts/${id}`,
      headers: secondHeaders,
      payload: { expected_version: 2 },
    });
    assert.equal(foreignDelete.statusCode, 200, foreignDelete.body);
    assert.equal(
      (await app.inject({ url: '/api/v1/shortcuts', headers: firstHeaders })).json().shortcuts
        .length,
      1,
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/shortcuts',
      headers: firstHeaders,
      payload: { id: randomUUID(), name: ' ', body: ' ' },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { expected_version: 2 },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const retried = await app.inject({
      method: 'DELETE',
      url: `/api/v1/shortcuts/${id}`,
      headers: firstHeaders,
      payload: { expected_version: 2 },
    });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(
      (await app.inject({ url: '/api/v1/shortcuts', headers: firstHeaders })).json().shortcuts
        .length,
      0,
    );
  } finally {
    await app.close();
  }
}
