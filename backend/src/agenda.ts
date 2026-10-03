import { z } from 'zod';
import type { Database } from './db.js';
import type { MongoStore } from './mongo-store.js';
import type { User } from './types.js';

const cursorSchema = z.object({ at: z.string().datetime(), id: z.string().uuid() });
export const agendaQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    cursor: z
      .string()
      .max(300)
      .optional()
      .transform((value, ctx) => {
        if (!value) return undefined;
        try {
          return cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Página inválida.' });
          return z.NEVER;
        }
      }),
  })
  .refine(
    ({ from, to }) =>
      Date.parse(to) > Date.parse(from) && Date.parse(to) - Date.parse(from) <= 93 * 86400000,
    'Selecione um período de até 93 dias.',
  );

interface AgendaRow {
  id: string;
  opportunity_id: string;
  starts_at: string | Date;
  unit: string;
  status: string;
  version: number;
  name: string;
  owner_id: string | null;
}

// Independent paginated read: no full agenda inside the periodic workspace/chat payload.
export async function agendaPage(
  db: Database | MongoStore,
  user: User,
  query: z.infer<typeof agendaQuery>,
) {
  const from = new Date(query.from),
    to = new Date(query.to),
    cursor = query.cursor;
  const rows =
    db.kind === 'mongo'
      ? await db
          .collection('appointments')
          .aggregate<AgendaRow>(
            [
              {
                $match: {
                  starts_at: { $gte: from, $lt: to },
                  ...(cursor
                    ? {
                        $or: [
                          { starts_at: { $gt: new Date(cursor.at) } },
                          { starts_at: new Date(cursor.at), id: { $gt: cursor.id } },
                        ],
                      }
                    : {}),
                },
              },
              { $sort: { starts_at: 1, id: 1 } },
              {
                $lookup: {
                  from: 'opportunities',
                  localField: 'opportunity_id',
                  foreignField: 'id',
                  as: 'opportunity',
                },
              },
              { $unwind: '$opportunity' },
              ...(user.role === 'manager' ? [] : [{ $match: { 'opportunity.owner_id': user.id } }]),
              { $limit: 51 },
              {
                $lookup: {
                  from: 'contacts',
                  localField: 'opportunity.contact_id',
                  foreignField: 'id',
                  as: 'contact',
                },
              },
              { $unwind: '$contact' },
              {
                $project: {
                  _id: 0,
                  id: 1,
                  opportunity_id: 1,
                  starts_at: 1,
                  unit: 1,
                  status: 1,
                  version: 1,
                  name: '$contact.name',
                  owner_id: '$opportunity.owner_id',
                },
              },
            ],
            { maxTimeMS: 10_000 },
          )
          .toArray()
      : (
          await db.query<AgendaRow>(
            `SELECT a.id,a.opportunity_id,a.starts_at,a.unit,a.status,a.version,c.name,o.owner_id
        FROM appointments a JOIN opportunities o ON o.id=a.opportunity_id JOIN contacts c ON c.id=o.contact_id
        WHERE ($1::boolean OR o.owner_id=$2) AND a.starts_at >= $3 AND a.starts_at < $4
          AND ($5::timestamptz IS NULL OR (a.starts_at,a.id)>($5::timestamptz,$6::uuid))
        ORDER BY a.starts_at,a.id LIMIT 51`,
            [user.role === 'manager', user.id, from, to, cursor?.at ?? null, cursor?.id ?? null],
          )
        ).rows;
  const items = rows.slice(0, 50);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      rows.length > 50 && last
        ? Buffer.from(
            JSON.stringify({ at: new Date(last.starts_at).toISOString(), id: last.id }),
          ).toString('base64url')
        : null,
  };
}
