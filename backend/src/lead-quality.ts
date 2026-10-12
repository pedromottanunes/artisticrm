import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import { lockActor } from './access.js';
import { DomainError, type Opportunity, type User } from './types.js';
import type { WeightedQueueParticipant, WeightedQueueSelection } from './weighted-queue.js';

export const nonCommercialReasons = [
  'ADVERTISING',
  'JOB_SEEKER',
  'NON_COMMERCIAL_MENTION',
  'POLITICAL_VIDEO',
] as const;
export const reasonLabels: Record<string, string> = {
  ADVERTISING: 'Vendas e propagandas',
  JOB_SEEKER: 'Procura de emprego',
  NON_COMMERCIAL_MENTION: 'Marcação não comercial da clínica',
  POLITICAL_VIDEO: 'Vídeos políticos',
};
export const qualityInput = z
  .object({
    reason: z.enum(nonCommercialReasons).nullable(),
    expected_version: z.number().int().positive(),
  })
  .strict();
type Tx = Sql | MongoTx;
type Compensation = {
  source_opportunity_id: string;
  user_id: string;
  status: 'pending' | 'used' | 'revoked';
  replacement_opportunity_id: string | null;
};

export function earnsCompensation(row: Opportunity) {
  return (
    row.claim_mode === 'reservation' &&
    row.accepted_by === row.owner_id &&
    ['rotation', 'compensation'].includes(row.reservation_origin ?? '')
  );
}
export function assertCommercial(row: Pick<Opportunity, 'non_commercial_reason'>) {
  if (row.non_commercial_reason)
    throw new DomainError(
      'NON_COMMERCIAL',
      'Este contato está classificado como não comercial. A gestão pode restaurá-lo antes de retomar o atendimento.',
    );
}
async function compensation(tx: Tx, id: string) {
  return tx instanceof MongoTx
    ? tx.one<Compensation>('lead_compensations', { source_opportunity_id: id })
    : ((
        await tx.query<Compensation>(
          'SELECT * FROM lead_compensations WHERE source_opportunity_id=$1',
          [id],
        )
      ).rows[0] ?? null);
}
export async function qualityDetails(db: Database | MongoStore, row: Opportunity, user: User) {
  const credit = await compensation(db, row.id);
  const author = row.non_commercial_by
    ? db.kind === 'mongo'
      ? await db.one<{ name: string }>('users', { id: row.non_commercial_by })
      : (
          await db.query<{ name: string }>('SELECT name FROM users WHERE id=$1', [
            row.non_commercial_by,
          ])
        ).rows[0]
    : null;
  return {
    id: row.id,
    version: row.version,
    reason: row.non_commercial_reason ?? null,
    marked_by_name: author?.name ?? null,
    marked_by: row.non_commercial_by ?? null,
    marked_at: row.non_commercial_at ?? null,
    can_mark: row.state === 'CLAIMED' && (user.role === 'manager' || row.owner_id === user.id),
    can_restore: user.role === 'manager',
    will_compensate:
      !row.non_commercial_reason &&
      !credit &&
      earnsCompensation(row) &&
      row.owner_id === user.id &&
      user.role === 'attendant',
    compensation_status: credit?.status ?? null,
    replacement_opportunity_id: credit?.replacement_opportunity_id ?? null,
  };
}

