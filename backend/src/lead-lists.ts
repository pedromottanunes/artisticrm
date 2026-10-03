import type { Document } from 'mongodb';
import { z } from 'zod';
import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import type { User } from './types.js';

export const leadListCategories = [
  'ALL',
  'NOT_SCHEDULED',
  'SCHEDULED',
  'ATTENDED',
  'NO_SHOW',
  'FOLLOW_UP',
  'CONTRACT_PENDING',
  'CLOSED',
  'DECLINED',
] as const;

export type LeadListCategory = (typeof leadListCategories)[number];

export const leadListsQuery = z
  .object({
    category: z.enum(leadListCategories).default('ALL'),
    owner: z.union([z.string().uuid(), z.literal('')]).default(''),
    search: z.string().trim().max(100).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();

const pageSize = 30;

interface LeadListRow {
  id: string;
  name: string;
  source: string;
  stage: string;
  consultation_status: string;
  owner_id: string | null;
  reserved_to: string | null;
  state: string;
  next_action: string;
}

const sqlCategory: Record<LeadListCategory, string> = {
  ALL: 'TRUE',
  NOT_SCHEDULED: "o.consultation_status IN ('UNDEFINED','NOT_SCHEDULED')",
  SCHEDULED: "o.consultation_status='SCHEDULED'",
  ATTENDED: "o.consultation_status='ATTENDED'",
  NO_SHOW: "o.consultation_status='NO_SHOW'",
  FOLLOW_UP: "o.stage='FOLLOW_UP'",
  CONTRACT_PENDING: "(o.stage='CONTRACT_PENDING' OR o.contract_status='awaiting')",
  CLOSED: "o.stage IN ('CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE')",
  DECLINED: "o.stage='DECLINED'",
};

function mongoCategory(category: LeadListCategory): Document {
  switch (category) {
    case 'NOT_SCHEDULED':
      return { consultation_status: { $in: ['UNDEFINED', 'NOT_SCHEDULED'] } };
    case 'SCHEDULED':
    case 'ATTENDED':
    case 'NO_SHOW':
      return { consultation_status: category };
    case 'FOLLOW_UP':
      return { stage: 'FOLLOW_UP' };
    case 'CONTRACT_PENDING':
      return { $or: [{ stage: 'CONTRACT_PENDING' }, { contract_status: 'awaiting' }] };
    case 'CLOSED':
      return { stage: { $in: ['CLOSED_WITH_DATE', 'CLOSED_WITHOUT_DATE'] } };
    case 'DECLINED':
      return { stage: 'DECLINED' };
    default:
      return {};
  }
}

function emptyCounts() {
  return Object.fromEntries(leadListCategories.map((category) => [category, 0])) as Record<
    LeadListCategory,
    number
  >;
}

function mongoCountGroup(): Document {
  const sumWhen = (condition: Document) => ({ $sum: { $cond: [condition, 1, 0] } });
  return {
    _id: null,
    ALL: { $sum: 1 },
    NOT_SCHEDULED: sumWhen({
      $in: ['$consultation_status', ['UNDEFINED', 'NOT_SCHEDULED']],
    }),
    SCHEDULED: sumWhen({ $eq: ['$consultation_status', 'SCHEDULED'] }),
    ATTENDED: sumWhen({ $eq: ['$consultation_status', 'ATTENDED'] }),
    NO_SHOW: sumWhen({ $eq: ['$consultation_status', 'NO_SHOW'] }),
    FOLLOW_UP: sumWhen({ $eq: ['$stage', 'FOLLOW_UP'] }),
    CONTRACT_PENDING: sumWhen({
      $or: [{ $eq: ['$stage', 'CONTRACT_PENDING'] }, { $eq: ['$contract_status', 'awaiting'] }],
    }),
    CLOSED: sumWhen({ $in: ['$stage', ['CLOSED_WITH_DATE', 'CLOSED_WITHOUT_DATE']] }),
    DECLINED: sumWhen({ $eq: ['$stage', 'DECLINED'] }),
  };
}

export async function leadListsPage(
  db: Database | MongoStore,
  user: User,
  query: z.infer<typeof leadListsQuery>,
) {
  const owner = user.role === 'manager' ? query.owner : user.id;
  if (db.kind === 'mongo') {
    const ownership: Document =
      user.role === 'manager' && owner
        ? { $or: [{ owner_id: owner }, { state: 'RESERVED', reserved_to: owner }] }
        : owner
          ? { owner_id: owner }
          : {};
    const ownershipStages: Document[] = Object.keys(ownership).length
      ? [{ $match: ownership }]
      : [];
    const contactStages: Document[] = [
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
    const searchStages: Document[] = [];
    if (query.search) {
      const literal = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      searchStages.push(...contactStages, {
        $match: {
          $or: [
            { 'contact.name': { $regex: literal, $options: 'i' } },
            { 'contact.phone': { $regex: literal, $options: 'i' } },
          ],
        },
      });
    }

    // Counting does not need to join contacts unless the user is searching. This
    // keeps the common, unfiltered refresh to one scan scoped to the visible owner.
    const countResult = await db
      .collection('opportunities')
      .aggregate<Record<string, number>>(
        [...ownershipStages, ...searchStages, { $group: mongoCountGroup() }],
        { maxTimeMS: 10_000 },
      )
      .next();
    const counts = emptyCounts();
    for (const category of leadListCategories)
      counts[category] = Number(countResult?.[category] ?? 0);
    const total = counts[query.category];
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
    const categoryFilter = mongoCategory(query.category);

    // Without a text search, filter, order and paginate before joining contacts.
    // At most 30 documents reach the lookup instead of the consultant's whole list.
    const rows = await db
      .collection('opportunities')
      .aggregate<LeadListRow>(
        [
          ...ownershipStages,
          ...searchStages,
          ...(Object.keys(categoryFilter).length ? [{ $match: categoryFilter }] : []),
          { $sort: { created_at: -1, id: -1 } },
          { $skip: (page - 1) * pageSize },
          { $limit: pageSize },
          ...(query.search ? [] : contactStages),
          {
            $project: {
              _id: 0,
              id: 1,
              name: '$contact.name',
              source: 1,
              stage: 1,
              consultation_status: 1,
              owner_id: 1,
              reserved_to: 1,
              state: 1,
              next_action: 1,
            },
          },
        ],
        { maxTimeMS: 10_000 },
      )
      .toArray();
    return { rows, counts, total, page, page_size: pageSize };
  }

  return db.transaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const ownership =
      user.role === 'manager'
        ? `($1='' OR o.owner_id::text=$1 OR (o.state='RESERVED' AND o.reserved_to::text=$1))`
        : 'o.owner_id::text=$1';
    const searchWhere = query.search
      ? ` AND (strpos(lower(c.name),lower($2))>0 OR strpos(COALESCE(c.phone,''),$2)>0)`
      : '';
    const where = `${ownership}${searchWhere}`;
    const countJoin = query.search ? 'JOIN contacts c ON c.id=o.contact_id' : '';
    const filterParams = query.search ? [owner, query.search] : [owner];
    const countRow = (
      await tx.query<Record<string, string>>(
        `SELECT
           count(*) AS "ALL",
           count(*) FILTER (WHERE ${sqlCategory.NOT_SCHEDULED}) AS "NOT_SCHEDULED",
           count(*) FILTER (WHERE ${sqlCategory.SCHEDULED}) AS "SCHEDULED",
           count(*) FILTER (WHERE ${sqlCategory.ATTENDED}) AS "ATTENDED",
           count(*) FILTER (WHERE ${sqlCategory.NO_SHOW}) AS "NO_SHOW",
           count(*) FILTER (WHERE ${sqlCategory.FOLLOW_UP}) AS "FOLLOW_UP",
           count(*) FILTER (WHERE ${sqlCategory.CONTRACT_PENDING}) AS "CONTRACT_PENDING",
           count(*) FILTER (WHERE ${sqlCategory.CLOSED}) AS "CLOSED",
           count(*) FILTER (WHERE ${sqlCategory.DECLINED}) AS "DECLINED"
         FROM opportunities o ${countJoin} WHERE ${where}`,
        filterParams,
      )
    ).rows[0];
    const counts = emptyCounts();
    for (const category of leadListCategories) counts[category] = Number(countRow[category] ?? 0);
    const total = counts[query.category];
    const page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
    const limitParameter = filterParams.length + 1;
    const rows = (
      await tx.query<LeadListRow>(
        `SELECT o.id,c.name,o.source,o.stage,o.consultation_status,
                o.owner_id,o.reserved_to,o.state,o.next_action
         FROM opportunities o JOIN contacts c ON c.id=o.contact_id
         WHERE ${where} AND (${sqlCategory[query.category]})
         ORDER BY o.created_at DESC,o.id DESC
         LIMIT $${limitParameter} OFFSET $${limitParameter + 1}`,
        [...filterParams, pageSize, (page - 1) * pageSize],
      )
    ).rows;
    return { rows, counts, total, page, page_size: pageSize };
  });
}
