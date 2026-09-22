import { z } from 'zod';
import type { Document } from 'mongodb';
import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import { closedStages, requireManager, stages, type User } from './types.js';
import { previewWeightedOrder } from './weighted-queue.js';

export const distributionQuery = z
  .object({
    state: z.enum(['ALL', 'RESERVED', 'POOL', 'CLAIMED', 'PENDING']).default('ALL'),
    scope: z.enum(['OPEN', 'CLOSED', 'ALL']).default('OPEN'),
    stage: z.enum(['ALL', ...stages]).default('ALL'),
    order: z.enum(['PRIORITY', 'RECENT']).default('PRIORITY'),
    attendant: z.union([z.string().uuid(), z.literal('')]).default(''),
    search: z.string().trim().max(100).default(''),
    source: z.string().trim().max(160).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
const states = ['RESERVED', 'POOL', 'CLAIMED', 'PENDING'];
const closedStageList = [...closedStages];
const closedStageSql = closedStages.map((stage) => `'${stage}'`).join(',');
const kinds = [
  'lead.created',
  'reservation.created',
  'reservation.expired',
  'opportunity.claimed',
  'opportunity.transferred',
  'queue.updated',
];
const pageSize = 25;
const businessTimeZone = 'America/Sao_Paulo';

function startOfDayInTimeZone(value: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const localMidnight = Date.UTC(parts.year, parts.month - 1, parts.day);
  const probe = new Date(localMidnight);
  const probeParts = Object.fromEntries(
    formatter
      .formatToParts(probe)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  const offset =
    Date.UTC(
      probeParts.year,
      probeParts.month - 1,
      probeParts.day,
      probeParts.hour,
      probeParts.minute,
      probeParts.second,
    ) - probe.getTime();
  return new Date(localMidnight - offset);
}

type BoardUser = Pick<
  User,
  | 'id'
  | 'name'
  | 'email'
  | 'role'
  | 'active'
  | 'queue_enabled'
  | 'queue_position'
  | 'queue_weight'
  | 'color'
  | 'version'
  | 'must_change_password'
> & { queue_credit: number };

function publicBoardUser({ queue_credit: _queueCredit, ...user }: BoardUser) {
  return user;
}

function attendantSummaries(
  users: BoardUser[],
  settings: { last_position: number },
  team: { user_id: string; state: string; count: number }[],
  expired: { user_id: string; count: number }[],
) {
  const eligible = users.filter(
    (user) =>
      user.role === 'attendant' &&
      user.active &&
      user.queue_enabled &&
      user.queue_position !== null,
  );
  const upcoming = previewWeightedOrder(eligible, settings.last_position);
  const ranks = new Map(upcoming.map((id, index) => [id, index + 1]));
  const metric = (userId: string, state: string) =>
    team.find((item) => item.user_id === userId && item.state === state)?.count ?? 0;
  return users
    .filter((user) => user.role === 'attendant')
    .map((user) => ({
      ...publicBoardUser(user),
      queue_rank: ranks.get(user.id) ?? null,
      is_next: ranks.get(user.id) === 1,
      claimed_count: metric(user.id, 'CLAIMED'),
      reserved_count: metric(user.id, 'RESERVED'),
      expired_today: expired.find((item) => item.user_id === user.id)?.count ?? 0,
    }));
}

// Counts cover every open opportunity, independently of the workspace's 500-row limit.
export async function distributionBoard(
  db: Database | MongoStore,
  user: User,
  query: z.infer<typeof distributionQuery>,
  now: () => Promise<Date>,
) {
  requireManager(user);
  const metricsSince = startOfDayInTimeZone(await now(), businessTimeZone);
  const result = await readDistributionBoard(db, query, metricsSince);
  // Read the clock after the query, without opening another connection inside its
  // transaction. Long queries must not restart the displayed countdown in the past.
  return { ...result, server_time: (await now()).toISOString() };
}

const userFields = [
  'id',
  'name',
  'email',
  'role',
  'active',
  'queue_enabled',
  'queue_position',
  'queue_weight',
  'queue_credit',
  'color',
  'version',
  'must_change_password',
];

async function readDistributionBoard(
  db: Database | MongoStore,
  query: z.infer<typeof distributionQuery>,
  metricsSince: Date,
) {
  if (db.kind === 'mongo')
    return db.atomic(async (tx) => {
      const users = await tx
        .collection('users')
        .find(
          {},
          {
            session: tx.session,
            projection: { _id: 0, ...Object.fromEntries(userFields.map((field) => [field, 1])) },
          },
        )
        .sort({ queue_position: 1, id: 1 })
        .toArray();
      const configuration = (await tx.one('distribution_settings', { id: 1 }))!;
      const settings = {
        version: configuration.version,
        timeout_minutes: configuration.timeout_minutes,
        last_position: configuration.last_position,
      };
      const open = { state: { $in: states }, stage: { $nin: closedStageList } };
      const filter: Document =
        query.scope === 'OPEN'
          ? { ...open }
          : query.scope === 'CLOSED'
            ? { stage: { $in: closedStageList } }
            : {};
      if (query.stage !== 'ALL') {
        if (filter.stage !== undefined) {
          const scopeStage = filter.stage;
          delete filter.stage;
          filter.$and = [{ stage: scopeStage }, { stage: query.stage }];
        } else filter.stage = query.stage;
      }
      if (query.state !== 'ALL') filter.state = query.state;
      if (query.attendant)
        filter.$or = [
          { state: 'RESERVED', reserved_to: query.attendant },
          { state: 'CLAIMED', owner_id: query.attendant },
          ...(query.scope === 'OPEN' ? [] : [{ owner_id: query.attendant }]),
        ];
      if (query.source) filter.source = query.source;
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
      const expired = await aggregate('audit_events', [
        {
          $match: {
            kind: 'reservation.expired',
            created_at: { $gte: metricsSince },
            'details.reserved_to': { $type: 'string' },
          },
        },
        { $group: { _id: '$details.reserved_to', count: { $sum: 1 } } },
      ]);
      const matched = await aggregate('opportunities', [...join, { $count: 'count' }]);
      const total = Number(matched[0]?.count ?? 0);
      const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
      const priority = {
        $switch: {
          branches: [
            { case: { $eq: ['$state', 'RESERVED'] }, then: 0 },
            { case: { $eq: ['$state', 'POOL'] }, then: 1 },
            { case: { $eq: ['$state', 'PENDING'] }, then: 2 },
          ],
          default: 3,
        },
      };
      const rows = await aggregate('opportunities', [
        ...join,
        ...(query.order === 'PRIORITY'
          ? [
              {
                $set: {
                  priority,
                  due: { $ifNull: ['$expires_at', '$created_at'] },
                },
              },
            ]
          : []),
        {
          $sort:
            query.order === 'RECENT' ? { created_at: -1, id: -1 } : { priority: 1, due: 1, id: 1 },
        },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
        {
          $project: {
            _id: 0,
            id: 1,
            name: '$contact.name',
            phone: '$contact.phone',
            interest: 1,
            source: 1,
            stage: 1,
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
      const normalizedTeam = team
        .filter((item) => item._id.user)
        .map((item) => ({
          user_id: item._id.user as string,
          state: item._id.state as string,
          count: Number(item.count),
        }));
      const normalizedExpired = expired
        .filter((item) => item._id)
        .map((item) => ({ user_id: item._id as string, count: Number(item.count) }));
      return {
        users: (users as unknown as BoardUser[]).map(publicBoardUser),
        attendants: attendantSummaries(
          users as unknown as BoardUser[],
          settings,
          normalizedTeam,
          normalizedExpired,
        ),
        settings,
        rows,
        total,
        page,
        page_size: pageSize,
        counts: Object.fromEntries(
          states.map((s) => [s, Number(counts.find((c) => c._id === s)?.count ?? 0)]),
        ),
        team: normalizedTeam,
        events,
      };
    }, true);

  return db.transaction(async (tx) => {
    // A coherent read for rows, totals and movement history in PostgreSQL as well.
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const users = (
      await tx.query<BoardUser>(
        `SELECT ${userFields.join(',')} FROM users ORDER BY queue_position NULLS FIRST,id`,
      )
    ).rows;
    const settings = (
      await tx.query<{ version: number; timeout_minutes: number; last_position: number }>(
        'SELECT version,timeout_minutes,last_position FROM distribution_settings WHERE id=1',
      )
    ).rows[0];
    const open = `o.state IN ('RESERVED','POOL','CLAIMED','PENDING') AND o.stage NOT IN (${closedStageSql})`;
    const selectedScope = `($4='ALL' OR ($4='OPEN' AND ${open}) OR ($4='CLOSED' AND o.stage IN (${closedStageSql})))`;
    const where = `${selectedScope} AND ($1='ALL' OR o.state=$1)
      AND ($2='' OR (o.state='RESERVED' AND o.reserved_to::text=$2) OR (o.state='CLAIMED' AND o.owner_id::text=$2) OR ($4<>'OPEN' AND o.owner_id::text=$2))
      AND ($3='' OR strpos(lower(c.name),lower($3))>0 OR strpos(c.phone,$3)>0)
      AND ($5='' OR o.source=$5)
      AND ($6='ALL' OR o.stage=$6)`;
    const args = [
      query.state,
      query.attendant,
      query.search,
      query.scope,
      query.source,
      query.stage,
    ];
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
    const expired = (
      await tx.query<{ user_id: string; count: string }>(
        `SELECT details->>'reserved_to' AS user_id,count(*)
        FROM audit_events
        WHERE kind='reservation.expired' AND created_at >= $1
          AND details->>'reserved_to' IS NOT NULL
        GROUP BY 1`,
        [metricsSince],
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
        `SELECT o.id,c.name,c.phone,o.interest,o.source,o.stage,o.state,o.reserved_to,o.owner_id,o.created_at,o.expires_at,o.claimed_at,o.needs_review,o.version
      FROM opportunities o JOIN contacts c ON c.id=o.contact_id WHERE ${where}
      ORDER BY ${
        query.order === 'RECENT'
          ? 'o.created_at DESC,o.id DESC'
          : "CASE o.state WHEN 'RESERVED' THEN 0 WHEN 'POOL' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END,COALESCE(o.expires_at,o.created_at),o.id"
      } LIMIT $7 OFFSET $8`,
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
    const normalizedTeam = team
      .filter((item) => item.user_id)
      .map((item) => ({ ...item, count: Number(item.count) }));
    const normalizedExpired = expired
      .filter((item) => item.user_id)
      .map((item) => ({ ...item, count: Number(item.count) }));
    return {
      users: users.map(publicBoardUser),
      attendants: attendantSummaries(users, settings, normalizedTeam, normalizedExpired),
      settings,
      rows,
      total,
      page,
      page_size: pageSize,
      counts: Object.fromEntries(
        states.map((s) => [s, Number(counts.find((c) => c.state === s)?.count ?? 0)]),
      ),
      team: normalizedTeam,
      events,
    };
  });
}
