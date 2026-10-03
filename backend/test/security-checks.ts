import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';

export async function checkEncodedRoutes(
  db: Database | MongoStore,
  password: string,
  email = 'vanessa@demo.artisti.local',
) {
  const { app } = await buildApp(db, {
    production: true,
    appOrigin: 'https://crm.example',
    reconcile: false,
  });
  try {
    const login = { email, password };
    const safe = { origin: 'https://crm.example', 'x-artisti-client': 'web' };
    for (const prefix of ['/api/v1', '/%61pi/v1', '/a%70i/v1', '/api/%761']) {
      for (const headers of [{ origin: 'https://attacker.example' }, { origin: safe.origin }]) {
        const denied = await app.inject({
          method: 'POST',
          url: `${prefix}/auth/login`,
          headers,
          payload: login,
        });
        assert.equal(denied.statusCode, 403, `${prefix}: CSRF cannot bypass the router`);
        assert.equal(denied.cookies.length, 0);
      }
      assert.equal((await app.inject({ url: `${prefix}/workspace` })).statusCode, 401);
    }
    const logged = await app.inject({
      method: 'POST',
      url: '/%61pi/v1/auth/login',
      headers: safe,
      payload: login,
    });
    assert.equal(logged.statusCode, 200);
    const cookie = logged.cookies.find((item) => item.name === 'artisti_session')!;
    assert.ok(cookie.httpOnly && cookie.secure);
    const headers = { ...safe, cookie: `artisti_session=${cookie.value}` };
    assert.equal((await app.inject({ url: '/%61pi/v1/me', headers })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: '/%61pi/v1/meta-marketing/status', headers })).statusCode,
      403,
    );
    const me = await app.inject({ url: '/api/v1/me', headers });
    assert.ok(!me.body.includes('password_hash'));
    assert.ok(!me.body.includes(password));
  } finally {
    await app.close();
  }
}
