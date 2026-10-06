import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import { DomainError, type User } from './types.js';
import { previewWeightedOrder, type WeightedQueueParticipant } from './weighted-queue.js';

type QueueStatusParticipant = WeightedQueueParticipant & {
  active: boolean;
  queue_enabled: boolean;
};

export interface PersonalQueueStatus {
  participating: boolean;
  next: boolean;
}

function personalStatus(
  participants: QueueStatusParticipant[],
  lastPosition: number,
  userId: string,
): PersonalQueueStatus {
  const eligible = participants.filter(
    (participant) =>
      participant.active && participant.queue_enabled && participant.queue_position !== null,
  );
  const order = previewWeightedOrder(eligible, lastPosition);
  const participating = order.includes(userId);
  return { participating, next: participating && order[0] === userId };
}

export async function personalQueueStatus(
  db: Database | MongoStore,
  user: User,
): Promise<PersonalQueueStatus> {
  if (user.role !== 'attendant')
    throw new DomainError('FORBIDDEN', 'Posição disponível somente para consultores.', 403);
  if (!user.active || !user.queue_enabled || user.queue_position === null)
    return { participating: false, next: false };

  if (db.kind === 'mongo')
    return db.atomic(async (tx) => {
      const settings = await tx.one<{ last_position: number }>('distribution_settings', { id: 1 });
      const participants = await tx
        .collection('users')
        .find(
          {
            role: 'attendant',
            active: true,
            queue_enabled: true,
            queue_position: { $type: 'number' },
          },
          { session: tx.session },
        )
        .project<QueueStatusParticipant>({
          _id: 0,
          id: 1,
          active: 1,
          queue_enabled: 1,
          queue_position: 1,
          queue_weight: 1,
          queue_credit: 1,
        })
        .toArray();
      return personalStatus(participants, settings?.last_position ?? 0, user.id);
    }, true);

  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const participants = (
      await tx.query<QueueStatusParticipant & { last_position: number }>(
        `SELECT u.id,u.active,u.queue_enabled,u.queue_position,u.queue_weight,u.queue_credit,
                settings.last_position
         FROM users u CROSS JOIN distribution_settings settings
         WHERE settings.id=1 AND u.role='attendant' AND u.active AND u.queue_enabled
           AND u.queue_position IS NOT NULL`,
      )
    ).rows;
    return personalStatus(participants, participants[0]?.last_position ?? 0, user.id);
  });
}
