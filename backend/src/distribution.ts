import { z } from 'zod';
import type { Document } from 'mongodb';
import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import { requireManager, type User } from './types.js';

export const distributionQuery = z
  .object({
    state: z.enum(['ALL', 'RESERVED', 'POOL', 'CLAIMED', 'PENDING']).default('ALL'),
    attendant: z.union([z.string().uuid(), z.literal('')]).default(''),
    search: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
const states = ['RESERVED', 'POOL', 'CLAIMED', 'PENDING'];
const kinds = [
  'lead.created',
  'reservation.created',
  'reservation.expired',
  'opportunity.claimed',
  'opportunity.transferred',
  'queue.updated',
];
const pageSize = 25;

// Counts cover every open opportunity, independently of the workspace's 500-row limit.
export async function distributionBoard(
  db: Database | MongoStore,
  user: User,
  query: z.infer<typeof distributionQuery>,
  now: () => Promise<Date>,
) {
  requireManager(user);
  const serverTime = (await now()).toISOString();
  if (db.kind === 'mongo')
    return db.atomic(async (tx) => {
      const open = { state: { $in: states }, stage: { $nin: ['LOST', 'WON'] } };
      const filter: Document = { ...open };
      if (query.state !== 'ALL') filter.state = query.state;
      if (query.attendant)
        filter.$or = [
          { state: 'RESERVED', reserved_to: query.attendant },
          { state: 'CLAIMED', owner_id: query.attendant },
        ];
      const join: Document[] = [
        { $match: filter },
        {
          $lookup: {
            from: 'contacts',
            localField: 'contact_id',
            foreignField: 'id',
            as: 'contact',
          },
        },
        { $unwind: '$contact' },
      ];
      if (query.search) {
        const literal = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        join.push({
          $match: {
            $or: [
              { 'contact.name': { $regex: literal, $options: 'i' } },
              { 'contact.phone': { $regex: literal, $options: 'i' } },
            ],
          },
        });
      }
      const aggregate = (collection: string, pipeline: Document[]) =>
        tx.collection(collection).aggregate(pipeline, { session: tx.session }).toArray();
      const counts = await aggregate('opportunities', [
        { $match: open },
        { $group: { _id: '$state', count: { $sum: 1 } } },
      ]);
      const team = await aggregate('opportunities', [
        { $match: open },
        {
          $group: {
            _id: {
              state: '$state',
              user: { $cond: [{ $eq: ['$state', 'RESERVED'] }, '$reserved_to', '$owner_id'] },
            },
            count: { $sum: 1 },
          },
        },
      ]);
      const matched = await aggregate('opportunities', [...join, { $count: 'count' }]);
      const total = Number(matched[0]?.count ?? 0);
      const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
      const rows = await aggregate('opportunities', [
        ...join,
        {
          $set: {
            priority: {
              $switch: {
                branches: [
                  { case: { $eq: ['$state', 'RESERVED'] }, then: 0 },
                  { case: { $eq: ['$state', 'POOL'] }, then: 1 },
                  { case: { $eq: ['$state', 'PENDING'] }, then: 2 },
                ],
                default: 3,
              },
            },
            due: { $ifNull: ['$expires_at', '$created_at'] },
          },
        },
        { $sort: { priority: 1, due: 1, id: 1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            _id: 0,
            id: 1,
            name: '$contact.name',
            phone: '$contact.phone',
            source: 1,
            state: 1,
            reserved_to: 1,
            owner_id: 1,
            created_at: 1,
            expires_at: 1,
            claimed_at: 1,
            needs_review: 1,
            version: 1,
          },
        },
      ]);
      const events = await aggregate('audit_events', [
        { $match: { kind: { $in: kinds } } },
        { $sort: { created_at: -1, id: -1 } },
        { $limit: 20 },
        {
          $lookup: {
            from: 'opportunities',
            localField: 'opportunity_id',
            foreignField: 'id',
            as: 'opportunity',
          },
        },
        {
          $lookup: {
            from: 'contacts',
            localField: 'opportunity.contact_id',
            foreignField: 'id',
            as: 'contact',
          },
        },
        {
          $project: {
            _id: 0,
            id: 1,
            opportunity_id: 1,
            description: 1,
            kind: 1,
            created_at: 1,
            name: { $arrayElemAt: ['$contact.name', 0] },
          },
        },
      ]);
      return {
        rows,
        total,
        page,
        page_size: pageSize,
        counts: Object.fromEntries(
          states.map((s) => [s, Number(counts.find((c) => c._id === s)?.count ?? 0)]),
        ),
        team: team
          .filter((t) => t._id.user)
          .map((t) => ({ user_id: t._id.user, state: t._id.state, count: Number(t.count) })),
        events,
        server_time: serverTime,
      };
    }, true);

  return db.transaction(async (tx) => {
    // A coherent read for rows, totals and movement history in PostgreSQL as well.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const open =
      "o.state IN ('RESERVED','POOL','CLAIMED','PENDING') AND o.stage NOT IN ('WON','LOST')";
    const where = `${open} AND ($1='ALL' OR o.state=$1)
      AND ($2='' OR (o.state='RESERVED' AND o.reserved_to::text=$2) OR (o.state='CLAIMED' AND o.owner_id::text=$2))
      AND ($3='' OR strpos(lower(c.name),lower($3))>0 OR strpos(c.phone,$3)>0)`;
    const args = [query.state, query.attendant, query.search];
    const counts = (
      await tx.query<{ state: string; count: string }>(
        `SELECT o.state,count(*) FROM opportunities o WHERE ${open} GROUP BY o.state`,
      )
    ).rows;
    const team = (
      await tx.query<{ user_id: string; state: string; count: string }>(
        `SELECT CASE WHEN o.state='RESERVED' THEN o.reserved_to ELSE o.owner_id END AS user_id,o.state,count(*) FROM opportunities o WHERE ${open} GROUP BY 1,2`,
      )
    ).rows;
    const total = Number(
      (
        await tx.query<{ count: string }>(
          `SELECT count(*) FROM opportunities o JOIN contacts c ON c.id=o.contact_id WHERE ${where}`,
          args,
        )
      ).rows[0].count,
    );
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = (
      await tx.query(
        `SELECT o.id,c.name,c.phone,o.source,o.state,o.reserved_to,o.owner_id,o.created_at,o.expires_at,o.claimed_at,o.needs_review,o.version
      FROM opportunities o JOIN contacts c ON c.id=o.contact_id WHERE ${where}
      ORDER BY CASE o.state WHEN 'RESERVED' THEN 0 WHEN 'POOL' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END,
      COALESCE(o.expires_at,o.created_at),o.id LIMIT $4 OFFSET $5`,
        [...args, pageSize, (page - 1) * pageSize],
      )
    ).rows;
    const events = (
      await tx.query(
        `SELECT a.id,a.opportunity_id,a.description,a.kind,a.created_at,c.name
      FROM audit_events a LEFT JOIN opportunities o ON o.id=a.opportunity_id LEFT JOIN contacts c ON c.id=o.contact_id
      WHERE a.kind=ANY($1::text[]) ORDER BY a.created_at DESC,a.id DESC LIMIT 20`,
        [kinds],
      )
    ).rows;
    return {
      rows,
      total,
      page,
      page_size: pageSize,
      counts: Object.fromEntries(
        states.map((s) => [s, Number(counts.find((c) => c.state === s)?.count ?? 0)]),
      ),
      team: team.filter((t) => t.user_id).map((t) => ({ ...t, count: Number(t.count) })),
      events,
      server_time: serverTime,
    };
  });
}
