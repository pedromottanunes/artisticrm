import { createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import type { Sql } from './db.js';

const digest = (payload: unknown) =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex');
const sensitive = (payload: unknown) =>
  !!payload && typeof payload === 'object' && 'password' in payload;
const legacyPrefix = 'scrypt-sha256:';

export function commandFingerprint(payload: unknown) {
  return sensitive(payload)
    ? hashPassword(JSON.stringify(payload))
    : Promise.resolve(digest(payload));
}

export function matchesCommandFingerprint(payload: unknown, stored: string) {
  if (stored.startsWith(legacyPrefix))
    return verifyPassword(digest(payload), stored.slice(legacyPrefix.length));
  if (sensitive(payload)) return verifyPassword(JSON.stringify(payload), stored);
  return Promise.resolve(stored === digest(payload));
}

// Older SQL receipts did not record the command kind. Wrap every legacy digest
// without needing the original password or losing idempotency. Never alter users.
export async function protectLegacySqlReceipts(tx: Sql) {
  for (;;) {
    const { rows } = await tx.query<{ actor_id: string; key: string; fingerprint: string }>(
      "SELECT actor_id,key,fingerprint FROM operation_receipts WHERE fingerprint ~ '^[a-f0-9]{64}$' LIMIT 20 FOR UPDATE",
    );
    if (!rows.length) return;
    for (const row of rows) {
      const wrapped = legacyPrefix + (await hashPassword(row.fingerprint));
      await tx.query('UPDATE operation_receipts SET fingerprint=$3 WHERE actor_id=$1 AND key=$2', [
        row.actor_id,
        row.key,
        wrapped,
      ]);
    }
  }
}
