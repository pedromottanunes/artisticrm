import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { renewSession, sessionExpiry, SESSION_MAX_AGE_SECONDS } from '../src/sessions.js';
import type { Database } from '../src/db.js';
import type { MongoStore } from '../src/mongo-store.js';

export async function checkPersistentSessions(
  db: Database | MongoStore,
  login: string,
  password: string,
) {
  let now = new Date();
  const options = {
    clock: () => now,
    reconcile: false,
    production: true,
    appOrigin: 'https://crm.example',
  };
  let { app } = await buildApp(db, options);
  const safe = { 'x-artisti-client': 'web', origin: 'https://crm.example' };
  const signIn = async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: safe,
      payload: { login, password },
    });
    assert.equal(response.statusCode, 200);
    const cookie = response.cookies.find((c) => c.name === 'artisti_session')!;
    assert.equal(cookie.maxAge, SESSION_MAX_AGE_SECONDS);
    assert.ok(cookie.httpOnly && cookie.secure);
    assert.equal(cookie.sameSite, 'Strict');
    return cookie.value;
  };
  const headers = (token: string) => ({ ...safe, cookie: `artisti_session=${token}` });
  const me = (token: string) => app.inject({ url: '/api/v1/me', headers: headers(token) });
  const row = async (token: string) =>
    db.kind === 'mongo'
      ? db.one('sessions', { token_hash: tokenHash(token) })
      : (
          await db.query<{ expires_at: Date; user_id: string; auth_version: number }>(
            'SELECT * FROM sessions WHERE token_hash=$1',
            [tokenHash(token)],
          )
        ).rows[0];
  const setExpiry = async (token: string, expiry: Date) =>
    db.kind === 'mongo'
      ? db.update('sessions', { token_hash: tokenHash(token) }, { $set: { expires_at: expiry } })
      : db.query('UPDATE sessions SET expires_at=$1 WHERE token_hash=$2', [
          expiry,
          tokenHash(token),
        ]);
  try {
    const token = await signIn();
    const otherDevice = await signIn();
    assert.notEqual(token, otherDevice);
    assert.equal(
      (await me(token)).statusCode,
      200,
      'second login must not disconnect the first device',
    );
    assert.deepEqual(new Date((await row(token))!.expires_at), sessionExpiry(now));
    const user = (await me(token)).json();
    assert.equal(user.session_expires_at, undefined);
    assert.equal(user.password_hash, undefined);

    // Fresh server instance, same persistent database and browser cookie.
    await app.close();
    ({ app } = await buildApp(db, options));
    assert.equal((await me(token)).statusCode, 200, 'deploy must preserve the session');
    now = new Date(now.getTime() + 9 * 3600_000);
    assert.equal((await me(token)).statusCode, 200, 'no more 8-hour logout');
    const previousExpiry = new Date((await row(token))!.expires_at);
    assert.equal((await me(token)).cookies[0].maxAge, SESSION_MAX_AGE_SECONDS - 9 * 3600);
    // Cookie repair must not turn every poll into a database read/write.
    const noWriteStore = Object.create(db);
    noWriteStore.update = noWriteStore.query = () => {
      throw new Error('unexpected session write');
    };
    assert.deepEqual(
      await renewSession(noWriteStore, tokenHash(token), user, previousExpiry, now),
      previousExpiry,
    );

    now = new Date(now.getTime() + 16 * 3600_000);
    const parallel = await Promise.all(Array.from({ length: 6 }, () => me(token)));
    assert.ok(parallel.every((response) => response.statusCode === 200));
    const cookies = parallel.flatMap((response) => response.cookies);
    assert.ok(cookies.length >= 1);
    assert.ok(
      cookies.every(
        (cookie) => cookie.value === token && cookie.maxAge === SESSION_MAX_AGE_SECONDS,
      ),
    );
    assert.deepEqual(new Date((await row(token))!.expires_at), sessionExpiry(now));
    assert.equal(
      await renewSession(db, tokenHash(token), user, previousExpiry, now),
      null,
      'a stale CAS cannot overwrite the winning cookie with the previous expiry',
    );
    assert.equal((await me(token)).cookies[0].maxAge, SESSION_MAX_AGE_SECONDS);

    // Upgrade a live legacy session without asking for the password again.
    const legacyExpiry = new Date(now.getTime() + 8 * 3600_000);
    await setExpiry(otherDevice, legacyExpiry);
    const upgraded = await me(otherDevice);
    assert.equal(upgraded.statusCode, 200);
    assert.equal(upgraded.cookies[0].value, otherDevice);
    assert.equal(upgraded.cookies[0].maxAge, SESSION_MAX_AGE_SECONDS);

    // Discard the response (no browser acknowledgment), then restart the server.
    // The next authenticated request must repair that old 8-hour browser cookie.
    const persistedExpiry = new Date((await row(otherDevice))!.expires_at);
    await app.close();
    ({ app } = await buildApp(db, options));
    now = new Date(now.getTime() + 60_000);
    const recovered = await me(otherDevice);
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.cookies[0].value, otherDevice);
    assert.equal(recovered.cookies[0].maxAge, SESSION_MAX_AGE_SECONDS - 60);
    assert.ok(recovered.cookies[0].httpOnly && recovered.cookies[0].secure);
    assert.deepEqual(
      new Date((await row(otherDevice))!.expires_at),
      persistedExpiry,
      'repairing the browser cookie must not extend the database expiry on every request',
    );

    // An already expired cookie must never be resurrected.
    await setExpiry(otherDevice, new Date(now.getTime() - 1));
    assert.equal((await me(otherDevice)).statusCode, 401);
    assert.equal(
      await renewSession(db, tokenHash(otherDevice), user, new Date(now.getTime() - 1), now),
      null,
    );

    await setExpiry(token, legacyExpiry);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: headers(token),
      payload: {},
    });
    assert.equal(logout.statusCode, 200);
    assert.equal(
      await renewSession(db, tokenHash(token), user, legacyExpiry, now),
      null,
      'a late renewal cannot recreate a logged-out session',
    );
    assert.equal((await me(token)).statusCode, 401);

    const disabledToken = await signIn();
    if (db.kind === 'mongo') await db.update('users', { id: user.id }, { $set: { active: false } });
    else await db.query('UPDATE users SET active=false WHERE id=$1', [user.id]);
    assert.equal((await me(disabledToken)).statusCode, 401);
    if (db.kind === 'mongo')
      await db.update(
        'users',
        { id: user.id },
        { $set: { active: true }, $inc: { auth_version: 1 } },
      );
    else
      await db.query('UPDATE users SET active=true,auth_version=auth_version+1 WHERE id=$1', [
        user.id,
      ]);
    assert.equal(
      (await me(disabledToken)).statusCode,
      401,
      'credential version changes still revoke access',
    );

    const inactiveToken = await signIn();
    now = new Date(now.getTime() + (SESSION_MAX_AGE_SECONDS + 1) * 1000);
    const expired = await me(inactiveToken);
    assert.equal(expired.statusCode, 401);
    assert.equal(expired.cookies.length, 0);
  } finally {
    await app.close();
  }
}
