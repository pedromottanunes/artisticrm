import { Binary } from 'mongodb';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import { lockActor } from './access.js';
import { DomainError, type Opportunity, type User } from './types.js';

export type CommercialDb = Database | MongoStore;
export type CommercialTx = Sql | MongoTx;
export type RecordKind =
  'case' | 'evidence' | 'job' | 'payment' | 'contract' | 'audit' | 'command' | 'extraction';
export interface CommercialRecord<T = Record<string, any>> {
  id: string;
  opportunity_id: string;
  kind: RecordKind;
  created_at: string;
  updated_at: string;
  data: T;
}
export const fingerprint = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export async function commercialTransaction<T>(
  db: CommercialDb,
  work: (tx: CommercialTx) => Promise<T>,
) {
  // Deliberately not MongoStore.atomic(): document work never touches the queue fence.
  if (db.kind === 'mongo')
    return db.client.withSession((session) =>
      session.withTransaction(() => work(new MongoTx(db.database, session)), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
        maxCommitTimeMS: 15_000,
      }),
    );
  return db.transaction(work);
}
export async function commercialAccess(
  tx: CommercialTx,
  id: string,
  actor: User | null,
  write = false,
  allowNonCommercial = false,
) {
  if (actor) {
    if (tx instanceof MongoTx) {
      const user = await tx.one<User>('users', { id: actor.id });
      if (!user?.active || user.auth_version !== actor.auth_version || user.role !== actor.role)
        throw new DomainError('UNAUTHENTICATED', 'Acesso revogado. Entre novamente.', 401);
      if (user.must_change_password)
        throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha.', 403);
      // A real write conflicts with concurrent deactivation without changing public versions.
      if (write) await tx.update('users', { id: actor.id }, { $inc: { commercial_guard: 1 } });
    } else await lockActor(tx, actor);
  }
  const row =
    tx instanceof MongoTx
      ? await tx.one<Opportunity>('opportunities', { id })
      : (
          await tx.query<Opportunity>(
            `SELECT o.*,c.name FROM opportunities o JOIN contacts c ON c.id=o.contact_id WHERE o.id=$1 ${write ? 'FOR UPDATE OF o' : ''}`,
            [id],
          )
        ).rows[0];
  if (!row || (actor && actor.role !== 'manager' && row.owner_id !== actor.id))
    throw new DomainError('NOT_FOUND', 'Paciente não encontrado.', 404);
  if (row.non_commercial_reason && !allowNonCommercial)
    throw new DomainError('NON_COMMERCIAL', 'Cadastro não comercial.', 409);
  if (tx instanceof MongoTx) {
    if (write) await tx.update('opportunities', { id }, { $inc: { commercial_guard: 1 } });
    row.name = (await tx.one<{ name: string }>('contacts', { id: row.contact_id }))?.name ?? '';
  }
  return row;
}
export async function getCommercial<T = Record<string, any>>(tx: CommercialTx, id: string) {
  return tx instanceof MongoTx
    ? tx.one<CommercialRecord<T>>('commercial_records', { id })
    : ((await tx.query<CommercialRecord<T>>('SELECT * FROM commercial_records WHERE id=$1', [id]))
        .rows[0] ?? null);
}
export async function caseRecords(tx: CommercialTx, id: string, kind?: RecordKind) {
  // Frequent polling/recalculation never loads unbounded command receipts or AI history.
  return tx instanceof MongoTx
    ? tx.many<CommercialRecord>(
        'commercial_records',
        {
          opportunity_id: id,
          kind: kind ?? { $in: ['case', 'evidence', 'job', 'payment', 'contract'] },
        },
        { created_at: 1, id: 1 },
      )
    : (
        await tx.query<CommercialRecord>(
          `SELECT * FROM commercial_records WHERE opportunity_id=$1 ${kind ? 'AND kind=$2' : "AND kind IN ('case','evidence','job','payment','contract')"} ORDER BY created_at,id`,
          kind ? [id, kind] : [id],
        )
      ).rows;
}
export async function commercialHistory(tx: CommercialTx, id: string) {
  return tx instanceof MongoTx
    ? tx.many<CommercialRecord>(
        'commercial_records',
        { opportunity_id: id, kind: 'audit' },
        { created_at: -1, id: -1 },
        50,
      )
    : (
        await tx.query<CommercialRecord>(
          "SELECT * FROM commercial_records WHERE opportunity_id=$1 AND kind='audit' ORDER BY created_at DESC,id DESC LIMIT 50",
          [id],
        )
      ).rows;
}

