import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDatabase, migrate } from '../src/db.js';
import { bootstrapManager } from '../src/bootstrap.js';
import { buildApp } from '../src/app.js';

const db = await openDatabase();
await migrate(db);
await bootstrapManager(db, 'staging@example.test', 'Release-smoke-example-password');
const { app } = await buildApp(db, {
  production: true,
  appOrigin: 'https://staging.example.test',
  staticRoot: fileURLToPath(new URL('../../frontend/dist', import.meta.url)),
  reconcile: false,
});
try {
  const index = await app.inject({ url: '/' });
  assert.equal(index.statusCode, 200);
  assert.match(index.body, /Artisti/);
  assert.match(index.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  const bundle = index.body.match(/src="([^"]+\.js)"/)!;
  const asset = await app.inject({ url: bundle[1] });
  assert.equal(asset.statusCode, 200);
  assert.doesNotMatch(asset.body, /Artisti\.demo2026|demo\.artisti\.local/);
  assert.equal((await app.inject({ url: '/api/v1/workspace' })).statusCode, 401);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-artisti-client': 'web', origin: 'https://staging.example.test' },
    payload: { email: 'staging@example.test', password: 'Release-smoke-example-password' },
  });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers['set-cookie']), /Secure/);
  const snapshot = await app.inject({
    url: '/api/v1/workspace',
    headers: { cookie: `artisti_session=${login.cookies[0].value}` },
  });
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.json().demo, false);
  assert.equal(snapshot.json().opportunities.length, 0);
  console.info(
    'Release smoke: frontend servido pela API, CSP, login restrito e bundle sem credenciais demo — OK.',
  );
} finally {
  await app.close();
  await db.close();
}