// Both stores run this command under the same queue write lock used by ingestion.
export async function setLeadQuality(
  db: Database | MongoStore,
  actor: User,
  id: string,
  input: z.infer<typeof qualityInput>,
  clock?: () => Promise<Date>,
) {
  const work = async (tx: Tx) => {
    let current: User | null;
    if (tx instanceof MongoTx) {
      current = await tx.one<User>('users', { id: actor.id });
      if (
        !current?.active ||
        current.auth_version !== actor.auth_version ||
        current.role !== actor.role
      )
        throw new DomainError('UNAUTHENTICATED', 'Acesso revogado. Entre novamente.', 401);
      if (current.must_change_password)
        throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha para continuar.', 403);
    } else {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      current = await lockActor(tx, actor);
    }
    const row =
      tx instanceof MongoTx
        ? await tx.one<Opportunity>('opportunities', { id })
        : (await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]))
            .rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
    if (current.role !== 'manager' && row.owner_id !== current.id)
      throw new DomainError('FORBIDDEN', 'Este lead não pertence a você.', 403);
    if (input.reason === null && current.role !== 'manager')
      throw new DomainError('FORBIDDEN', 'Somente a gestão pode restaurar um contato.', 403);
    let credit = await compensation(tx, id);
    // Natural retry: the same classification has already been committed. No new audit or credit.
    if ((row.non_commercial_reason ?? null) === input.reason)
      return {
        id,
        version: row.version,
        reason: input.reason,
        compensation_status: credit?.status ?? null,
      };
    if (row.version !== input.expected_version)
      throw new DomainError('VERSION_CONFLICT', 'O lead mudou. Atualize e tente novamente.');
    if (row.state !== 'CLAIMED')
      throw new DomainError('NOT_CLAIMED', 'Assuma o lead antes de aplicar um selo.');
    const booked =
      tx instanceof MongoTx
        ? await tx.one('appointments', {
            opportunity_id: id,
            status: { $in: ['scheduled', 'attended', 'no_show'] },
          })
        : (
            await tx.query(
              "SELECT id FROM appointments WHERE opportunity_id=$1 AND status IN ('scheduled','attended','no_show') LIMIT 1",
              [id],
            )
          ).rows[0];
    if (input.reason && (row.sale_completed_at || booked))
      throw new DomainError(
        'COMMERCIAL_ACTIVITY',
        'Há consulta ou venda registrada. Corrija esse registro antes de classificar como não comercial.',
      );
    const now = clock
      ? await clock()
      : tx instanceof MongoTx
        ? await tx.now()
        : new Date(
            (await tx.query<{ now: string }>('SELECT clock_timestamp() AS now')).rows[0].now,
          );
    const values = {
      non_commercial_reason: input.reason,
      non_commercial_by: input.reason ? current.id : null,
      non_commercial_at: input.reason ? now : null,
    };
    if (tx instanceof MongoTx)
      await tx.update('opportunities', { id }, { $set: values, $inc: { version: 1 } });
    else
      await tx.query(
        'UPDATE opportunities SET non_commercial_reason=$2,non_commercial_by=$3,non_commercial_at=$4,version=version+1 WHERE id=$1',
        [id, values.non_commercial_reason, values.non_commercial_by, values.non_commercial_at],
      );
    if (
      input.reason &&
      !row.non_commercial_reason &&
      !credit &&
      current.role === 'attendant' &&
      earnsCompensation(row)
    ) {
      credit = {
        source_opportunity_id: id,
        user_id: current.id,
        status: 'pending',
        replacement_opportunity_id: null,
      };
      if (tx instanceof MongoTx)
        await tx.insert('lead_compensations', { ...credit, created_at: now, used_at: null });
      else
        await tx.query(
          "INSERT INTO lead_compensations(source_opportunity_id,user_id,status,created_at) VALUES($1,$2,'pending',$3)",
          [id, current.id, now],
        );
    }
    if (!input.reason && credit?.status === 'pending') {
      if (tx instanceof MongoTx)
        await tx.update(
          'lead_compensations',
          { source_opportunity_id: id },
          { $set: { status: 'revoked' } },
        );
      else
        await tx.query(
          "UPDATE lead_compensations SET status='revoked' WHERE source_opportunity_id=$1",
          [id],
        );
      credit.status = 'revoked';
    }
    if (input.reason) {
      if (tx instanceof MongoTx) {
        const identities = await tx.many('contact_identities', {
          contact_id: row.contact_id,
          provider: 'instagram',
        });
        for (const identity of identities)
          await tx.update(
            'instagram_comments',
            {
              account_id: identity.channel_account_id,
              sender_id: identity.external_user_id,
              opportunity_id: null,
            },
            {
              $set: { ignored: true, opportunity_id: id, claimed_by: row.owner_id },
              $inc: { version: 1 },
            },
          );
      } else
        await tx.query(
          `UPDATE instagram_comments c SET ignored=true,opportunity_id=$1,claimed_by=$2,version=version+1 WHERE c.opportunity_id IS NULL AND EXISTS(SELECT 1 FROM contact_identities i WHERE i.contact_id=$3 AND i.provider='instagram' AND i.channel_account_id=c.account_id AND i.external_user_id=c.sender_id)`,
          [id, row.owner_id, row.contact_id],
        );
      if (tx instanceof MongoTx)
        await tx.remove('push_records', {
          kind: { $in: ['event', 'job'] },
          $or: [{ 'data.opportunityId': id }, { 'data.event.data.opportunityId': id }],
        });
      else
        await tx.query(
          "DELETE FROM push_records WHERE kind IN ('event','job') AND (data->>'opportunityId'=$1 OR data->'event'->'data'->>'opportunityId'=$1)",
          [id],
        );
    }
    const event = {
      id: randomUUID(),
      opportunity_id: id,
      actor_id: current.id,
      kind: input.reason ? 'lead.non_commercial' : 'lead.restored',
      description: input.reason
        ? `Não comercial: ${reasonLabels[input.reason]}. Marcado por ${current.name}.`
        : `Atendimento restaurado por ${current.name}.`,
      created_at: now,
      details: {
        previous_reason: row.non_commercial_reason ?? null,
        reason: input.reason,
        compensation_status: credit?.status ?? null,
      },
    };
    if (tx instanceof MongoTx) await tx.insert('audit_events', event);
    else
      await tx.query(
        'INSERT INTO audit_events(id,opportunity_id,actor_id,kind,description,created_at,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          event.id,
          id,
          current.id,
          event.kind,
          event.description,
          now,
          JSON.stringify(event.details),
        ],
      );
    return {
      id,
      version: row.version + 1,
      reason: input.reason,
      compensation_status: credit?.status ?? null,
    };
  };
  return db.kind === 'mongo' ? db.atomic(work) : db.transaction(work);
}

