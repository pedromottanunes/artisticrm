import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Sql } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import { lockActor } from './access.js';
import { DomainError, type User } from './types.js';
import type { ChannelIdentityInput } from './crm.js';

type Tx = Sql | MongoTx;
type Row = Record<string, any>;
type Table = 'instagram_prospects' | 'users' | 'opportunities' | 'audit_events';
const DAY = 86_400_000;
const collation = { locale: 'en', strength: 2 };

// Only fixed, internal table/column names are accepted by these helpers.
async function one(tx: Tx, table: Table, filter: Row): Promise<Row | null> {
  if (tx instanceof MongoTx) return tx.one(table, filter);
  return (
    (
      await tx.query<Row>(
        `SELECT * FROM ${table} WHERE ${Object.keys(filter)
          .map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`)
          .join(' AND ')} LIMIT 1`,
        Object.values(filter),
      )
    ).rows[0] ?? null
  );
}
async function insert(tx: Tx, table: Table, row: Row) {
  if (tx instanceof MongoTx) return tx.insert(table, row);
  await tx.query(
    `INSERT INTO ${table} (${Object.keys(row)
      .map((k) => `"${k}"`)
      .join(',')}) VALUES (${Object.keys(row)
      .map((_, i) => `$${i + 1}`)
      .join(',')})`,
    Object.values(row).map((value) =>
      value && typeof value === 'object' && !(value instanceof Date)
        ? JSON.stringify(value)
        : value,
    ),
  );
}
async function update(tx: Tx, table: Table, id: string, values: Row) {
  if (tx instanceof MongoTx) return tx.update(table, { id }, { $set: values });
  await tx.query(
    `UPDATE ${table} SET ${Object.keys(values)
      .map((k, i) => `"${k}"=$${i + 1}`)
      .join(',')} WHERE id=$${Object.keys(values).length + 1}`,
    [...Object.values(values), id],
  );
}

export function normalizeInstagramProfile(input: string): string {
  let value = input.trim();
  if (/^(?:https?:\/\/|(?:www\.|m\.)?instagram\.com\/)/i.test(value)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new DomainError('INVALID_PROFILE', 'Informe um @ ou link de perfil do Instagram.', 400);
    }
    if (
      !['instagram.com', 'www.instagram.com', 'm.instagram.com'].includes(
        url.hostname.toLowerCase(),
      ) ||
      url.username ||
      url.password ||
      url.port ||
      url.protocol !== 'https:'
    )
      throw new DomainError(
        'INVALID_PROFILE',
        'Use um link de perfil do Instagram com HTTPS.',
        400,
      );
    value = url.pathname.replace(/^\//, '').replace(/\/$/, '');
  } else value = value.replace(/^@/, '');
  value = value.toLowerCase();
  if (
    !/^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/.test(value) ||
    value.includes('..') ||
    [
      'p',
      'reel',
      'reels',
      'stories',
      'explore',
      'direct',
      'accounts',
      'about',
      'developer',
    ].includes(value)
  )
    throw new DomainError(
      'INVALID_PROFILE',
      'Informe o perfil, não um link de publicação ou Reels.',
      400,
    );
  return value;
}

export const prospectSchema = z
  .object({
    profile: z.string().trim().min(1).max(500),
    source: z.enum(['Curtida', 'Novo seguidor', 'Outra interação']).default('Outra interação'),
  })
  .strict();

export interface ProspectRouting {
  username?: string;
  unresolved?: boolean;
  receivedAt: string;
}

export interface ProspectDecision {
  reservation?: Row;
  ownerId?: string;
  review?: boolean;
}

export async function findProspect(tx: Tx, accountId: string, username: string) {
  return one(tx, 'instagram_prospects', {
    account_id: accountId,
    username: username.toLowerCase(),
  });
}

export function prospectBlocksComment(
  row: Row | null | undefined,
  userId: string,
  now: Date,
  senderId: string,
) {
  if (
    !row ||
    row.status === 'cancelled' ||
    (row.status === 'waiting' && new Date(row.expires_at) <= now)
  )
    return false;
  return (
    row.status === 'review' ||
    row.owner_id !== userId ||
    (row.external_user_id && row.external_user_id !== senderId)
  );
}

export async function transferProspects(tx: Tx, opportunityId: string, ownerId: string, now: Date) {
  // Move review records too, but only resolve reviews whose scoped ID belongs to this contact.
  if (tx instanceof MongoTx) {
    const lead = await tx.one('opportunities', { id: opportunityId });
    const rows = await tx.many('instagram_prospects', {
      opportunity_id: opportunityId,
      status: { $in: ['matched', 'review'] },
    });
    for (const row of rows) {
      const identity = row.external_user_id
        ? await tx.one('contact_identities', {
            provider: 'instagram',
            channel_account_id: row.account_id,
            external_user_id: row.external_user_id,
          })
        : null;
      await tx.update(
        'instagram_prospects',
        { id: row.id },
        {
          $set: {
            owner_id: ownerId,
            status: lead && identity?.contact_id === lead.contact_id ? 'matched' : 'review',
            updated_at: now,
          },
          $inc: { version: 1 },
        },
      );
    }
  } else
    await tx.query(
      `UPDATE instagram_prospects p SET owner_id=$2,updated_at=$3,version=version+1,
        status=CASE WHEN EXISTS (SELECT 1 FROM opportunities o JOIN contact_identities i ON i.contact_id=o.contact_id
          WHERE o.id=p.opportunity_id AND i.provider='instagram' AND i.channel_account_id=p.account_id AND i.external_user_id=p.external_user_id)
          THEN 'matched' ELSE 'review' END
        WHERE opportunity_id=$1 AND status IN ('matched','review')`,
      [opportunityId, ownerId, now],
    );
}

async function recordIdentityConflict(
  tx: Tx,
  row: Row,
  identity: ChannelIdentityInput,
  opportunityId: string,
  now: Date,
) {
  // Stable event ID keeps repeated messages/retries from multiplying the same conflict record.
  const hash = createHash('sha256')
    .update(JSON.stringify(['prospect-conflict', row.id, opportunityId, identity.external_user_id]))
    .digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  if (await one(tx, 'audit_events', { id })) return;
  await insert(tx, 'audit_events', {
    id,
    opportunity_id: opportunityId,
    actor_id: null,
    kind: 'prospect.identity_conflict',
    description:
      'Perfil com vínculo anterior ou identidade divergente. A reserva original foi preservada; a gestão deve revisar este atendimento.',
    details: {
      prospect_id: row.id,
      original_opportunity_id: row.opportunity_id ?? null,
      account_id: identity.account_id,
      sender_external_id: identity.external_user_id,
    },
    created_at: now,
  });
}

// Runs inside the same transaction as lead creation. It never accepts an owner from a client.
export async function decideProspect(
  tx: Tx,
  identity: ChannelIdentityInput | undefined,
  routing: ProspectRouting | undefined,
  now: Date,
): Promise<ProspectDecision> {
  if (!identity || identity.provider !== 'instagram' || !routing) return {};
  const reservation = routing.username
    ? await findProspect(tx, identity.account_id, routing.username)
    : null;
  if (!reservation || reservation.status === 'cancelled')
    return { review: routing.unresolved === true };
  if (new Date(reservation.created_at) > new Date(routing.receivedAt)) return {};
  const owner = await one(tx, 'users', { id: reservation.owner_id });
  const valid =
    reservation.status === 'waiting' &&
    new Date(reservation.expires_at) > now &&
    owner?.active &&
    owner.role === 'attendant' &&
    (!reservation.external_user_id || reservation.external_user_id === identity.external_user_id);
  return { reservation, ownerId: valid ? reservation.owner_id : undefined, review: !valid };
}

export async function finishProspect(
  tx: Tx,
  decision: ProspectDecision,
  identity: ChannelIdentityInput | undefined,
  opportunityId: string,
  ownerId: string | null,
  now: Date,
) {
  const row = decision.reservation;
  if (!row || !identity) return;
  const anotherLead = row.opportunity_id && row.opportunity_id !== opportunityId;
  const anotherIdentity =
    row.external_user_id &&
    row.external_user_id !== identity.external_user_id &&
    row.opportunity_id !== opportunityId;
  if (anotherLead || anotherIdentity) {
    await recordIdentityConflict(tx, row, identity, opportunityId, now);
    // A conflicting response cannot replace a confirmed lead/ID/owner. An unbound reservation
    // can require review, but must not point at the conflicting lead either.
    if (!row.opportunity_id && row.status !== 'review')
      await update(tx, 'instagram_prospects', row.id, {
        status: 'review',
        updated_at: now,
        version: row.version + 1,
      });
    return;
  }
  const matched =
    ownerId === row.owner_id &&
    (row.opportunity_id === opportunityId ||
      !row.external_user_id ||
      row.external_user_id === identity.external_user_id);
  if (matched && row.status === 'matched' && row.opportunity_id === opportunityId) return;
  await update(tx, 'instagram_prospects', row.id, {
    status: matched ? 'matched' : 'review',
    opportunity_id: opportunityId,
    external_user_id: row.external_user_id || identity.external_user_id,
    updated_at: now,
    version: row.version + 1,
  });
}

export class InstagramProspects {
  constructor(
    private db: Database | MongoStore,
    private accountId?: string,
  ) {}
  private account() {
    if (!this.accountId)
      throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
    return this.accountId;
  }
  private transaction<T>(work: (tx: Tx) => Promise<T>) {
    return this.db.kind === 'mongo'
      ? this.db.atomic(work)
      : this.db.transaction(async (tx) => {
          await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
          return work(tx);
        });
  }
  private async actor(tx: Tx, user: User) {
    if (!(tx instanceof MongoTx)) return lockActor(tx, user);
    const current = await one(tx, 'users', { id: user.id });
    if (
      !current?.active ||
      current.auth_version !== user.auth_version ||
      current.role !== user.role
    )
      throw new DomainError('UNAUTHENTICATED', 'Acesso revogado. Entre novamente.', 401);
    if (current.must_change_password)
      throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha para continuar.', 403);
    return current;
  }
  private async audit(tx: Tx, user: User, id: string, kind: string, now: Date) {
    await insert(tx, 'audit_events', {
      id: randomUUID(),
      opportunity_id: null,
      actor_id: user.id,
      kind,
      description: `Reserva de prospecção ${id}.`,
      created_at: now,
    });
  }
  async create(user: User, input: z.infer<typeof prospectSchema>) {
    const account = this.account();
    const username = normalizeInstagramProfile(input.profile);
    return this.transaction(async (tx) => {
      await this.actor(tx, user);
      if (user.role !== 'attendant')
        throw new DomainError(
          'FORBIDDEN',
          'A reserva deve ser cadastrada pelo consultor responsável.',
          403,
        );
      const now =
        tx instanceof MongoTx
          ? await tx.now()
          : new Date(
              (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now,
            );
      const prior = await findProspect(tx, account, username);
      if (
        prior &&
        prior.status !== 'cancelled' &&
        (prior.status !== 'waiting' || new Date(prior.expires_at) > now)
      ) {
        if (prior.owner_id !== user.id)
          throw new DomainError(
            'PROFILE_RESERVED',
            'Este perfil já possui uma reserva ou atendimento. Solicite revisão à gestão.',
          );
        return { id: prior.id, username, status: prior.status, duplicate: true };
      }
      // Existing known identities take precedence, even if the old reservation expired.
      const identities =
        tx instanceof MongoTx
          ? await tx
              .collection('contact_identities')
              .find(
                { provider: 'instagram', channel_account_id: account, username },
                { session: tx.session, collation },
              )
              .limit(2)
              .toArray()
          : (
              await tx.query<Row>(
                "SELECT * FROM contact_identities WHERE provider='instagram' AND channel_account_id=$1 AND lower(username)=$2 LIMIT 2",
                [account, username],
              )
            ).rows;
      if (identities.length > 1)
        throw new DomainError(
          'PROFILE_CONFLICT',
          'Perfil com identificação ambígua. Solicite revisão à gestão.',
        );
      const identity = identities[0];
      if (identity) {
        const lead = await one(tx, 'opportunities', { contact_id: identity.contact_id });
        if (lead)
          throw new DomainError(
            'PROFILE_EXISTS',
            'Este perfil já possui atendimento no CRM. Use a conversa existente ou solicite revisão à gestão.',
          );
      }
      const values = {
        account_id: account,
        username,
        owner_id: user.id,
        source: input.source,
        status: 'waiting',
        external_user_id: identity?.external_user_id ?? null,
        opportunity_id: null,
        created_at: now,
        updated_at: now,
        expires_at: new Date(now.getTime() + 30 * DAY),
        version: (prior?.version ?? 0) + 1,
      };
      const id = prior?.id ?? randomUUID();
      if (prior) await update(tx, 'instagram_prospects', id, values);
      else await insert(tx, 'instagram_prospects', { id, ...values });
      await this.audit(tx, user, id, 'prospect.reserved', now);
      return { id, username, status: 'waiting', duplicate: false };
    });
  }
  async list(user: User, before?: string) {
    if (!this.accountId) return { configured: false, items: [], next_cursor: null };
    const cursor = before ? z.string().max(80).parse(before).split('|') : undefined;
    if (
      cursor &&
      (cursor.length !== 2 ||
        !z.iso.datetime().safeParse(cursor[0]).success ||
        !z.uuid().safeParse(cursor[1]).success)
    )
      throw new DomainError('INVALID_CURSOR', 'Atualize a lista.', 400);
    const rows =
      this.db.kind === 'mongo'
        ? await this.db.many<Row>(
            'instagram_prospects',
            {
              account_id: this.accountId,
              ...(user.role !== 'manager' ? { owner_id: user.id } : {}),
              ...(cursor
                ? {
                    $or: [
                      { updated_at: { $lt: new Date(cursor[0]) } },
                      { updated_at: new Date(cursor[0]), id: { $lt: cursor[1] } },
                    ],
                  }
                : {}),
            },
            { updated_at: -1, id: -1 },
            31,
          )
        : (
            await this.db.query<Row>(
              'SELECT * FROM instagram_prospects WHERE account_id=$1 AND ($2::uuid IS NULL OR owner_id=$2) AND ($3::timestamptz IS NULL OR (updated_at,id)<($3::timestamptz,$4::uuid)) ORDER BY updated_at DESC,id DESC LIMIT 31',
              [
                this.accountId,
                user.role === 'manager' ? null : user.id,
                cursor?.[0] ?? null,
                cursor?.[1] ?? null,
              ],
            )
          ).rows;
    return {
      configured: true,
      items: rows.slice(0, 30).map((row) => ({
        id: row.id,
        username: row.username,
        owner_id: row.owner_id,
        status:
          row.status === 'waiting' && new Date(row.expires_at) <= new Date()
            ? 'expired'
            : row.status,
        source: row.source,
        expires_at: row.expires_at,
        version: row.version,
        opportunity_id: row.opportunity_id,
      })),
      next_cursor:
        rows.length > 30 ? `${new Date(rows[29].updated_at).toISOString()}|${rows[29].id}` : null,
    };
  }
  async cancel(user: User, id: string, version: number) {
    this.account();
    return this.transaction(async (tx) => {
      await this.actor(tx, user);
      const row = await one(tx, 'instagram_prospects', { id, account_id: this.accountId });
      if (!row || (user.role !== 'manager' && row.owner_id !== user.id))
        throw new DomainError('NOT_FOUND', 'Reserva não encontrada.', 404);
      if (row.version !== version || row.status === 'matched')
        throw new DomainError(
          'PROSPECT_CHANGED',
          'A reserva mudou ou já virou atendimento. Atualize a lista.',
        );
      if (row.status === 'review' && user.role !== 'manager')
        throw new DomainError('FORBIDDEN', 'A gestão deve revisar esta reserva.', 403);
      const now = new Date();
      await update(tx, 'instagram_prospects', id, {
        status: 'cancelled',
        updated_at: now,
        version: row.version + 1,
      });
      await this.audit(tx, user, id, 'prospect.cancelled', now);
      return { ok: true };
    });
  }
  async hasReservationsToResolve() {
    if (!this.accountId) return false;
    const now = new Date();
    if (this.db.kind === 'mongo')
      return !!(await this.db.collection('instagram_prospects').findOne(
        {
          account_id: this.accountId,
          status: { $in: ['waiting', 'matched', 'review'] },
          expires_at: { $gt: now },
        },
        { projection: { _id: 1 } },
      ));
    return !!(
      await this.db.query(
        "SELECT id FROM instagram_prospects WHERE account_id=$1 AND status IN ('waiting','matched','review') AND expires_at>$2 LIMIT 1",
        [this.accountId, now],
      )
    ).rows.length;
  }
}
