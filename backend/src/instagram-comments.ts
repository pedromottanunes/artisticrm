import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Sql } from './db.js';
import { MongoTx, type MongoStore } from './mongo-store.js';
import { DomainError, isClosedStage, type User } from './types.js';
import type { InstagramConfig, InstagramFetch } from './instagram.js';
import { enqueuePushEvent, putPush } from './push-store.js';
import { wasDeleted } from './lead-deletion.js';
import { findProspect, finishProspect, prospectBlocksComment } from './instagram-prospects.js';

const DAY = 86_400_000;
const privateReplyReceiptSchema = z.object({
  account_id: z.string().min(1).max(512),
  recipient_id: z.string().min(1).max(512),
  message_id: z.string().min(1).max(512),
  confirmed_at: z.string().datetime(),
});
export const commentChangeSchema = z.object({
  field: z.literal('comments'),
  value: z.object({
    id: z.string().regex(/^\d+$/).max(100),
    from: z.object({
      id: z.string().regex(/^\d+$/).max(100),
      username: z.string().max(100).optional(),
    }),
    text: z.string().max(10_000).default(''),
    media: z.object({ id: z.string().regex(/^\d+$/).max(100) }).optional(),
  }),
});
const cursorSchema = z
  .string()
  .max(80)
  .refine((value) => {
    const [date, id, extra] = value.split('|');
    return !extra && z.iso.datetime().safeParse(date).success && z.uuid().safeParse(id).success;
  }, 'Cursor inválido. Atualize o bolsão.');

export interface CommentEvent {
  kind: 'comment';
  comment_id: string;
  sender_id: string;
  username: string;
  text: string;
  media_id: string;
  created_at: string;
}
type Tx = Sql | MongoTx;
type Row = Record<string, any>;
type Table =
  | 'instagram_comments'
  | 'users'
  | 'contacts'
  | 'contact_identities'
  | 'opportunities'
  | 'channel_accounts'
  | 'conversations'
  | 'messages'
  | 'audit_events'
  | 'instagram_webhook_inbox';