export async function nextCompensation<T extends WeightedQueueParticipant>(
  tx: Tx,
  users: T[],
): Promise<(WeightedQueueSelection<T> & { compensationId: string }) | undefined> {
  const eligible = users.filter(
    (u) => u.queue_position !== null && u.queue_weight >= 1 && u.queue_weight <= 5,
  );
  const ids = eligible.map((u) => u.id);
  if (!ids.length) return;
  const credit =
    tx instanceof MongoTx
      ? (
          await tx.many<Compensation>(
            'lead_compensations',
            { status: 'pending', user_id: { $in: ids } },
            { created_at: 1, source_opportunity_id: 1 },
            1,
          )
        )[0]
      : (
          await tx.query<Compensation>(
            "SELECT * FROM lead_compensations WHERE status='pending' AND user_id=ANY($1::uuid[]) ORDER BY created_at,source_opportunity_id LIMIT 1",
            [ids],
          )
        ).rows[0];
  if (!credit) return;
  return {
    selected: eligible.find((u) => u.id === credit.user_id)!,
    compensationId: credit.source_opportunity_id,
    credits: new Map(),
    totalWeight: eligible.reduce((sum, u) => sum + u.queue_weight, 0),
  };
}
export async function useCompensation(
  tx: Tx,
  source: string | undefined,
  replacement: string,
  now: Date,
) {
  if (!source) return;
  if (tx instanceof MongoTx)
    await tx.update(
      'lead_compensations',
      { source_opportunity_id: source, status: 'pending' },
      { $set: { status: 'used', replacement_opportunity_id: replacement, used_at: now } },
    );
  else
    await tx.query(
      "UPDATE lead_compensations SET status='used',replacement_opportunity_id=$2,used_at=$3 WHERE source_opportunity_id=$1 AND status='pending'",
      [source, replacement, now],
    );
}

export async function compensationOrder(tx: Tx, users: WeightedQueueParticipant[]) {
  const ids = users.filter((user) => user.queue_position !== null).map((user) => user.id);
  if (!ids.length) return [];
  const rows =
    tx instanceof MongoTx
      ? await tx
          .collection('lead_compensations')
          .aggregate<{ user_id: string }>(
            [
              { $match: { status: 'pending', user_id: { $in: ids } } },
              { $sort: { created_at: 1, source_opportunity_id: 1 } },
              { $project: { _id: 0, user_id: 1 } },
            ],
            { session: tx.session },
          )
          .toArray()
      : (
          await tx.query<{ user_id: string }>(
            `SELECT user_id FROM lead_compensations
    WHERE status='pending' AND user_id=ANY($1::uuid[]) ORDER BY created_at,source_opportunity_id`,
            [ids],
          )
        ).rows;
  return rows.map((row) => row.user_id);
}
