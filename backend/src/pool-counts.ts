import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import { DomainError, type User } from './types.js';

export interface AttendantPoolCounts {
  leads: number;
  comments: number;
}

/**
 * Small, database-only counter used by the consultant navigation.
 * It deliberately does not load workspace rows or call Meta.
 */
export async function attendantPoolCounts(
  db: Database | MongoStore,
  user: User,
  instagramAccountId: string | undefined,
  time: Date,
): Promise<AttendantPoolCounts> {
  if (user.role !== 'attendant')
    throw new DomainError('FORBIDDEN', 'Bolsão disponível somente para consultores.', 403);

  if (db.kind === 'mongo') {
    // A badge can tolerate a count changing between these two reads. Avoiding a
    // transaction keeps this frequent read inexpensive on Atlas/Render.
    const leads = await db.count('opportunities', { state: 'POOL' });
    if (!instagramAccountId) return { leads, comments: 0 };
    const grouped = await db
      .collection('instagram_comments')
      .aggregate<{ count: number }>([
        {
          $match: {
            account_id: instagramAccountId,
            ignored: false,
            opportunity_id: null,
            reply_deadline_at: { $gt: time },
          },
        },
        { $group: { _id: '$sender_id' } },
        { $count: 'count' },
      ])
      .next();
    return { leads, comments: grouped?.count ?? 0 };
  }

  const row = (
    await db.query<{ leads: number; comments: number }>(
      `SELECT
         (SELECT count(*)::integer FROM opportunities WHERE state='POOL') AS leads,
         CASE WHEN $1::text IS NULL THEN 0 ELSE (
           SELECT count(DISTINCT sender_id)::integer
           FROM instagram_comments
           WHERE account_id=$1 AND NOT ignored AND opportunity_id IS NULL AND reply_deadline_at>$2
         ) END AS comments`,
      [instagramAccountId ?? null, time],
    )
  ).rows[0];
  return { leads: Number(row?.leads ?? 0), comments: Number(row?.comments ?? 0) };
}