// These helpers receive only server-defined table/column names. Values always use parameters.
async function one(tx: Tx, table: Table, filter: Row): Promise<Row | null> {
  if (tx instanceof MongoTx) return tx.one(table, filter);
  const keys = Object.keys(filter);
  return (
    (
      await tx.query<Row>(
        `SELECT * FROM ${table} WHERE ${keys.map((key, i) => `"${key}" IS NOT DISTINCT FROM $${i + 1}`).join(' AND ')} LIMIT 1`,
        Object.values(filter),
      )
    ).rows[0] ?? null
  );
}
async function insert(tx: Tx, table: Table, row: Row) {
  if (tx instanceof MongoTx) return tx.insert(table, row);
  const keys = Object.keys(row);
  await tx.query(
    `INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row).map((value) =>
      Array.isArray(value) || (value && typeof value === 'object' && !(value instanceof Date))
        ? JSON.stringify(value)
        : value,
    ),
  );
}
async function update(tx: Tx, table: Table, filter: Row, values: Row) {
  if (tx instanceof MongoTx) return tx.update(table, filter, { $set: values });
  const keys = Object.keys(values);
  await tx.query(
    `UPDATE ${table} SET ${keys.map((key, i) => `"${key}"=$${i + 1}`).join(',')} WHERE ${Object.keys(
      filter,
    )
      .map((key, i) => `"${key}" IS NOT DISTINCT FROM $${i + keys.length + 1}`)
      .join(' AND ')}`,
    [...Object.values(values), ...Object.values(filter)],
  );
}
async function now(tx: Tx) {
  return tx instanceof MongoTx
    ? tx.now()
    : new Date((await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now);
}

export type CommentMessagingMode =
  'direct' | 'private_reply' | 'waiting_reply' | 'expired' | 'send_unconfirmed';
export function commentMessagingMode(
  conversation: {
    private_reply_comment_id?: string | null;
    private_reply_message_id?: string | null;
    private_reply_started_at?: Date | string | null;
    last_inbound_at?: Date | string | null;
  },
  deadline: Date | string | null,
  time = new Date(),
): CommentMessagingMode {
  if (!conversation.private_reply_comment_id) return 'direct';
  const inbound = conversation.last_inbound_at
    ? new Date(conversation.last_inbound_at).getTime()
    : 0;
  const started = conversation.private_reply_started_at
    ? new Date(conversation.private_reply_started_at).getTime()
    : 0;
  if (inbound && inbound >= started && inbound + DAY > time.getTime()) return 'direct';
  if (conversation.private_reply_message_id && inbound && inbound >= started) return 'expired';
  if (conversation.private_reply_message_id) return 'waiting_reply';
  return deadline && new Date(deadline).getTime() > time.getTime() ? 'private_reply' : 'expired';
}

export class InstagramComments {
  private previewPausedUntil = 0;
  private verifications = new Map<string, Promise<void>>();
  constructor(
    private db: Database | MongoStore,
    private config?: InstagramConfig,
    private request: InstagramFetch = fetch,
  ) {}

  private transaction<T>(work: (tx: Tx) => Promise<T>) {
    return this.db.kind === 'mongo'
      ? this.db.atomic(work)
      : this.db.transaction(async (tx) => {
          await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
          return work(tx);
        });
  }
  private enabled() {
    if (!this.config)
      throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
    return this.config;
  }
  private async actor(tx: Tx, user: User) {
    const current =
      tx instanceof MongoTx
        ? await one(tx, 'users', { id: user.id })
        : (await tx.query<Row>('SELECT * FROM users WHERE id=$1 FOR SHARE', [user.id])).rows[0];
    if (!current?.active || current.auth_version !== user.auth_version)
      throw new DomainError('UNAUTHENTICATED', 'Sua sessão expirou.', 401);
    if (current.role !== 'attendant')
      throw new DomainError('FORBIDDEN', 'Somente consultores podem assumir comentários.', 403);
  }

  async persist(event: CommentEvent, eventId: string, lease: string) {
    const config = this.enabled();
    await this.transaction(async (tx) => {
      const time = await now(tx);
      if (
        !(await wasDeleted(tx, eventId)) &&
        !(await one(tx, 'instagram_comments', {
          account_id: config.accountId,
          comment_id: event.comment_id,
        }))
      ) {
        const cachedMedia = event.media_id
          ? tx instanceof MongoTx
            ? (
                await tx.many(
                  'instagram_comments',
                  {
                    account_id: config.accountId,
                    media_id: event.media_id,
                    preview_checked_at: { $gte: new Date(time.getTime() - 24 * 60 * 60_000) },
                  },
                  { preview_checked_at: -1 },
                  1,
                )
              )[0]
            : (
                await tx.query<Row>(
                  `SELECT permalink,thumbnail_url,preview_checked_at FROM instagram_comments WHERE account_id=$1 AND media_id=$2 AND preview_checked_at>=$3 ORDER BY preview_checked_at DESC LIMIT 1`,
                  [config.accountId, event.media_id, new Date(time.getTime() - 24 * 60 * 60_000)],
                )
              ).rows[0]
          : null;
        // Successful previews last a day; failures/in-progress lookups suppress repeats for 15 min.
        const cache =
          cachedMedia &&
          (cachedMedia.permalink ||
            new Date(cachedMedia.preview_checked_at).getTime() + 15 * 60_000 > time.getTime())
            ? cachedMedia
            : null;
        // Subsequent comments stay with an already assigned profile; never open another outreach.
        let sibling =
          tx instanceof MongoTx
            ? await tx.one('instagram_comments', {
                account_id: config.accountId,
                sender_id: event.sender_id,
                opportunity_id: { $ne: null },
              })
            : (
                await tx.query<Row>(
                  'SELECT * FROM instagram_comments WHERE account_id=$1 AND sender_id=$2 AND opportunity_id IS NOT NULL LIMIT 1',
                  [config.accountId, event.sender_id],
                )
              ).rows[0];
        if (!sibling) {
          const identity = await one(tx, 'contact_identities', {
            provider: 'instagram',
            channel_account_id: config.accountId,
            external_user_id: event.sender_id,
          });
          const lead = identity
            ? tx instanceof MongoTx
              ? (
                  await tx.many(
                    'opportunities',
                    { contact_id: identity.contact_id },
                    { created_at: -1 },
                    1,
                  )
                )[0]
              : (
                  await tx.query<Row>(
                    'SELECT * FROM opportunities WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 1',
                    [identity.contact_id],
                  )
                ).rows[0]
            : null;
          if (lead?.owner_id) {
            const account = await one(tx, 'channel_accounts', {
              provider: 'instagram',
              external_account_id: config.accountId,
            });
            const conversation = account
              ? await one(tx, 'conversations', {
                  channel_account_id: account.id,
                  opportunity_id: lead.id,
                })
              : null;
            sibling = {
              opportunity_id: lead.id,
              conversation_id: conversation?.id ?? null,
              claimed_by: lead.owner_id,
            };
          }
        }
        const { kind: _, ...data } = event;
        await insert(tx, 'instagram_comments', {
          ...data,
          created_at: new Date(event.created_at),
          id: randomUUID(),
          account_id: config.accountId,
          reply_deadline_at: new Date(new Date(event.created_at).getTime() + 7 * DAY),
          received_at: time,
          permalink: cache?.permalink ?? '',
          thumbnail_url: cache?.thumbnail_url ?? '',
          preview_checked_at: cache?.preview_checked_at ?? null,
          ignored: false,
          version: 1,
          opportunity_id: sibling?.opportunity_id ?? null,
          conversation_id: sibling?.conversation_id ?? null,
          claimed_by: sibling?.claimed_by ?? null,
        });
        if (sibling?.conversation_id) {
          await insert(tx, 'messages', {
            id: randomUUID(),
            conversation_id: sibling.conversation_id,
            external_message_id: `comment:${config.accountId}:${event.comment_id}`,
            direction: 'inbound',
            sender_external_id: event.sender_id,
            type: 'instagram_comment',
            text: event.text,
            attachments: cache?.permalink ? [{ type: 'ig_post', url: cache.permalink }] : [],
            status: 'received',
            created_at: time,
          });
          await update(
            tx,
            'conversations',
            { id: sibling.conversation_id },
            { last_message_at: time, updated_at: time },
          );
          await enqueuePushEvent(
            tx,
            eventId,
            sibling.opportunity_id,
            'comment.received.owned',
            time,
          );
        }
        if (!sibling && new Date(event.created_at).getTime() + 7 * DAY > time.getTime())
          await putPush(tx, {
            id: `event:${eventId}`,
            kind: 'event',
            available_at: time.toISOString(),
            expires_at: new Date(time.getTime() + 3600_000).toISOString(),
            data: {
              kind: 'comment.received',
              commentId: event.comment_id,
              accountId: config.accountId,
            },
          });
      }
      await update(
        tx,
        'instagram_webhook_inbox',
        { event_id: eventId, lease_id: lease },
        { processed_at: time, lease_id: null, last_error: null },
      );
    });
  }

  // Preview lookups run independently of Direct ingestion. They can fail without
  // postponing a comment, a message, or the consultant's ability to claim a profile.
  async enrichPreviews(limit = 3) {
    const config = this.config;
    if (!config || config.profileLookup === false || this.previewPausedUntil > Date.now()) return;
    const db = this.db;
    for (let index = 0; index < limit; index++) {
      const candidate =
        db.kind === 'mongo'
          ? (
              await db.many(
                'instagram_comments',
                { account_id: config.accountId, preview_checked_at: null, media_id: { $ne: '' } },
                { received_at: -1 },
                1,
              )
            )[0]
          : (
              await db.query<Row>(
                "SELECT * FROM instagram_comments WHERE account_id=$1 AND preview_checked_at IS NULL AND media_id<>'' ORDER BY received_at DESC LIMIT 1",
                [config.accountId],
              )
            ).rows[0];
      if (!candidate) return;
      const claimed = await this.transaction(async (tx) => {
        const current = await one(tx, 'instagram_comments', { id: candidate.id });
        if (!current || current.preview_checked_at) return false;
        await update(
          tx,
          'instagram_comments',
          { account_id: config.accountId, media_id: candidate.media_id },
          { preview_checked_at: await now(tx) },
        );
        return true;
      });
      if (!claimed) continue;
      try {
        const response = await this.request(
          `https://graph.instagram.com/${config.graphApiVersion}/${candidate.media_id}?fields=permalink,media_type,media_url,thumbnail_url`,
          {
            headers: { Authorization: `Bearer ${config.accessToken}` },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 429 || response.status >= 500) {
            this.previewPausedUntil = Date.now() + 15 * 60_000;
            return;
          }
          continue;
        }
        const media = z
          .object({
            permalink: z.string().url().optional(),
            media_type: z.string().optional(),
            media_url: z.string().url().optional(),
            thumbnail_url: z.string().url().optional(),
          })
          .parse(await response.json());
        const permalink =
          media.permalink && /^https:\/\/(www\.)?instagram\.com\//i.test(media.permalink)
            ? media.permalink
            : '';
        const image = media.thumbnail_url || (media.media_type === 'IMAGE' ? media.media_url : '');
        const thumbnail =
          image &&
          /^https:\/\/([a-z0-9-]+\.)*(cdninstagram\.com|fbcdn\.net|fbsbx\.com)\//i.test(image)
            ? image
            : '';
        await this.transaction(async (tx) =>
          update(
            tx,
            'instagram_comments',
            { account_id: config.accountId, media_id: candidate.media_id },
            { permalink, thumbnail_url: thumbnail },
          ),
        );
      } catch {
        /* Optional preview: do not retry indefinitely or affect the inbox. */
      }
    }
  }

  async list(user: User, before?: string) {
    if (!this.config) return { configured: false, comments: [], next_cursor: null };
    const cursor = before ? cursorSchema.parse(before).split('|') : undefined;
    const time = new Date();
    const filter = {
      account_id: this.config.accountId,
      ignored: false,
      opportunity_id: null,
      reply_deadline_at: { $gt: time },
    };
    let rows: Row[];
    // Group before pagination: a frequent commenter cannot occupy an entire page.
    if (this.db.kind === 'mongo')
      rows = await this.db
        .collection('instagram_comments')
        .aggregate([
          { $match: filter },
          { $sort: { received_at: -1, id: -1 } },
          {
            $group: {
              _id: '$sender_id',
              comment: { $first: '$$ROOT' },
              comment_count: { $sum: 1 },
            },
          },
          { $replaceWith: { $mergeObjects: ['$comment', { comment_count: '$comment_count' }] } },
          ...(cursor
            ? [
                {
                  $match: {
                    $or: [
                      { received_at: { $lt: new Date(cursor[0]) } },
                      { received_at: new Date(cursor[0]), id: { $lt: cursor[1] } },
                    ],
                  },
                },
              ]
            : []),
          { $sort: { received_at: -1, id: -1 } },
          { $limit: 31 },
          { $project: { _id: 0 } },
        ])
        .toArray();
    else
      rows = (
        await this.db.query<Row>(
          `SELECT * FROM (
      SELECT DISTINCT ON (sender_id) *, count(*) OVER(PARTITION BY sender_id)::integer AS comment_count
      FROM instagram_comments WHERE account_id=$1 AND NOT ignored AND opportunity_id IS NULL AND reply_deadline_at>$2
      ORDER BY sender_id,received_at DESC,id DESC
    ) grouped WHERE ($3::timestamptz IS NULL OR (received_at,id)<($3::timestamptz,$4::uuid)) ORDER BY received_at DESC,id DESC LIMIT 31`,
          [this.config.accountId, time, cursor?.[0] ?? null, cursor?.[1] ?? null],
        )
      ).rows;
    const usernames = rows
      .slice(0, 30)
      .map((row) => String(row.username).toLowerCase())
      .filter(Boolean);
    const reservations =
      this.db.kind === 'mongo'
        ? await this.db.many(
            'instagram_prospects',
            { account_id: this.config.accountId, username: { $in: usernames } },
            {},
            30,
          )
        : (
            await this.db.query<Row>(
              'SELECT * FROM instagram_prospects WHERE account_id=$1 AND username=ANY($2::text[]) LIMIT 30',
              [this.config.accountId, usernames],
            )
          ).rows;
    const owners = new Map(reservations.map((row) => [row.username, row]));
    return {
      configured: true,
      comments: rows
        .slice(0, 30)
        .map((row) => ({
          ...row,
          can_claim:
            user.role === 'attendant' &&
            !prospectBlocksComment(
              owners.get(row.username.toLowerCase()),
              user.id,
              time,
              row.sender_id,
            ),
        })),
      next_cursor:
        rows.length > 30 ? `${new Date(rows[29].received_at).toISOString()}|${rows[29].id}` : null,
    };
  }

  async ignore(user: User, id: string, version: number) {
    const config = this.enabled();
    return this.transaction(async (tx) => {
      await this.actor(tx, user);
      const row = await one(tx, 'instagram_comments', { id, account_id: config.accountId });
      if (!row) throw new DomainError('NOT_FOUND', 'Comentário não encontrado.', 404);
      const reservation = row.username
        ? await findProspect(tx, config.accountId, row.username)
        : null;
      if (prospectBlocksComment(reservation, user.id, new Date(), row.sender_id))
        throw new DomainError('PROFILE_RESERVED', 'Este perfil foi reservado por outro consultor.');
      if (row.opportunity_id || row.version !== version)
        throw new DomainError('COMMENT_CHANGED', 'Este comentário mudou. Atualize o bolsão.');
      await update(
        tx,
        'instagram_comments',
        { account_id: config.accountId, sender_id: row.sender_id, opportunity_id: null },
        { ignored: true, version: version + 1 },
      );
      return { ok: true };
    });
  }

  async claim(user: User, id: string, version: number) {
    const config = this.enabled();
    return this.transaction(async (tx) => {
      await this.actor(tx, user);
      const comment = await one(tx, 'instagram_comments', { id, account_id: config.accountId });
      if (!comment) throw new DomainError('NOT_FOUND', 'Comentário não encontrado.', 404);
      if (comment.opportunity_id) {
        const lead = await one(tx, 'opportunities', { id: comment.opportunity_id });
        if (lead?.owner_id === user.id && lead.state === 'CLAIMED')
          return { opportunity_id: lead.id, conversation_id: comment.conversation_id };
        throw new DomainError(
          'ALREADY_CLAIMED',
          'Este perfil já foi assumido por outro consultor.',
        );
      }
      const time = await now(tx);
      const reservation = comment.username
        ? await findProspect(tx, config.accountId, comment.username)
        : null;
      if (prospectBlocksComment(reservation, user.id, time, comment.sender_id))
        throw new DomainError(
          'PROFILE_RESERVED',
          'Este perfil possui uma reserva. Solicite revisão à gestão.',
        );
      if (comment.ignored || comment.version !== version)
        throw new DomainError('COMMENT_CHANGED', 'Este comentário mudou. Atualize o bolsão.');
      if (new Date(comment.reply_deadline_at).getTime() <= time.getTime())
        throw new DomainError('COMMENT_EXPIRED', 'O prazo para abordar este comentário terminou.');
      let identity = await one(tx, 'contact_identities', {
        provider: 'instagram',
        channel_account_id: config.accountId,
        external_user_id: comment.sender_id,
      });
      let contact = identity ? await one(tx, 'contacts', { id: identity.contact_id }) : null;
      if (!contact) {
        contact = {
          id: randomUUID(),
          name: comment.username || 'Contato Instagram',
          phone: null,
          email: '',
          residence_city: '',
          instagram: comment.username,
          is_demo: false,
        };
        await insert(tx, 'contacts', contact);
        identity = {
          id: randomUUID(),
          contact_id: contact.id,
          provider: 'instagram',
          channel_account_id: config.accountId,
          external_user_id: comment.sender_id,
          username: comment.username,
          display_name: '',
          last_seen_at: time,
        };
        await insert(tx, 'contact_identities', identity);
      }
      const existing =
        tx instanceof MongoTx
          ? (await tx.many('opportunities', { contact_id: contact.id }, { created_at: -1 }, 1))[0]
          : (
              await tx.query<Row>(
                'SELECT * FROM opportunities WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
                [contact.id],
              )
            ).rows[0];
      let lead = existing;
      if (lead) {
        if (isClosedStage(lead.stage) || lead.state === 'CANCELLED')
          throw new DomainError(
            'LEAD_CLOSED',
            'Este contato já tem um atendimento encerrado. Solicite a revisão da gestão.',
          );
        if (
          (lead.owner_id && lead.owner_id !== user.id) ||
          (lead.state === 'RESERVED' &&
            lead.reserved_to !== user.id &&
            new Date(lead.expires_at).getTime() > time.getTime())
        )
          throw new DomainError('ALREADY_CLAIMED', 'Este perfil já pertence a outro consultor.');
        await update(
          tx,
          'opportunities',
          { id: lead.id },
          {
            owner_id: user.id,
            reserved_to: null,
            state: 'CLAIMED',
            expires_at: null,
            claimed_at: lead.claimed_at ?? time,
            version: lead.version + 1,
          },
        );
      } else {
        lead = {
          id: randomUUID(),
          contact_id: contact.id,
          interest: '',
          unit: 'A definir',
          source: 'Comentário do Instagram',
          source_evidence: 'Comentário recebido pelo webhook assinado da Meta.',
          channel: 'instagram',
          state: 'CLAIMED',
          owner_id: user.id,
          reserved_to: null,
          created_at: time,
          expires_at: null,
          claimed_at: time,
          last_message_at: time,
          next_action: '',
          stage: 'NEW_LEAD',
          consultation_status: 'UNDEFINED',
          version: 1,
          ...(tx instanceof MongoTx
            ? {
                open: true,
                needs_review: false,
                procedure_date: null,
                sale_completed_at: null,
                sale_seller_name: '',
                consultant: '',
                total_value_cents: null,
                down_payment_cents: null,
                hair_grade_classification: '',
                has_pack: null,
                contract_status: null,
              }
            : {}),
        };
        await insert(tx, 'opportunities', lead);
      }
      let account = await one(tx, 'channel_accounts', {
        provider: 'instagram',
        external_account_id: config.accountId,
      });
      if (!account) {
        account = {
          id: randomUUID(),
          provider: 'instagram',
          external_account_id: config.accountId,
          username: config.username ?? '',
          status: 'active',
          graph_api_version: config.graphApiVersion,
          created_at: time,
          updated_at: time,
        };
        await insert(tx, 'channel_accounts', account);
      }
      let conversation = await one(tx, 'conversations', {
        channel_account_id: account.id,
        opportunity_id: lead.id,
      });
      if (!conversation) {
        conversation = {
          id: randomUUID(),
          channel_account_id: account.id,
          contact_id: contact.id,
          opportunity_id: lead.id,
          status: 'open',
          last_message_at: time,
          last_inbound_at: null,
          last_outbound_at: null,
          created_at: time,
          updated_at: time,
          private_reply_comment_id: comment.comment_id,
          private_reply_message_id: null,
        };
        await insert(tx, 'conversations', conversation);
      } else if (!conversation.private_reply_comment_id) {
        await update(
          tx,
          'conversations',
          { id: conversation.id },
          { private_reply_comment_id: comment.comment_id },
        );
      }
      // Keep the public comment in history without treating it as an inbound Direct/open window.
      if (reservation?.status === 'waiting' && new Date(reservation.expires_at) > time)
        await finishProspect(
          tx,
          { reservation },
          {
            provider: 'instagram',
            account_id: config.accountId,
            external_user_id: comment.sender_id,
          },
          lead.id,
          user.id,
          time,
        );
      await insert(tx, 'messages', {
        id: randomUUID(),
        conversation_id: conversation.id,
        external_message_id: `comment:${config.accountId}:${comment.comment_id}`,
        direction: 'inbound',
        sender_external_id: comment.sender_id,
        type: 'instagram_comment',
        text: comment.text,
        attachments: comment.permalink ? [{ type: 'ig_post', url: comment.permalink }] : [],
        status: 'received',
        created_at: time,
      });
      await update(
        tx,
        'instagram_comments',
        { account_id: config.accountId, sender_id: comment.sender_id, opportunity_id: null },
        {
          opportunity_id: lead.id,
          conversation_id: conversation.id,
          claimed_by: user.id,
          version: comment.version + 1,
        },
      );
      await update(
        tx,
        'conversations',
        { id: conversation.id },
        { last_message_at: time, updated_at: time },
      );
      await insert(tx, 'audit_events', {
        id: randomUUID(),
        opportunity_id: lead.id,
        actor_id: user.id,
        kind: 'comment.claimed',
        description: 'Comentário do Instagram assumido pelo consultor.',
        details: {},
        created_at: time,
      });
      await enqueuePushEvent(
        tx,
        `comment-claim:${comment.id}`,
        lead.id,
        'opportunity.claimed',
        time,
      );
      return { opportunity_id: lead.id as string, conversation_id: conversation.id as string };
    });
  }

  async mode(conversation: Row): Promise<CommentMessagingMode> {
    return (await this.modes([conversation]))[0];
  }

  async modes(conversations: Row[]): Promise<CommentMessagingMode[]> {
    const related = conversations.filter((row) => row.private_reply_comment_id);
    if (!related.length) return conversations.map(() => 'direct');
    const db = this.db;
    const accountId = this.enabled().accountId;
    const ids = [...new Set(related.map((row) => row.private_reply_comment_id))];
    const messageIds = related.map((row) => row.private_reply_message_id).filter(Boolean);
    // At most two focused queries per conversation list, regardless of the number of chats.
    const [comments, messages] = await Promise.all([
      db.kind === 'mongo'
        ? db
            .collection('instagram_comments')
            .find(
              { account_id: accountId, comment_id: { $in: ids } },
              { projection: { comment_id: 1, reply_deadline_at: 1 } },
            )
            .toArray()
        : db
            .query<Row>(
              'SELECT comment_id,reply_deadline_at FROM instagram_comments WHERE account_id=$1 AND comment_id=ANY($2::text[])',
              [accountId, ids],
            )
            .then((result) => result.rows),
      !messageIds.length
        ? Promise.resolve([] as Row[])
        : db.kind === 'mongo'
          ? db
              .collection('messages')
              .find({ id: { $in: messageIds } }, { projection: { id: 1, status: 1 } })
              .toArray()
          : db
              .query<Row>('SELECT id,status FROM messages WHERE id=ANY($1::uuid[])', [messageIds])
              .then((result) => result.rows),
    ]);
    const deadlines = new Map(comments.map((row) => [row.comment_id, row.reply_deadline_at]));
    const statuses = new Map(messages.map((row) => [row.id, row.status]));
    const time = new Date();
    return conversations.map((conversation) => {
      const mode = commentMessagingMode(
        conversation,
        deadlines.get(conversation.private_reply_comment_id) ?? null,
        time,
      );
      return mode === 'waiting_reply' &&
        ['unknown', 'failed'].includes(statuses.get(conversation.private_reply_message_id))
        ? 'send_unconfirmed'
        : mode;
    });
  }

  // Obtain the actual comment creation time, rather than trusting delayed webhook delivery time.
  async verifyPrivateReply(commentId: string) {
    const running = this.verifications.get(commentId);
    if (running) return running;
    const work = this.verifyCommentTimestamp(commentId);
    this.verifications.set(commentId, work);
    try {
      await work;
    } finally {
      this.verifications.delete(commentId);
    }
  }

  private async verifyCommentTimestamp(commentId: string) {
    const config = this.enabled();
    const cached = await one(this.db, 'instagram_comments', {
      account_id: config.accountId,
      comment_id: commentId,
    });
    if (cached?.timestamp_verified_at) {
      if (new Date(cached.reply_deadline_at).getTime() <= Date.now())
        throw new DomainError(
          'COMMENT_EXPIRED',
          'O prazo de sete dias para responder ao comentário terminou.',
        );
      return;
    }
    let data: { timestamp: string };
    try {
      const response = await this.request(
        `https://graph.instagram.com/${config.graphApiVersion}/${commentId}?fields=timestamp`,
        {
          headers: { Authorization: `Bearer ${config.accessToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Unavailable comment');
      }
      data = z
        .object({ timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))) })
        .parse(await response.json());
    } catch {
      throw new DomainError(
        'COMMENT_UNAVAILABLE',
        'Não foi possível verificar o comentário no Instagram. Atualize e tente novamente.',
        502,
      );
    }
    const created = new Date(data.timestamp);
    const deadline = new Date(created.getTime() + 7 * DAY);
    await this.transaction(async (tx) =>
      update(
        tx,
        'instagram_comments',
        { account_id: config.accountId, comment_id: commentId },
        { created_at: created, reply_deadline_at: deadline, timestamp_verified_at: new Date() },
      ),
    );
    if (deadline.getTime() <= Date.now())
      throw new DomainError(
        'COMMENT_EXPIRED',
        'O prazo de sete dias para responder ao comentário terminou.',
      );
  }

  // Called inside the same transaction that reserves the outgoing message. A lost HTTP
  // response never releases this slot: blindly retrying could send a second approach.
  async authorizeSend(
    tx: Tx,
    user: User,
    conversationId: string,
    messageId: string,
    externalUserId: string,
  ) {
    await this.actor(tx, user);
    const conversation = await one(tx, 'conversations', { id: conversationId });
    const lead =
      conversation &&
      (tx instanceof MongoTx
        ? await one(tx, 'opportunities', { id: conversation.opportunity_id })
        : (
            await tx.query<Row>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [
              conversation.opportunity_id,
            ])
          ).rows[0]);
    if (!conversation || lead?.state !== 'CLAIMED' || lead.owner_id !== user.id)
      throw new DomainError('FORBIDDEN', 'Esta conversa não pertence a você.', 403);
    const comment = conversation.private_reply_comment_id
      ? await one(tx, 'instagram_comments', {
          account_id: this.enabled().accountId,
          comment_id: conversation.private_reply_comment_id,
        })
      : null;
    const mode = commentMessagingMode(
      conversation,
      comment?.reply_deadline_at ?? null,
      await now(tx),
    );
    if (mode === 'waiting_reply')
      throw new DomainError(
        'WAITING_REPLY',
        'Aguarde o lead responder no Instagram antes de enviar outra mensagem.',
      );
    if (mode === 'expired')
      throw new DomainError(
        'MESSAGING_WINDOW_CLOSED',
        'O prazo de envio terminou. Aguarde uma nova mensagem do lead.',
      );
    if (mode === 'private_reply') {
      await update(
        tx,
        'conversations',
        { id: conversationId },
        { private_reply_message_id: messageId, private_reply_started_at: await now(tx) },
      );
      return { comment_id: conversation.private_reply_comment_id as string };
    }
    return { id: externalUserId };
  }

  // Persist the Meta acknowledgement before finalizing any local state. Recovery
  // uses these IDs only; it must never POST the private reply a second time.
  async confirmPrivateReply(messageId: string, recipientId: string, externalMessageId: string) {
    const receipt = privateReplyReceiptSchema.parse({
      account_id: this.enabled().accountId,
      recipient_id: recipientId,
      message_id: externalMessageId,
      confirmed_at: new Date().toISOString(),
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await this.transaction(async (tx) => {
          const message = await one(tx, 'messages', { id: messageId });
          if (!message) throw new DomainError('NOT_FOUND', 'Mensagem não encontrada.', 404);
          if (message.private_reply_receipt) {
            const saved = privateReplyReceiptSchema.parse(message.private_reply_receipt);
            if (
              saved.account_id !== receipt.account_id ||
              saved.recipient_id !== recipientId ||
              saved.message_id !== externalMessageId
            )
              throw new DomainError(
                'IDENTITY_CONFLICT',
                'Confirmação de envio divergente. Solicite revisão da gestão.',
              );
            return;
          }
          const conversation = await one(tx, 'conversations', { id: message.conversation_id });
          const account =
            conversation &&
            (await one(tx, 'channel_accounts', { id: conversation.channel_account_id }));
          if (
            message.direction !== 'outbound' ||
            conversation?.private_reply_message_id !== messageId ||
            account?.external_account_id !== receipt.account_id ||
            account.provider !== 'instagram'
          )
            throw new DomainError(
              'IDENTITY_CONFLICT',
              'Confirmação incompatível com esta conversa.',
            );
          await update(
            tx,
            'messages',
            { id: messageId },
            {
              private_reply_receipt: tx instanceof MongoTx ? receipt : JSON.stringify(receipt),
              private_reply_binding_pending: true,
              private_reply_binding_retry_at: await now(tx),
              error_code: 'RECIPIENT_BINDING_PENDING',
            },
          );
        });
        break;
      } catch (error) {
        // Bounded database-only retry, including an acknowledgement lost after commit.
        if (error instanceof DomainError || attempt >= 2) throw error;
      }
    }
    try {
      return await this.completePrivateReply(messageId);
    } catch {
      throw new DomainError(
        'INSTAGRAM_BINDING_PENDING',
        'O envio foi confirmado. O CRM está recuperando o vínculo da conversa; não reenvie a mensagem.',
        503,
      );
    }
  }

  async completePrivateReply(messageId: string) {
    const config = this.enabled();
    return this.transaction(async (tx) => {
      const message = await one(tx, 'messages', { id: messageId });
      if (!message) throw new DomainError('NOT_FOUND', 'Mensagem não encontrada.', 404);
      if (!message.private_reply_binding_pending)
        return {
          id: message.id as string,
          status: message.status as string,
          external_message_id: message.external_message_id as string | null,
        };
      const receipt = privateReplyReceiptSchema.parse(message.private_reply_receipt);
      if (receipt.account_id !== config.accountId)
        throw new DomainError('IDENTITY_CONFLICT', 'A confirmação pertence a outra conta.');
      const conversation = await one(tx, 'conversations', { id: message.conversation_id });
      const account =
        conversation &&
        (await one(tx, 'channel_accounts', { id: conversation.channel_account_id }));
      if (
        !conversation ||
        conversation.private_reply_message_id !== messageId ||
        account?.external_account_id !== config.accountId ||
        account.provider !== 'instagram'
      )
        throw new DomainError(
          'IDENTITY_CONFLICT',
          'O vínculo da conversa exige revisão da gestão.',
        );
      await this.bindRecipient(tx, conversation, receipt.recipient_id);
      const confirmed = new Date(receipt.confirmed_at);
      await update(
        tx,
        'messages',
        { id: messageId },
        {
          status: ['delivered', 'read'].includes(message.status) ? message.status : 'sent',
          external_message_id: receipt.message_id,
          sent_at: confirmed,
          sending_started_at: null,
          error_code: null,
          private_reply_binding_pending: false,
          private_reply_binding_retry_at: null,
        },
      );
      await update(
        tx,
        'conversations',
        { id: conversation.id },
        {
          last_message_at: new Date(
            Math.max(new Date(conversation.last_message_at).getTime(), confirmed.getTime()),
          ),
          last_outbound_at: new Date(
            Math.max(
              conversation.last_outbound_at ? new Date(conversation.last_outbound_at).getTime() : 0,
              confirmed.getTime(),
            ),
          ),
          updated_at: await now(tx),
        },
      );
      return {
        id: messageId,
        status: ['delivered', 'read'].includes(message.status)
          ? (message.status as string)
          : 'sent',
        external_message_id: receipt.message_id,
      };
    });
  }

  // Before ingesting a reply, finish its known pending identity mapping. A failure
  // leaves the webhook in the existing durable retry queue, never a duplicate lead.
  async recoverRecipient(senderId: string) {
    const config = this.enabled();
    const pending =
      this.db.kind === 'mongo'
        ? await this.db.collection('messages').findOne(
            {
              private_reply_binding_pending: true,
              'private_reply_receipt.account_id': config.accountId,
              'private_reply_receipt.recipient_id': senderId,
            },
            { projection: { id: 1 } },
          )
        : (
            await this.db.query<{ id: string }>(
              `SELECT id FROM messages WHERE private_reply_binding_pending AND private_reply_receipt->>'account_id'=$1 AND private_reply_receipt->>'recipient_id'=$2 LIMIT 1`,
              [config.accountId, senderId],
            )
          ).rows[0];
    if (pending) await this.completePrivateReply(pending.id as string);
  }

  async recoverPrivateReplies(limit = 3) {
    if (!this.config) return;
    const accountId = this.config.accountId;
    const pending =
      this.db.kind === 'mongo'
        ? await this.db
            .collection('messages')
            .find(
              {
                private_reply_binding_pending: true,
                'private_reply_receipt.account_id': accountId,
                private_reply_binding_retry_at: { $lte: new Date() },
              },
              { projection: { id: 1 } },
            )
            .sort({ private_reply_binding_retry_at: 1 })
            .limit(limit)
            .toArray()
        : (
            await this.db.query<{ id: string }>(
              `SELECT id FROM messages WHERE private_reply_binding_pending AND private_reply_receipt->>'account_id'=$1 AND private_reply_binding_retry_at<=clock_timestamp() ORDER BY private_reply_binding_retry_at LIMIT $2`,
              [accountId, limit],
            )
          ).rows;
    for (const message of pending) {
      try {
        await this.completePrivateReply(message.id as string);
      } catch (error) {
        // An identity conflict is never resolved by merging two leads automatically.
        const retryAt = new Date(
          Date.now() + (error instanceof DomainError ? 15 * 60_000 : 60_000),
        );
        await update(
          this.db,
          'messages',
          { id: message.id, private_reply_binding_pending: true },
          { private_reply_binding_retry_at: retryAt },
        );
      }
    }
  }

  private async bindRecipient(tx: Tx, conversation: Row, recipientId: string) {
    const config = this.enabled();
    const identity = await one(tx, 'contact_identities', {
      provider: 'instagram',
      channel_account_id: config.accountId,
      external_user_id: recipientId,
    });
    if (identity && identity.contact_id !== conversation.contact_id)
      throw new DomainError(
        'IDENTITY_CONFLICT',
        'O Instagram retornou um perfil já cadastrado. Solicite revisão da gestão.',
      );
    if (!identity)
      await insert(tx, 'contact_identities', {
        id: randomUUID(),
        contact_id: conversation.contact_id,
        provider: 'instagram',
        channel_account_id: config.accountId,
        external_user_id: recipientId,
        username: '',
        display_name: '',
        last_seen_at: await now(tx),
      });
    await update(
      tx,
      'conversations',
      { id: conversation.id },
      { instagram_recipient_id: recipientId },
    );
  }

  register(app: FastifyInstance, runWorker = true) {
    let active: Promise<void> | undefined;
    const timer =
      this.config && runWorker
        ? setInterval(() => {
            if (!active)
              active = this.enrichPreviews()
                .catch(() => app.log.error('Instagram comment preview processing failed'))
                .finally(() => {
                  active = undefined;
                });
          }, 15_000)
        : undefined;
    timer?.unref();
    app.addHook('onClose', async () => {
      if (timer) clearInterval(timer);
      await active;
    });
    const params = z.object({ id: z.string().uuid() });
    const input = z.object({ expected_version: z.number().int().positive() }).strict();
    app.get('/api/v1/instagram/comments', async (req) => {
      const query = z.object({ before: cursorSchema.optional() }).parse(req.query);
      return this.list(req.user, query.before);
    });
    app.post('/api/v1/instagram/comments/:id/claim', async (req) =>
      this.claim(req.user, params.parse(req.params).id, input.parse(req.body).expected_version),
    );
    app.post('/api/v1/instagram/comments/:id/ignore', async (req) =>
      this.ignore(req.user, params.parse(req.params).id, input.parse(req.body).expected_version),
    );
  }
}