// The first sale event is immutable, unlike current ownership or the first upload.
// Legacy sales authored by an attendant are attributable because recordSale enforces
// ownership. A legacy manager-authored sale without a snapshot stays unidentified;
// never guess from free-text names, metrics ownership or a later transfer.
export async function commercialBeneficiaries(tx: CommercialTx, ids: string[]) {
  const result = new Map<string, string | null>();
  if (!ids.length) return result;
  type SaleEvent = {
    opportunity_id: string;
    actor_id: string | null;
    details: { beneficiary_id?: string | null };
  };
  const events =
    tx instanceof MongoTx
      ? await tx.many<SaleEvent>(
          'audit_events',
          {
            opportunity_id: { $in: ids },
            kind: 'sale.completed',
          },
          { created_at: 1, id: 1 },
        )
      : (
          await tx.query<SaleEvent>(
            "SELECT opportunity_id,actor_id,details FROM audit_events WHERE opportunity_id=ANY($1::uuid[]) AND kind='sale.completed' ORDER BY created_at,id",
            [ids],
          )
        ).rows;
  const legacyActors = [
    ...new Set(
      events
        .filter((e) => !Object.hasOwn(e.details ?? {}, 'beneficiary_id') && e.actor_id)
        .map((e) => e.actor_id!),
    ),
  ];
  const attendants = new Set(
    legacyActors.length
      ? (tx instanceof MongoTx
          ? await tx.many<{ id: string }>('users', { id: { $in: legacyActors }, role: 'attendant' })
          : (
              await tx.query<{ id: string }>(
                "SELECT id FROM users WHERE id=ANY($1::uuid[]) AND role='attendant'",
                [legacyActors],
              )
            ).rows
        ).map((u) => u.id)
      : [],
  );
  for (const event of events) {
    if (result.has(event.opportunity_id)) continue;
    result.set(
      event.opportunity_id,
      Object.hasOwn(event.details ?? {}, 'beneficiary_id')
        ? (event.details.beneficiary_id ?? null)
        : event.actor_id && attendants.has(event.actor_id)
          ? event.actor_id
          : null,
    );
  }
  return result;
}
export async function saveCommercial(tx: CommercialTx, row: CommercialRecord) {
  if (tx instanceof MongoTx)
    await tx
      .collection('commercial_records')
      .replaceOne({ id: row.id }, row, { upsert: true, session: tx.session });
  else
    await tx.query(
      `INSERT INTO commercial_records(id,opportunity_id,kind,created_at,updated_at,data)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET updated_at=$5,data=$6`,
      [
        row.id,
        row.opportunity_id,
        row.kind,
        row.created_at,
        row.updated_at,
        JSON.stringify(row.data),
      ],
    );
}
export function newCommercial(
  opportunity_id: string,
  kind: RecordKind,
  data: Record<string, any>,
  now: string,
  id: string = randomUUID(),
): CommercialRecord {
  return { id, opportunity_id, kind, data, created_at: now, updated_at: now };
}
export async function saveCommercialFile(
  tx: CommercialTx,
  id: string,
  opportunityId: string,
  bytes: Buffer,
) {
  if (tx instanceof MongoTx)
    await tx.insert('commercial_files', {
      id,
      opportunity_id: opportunityId,
      content: new Binary(bytes),
    });
  else
    await tx.query('INSERT INTO commercial_files(id,opportunity_id,content) VALUES($1,$2,$3)', [
      id,
      opportunityId,
      bytes,
    ]);
}
export async function readCommercialFile(
  tx: CommercialTx,
  id: string,
  opportunityId: string,
): Promise<Buffer> {
  if (tx instanceof MongoTx) {
    const row = await tx.one<{ content: Binary | Buffer }>('commercial_files', {
      id,
      opportunity_id: opportunityId,
    });
    if (row) return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content.value());
  } else {
    const row = (
      await tx.query<{ content: Uint8Array }>(
        'SELECT content FROM commercial_files WHERE id=$1 AND opportunity_id=$2',
        [id, opportunityId],
      )
    ).rows[0];
    if (row) return Buffer.from(row.content);
  }
  throw new DomainError('DOCUMENT_NOT_FOUND', 'Documento indisponível.', 404);
}
export async function transactionUsed(tx: CommercialTx, key: string, exceptId: string) {
  return tx instanceof MongoTx
    ? !!(await tx.one('commercial_records', {
        id: { $ne: exceptId },
        kind: 'payment',
        'data.status': 'confirmed',
        'data.transaction_key': key,
      }))
    : !!(
        await tx.query(
          `SELECT id FROM commercial_records WHERE id<>$1 AND kind='payment' AND data->>'status'='confirmed' AND data->>'transaction_key'=$2 LIMIT 1`,
          [exceptId, key],
        )
      ).rows.length;
}
export async function paymentClaimed(tx: CommercialTx, keys: string[], paymentId: string) {
  return tx instanceof MongoTx
    ? !!(await tx.one('commercial_payment_claims', {
        id: { $in: keys },
        payment_id: { $ne: paymentId },
      }))
    : !!(
        await tx.query(
          'SELECT id FROM commercial_payment_claims WHERE id=ANY($1::text[]) AND payment_id<>$2 LIMIT 1',
          [keys, paymentId],
        )
      ).rows.length;
}
export async function claimPayment(
  tx: CommercialTx,
  keys: string[],
  paymentId: string,
  opportunityId: string,
) {
  // Unique claims serialize different patients too; a check-then-insert alone is racy.
  for (const key of [...new Set(keys)].sort()) {
    if (tx instanceof MongoTx)
      await tx
        .collection('commercial_payment_claims')
        .updateOne(
          { id: key },
          { $setOnInsert: { id: key, payment_id: paymentId, opportunity_id: opportunityId } },
          { upsert: true, session: tx.session },
        );
    else
      await tx.query(
        'INSERT INTO commercial_payment_claims(id,payment_id,opportunity_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [key, paymentId, opportunityId],
      );
  }
  if (await paymentClaimed(tx, keys, paymentId))
    throw new DomainError(
      'DUPLICATE_PAYMENT',
      'Este comprovante ou transação já foi contabilizado. Solicite revisão.',
      409,
    );
}
export async function releasePaymentClaims(tx: CommercialTx, paymentId: string) {
  if (tx instanceof MongoTx)
    await tx.remove('commercial_payment_claims', { payment_id: paymentId });
  else await tx.query('DELETE FROM commercial_payment_claims WHERE payment_id=$1', [paymentId]);
}
