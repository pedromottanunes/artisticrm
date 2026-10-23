import { z } from 'zod';
import { MongoTx } from './mongo-store.js';
import { lockActor } from './access.js';
import { DomainError, type User } from './types.js';
import {
  commercialBeneficiaries,
  commercialTransaction,
  type CommercialDb,
} from './commercial-store.js';
import { assessCommercial, saoPauloDate } from './commercial-domain.js';

export const commercialListQuery = z
  .object({
    owner: z.union([z.string().uuid(), z.literal('')]).default(''),
    status: z.enum(['all', 'pending', 'eligible']).default('pending'),
    period: z.union([z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), z.literal('')]).default(''),
    page: z.coerce.number().int().min(1).max(100000).default(1),
  })
  .strict();
export async function commercialList(
  db: CommercialDb,
  actor: User,
  query: z.infer<typeof commercialListQuery>,
  now = new Date(),
) {
  return commercialTransaction(db, async (tx) => {
    const owner = actor.role === 'manager' ? query.owner : actor.id;
    if (tx instanceof MongoTx) {
      const user = await tx.one<User>('users', { id: actor.id });
      if (!user?.active || user.auth_version !== actor.auth_version || user.role !== actor.role)
        throw new DomainError('UNAUTHENTICATED', 'Entre novamente.', 401);
      if (user.must_change_password)
        throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha.', 403);
    } else await lockActor(tx, actor);
    const pageSize = 20;
    let rows: any[], total: number, page: number;
    if (tx instanceof MongoTx) {
      const pipeline: any[] = [
        { $match: { non_commercial_reason: null, ...(owner ? { owner_id: owner } : {}) } },
        {
          $lookup: {
            from: 'commercial_records',
            localField: 'id',
            foreignField: 'opportunity_id',
            pipeline: [{ $match: { kind: 'case' } }],
            as: 'commercial',
          },
        },
        { $unwind: { path: '$commercial', preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [{ sale_completed_at: { $ne: null } }, { 'commercial.kind': 'case' }],
          },
        },
        {
          $set: {
            eligible: {
              $and: [
                { $eq: [{ $ifNull: ['$commercial.data.assessment.eligible', false] }, true] },
                { $ne: [{ $ifNull: ['$sale_completed_at', null] }, null] },
              ],
            },
          },
        },
        ...(query.status === 'all' ? [] : [{ $match: { eligible: query.status === 'eligible' } }]),
        ...(query.period
          ? [{ $match: { 'commercial.data.assessment.commission_period': query.period } }]
          : []),
      ];
      const count = await tx
        .collection('opportunities')
        .aggregate([...pipeline, { $count: 'total' }], { session: tx.session })
        .next();
      total = count?.total ?? 0;
      page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
      rows = await tx
        .collection('opportunities')
        .aggregate(
          [
            ...pipeline,
            {
              $set: {
                sort_at: { $toDate: { $ifNull: ['$commercial.updated_at', '$sale_completed_at'] } },
              },
            },
            { $sort: { sort_at: -1, id: 1 } },
            { $skip: (page - 1) * pageSize },
            { $limit: pageSize },
            {
              $lookup: {
                from: 'contacts',
                localField: 'contact_id',
                foreignField: 'id',
                as: 'contact',
              },
            },
            {
              $project: {
                _id: 0,
                id: 1,
                name: { $arrayElemAt: ['$contact.name', 0] },
                owner_id: 1,
                assessment: '$commercial.data.assessment',
                sale_registered: {
                  $ne: [{ $ifNull: ['$sale_completed_at', null] }, null],
                },
                eligible: 1,
              },
            },
          ],
          { session: tx.session },
        )
        .toArray();
    } else {
      const eligible = `(r.data->'assessment'->>'eligible'='true' AND o.sale_completed_at IS NOT NULL)`;
      const where = `(r.id IS NOT NULL OR o.sale_completed_at IS NOT NULL) AND o.non_commercial_reason IS NULL AND ($1='' OR o.owner_id::text=$1)
        AND ($2='all' OR ($2='eligible' AND ${eligible}) OR ($2='pending' AND NOT COALESCE(${eligible},false)))
        AND ($3='' OR r.data->'assessment'->>'commission_period'=$3)`;
      const params = [owner, query.status, query.period];
      total = Number(
        (
          await tx.query<{ total: string }>(
            `SELECT count(*) AS total FROM opportunities o
        LEFT JOIN commercial_records r ON r.opportunity_id=o.id AND r.kind='case' WHERE ${where}`,
            params,
          )
        ).rows[0].total,
      );
      page = Math.min(query.page, Math.max(1, Math.ceil(total / pageSize)));
      rows = (
        await tx.query(
          `SELECT o.id,c.name,o.owner_id,
        r.data->'assessment' AS assessment,o.sale_completed_at IS NOT NULL AS sale_registered,COALESCE(${eligible},false) AS eligible
        FROM opportunities o LEFT JOIN commercial_records r ON r.opportunity_id=o.id AND r.kind='case' JOIN contacts c ON c.id=o.contact_id
        WHERE ${where} ORDER BY COALESCE(r.updated_at,o.sale_completed_at) DESC,o.id LIMIT $4 OFFSET $5`,
          [...params, pageSize, (page - 1) * pageSize],
        )
      ).rows;
    }
    const beneficiaries = await commercialBeneficiaries(
      tx,
      rows.map((row) => row.id),
    );
    const emptyAssessment = assessCommercial({
      payments: [],
      contract: null,
      sale_registered: true,
      today: saoPauloDate(now),
    });
    return {
      enabled: true,
      page,
      page_size: pageSize,
      total,
      rows: rows.map((row) => ({
        ...row,
        beneficiary_id: beneficiaries.get(row.id) ?? null,
        assessment: {
          ...(row.assessment ?? emptyAssessment),
          eligible: row.eligible,
          reasons: [
            ...(row.assessment?.reasons ?? emptyAssessment.reasons),
            ...(!row.sale_registered ? ['SALE_NOT_REGISTERED'] : []),
          ],
          commission_period: row.eligible ? row.assessment?.commission_period : null,
          expected_payment_on: row.eligible ? row.assessment?.expected_payment_on : null,
        },
      })),
    };
  });
}
