import type { Sql, Database } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import type { Opportunity, User } from './types.js';

export type PushDb = Database | MongoStore;
export type PushTx = Sql | MongoTx;
export interface PushRecord {
  id: string;
  kind: 'event' | 'subscription' | 'job';
  available_at: string;
  expires_at: string;
  data: Record<string, any>;
}
export const inPushTransaction = <T>(db: PushDb, callback: (tx: PushTx) => Promise<T>) =>
  db.kind === 'mongo'
    ? db.atomic(callback)
    : db.transaction(async (tx) => {
        // Serializes expansion and lease acquisition only; network delivery is outside.
        await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
        return callback(tx);
      });
export async function getPush(tx: PushTx, id: string): Promise<PushRecord | null> {
  return tx instanceof MongoTx
    ? tx.one<PushRecord>('push_records', { id })
    : ((await tx.query<PushRecord>('SELECT * FROM push_records WHERE id=$1', [id])).rows[0] ??
        null);
}
export async function putPush(tx: PushTx, record: PushRecord) {
  if (tx instanceof MongoTx)
    await tx
      .collection('push_records')
      .replaceOne({ id: record.id }, record, { upsert: true, session: tx.session });
  else
    await tx.query(
      'INSERT INTO push_records VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET available_at=$3,expires_at=$4,data=$5',
      [record.id, record.kind, record.available_at, record.expires_at, JSON.stringify(record.data)],
    );
}
export async function removePush(tx: PushTx, id: string) {
  if (tx instanceof MongoTx) await tx.remove('push_records', { id });
  else await tx.query('DELETE FROM push_records WHERE id=$1', [id]);
}
export async function readyPush(
  tx: PushTx,
  kind: PushRecord['kind'],
  now: string,
  limit = 100,
): Promise<PushRecord[]> {
  return tx instanceof MongoTx
    ? tx.many(
        'push_records',
        { kind, available_at: { $lte: now }, expires_at: { $gt: now } },
        { available_at: 1, id: 1 },
        limit,
      )
    : (
        await tx.query<PushRecord>(
          'SELECT * FROM push_records WHERE kind=$1 AND available_at<=$2 AND expires_at>$2 ORDER BY available_at,id LIMIT $3',
          [kind, now, limit],
        )
      ).rows;
}
export async function cleanPush(tx: PushTx, now: string) {
  if (tx instanceof MongoTx) await tx.remove('push_records', { expires_at: { $lte: now } });
  else await tx.query('DELETE FROM push_records WHERE expires_at<=$1', [now]);
}
export async function pushUser(tx: PushTx, id: string): Promise<User | null> {
  return tx instanceof MongoTx
    ? tx.one<User>('users', { id })
    : ((await tx.query<User>('SELECT * FROM users WHERE id=$1', [id])).rows[0] ?? null);
}
export async function pushSession(
  tx: PushTx,
  hash: string,
  userId: string,
  version: number,
  now: Date,
) {
  return tx instanceof MongoTx
    ? !!(await tx.one('sessions', {
        token_hash: hash,
        user_id: userId,
        auth_version: version,
        expires_at: { $gt: now },
      }))
    : !!(
        await tx.query(
          'SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND auth_version=$3 AND expires_at>$4',
          [hash, userId, version, now],
        )
      ).rows.length;
}
export async function removePushSession(tx: PushTx, hash: string) {
  if (tx instanceof MongoTx) await tx.remove('sessions', { token_hash: hash });
  else await tx.query('DELETE FROM sessions WHERE token_hash=$1', [hash]);
}
export async function pushOpportunity(tx: PushTx, id: string): Promise<Opportunity | null> {
  return tx instanceof MongoTx
    ? tx.one<Opportunity>('opportunities', { id })
    : ((await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1', [id])).rows[0] ??
        null);
}
export async function enqueuePushEvent(
  tx: PushTx,
  eventId: string,
  opportunityId: string | null,
  kind: string,
  now: Date,
) {
  if (
    !opportunityId ||
    ![
      'lead.created',
      'reservation.created',
      'reservation.expired',
      'opportunity.transferred',
    ].includes(kind)
  )
    return;
  const lead = await pushOpportunity(tx, opportunityId);
  if (!lead) return;
  await putPush(tx, {
    id: `event:${eventId}`,
    kind: 'event',
    available_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 3600000).toISOString(),
    data: {
      opportunityId,
      kind,
      createdAt: now.toISOString(),
      state: lead.state,
      target: lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id,
    },
  });
}
