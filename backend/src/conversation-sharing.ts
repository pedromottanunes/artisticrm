import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import type { User } from './types.js';

export interface ConversationPortfolioShareView {
  id: string;
  source_user_id: string;
  source_name: string;
  source_active: boolean;
  reviewer_user_id: string;
  reviewer_name: string;
  granted_by: string;
  granted_at: string | Date;
  version: number;
  conversation_count: number;
}

export async function reviewSourceIds(db: Database | MongoStore, reviewerUserId: string) {
  if (db.kind === 'mongo')
    return (
      await db.many<{ source_user_id: string }>('conversation_portfolio_shares', {
        reviewer_user_id: reviewerUserId,
        revoked_at: null,
      })
    ).map((share) => share.source_user_id);
  return (
    await db.query<{ source_user_id: string }>(
      `SELECT source_user_id FROM conversation_portfolio_shares
       WHERE reviewer_user_id=$1 AND revoked_at IS NULL`,
      [reviewerUserId],
    )
  ).rows.map((share) => share.source_user_id);
}

export async function canReviewOwner(
  db: Database | MongoStore,
  user: User,
  ownerId: string | null,
) {
  if (user.role !== 'attendant' || !user.active || !ownerId || ownerId === user.id) return false;
  if (db.kind === 'mongo')
    return Boolean(
      await db.one('conversation_portfolio_shares', {
        source_user_id: ownerId,
        reviewer_user_id: user.id,
        revoked_at: null,
      }),
    );
  return Boolean(
    (
      await db.query(
        `SELECT id FROM conversation_portfolio_shares
         WHERE source_user_id=$1 AND reviewer_user_id=$2 AND revoked_at IS NULL`,
        [ownerId, user.id],
      )
    ).rows.length,
  );
}

export async function conversationPortfolioShares(
  db: Database | MongoStore,
): Promise<ConversationPortfolioShareView[]> {
  if (db.kind !== 'mongo')
    return (
      await db.query<ConversationPortfolioShareView>(
        `SELECT s.id,s.source_user_id,source.name AS source_name,source.active AS source_active,
                s.reviewer_user_id,reviewer.name AS reviewer_name,s.granted_by,s.granted_at,s.version,
                (SELECT count(*)::integer FROM conversations cv
                 JOIN opportunities o ON o.id=cv.opportunity_id
                 JOIN channel_accounts ca ON ca.id=cv.channel_account_id
                 WHERE o.owner_id=s.source_user_id AND o.non_commercial_reason IS NULL
                   AND o.state<>'CANCELLED' AND ca.provider IN ('instagram','messenger')) AS conversation_count
         FROM conversation_portfolio_shares s
         JOIN users source ON source.id=s.source_user_id
         JOIN users reviewer ON reviewer.id=s.reviewer_user_id
         WHERE s.revoked_at IS NULL
         ORDER BY source.name,s.granted_at`,
      )
    ).rows;

  const shares = await db.many<{
    id: string;
    source_user_id: string;
    reviewer_user_id: string;
    granted_by: string;
    granted_at: Date;
    version: number;
  }>('conversation_portfolio_shares', { revoked_at: null }, { granted_at: 1 });
  if (!shares.length) return [];
  const users = await db.many<Pick<User, 'id' | 'name' | 'active'>>('users', {
    id: {
      $in: [...new Set(shares.flatMap((share) => [share.source_user_id, share.reviewer_user_id]))],
    },
  });
  const byId = new Map(users.map((user) => [user.id, user]));
  const sourceIds = [...new Set(shares.map((share) => share.source_user_id))];
  const supportedAccountIds = (
    await db.many<{ id: string }>('channel_accounts', {
      provider: { $in: ['instagram', 'messenger'] },
    })
  ).map((account) => account.id);
  const counts = new Map<string, number>();
  if (sourceIds.length && supportedAccountIds.length) {
    const grouped = await db
      .collection('conversations')
      .aggregate<{ _id: string; count: number }>([
        { $match: { channel_account_id: { $in: supportedAccountIds } } },
        {
          $lookup: {
            from: 'opportunities',
            localField: 'opportunity_id',
            foreignField: 'id',
            as: 'opportunity',
          },
        },
        { $set: { opportunity: { $first: '$opportunity' } } },
        {
          $match: {
            'opportunity.owner_id': { $in: sourceIds },
            'opportunity.non_commercial_reason': null,
            'opportunity.state': { $ne: 'CANCELLED' },
          },
        },
        { $group: { _id: '$opportunity.owner_id', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const row of grouped) counts.set(row._id, row.count);
  }
  const rows: ConversationPortfolioShareView[] = [];
  for (const share of shares) {
    const source = byId.get(share.source_user_id);
    const reviewer = byId.get(share.reviewer_user_id);
    if (!source || !reviewer) continue;
    rows.push({
      ...share,
      source_name: source.name,
      source_active: source.active,
      reviewer_name: reviewer.name,
      conversation_count: counts.get(share.source_user_id) ?? 0,
    });
  }
  return rows.sort((left, right) => left.source_name.localeCompare(right.source_name, 'pt-BR'));
}
