import type { Database, Sql } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import type { PushTx } from './push-store.js';

type NotificationMuteReader = Sql | Database | MongoTx | MongoStore;

const messageKinds = ['message.received', 'comment.received.owned'];

export async function mutedOpportunityIds(
  db: NotificationMuteReader,
  userId: string,
  opportunityIds: string[],
) {
  const muted = new Set<string>();
  const uniqueIds = [...new Set(opportunityIds)];
  if (!uniqueIds.length) return muted;
  if (db instanceof MongoTx) {
    const rows = await db.many<{ opportunity_id: string }>('lead_notification_mutes', {
      user_id: userId,
      opportunity_id: { $in: uniqueIds },
    });
    for (const row of rows) muted.add(row.opportunity_id);
    return muted;
  }
  const rows = (
    await db.query<{ opportunity_id: string }>(
      'SELECT opportunity_id FROM lead_notification_mutes WHERE user_id=$1 AND opportunity_id=ANY($2::uuid[])',
      [userId, uniqueIds],
    )
  ).rows;
  for (const row of rows) muted.add(row.opportunity_id);
  return muted;
}

export async function isLeadNotificationMuted(tx: PushTx, userId: string, opportunityId: string) {
  if (tx instanceof MongoTx)
    return !!(await tx.one('lead_notification_mutes', {
      user_id: userId,
      opportunity_id: opportunityId,
    }));
  return !!(
    await tx.query('SELECT 1 FROM lead_notification_mutes WHERE user_id=$1 AND opportunity_id=$2', [
      userId,
      opportunityId,
    ])
  ).rows.length;
}

export async function setLeadNotificationMuted(
  tx: PushTx,
  userId: string,
  opportunityId: string,
  muted: boolean,
) {
  if (tx instanceof MongoTx) {
    if (muted)
      await tx.collection('lead_notification_mutes').updateOne(
        { user_id: userId, opportunity_id: opportunityId },
        {
          $setOnInsert: {
            user_id: userId,
            opportunity_id: opportunityId,
            created_at: await tx.now(),
          },
        },
        { upsert: true, session: tx.session },
      );
    else
      await tx.remove('lead_notification_mutes', {
        user_id: userId,
        opportunity_id: opportunityId,
      });
    if (muted)
      await tx.remove('push_records', {
        kind: 'job',
        'data.message.userId': userId,
        'data.event.data.opportunityId': opportunityId,
        'data.event.data.kind': { $in: messageKinds },
      });
    return;
  }
  if (muted)
    await tx.query(
      `INSERT INTO lead_notification_mutes(user_id,opportunity_id)
       VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [userId, opportunityId],
    );
  else
    await tx.query('DELETE FROM lead_notification_mutes WHERE user_id=$1 AND opportunity_id=$2', [
      userId,
      opportunityId,
    ]);
  if (muted)
    await tx.query(
      `DELETE FROM push_records
       WHERE kind='job'
         AND data->'message'->>'userId'=$1
         AND data->'event'->'data'->>'opportunityId'=$2
         AND data->'event'->'data'->>'kind'=ANY($3::text[])`,
      [userId, opportunityId, messageKinds],
    );
}
