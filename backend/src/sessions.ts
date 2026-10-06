import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import type { User } from './types.js';

export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const sessionExpiry = (now: Date) =>
  new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
export const sessionCookieOptions = (production: boolean, maxAge = SESSION_MAX_AGE_SECONDS) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: production,
  maxAge,
});

// Uses the persisted expiry already read during authentication. No extra reads,
// and at most one renewal write per session/day, including concurrent requests.
// Existing unexpired 8-hour sessions are upgraded on their next authenticated request.
// Return the persisted expiry even when no renewal is needed: a prior Set-Cookie
// response may have been lost. A failed CAS returns null, never an older expiry
// that could overwrite the concurrent winner's cookie.
export async function renewSession(
  db: Database | MongoStore,
  hash: string,
  user: Pick<User, 'id' | 'auth_version'>,
  previousExpiry: Date,
  now: Date,
): Promise<Date | null> {
  const next = sessionExpiry(now);
  if (!Number.isFinite(previousExpiry.getTime()) || previousExpiry.getTime() <= now.getTime())
    return null;
  if (previousExpiry.getTime() > next.getTime() - RENEW_INTERVAL_MS) return previousExpiry;
  if (db.kind === 'mongo') {
    const result = await db.update(
      'sessions',
      {
        token_hash: hash,
        user_id: user.id,
        auth_version: user.auth_version,
        expires_at: previousExpiry,
      },
      { $set: { expires_at: next } },
    );
    return result.modifiedCount === 1 ? next : null;
  }
  const result = await db.query(
    `UPDATE sessions SET expires_at=$1
     WHERE token_hash=$2 AND user_id=$3 AND auth_version=$4 AND expires_at=$5
     RETURNING token_hash`,
    [next, hash, user.id, user.auth_version, previousExpiry],
  );
  // Never insert here: logout/deactivation/password resets must remain authoritative.
  return result.rows.length === 1 ? next : null;
}
