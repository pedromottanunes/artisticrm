import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CRM, LeadInput, MetaAttributionInput } from './crm.js';
import type { MongoOperations } from './mongo-crm.js';
import { DomainError, type Opportunity, type User } from './types.js';
import { wasDeleted } from './lead-deletion.js';
import { enqueuePushEvent } from './push-store.js';
import { mutedOpportunityIds, setLeadNotificationMuted } from './lead-notification-mutes.js';
import { MediaProxy, trustedMediaUrl } from './media-proxy.js';
import { MongoTx } from './mongo-store.js';
import type { Sql } from './db.js';
import { lockActor } from './access.js';
import { canReviewOwner, reviewSourceIds } from './conversation-sharing.js';

export interface MessengerConfig {
  appSecret: string;
  verifyToken: string;
  pageId: string;
  pageAccessToken: string;
  graphApiVersion: string;
}
export type MessengerFetch = typeof fetch;

export function messengerConfig(env: NodeJS.ProcessEnv): MessengerConfig | undefined {
  if (env.MESSENGER_ENABLED !== 'true') return undefined;
  const parsed = z
    .object({
      appSecret: z.string().min(16),
      verifyToken: z.string().min(32),
      pageId: z.string().regex(/^\d+$/),
      pageAccessToken: z.string().min(20),
      graphApiVersion: z.string().regex(/^v\d+\.\d+$/),
    })
    .safeParse({
      appSecret: env.MESSENGER_APP_SECRET,
      verifyToken: env.MESSENGER_VERIFY_TOKEN,
      pageId: env.MESSENGER_PAGE_ID,
      pageAccessToken: env.MESSENGER_PAGE_ACCESS_TOKEN,
      graphApiVersion: env.META_GRAPH_VERSION,
    });
  if (!parsed.success)
    throw new Error('Configuração do Messenger incompleta ou inválida. Consulte MESSENGER.md.');
  return parsed.data;
}

const identifier = z.string().trim().min(1).max(512);
const referralSchema = z
  .object({
    ad_id: z.string().trim().max(512).nullish(),
    referer_uri: z.string().url().max(4096).nullish(),
    ref: z.string().trim().max(2048).nullish(),
    source: z.string().trim().max(80).nullish(),
    type: z.string().trim().max(80).nullish(),
  })
  .passthrough();
const attachmentSchema = z.object({
  type: z.string().trim().min(1).max(80),
  payload: z
    .object({ url: z.string().url().max(4096).optional() })
    .passthrough()
    .optional(),
});
const storedAttachmentSchema = z.object({
  type: z.string().trim().min(1).max(80),
  url: z.string().url().max(4096).optional(),
});
const messagingEventSchema = z
  .object({
    sender: z.object({ id: identifier }),
    recipient: z.object({ id: identifier }),
    timestamp: z.number().int().nonnegative().optional(),
    message: z
      .object({
        mid: identifier,
        text: z.string().max(10_000).optional(),
        is_echo: z.boolean().optional(),
        attachments: z.array(attachmentSchema).max(20).optional(),
      })
      .passthrough()
      .optional(),
    postback: z
      .object({
        mid: identifier.optional(),
        title: z.string().max(10_000).optional(),
        payload: z.string().max(10_000).optional(),
        referral: referralSchema.optional(),
      })
      .passthrough()
      .optional(),
    referral: referralSchema.optional(),
  })
  .passthrough()
  .refine((event) => Boolean(event.message || event.postback || event.referral));
const envelopeSchema = z.object({
  object: z.literal('page'),
  entry: z
    .array(
      z.object({
        id: identifier,
        time: z.number().int().nonnegative().optional(),
        messaging: z.array(z.unknown()).max(1000).optional(),
      }),
    )
    .max(1000),
});
const profileSchema = z
  .object({
    id: identifier,
    name: z.string().trim().max(200).nullish(),
    first_name: z.string().trim().max(100).nullish(),
    last_name: z.string().trim().max(100).nullish(),
    profile_pic: z.string().url().max(4096).nullish(),
  })
  .passthrough();

type Referral = z.infer<typeof referralSchema>;
interface MessengerEvent {
  sender_id: string;
  external_message_id: string;
  lead: LeadInput;
  message: {
    type: string;
    text: string;
    attachments: { type: string; url?: string }[];
    created_at: string;
  };
}
interface ConversationContext {
  non_commercial_reason?: string | null;
  id: string;
  opportunity_id: string;
  contact_id: string;
  last_message_at: Date | string;
  last_inbound_at?: Date | string | null;
  external_user_id: string;
  state: string;
  owner_id: string | null;
  reserved_to: string | null;
}

function eventDate(timestamp?: number) {
  const value = timestamp
    ? timestamp < 1_000_000_000_000
      ? timestamp * 1000
      : timestamp
    : Date.now();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function metaAttribution(referral?: Referral): MetaAttributionInput | undefined {
  if (!referral?.ad_id) return;
  return {
    provider: 'meta',
    channel: 'messenger',
    source_type: 'ad',
    source_id: referral.ad_id,
    source_url: referral.referer_uri ?? undefined,
  };
}

function normalizeEvent(
  input: z.infer<typeof messagingEventSchema>,
  config: MessengerConfig,
): MessengerEvent | undefined {
  if (
    input.recipient.id !== config.pageId ||
    input.sender.id === config.pageId ||
    input.message?.is_echo
  )
    return;
  const referral = input.referral ?? input.postback?.referral;
  const attribution = metaAttribution(referral);
  const kind = input.message ? 'message' : input.postback ? 'postback' : 'referral';
  if (kind === 'referral' && !attribution) return;
  const attachments = (input.message?.attachments ?? []).map((item) => ({
    type: item.type,
    ...(item.payload?.url ? { url: item.payload.url } : {}),
  }));
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(input.postback ?? referral ?? {}))
    .digest('hex')
    .slice(0, 24);
  const externalMessageId =
    input.message?.mid ??
    input.postback?.mid ??
    `${kind}:${input.sender.id}:${input.timestamp ?? 'without-timestamp'}:${fingerprint}`;
  const createdAt = eventDate(input.timestamp).toISOString();
  return {
    sender_id: input.sender.id,
    external_message_id: externalMessageId,
    message: {
      type: input.message
        ? input.message.text
          ? 'text'
          : (attachments[0]?.type ?? 'unsupported')
        : kind,
      text: input.message?.text ?? input.postback?.title ?? input.postback?.payload ?? '',
      attachments,
      created_at: createdAt,
    },
    lead: {
      name: 'Contato Messenger',
      interest: 'Messenger do Facebook',
      unit: 'A definir',
      source: attribution ? 'Meta Ads' : 'Facebook Messenger — origem orgânica',
      source_evidence: attribution
        ? 'Webhook do Messenger assinado com referência de anúncio enviada pela Meta.'
        : 'Entrada confirmada pelo Messenger da Página; nenhuma referência de anúncio foi fornecida.',
      meta_attribution: attribution,
      source_event_at: createdAt,
      identity: {
        provider: 'messenger',
        account_id: config.pageId,
        external_user_id: input.sender.id,
      },
    },
  };
}

function secretMatches(left: string, right: string) {
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest(),
  );
}

function mediaContentType(type: string, received: string) {
  if (received && received !== 'application/octet-stream') return received;
  if (['image', 'photo', 'animated_image'].includes(type.toLowerCase())) return 'image/jpeg';
  if (['audio', 'voice', 'voice_message'].includes(type.toLowerCase())) return 'audio/mpeg';
  if (type.toLowerCase() === 'video') return 'video/mp4';
  return received;
}

function imageExtension(contentType: string) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/gif') return 'gif';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/avif') return 'avif';
  return 'jpg';
}

export class MessengerCentral {
  private profileCache = new Map<string, { expires: number; name?: string; picture?: string }>();
  private profilePausedUntil = 0;
  private mediaProxy: MediaProxy;

  constructor(
    readonly crm: CRM | MongoOperations,
    private config?: MessengerConfig,
    private request: MessengerFetch = fetch,
  ) {
    this.mediaProxy = new MediaProxy(request);
  }

  async receive(raw: Buffer, signature: unknown) {
    const config = this.config;
    if (!config) throw new DomainError('MESSENGER_DISABLED', 'Messenger não configurado.', 503);
    if (
      typeof signature !== 'string' ||
      !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
      !timingSafeEqual(
        createHmac('sha256', config.appSecret).update(raw).digest(),
        Buffer.from(signature.slice(7), 'hex'),
      )
    )
      throw new DomainError('INVALID_SIGNATURE', 'Assinatura inválida.', 401);
    let envelope: z.infer<typeof envelopeSchema>;
    try {
      envelope = envelopeSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new DomainError('INVALID_WEBHOOK', 'Evento do Messenger inválido.', 400);
    }
    const events: { id: string; value: MessengerEvent }[] = [];
    for (const entry of envelope.entry) {
      if (entry.id !== config.pageId) continue;
      for (const rawEvent of entry.messaging ?? []) {
        const parsed = messagingEventSchema.safeParse(rawEvent);
        if (!parsed.success) continue;
        const value = normalizeEvent(parsed.data, config);
        if (value)
          events.push({ id: `messenger:${config.pageId}:${value.external_message_id}`, value });
      }
    }
    if (!events.length) return 0;
    const db = this.crm.db;
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        const now = await tx.now();
        for (const [index, event] of events.entries()) {
          if (await wasDeleted(tx, event.id)) continue;
          const receivedAt = new Date(now.getTime() + index);
          await tx.collection('messenger_webhook_inbox').updateOne(
            { event_id: event.id },
            {
              $setOnInsert: {
                event_id: event.id,
                page_id: config.pageId,
                event: event.value,
                received_at: receivedAt,
                available_at: receivedAt,
                processed_at: null,
                attempts: 0,
                lease_id: null,
                last_error: null,
              },
            },
            { upsert: true, session: tx.session },
          );
        }
      });
    else
      await db.transaction(async (tx) => {
        for (const [index, event] of events.entries()) {
          if (await wasDeleted(tx, event.id)) continue;
          await tx.query(
            `INSERT INTO messenger_webhook_inbox(event_id,page_id,event,received_at,available_at)
             VALUES($1,$2,$3,clock_timestamp()+($4*interval '1 millisecond'),
               clock_timestamp()+($4*interval '1 millisecond')) ON CONFLICT(event_id) DO NOTHING`,
            [event.id, config.pageId, JSON.stringify(event.value), index],
          );
        }
      });
    return events.length;
  }

  private async pauseProfiles(until: number) {
    this.profilePausedUntil = Math.max(this.profilePausedUntil, until);
    const db = this.crm.db;
    const pausedUntil = new Date(this.profilePausedUntil);
    if (db.kind === 'mongo')
      await db.update(
        'channel_accounts',
        { provider: 'messenger', external_account_id: this.config!.pageId },
        { $max: { messenger_profile_paused_until: pausedUntil } },
      );
    else
      await db.query(
        `UPDATE channel_accounts SET messenger_profile_paused_until=GREATEST(messenger_profile_paused_until,$2)
        WHERE provider='messenger' AND external_account_id=$1`,
        [this.config!.pageId, pausedUntil],
      );
  }

  private async profile(senderId: string) {
    const cached = this.profileCache.get(senderId);
    if (cached && cached.expires > Date.now()) return cached;
    const config = this.config!;
    const url = new URL(
      `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(senderId)}`,
    );
    url.searchParams.set('fields', 'id,name,first_name,last_name,profile_pic');
    let response: Response;
    let body: unknown;
    try {
      response = await this.request(url, {
        headers: { Authorization: `Bearer ${config.pageAccessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      body = await response.json().catch(() => null);
    } catch {
      await this.pauseProfiles(Date.now() + 15 * 60_000);
      return;
    }
    const error = z
      .object({
        error: z.object({ code: z.number().optional(), is_transient: z.boolean().optional() }),
      })
      .safeParse(body);
    const retry = response.headers.get('retry-after')?.trim();
    const retryUntil = retry
      ? /^\d+(?:\.\d+)?$/.test(retry)
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry)
      : 0;
    const rateLimited =
      response.status === 429 ||
      (error.success &&
        [4, 17, 32, 613, 80000, 80001, 80002, 80004, 80006].includes(error.data.error.code ?? 0));
    if (
      rateLimited ||
      response.status >= 500 ||
      [401, 403].includes(response.status) ||
      (error.success &&
        (error.data.error.is_transient || [102, 190].includes(error.data.error.code ?? 0))) ||
      (Number.isFinite(retryUntil) && retryUntil > Date.now())
    )
      await this.pauseProfiles(
        Math.max(
          Date.now() + 15 * 60_000,
          Number.isFinite(retryUntil) && retryUntil <= 8.64e15 ? retryUntil : 0,
        ),
      );
    if (!response.ok || error.success) return;
    const parsed = profileSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== senderId) return;
    const name =
      parsed.data.name ??
      ([parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(' ').trim() ||
        undefined);
    const value = {
      expires: Date.now() + 24 * 60 * 60_000,
      name,
      picture: parsed.data.profile_pic ?? undefined,
    };
    if (this.profileCache.size >= 2_000)
      this.profileCache.delete(this.profileCache.keys().next().value!);
    this.profileCache.set(senderId, value);
    return value;
  }

  private async refreshProfile(senderId: string, opportunityId: string) {
    const config = this.config!;
    const profile = await this.profile(senderId);
    if (!profile) return;
    const db = this.crm.db;
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        const now = await tx.now();
        const opportunity = await tx.one<Opportunity>('opportunities', { id: opportunityId });
        if (!opportunity) return;
        await tx.update(
          'contact_identities',
          {
            contact_id: opportunity.contact_id,
            provider: 'messenger',
            channel_account_id: config.pageId,
            external_user_id: senderId,
          },
          {
            $set: {
              ...(profile.name ? { display_name: profile.name } : {}),
              ...(profile.picture ? { profile_picture_url: profile.picture } : {}),
              profile_updated_at: now,
              profile_check_after: new Date(now.getTime() + 24 * 60 * 60_000),
            },
          },
        );
        if (profile.name)
          await tx.update(
            'contacts',
            { id: opportunity.contact_id, name: 'Contato Messenger' },
            { $set: { name: profile.name } },
          );
      });
    else
      await db.transaction(async (tx) => {
        const row = (
          await tx.query<{ contact_id: string }>(
            `UPDATE contact_identities ci SET
               display_name=CASE WHEN $3='' THEN ci.display_name ELSE $3 END,
               profile_picture_url=CASE WHEN $4='' THEN ci.profile_picture_url ELSE $4 END,
               profile_updated_at=clock_timestamp(),profile_check_after=clock_timestamp()+interval '24 hours'
             FROM opportunities o
             WHERE o.id=$1 AND ci.contact_id=o.contact_id AND ci.provider='messenger'
               AND ci.channel_account_id=$2 AND ci.external_user_id=$5
             RETURNING ci.contact_id`,
            [opportunityId, config.pageId, profile.name ?? '', profile.picture ?? '', senderId],
          )
        ).rows[0];
        if (row && profile.name)
          await tx.query("UPDATE contacts SET name=$2 WHERE id=$1 AND name='Contato Messenger'", [
            row.contact_id,
            profile.name,
          ]);
      });
  }

  async drainProfiles(limit = 3) {
    const config = this.config;
    if (!config || this.profilePausedUntil > Date.now()) return;
    const db = this.crm.db;
    const account =
      db.kind === 'mongo'
        ? await db.one<{ messenger_profile_paused_until?: Date }>('channel_accounts', {
            provider: 'messenger',
            external_account_id: config.pageId,
          })
        : (
            await db.query<{ messenger_profile_paused_until: Date | null }>(
              "SELECT messenger_profile_paused_until FROM channel_accounts WHERE provider='messenger' AND external_account_id=$1",
              [config.pageId],
            )
          ).rows[0];
    this.profilePausedUntil = new Date(account?.messenger_profile_paused_until ?? 0).getTime();
    if (this.profilePausedUntil > Date.now()) return;
    for (let index = 0; index < limit; index++) {
      const filter = {
        provider: 'messenger',
        channel_account_id: config.pageId,
        profile_pending: true,
        $or: [{ profile_check_after: { $lte: new Date() } }, { profile_check_after: null }],
      };
      const candidate =
        db.kind === 'mongo'
          ? await db.collection('contact_identities').findOne(filter, { projection: { id: 1 } })
          : (
              await db.query(
                `SELECT id FROM contact_identities WHERE provider='messenger' AND channel_account_id=$1
                 AND profile_pending AND profile_check_after<=clock_timestamp() LIMIT 1`,
                [config.pageId],
              )
            ).rows[0];
      if (!candidate) return;
      const job =
        db.kind === 'mongo'
          ? await db.atomic(async (tx) => {
              const identity = await tx.one('contact_identities', { ...filter, id: candidate.id });
              if (!identity) return;
              const now = await tx.now();
              await tx.update(
                'contact_identities',
                { id: identity.id },
                {
                  $set: {
                    profile_pending: false,
                    profile_check_after: new Date(now.getTime() + 15 * 60_000),
                  },
                },
              );
              return {
                sender: identity.external_user_id as string,
                opportunity: identity.profile_opportunity_id as string,
              };
            })
          : await db.transaction(async (tx) => {
              const identity = (
                await tx.query<{ external_user_id: string; profile_opportunity_id: string }>(
                  `UPDATE contact_identities SET profile_pending=false,
                     profile_check_after=clock_timestamp()+interval '15 minutes'
                   WHERE id=$1 AND profile_pending AND profile_check_after<=clock_timestamp()
                   RETURNING external_user_id,profile_opportunity_id`,
                  [candidate.id],
                )
              ).rows[0];
              return identity
                ? {
                    sender: identity.external_user_id,
                    opportunity: identity.profile_opportunity_id,
                  }
                : undefined;
            });
      if (job?.opportunity) {
        await this.refreshProfile(job.sender, job.opportunity);
        if (this.profilePausedUntil > Date.now()) {
          // Preserve the job during transient failures, without retrying other profiles meanwhile.
          const retryAt = new Date(this.profilePausedUntil);
          if (db.kind === 'mongo')
            await db.update(
              'contact_identities',
              {
                provider: 'messenger',
                channel_account_id: config.pageId,
                external_user_id: job.sender,
              },
              { $set: { profile_pending: true }, $max: { profile_check_after: retryAt } },
            );
          else
            await db.query(
              `UPDATE contact_identities SET profile_pending=true,profile_check_after=GREATEST(profile_check_after,$3)
              WHERE provider='messenger' AND channel_account_id=$1 AND external_user_id=$2`,
              [config.pageId, job.sender, retryAt],
            );
          return;
        }
      }
    }
  }

  private async persistInbound(
    eventId: string,
    lease: string,
    value: MessengerEvent,
    opportunityId: string,
  ) {
    const config = this.config!;
    const db = this.crm.db;
    if (db.kind === 'mongo')
      return db.atomic(async (tx) => {
        const now = await tx.now();
        const opportunity = await tx.one<Opportunity>('opportunities', { id: opportunityId });
        if (!opportunity) throw new Error('Missing opportunity');
        let account = await tx.one('channel_accounts', {
          provider: 'messenger',
          external_account_id: config.pageId,
        });
        if (!account) {
          account = {
            id: randomUUID(),
            provider: 'messenger',
            external_account_id: config.pageId,
            username: '',
            status: 'active',
            graph_api_version: config.graphApiVersion,
            created_at: now,
            updated_at: now,
          };
          await tx.insert('channel_accounts', account);
        }
        let conversation = await tx.one('conversations', {
          channel_account_id: account.id,
          opportunity_id: opportunityId,
        });
        const createdAt = new Date(value.message.created_at);
        if (!conversation) {
          conversation = {
            id: randomUUID(),
            channel_account_id: account.id,
            contact_id: opportunity.contact_id,
            opportunity_id: opportunityId,
            status: 'open',
            last_message_at: createdAt,
            last_inbound_at: createdAt,
            last_outbound_at: null,
            created_at: now,
            updated_at: now,
          };
          await tx.insert('conversations', conversation);
        } else
          await tx.update(
            'conversations',
            { id: conversation.id },
            {
              $max: { last_message_at: createdAt, last_inbound_at: createdAt },
              $set: { updated_at: now },
            },
          );
        const inserted = await tx.collection('messages').updateOne(
          { external_message_id: value.external_message_id },
          {
            $setOnInsert: {
              id: randomUUID(),
              conversation_id: conversation.id,
              external_message_id: value.external_message_id,
              direction: 'inbound',
              sender_external_id: value.sender_id,
              type: value.message.type,
              text: value.message.text,
              attachments: value.message.attachments,
              status: 'received',
              created_at: createdAt,
            },
          },
          { upsert: true, session: tx.session },
        );
        if (inserted.upsertedCount)
          await tx.update(
            'contact_identities',
            {
              provider: 'messenger',
              channel_account_id: config.pageId,
              external_user_id: value.sender_id,
            },
            { $set: { profile_pending: true, profile_opportunity_id: opportunityId } },
          );
        if (inserted.upsertedCount)
          await enqueuePushEvent(tx, eventId, opportunityId, 'message.received', now);
        await tx.update(
          'messenger_webhook_inbox',
          { event_id: eventId, lease_id: lease },
          {
            $set: {
              processed_at: now,
              opportunity_id: opportunityId,
              conversation_id: conversation.id,
              lease_id: null,
              last_error: null,
            },
          },
        );
        return conversation.id as string;
      });
    return db.transaction(async (tx) => {
      const opportunity = (
        await tx.query<{ contact_id: string }>('SELECT contact_id FROM opportunities WHERE id=$1', [
          opportunityId,
        ])
      ).rows[0];
      if (!opportunity) throw new Error('Missing opportunity');
      const account = (
        await tx.query<{ id: string }>(
          `INSERT INTO channel_accounts(id,provider,external_account_id,username,status,graph_api_version)
           VALUES($1,'messenger',$2,'','active',$3)
           ON CONFLICT(provider,external_account_id) DO UPDATE SET graph_api_version=EXCLUDED.graph_api_version,
             status='active',updated_at=clock_timestamp() RETURNING id`,
          [randomUUID(), config.pageId, config.graphApiVersion],
        )
      ).rows[0];
      const createdAt = new Date(value.message.created_at);
      const conversation = (
        await tx.query<{ id: string }>(
          `INSERT INTO conversations(
             id,channel_account_id,contact_id,opportunity_id,status,last_message_at,last_inbound_at,created_at,updated_at
           ) VALUES($1,$2,$3,$4,'open',$5,$5,clock_timestamp(),clock_timestamp())
           ON CONFLICT(channel_account_id,opportunity_id) DO UPDATE SET
             last_message_at=GREATEST(conversations.last_message_at,EXCLUDED.last_message_at),
             last_inbound_at=GREATEST(conversations.last_inbound_at,EXCLUDED.last_inbound_at),
             updated_at=clock_timestamp() RETURNING id`,
          [randomUUID(), account.id, opportunity.contact_id, opportunityId, createdAt],
        )
      ).rows[0];
      const inserted = await tx.query(
        `INSERT INTO messages(
           id,conversation_id,external_message_id,direction,sender_external_id,type,text,attachments,status,created_at
         ) VALUES($1,$2,$3,'inbound',$4,$5,$6,$7,'received',$8)
         ON CONFLICT(external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING RETURNING id`,
        [
          randomUUID(),
          conversation.id,
          value.external_message_id,
          value.sender_id,
          value.message.type,
          value.message.text,
          JSON.stringify(value.message.attachments),
          createdAt,
        ],
      );
      if (inserted.rows.length)
        await tx.query(
          `UPDATE contact_identities SET profile_pending=true,profile_opportunity_id=$3
           WHERE provider='messenger' AND channel_account_id=$1 AND external_user_id=$2`,
          [config.pageId, value.sender_id, opportunityId],
        );
      if (inserted.rows.length)
        await enqueuePushEvent(tx, eventId, opportunityId, 'message.received', new Date());
      await tx.query(
        `UPDATE messenger_webhook_inbox SET processed_at=clock_timestamp(),opportunity_id=$3,
         conversation_id=$4,lease_id=NULL,last_error=NULL WHERE event_id=$1 AND lease_id=$2`,
        [eventId, lease, opportunityId, conversation.id],
      );
      return conversation.id;
    });
  }

  async drain(limit = 25) {
    if (!this.config) return;
    const db = this.crm.db;
    if (
      db.kind === 'mongo' &&
      !(await db.collection('messenger_webhook_inbox').findOne(
        {
          page_id: this.config.pageId,
          processed_at: null,
          available_at: { $lte: await db.now() },
        },
        { projection: { _id: 1 } },
      ))
    )
      return;
    for (let index = 0; index < limit; index++) {
      const lease = randomUUID();
      const row =
        db.kind === 'mongo'
          ? await db.atomic(async (tx) => {
              const now = await tx.now();
              const selected = (
                await tx.many<{ event_id: string; event: MessengerEvent; attempts: number }>(
                  'messenger_webhook_inbox',
                  {
                    page_id: this.config!.pageId,
                    processed_at: null,
                    available_at: { $lte: now },
                  },
                  { received_at: 1, event_id: 1 },
                  1,
                )
              )[0];
              if (!selected) return;
              await tx.update(
                'messenger_webhook_inbox',
                { event_id: selected.event_id },
                {
                  $set: { lease_id: lease, available_at: new Date(now.getTime() + 120_000) },
                  $inc: { attempts: 1 },
                },
              );
              return selected;
            })
          : await db.transaction(async (tx) => {
              const selected = (
                await tx.query<{ event_id: string; event: MessengerEvent; attempts: number }>(
                  `SELECT event_id,event,attempts FROM messenger_webhook_inbox
                   WHERE processed_at IS NULL AND available_at<=clock_timestamp() AND page_id=$1
                   ORDER BY received_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
                  [this.config!.pageId],
                )
              ).rows[0];
              if (!selected) return;
              await tx.query(
                `UPDATE messenger_webhook_inbox SET lease_id=$2,attempts=attempts+1,
                 available_at=clock_timestamp()+interval '2 minutes' WHERE event_id=$1`,
                [selected.event_id, lease],
              );
              return selected;
            });
      if (!row) return;
      try {
        const value = typeof row.event === 'string' ? JSON.parse(row.event) : row.event;
        const result = await this.crm.ingest(value.lead, row.event_id, null);
        await this.persistInbound(row.event_id, lease, value, result.id);
      } catch {
        const seconds = Math.min(300, 2 ** Math.min(row.attempts + 1, 8));
        if (db.kind === 'mongo')
          await db.update(
            'messenger_webhook_inbox',
            { event_id: row.event_id, lease_id: lease },
            {
              $set: {
                lease_id: null,
                last_error: 'PROCESSING_FAILED',
                available_at: new Date((await db.now()).getTime() + seconds * 1000),
              },
            },
          );
        else
          await db.query(
            `UPDATE messenger_webhook_inbox SET lease_id=NULL,last_error='PROCESSING_FAILED',
             available_at=clock_timestamp()+($3*interval '1 second') WHERE event_id=$1 AND lease_id=$2`,
            [row.event_id, lease, seconds],
          );
      }
    }
  }

  async owns(conversationId: string) {
    if (!this.config) return false;
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      const account = await db.one('channel_accounts', {
        provider: 'messenger',
        external_account_id: this.config.pageId,
      });
      return Boolean(
        account &&
        (await db.one('conversations', { id: conversationId, channel_account_id: account.id })),
      );
    }
    return Boolean(
      (
        await db.query(
          `SELECT cv.id FROM conversations cv JOIN channel_accounts ca ON ca.id=cv.channel_account_id
           WHERE cv.id=$1 AND ca.provider='messenger' AND ca.external_account_id=$2`,
          [conversationId, this.config.pageId],
        )
      ).rows.length,
    );
  }

  private async context(user: User, conversationId: string): Promise<ConversationContext> {
    if (!this.config)
      throw new DomainError('MESSENGER_DISABLED', 'Messenger não configurado.', 503);
    const db = this.crm.db;
    let context: ConversationContext | null;
    if (db.kind === 'mongo') {
      const account = await db.one('channel_accounts', {
        provider: 'messenger',
        external_account_id: this.config.pageId,
      });
      const conversation = account
        ? await db.one<ConversationContext>('conversations', {
            id: conversationId,
            channel_account_id: account.id,
          })
        : null;
      const opportunity = conversation
        ? await db.one<Opportunity>('opportunities', { id: conversation.opportunity_id })
        : null;
      const identity = conversation
        ? await db.one<{ external_user_id: string }>('contact_identities', {
            contact_id: conversation.contact_id,
            provider: 'messenger',
            channel_account_id: this.config.pageId,
          })
        : null;
      context =
        conversation && opportunity && identity
          ? {
              ...conversation,
              external_user_id: identity.external_user_id,
              state: opportunity.state,
              non_commercial_reason: opportunity.non_commercial_reason,
              owner_id: opportunity.owner_id,
              reserved_to: opportunity.reserved_to,
            }
          : null;
    } else
      context =
        (
          await db.query<ConversationContext>(
            `SELECT cv.id,cv.opportunity_id,cv.contact_id,cv.last_message_at,cv.last_inbound_at,
                    o.state,o.owner_id,o.reserved_to,o.non_commercial_reason,ci.external_user_id
             FROM conversations cv JOIN opportunities o ON o.id=cv.opportunity_id
             JOIN channel_accounts ca ON ca.id=cv.channel_account_id
             JOIN LATERAL(SELECT external_user_id FROM contact_identities i
               WHERE i.contact_id=cv.contact_id AND i.provider='messenger'
                 AND i.channel_account_id=ca.external_account_id LIMIT 1) ci ON TRUE
             WHERE cv.id=$1 AND ca.provider='messenger' AND ca.external_account_id=$2`,
            [conversationId, this.config.pageId],
          )
        ).rows[0] ?? null;
    if (!context) throw new DomainError('NOT_FOUND', 'Conversa não encontrada.', 404);
    if (
      user.role !== 'manager' &&
      context.owner_id !== user.id &&
      !(
        context.state !== 'CANCELLED' &&
        !context.non_commercial_reason &&
        (await canReviewOwner(db, user, context.owner_id))
      )
    )
      throw new DomainError('FORBIDDEN', 'Assuma o lead para acessar esta conversa.', 403);
    return context;
  }

  private async unreadConversationIds(userId: string, ids: string[]) {
    const unread = new Set<string>();
    if (!ids.length) return unread;
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      const rows = await db
        .collection('conversations')
        .aggregate<{ id: string }>([
          { $match: { id: { $in: ids } } },
          {
            $lookup: {
              from: 'messages',
              let: { conversationId: '$id' },
              pipeline: [
                {
                  $match: {
                    direction: 'inbound',
                    $expr: { $eq: ['$conversation_id', '$$conversationId'] },
                  },
                },
                { $sort: { created_at: -1, id: -1 } },
                { $limit: 1 },
                { $project: { _id: 0, id: 1, created_at: 1 } },
              ],
              as: 'inbound',
            },
          },
          { $set: { inbound: { $first: '$inbound' } } },
          { $match: { 'inbound.id': { $exists: true } } },
          {
            $lookup: {
              from: 'conversation_reads',
              let: { conversationId: '$id' },
              pipeline: [
                {
                  $match: {
                    user_id: userId,
                    $expr: { $eq: ['$conversation_id', '$$conversationId'] },
                  },
                },
                { $project: { _id: 0, last_read_message_id: 1 } },
              ],
              as: 'read',
            },
          },
          {
            $lookup: {
              from: 'messages',
              localField: 'read.last_read_message_id',
              foreignField: 'id',
              as: 'read_message',
            },
          },
          { $set: { read_message: { $first: '$read_message' } } },
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: [{ $ifNull: ['$read_message.id', null] }, null] },
                  { $gt: ['$inbound.created_at', '$read_message.created_at'] },
                  {
                    $and: [
                      { $eq: ['$inbound.created_at', '$read_message.created_at'] },
                      { $gt: ['$inbound.id', '$read_message.id'] },
                    ],
                  },
                ],
              },
            },
          },
          { $project: { _id: 0, id: 1 } },
        ])
        .toArray();
      for (const row of rows) unread.add(row.id);
      return unread;
    }
    const rows = (
      await db.query<{ conversation_id: string }>(
        `SELECT selected.conversation_id FROM unnest($1::uuid[]) AS selected(conversation_id)
         JOIN LATERAL(SELECT id,created_at FROM messages WHERE conversation_id=selected.conversation_id
           AND direction='inbound' ORDER BY created_at DESC,id DESC LIMIT 1) inbound ON TRUE
         LEFT JOIN conversation_reads reads ON reads.conversation_id=selected.conversation_id AND reads.user_id=$2
         LEFT JOIN messages read_message ON read_message.id=reads.last_read_message_id
         WHERE read_message.id IS NULL OR
           (read_message.created_at,read_message.id)<(inbound.created_at,inbound.id)`,
        [ids, userId],
      )
    ).rows;
    for (const row of rows) unread.add(row.conversation_id);
    return unread;
  }

  async list(
    user: User,
    view: 'mine' | 'reserved' | 'pool' | 'all' | 'non_commercial' | 'review' = 'mine',
  ) {
    if (!this.config) return { configured: false, conversations: [] as Record<string, unknown>[] };
    if (view === 'all' && user.role !== 'manager')
      throw new DomainError('FORBIDDEN', 'Visão completa restrita à gestão.', 403);
    if (view === 'pool' && user.role === 'attendant' && !user.queue_enabled)
      throw new DomainError(
        'POOL_ACCESS_DISABLED',
        'O bolsão está disponível somente para consultores que participam do rodízio.',
        403,
      );
    const db = this.crm.db;
    if (view === 'review' && user.role !== 'attendant')
      throw new DomainError('FORBIDDEN', 'A carteira de revisão é exclusiva dos consultores.', 403);
    const reviewOwners = view === 'review' ? await reviewSourceIds(db, user.id) : [];
    const archived = view === 'non_commercial';
    if (archived) view = user.role === 'manager' ? 'all' : 'mine';
    let rows: Array<{
      id: string;
      opportunity_id: string;
      contact_name: string;
      profile_picture_url: string;
      state: string;
      owner_id: string | null;
      reserved_to: string | null;
      version: number;
      non_commercial_reason: string | null;
      last_message_at: Date | string;
      last_inbound_at: Date | string | null;
    }> = [];
    if (db.kind === 'mongo') {
      const account = await db.one('channel_accounts', {
        provider: 'messenger',
        external_account_id: this.config.pageId,
      });
      if (account) {
        const all = user.role === 'manager' && view === 'all';
        const visibility =
          view === 'mine'
            ? { owner_id: user.id }
            : view === 'review'
              ? { owner_id: { $in: reviewOwners }, state: { $ne: 'CANCELLED' } }
              : view === 'reserved'
                ? {
                    state: 'RESERVED',
                    ...(user.role === 'manager' ? {} : { reserved_to: user.id }),
                  }
                : user.role === 'manager' || (user.active && user.queue_enabled)
                  ? { state: 'POOL' }
                  : { id: '__inactive_user_cannot_view_pool__' };
        // Scope ownership before limiting. One aggregation replaces per-conversation reads.
        rows = await db
          .collection(all ? 'conversations' : 'opportunities')
          .aggregate<(typeof rows)[number]>([
            ...(all
              ? [
                  { $match: { channel_account_id: account.id } },
                  { $sort: { last_message_at: -1, id: 1 } },
                  {
                    $lookup: {
                      from: 'opportunities',
                      localField: 'opportunity_id',
                      foreignField: 'id',
                      as: 'opportunity',
                    },
                  },
                  { $unwind: '$opportunity' },
                ]
              : [
                  {
                    $match: {
                      ...visibility,
                      non_commercial_reason: archived ? { $ne: null } : null,
                    },
                  },
                  {
                    $project: {
                      _id: 0,
                      opportunity: {
                        id: '$id',
                        state: '$state',
                        owner_id: '$owner_id',
                        reserved_to: '$reserved_to',
                        version: '$version',
                        non_commercial_reason: '$non_commercial_reason',
                      },
                    },
                  },
                  {
                    $lookup: {
                      from: 'conversations',
                      let: { opportunityId: '$opportunity.id' },
                      pipeline: [
                        {
                          $match: {
                            channel_account_id: account.id,
                            $expr: { $eq: ['$opportunity_id', '$$opportunityId'] },
                          },
                        },
                      ],
                      as: 'conversation',
                    },
                  },
                  { $unwind: '$conversation' },
                  {
                    $replaceRoot: {
                      newRoot: {
                        $mergeObjects: ['$conversation', { opportunity: '$opportunity' }],
                      },
                    },
                  },
                ]),
            { $match: { 'opportunity.non_commercial_reason': archived ? { $ne: null } : null } },
            // The account-wide stream is already index-sorted; do not re-sort it after lookup.
            ...(all ? [] : [{ $sort: { last_message_at: -1, id: 1 } }]),
            { $limit: 100 },
            {
              $lookup: {
                from: 'contacts',
                localField: 'contact_id',
                foreignField: 'id',
                as: 'contact',
              },
            },
            {
              $lookup: {
                from: 'contact_identities',
                let: { contactId: '$contact_id' },
                pipeline: [
                  {
                    $match: {
                      provider: 'messenger',
                      channel_account_id: this.config.pageId,
                      $expr: { $eq: ['$contact_id', '$$contactId'] },
                    },
                  },
                  { $limit: 1 },
                  { $project: { _id: 0, profile_picture_url: 1 } },
                ],
                as: 'identity',
              },
            },
            { $set: { contact: { $first: '$contact' }, identity: { $first: '$identity' } } },
            {
              $project: {
                _id: 0,
                id: 1,
                opportunity_id: '$opportunity.id',
                contact_name: { $ifNull: ['$contact.name', 'Contato Messenger'] },
                profile_picture_url: { $ifNull: ['$identity.profile_picture_url', ''] },
                state: '$opportunity.state',
                owner_id: '$opportunity.owner_id',
                reserved_to: '$opportunity.reserved_to',
                version: '$opportunity.version',
                non_commercial_reason: { $ifNull: ['$opportunity.non_commercial_reason', null] },
                last_message_at: 1,
                last_inbound_at: { $ifNull: ['$last_inbound_at', null] },
              },
            },
          ])
          .toArray();
      }
    } else {
      const visibility =
        user.role === 'manager'
          ? view === 'all'
            ? 'TRUE'
            : view === 'mine'
              ? 'o.owner_id=$2'
              : view === 'reserved'
                ? "o.state='RESERVED'"
                : "o.state='POOL'"
          : view === 'mine'
            ? 'o.owner_id=$2'
            : view === 'review'
              ? "o.owner_id=ANY($2::uuid[]) AND o.state<>'CANCELLED'"
              : view === 'reserved'
                ? "o.state='RESERVED' AND o.reserved_to=$2"
                : user.active && user.queue_enabled
                  ? "o.state='POOL'"
                  : 'FALSE';
      rows = (
        await db.query(
          `SELECT cv.id,o.id AS opportunity_id,c.name AS contact_name,
                  COALESCE(ci.profile_picture_url,'') AS profile_picture_url,o.state,o.owner_id,
                  o.reserved_to,o.version,o.non_commercial_reason,cv.last_message_at,cv.last_inbound_at
           FROM conversations cv JOIN opportunities o ON o.id=cv.opportunity_id
           JOIN contacts c ON c.id=cv.contact_id JOIN channel_accounts ca ON ca.id=cv.channel_account_id
           LEFT JOIN LATERAL(SELECT * FROM contact_identities i WHERE i.contact_id=cv.contact_id
             AND i.provider='messenger' AND i.channel_account_id=ca.external_account_id LIMIT 1) ci ON TRUE
           WHERE ca.provider='messenger' AND ca.external_account_id=$1
             AND o.non_commercial_reason IS ${archived ? 'NOT NULL' : 'NULL'} AND (${visibility})
           ORDER BY cv.last_message_at DESC,cv.id LIMIT 100`,
          visibility.includes('$2')
            ? [this.config.pageId, view === 'review' ? reviewOwners : user.id]
            : [this.config.pageId],
        )
      ).rows as typeof rows;
    }
    const unread = await this.unreadConversationIds(
      user.id,
      rows.map((row) => row.id),
    );
    const muted =
      user.role === 'attendant'
        ? await mutedOpportunityIds(
            db,
            user.id,
            rows.map((row) => row.opportunity_id),
          )
        : new Set<string>();
    return {
      configured: true,
      conversations: rows.map((row) => {
        const withinWindow =
          Boolean(row.last_inbound_at) &&
          Date.now() - new Date(row.last_inbound_at!).getTime() < 24 * 60 * 60_000;
        return {
          ...row,
          channel: 'messenger' as const,
          instagram_username: '',
          unread: !archived && unread.has(row.id),
          notifications_muted: archived || muted.has(row.opportunity_id),
          messaging_mode: withinWindow ? ('direct' as const) : ('expired' as const),
          review_shared: view === 'review',
          can_send: withinWindow && row.state === 'CLAIMED' && row.owner_id === user.id,
        };
      }),
    };
  }

  async messages(user: User, conversationId: string, afterMessageId?: string) {
    const context = await this.context(user, conversationId);
    const db = this.crm.db;
    let messages: Record<string, unknown>[];
    if (db.kind === 'mongo') {
      const projection = {
        _id: 0,
        id: 1,
        external_message_id: 1,
        direction: 1,
        sender_user_id: 1,
        type: 1,
        text: 1,
        attachments: 1,
        status: 1,
        error_code: 1,
        sent_at: 1,
        delivered_at: 1,
        read_at: 1,
        created_at: 1,
      };
      if (afterMessageId) {
        const cursor = await db.one<{ created_at: Date; id: string }>('messages', {
          id: afterMessageId,
          conversation_id: context.id,
        });
        if (!cursor) throw new DomainError('INVALID_CURSOR', 'Atualize a conversa novamente.', 400);
        messages = await db
          .collection('messages')
          .find({
            conversation_id: context.id,
            $or: [
              { created_at: { $gt: cursor.created_at } },
              { created_at: cursor.created_at, id: { $gt: cursor.id } },
            ],
          })
          .project(projection)
          .sort({ created_at: 1, id: 1 })
          .limit(201)
          .toArray();
      } else
        messages = (
          await db
            .collection('messages')
            .find({ conversation_id: context.id })
            .project(projection)
            .sort({ created_at: -1, id: -1 })
            .limit(201)
            .toArray()
        ).reverse();
    } else if (afterMessageId) {
      const cursor = (
        await db.query<{ created_at: Date | string; id: string }>(
          'SELECT created_at,id FROM messages WHERE id=$1 AND conversation_id=$2',
          [afterMessageId, context.id],
        )
      ).rows[0];
      if (!cursor) throw new DomainError('INVALID_CURSOR', 'Atualize a conversa novamente.', 400);
      messages = (
        await db.query(
          `SELECT id,external_message_id,direction,sender_user_id,type,text,attachments,status,
                  error_code,sent_at,delivered_at,read_at,created_at FROM messages
           WHERE conversation_id=$1 AND (created_at,id)>($2,$3) ORDER BY created_at,id LIMIT 201`,
          [context.id, cursor.created_at, cursor.id],
        )
      ).rows;
    } else
      messages = (
        await db.query(
          `SELECT * FROM(SELECT id,external_message_id,direction,sender_user_id,type,text,attachments,
             status,error_code,sent_at,delivered_at,read_at,created_at FROM messages
             WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 201) recent
           ORDER BY created_at,id`,
          [context.id],
        )
      ).rows;
    const hasMore = messages.length > 200;
    if (hasMore) messages = afterMessageId ? messages.slice(0, 200) : messages.slice(-200);
    return {
      conversation_id: context.id,
      opportunity_id: context.opportunity_id,
      can_send:
        context.state === 'CLAIMED' &&
        context.owner_id === user.id &&
        Boolean(context.last_inbound_at) &&
        Date.now() - new Date(context.last_inbound_at!).getTime() < 24 * 60 * 60_000,
      messaging_mode:
        context.last_inbound_at &&
        Date.now() - new Date(context.last_inbound_at).getTime() < 24 * 60 * 60_000
          ? 'direct'
          : 'expired',
      last_message_at: context.last_message_at,
      has_more: hasMore,
      messages,
    };
  }

  async markRead(user: User, conversationId: string, lastMessageId?: string) {
    const context = await this.context(user, conversationId);
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      await db.atomic(async (tx) => {
        const target = lastMessageId
          ? await tx.one<{ id: string; created_at: Date }>('messages', {
              id: lastMessageId,
              conversation_id: context.id,
            })
          : (
              await tx.many<{ id: string; created_at: Date }>(
                'messages',
                { conversation_id: context.id },
                { created_at: -1, id: -1 },
                1,
              )
            )[0];
        if (lastMessageId && !target)
          throw new DomainError('INVALID_MESSAGE', 'Mensagem não pertence à conversa.', 400);
        if (!target) return;
        const existing = await tx.one<{ last_read_message_id?: string | null }>(
          'conversation_reads',
          { conversation_id: context.id, user_id: user.id },
        );
        const previous = existing?.last_read_message_id
          ? await tx.one<{ id: string; created_at: Date }>('messages', {
              id: existing.last_read_message_id,
              conversation_id: context.id,
            })
          : null;
        const advances =
          !previous ||
          target.created_at.getTime() > previous.created_at.getTime() ||
          (target.created_at.getTime() === previous.created_at.getTime() &&
            target.id > previous.id);
        if (!existing || advances)
          await tx
            .collection('conversation_reads')
            .updateOne(
              { conversation_id: context.id, user_id: user.id },
              { $set: { last_read_message_id: target.id, read_at: await tx.now() } },
              { upsert: true, session: tx.session },
            );
      });
    } else {
      const target = lastMessageId
        ? (
            await db.query<{ id: string; created_at: Date | string }>(
              'SELECT id,created_at FROM messages WHERE id=$1 AND conversation_id=$2',
              [lastMessageId, context.id],
            )
          ).rows[0]
        : (
            await db.query<{ id: string; created_at: Date | string }>(
              'SELECT id,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
              [context.id],
            )
          ).rows[0];
      if (lastMessageId && !target)
        throw new DomainError('INVALID_MESSAGE', 'Mensagem não pertence à conversa.', 400);
      if (!target) return { read: true };
      await db.query(
        `INSERT INTO conversation_reads(conversation_id,user_id,last_read_message_id,read_at)
         VALUES($1,$2,$3,clock_timestamp())
         ON CONFLICT(conversation_id,user_id) DO UPDATE SET
           last_read_message_id=EXCLUDED.last_read_message_id,read_at=EXCLUDED.read_at
         WHERE conversation_reads.last_read_message_id IS NULL
            OR EXISTS (
              SELECT 1 FROM messages previous
              WHERE previous.id=conversation_reads.last_read_message_id
                AND (previous.created_at,previous.id)<=($4,$3)
            )`,
        [context.id, user.id, target.id, target.created_at],
      );
    }
    return { read: true };
  }

  async setNotificationsMuted(user: User, conversationId: string, muted: boolean) {
    if (user.role !== 'attendant')
      throw new DomainError(
        'FORBIDDEN',
        'Somente o consultor responsável pode silenciar este lead.',
        403,
      );
    const context = await this.context(user, conversationId);
    const db = this.crm.db;
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        const lead = await tx.one<Opportunity>('opportunities', { id: context.opportunity_id });
        if (!lead || lead.owner_id !== user.id)
          throw new DomainError('FORBIDDEN', 'Este lead não está mais vinculado a você.', 403);
        await setLeadNotificationMuted(tx, user.id, context.opportunity_id, muted);
      });
    else
      await db.transaction(async (tx) => {
        const lead = (
          await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [
            context.opportunity_id,
          ])
        ).rows[0];
        if (!lead || lead.owner_id !== user.id)
          throw new DomainError('FORBIDDEN', 'Este lead não está mais vinculado a você.', 403);
        await setLeadNotificationMuted(tx, user.id, context.opportunity_id, muted);
      });
    return { notifications_muted: muted };
  }

  private async setOutboundState(
    id: string,
    status: 'sent' | 'failed' | 'unknown',
    externalMessageId?: string,
    errorCode?: string,
  ) {
    const db = this.crm.db;
    const now = db.kind === 'mongo' ? await db.now() : new Date();
    if (db.kind === 'mongo') {
      const message = await db.one<{ conversation_id: string }>('messages', { id });
      await db.update(
        'messages',
        { id },
        {
          $set: {
            status,
            sending_started_at: null,
            ...(externalMessageId ? { external_message_id: externalMessageId, sent_at: now } : {}),
            error_code: errorCode ?? null,
          },
        },
      );
      if (status === 'sent' && message)
        await db.update(
          'conversations',
          { id: message.conversation_id },
          { $set: { last_message_at: now, last_outbound_at: now, updated_at: now } },
        );
    } else
      await db.transaction(async (tx) => {
        const updated = (
          await tx.query<{ conversation_id: string }>(
            `UPDATE messages SET status=$2,sending_started_at=NULL,
               external_message_id=COALESCE($3,external_message_id),error_code=$4,
               sent_at=CASE WHEN $2='sent' THEN clock_timestamp() ELSE sent_at END
             WHERE id=$1 RETURNING conversation_id`,
            [id, status, externalMessageId ?? null, errorCode ?? null],
          )
        ).rows[0];
        if (status === 'sent' && updated)
          await tx.query(
            `UPDATE conversations SET last_message_at=clock_timestamp(),last_outbound_at=clock_timestamp(),
               updated_at=clock_timestamp() WHERE id=$1`,
            [updated.conversation_id],
          );
      });
  }

  async recoverStaleSends(maxAgeMs = 120_000) {
    if (!this.config) return 0;
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      const cutoff = new Date((await db.now()).getTime() - maxAgeMs);
      const result = await db.collection('messages').updateMany(
        {
          client_request_id: { $regex: '^messenger:' },
          direction: 'outbound',
          status: 'sending',
          $or: [
            { sending_started_at: { $lte: cutoff } },
            { sending_started_at: { $exists: false }, created_at: { $lte: cutoff } },
            { sending_started_at: null, created_at: { $lte: cutoff } },
          ],
        },
        {
          $set: {
            status: 'unknown',
            error_code: 'PROCESS_INTERRUPTED',
            sending_started_at: null,
          },
        },
      );
      return result.modifiedCount;
    }
    const result = await db.query<{ id: string }>(
      `UPDATE messages SET status='unknown',error_code='PROCESS_INTERRUPTED',sending_started_at=NULL
       WHERE client_request_id LIKE 'messenger:%' AND direction='outbound' AND status='sending'
         AND COALESCE(sending_started_at,created_at)<=clock_timestamp()-($1*interval '1 millisecond')
       RETURNING id`,
      [maxAgeMs],
    );
    return result.rows.length;
  }

  // Serialize authorization with the outgoing reservation, just like queue/claim changes.
  // No provider request runs while the database transaction is open.
  private async authorizeSend(
    tx: MongoTx | Sql,
    user: User,
    context: ConversationContext,
    newSend: boolean,
  ) {
    const actor =
      tx instanceof MongoTx
        ? await tx.one<User>('users', { id: user.id })
        : await lockActor(tx, user);
    if (!actor?.active || actor.auth_version !== user.auth_version || actor.must_change_password)
      throw new DomainError('UNAUTHENTICATED', 'Sua sessão expirou.', 401);
    if (actor.role !== 'attendant')
      throw new DomainError('FORBIDDEN', 'Somente a responsável pode responder.', 403);
    const lead =
      tx instanceof MongoTx
        ? await tx.one<Opportunity>('opportunities', { id: context.opportunity_id })
        : (
            await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [
              context.opportunity_id,
            ])
          ).rows[0];
    const conversation =
      tx instanceof MongoTx
        ? await tx.one<ConversationContext>('conversations', { id: context.id })
        : (
            await tx.query<ConversationContext>(
              'SELECT * FROM conversations WHERE id=$1 FOR UPDATE',
              [context.id],
            )
          ).rows[0];
    if (
      !conversation ||
      conversation.opportunity_id !== lead?.id ||
      lead.state !== 'CLAIMED' ||
      lead.owner_id !== actor.id
    )
      throw new DomainError('FORBIDDEN', 'Esta conversa não pertence a você.', 403);
    // Replaying a receipt does not send again and remains possible after the window closes.
    if (!newSend) return;
    const now =
      tx instanceof MongoTx
        ? await tx.now()
        : (await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now;
    const lastInbound = new Date(conversation.last_inbound_at ?? '').getTime();
    if (!Number.isFinite(lastInbound) || new Date(now).getTime() - lastInbound >= 24 * 60 * 60_000)
      throw new DomainError(
        'MESSENGER_WINDOW_EXPIRED',
        'A janela de 24 horas do Messenger terminou. Aguarde uma nova mensagem do lead.',
        409,
      );
  }

  async send(user: User, conversationId: string, text: string, key: string) {
    const config = this.config;
    if (!config) throw new DomainError('MESSENGER_DISABLED', 'Messenger não configurado.', 503);
    const context = await this.context(user, conversationId);
    if (context.state !== 'CLAIMED' || context.owner_id !== user.id)
      throw new DomainError('FORBIDDEN', 'Aceite o lead antes de responder.', 403);
    const requestId = `messenger:${conversationId}:${user.id}:${key}`;
    const fingerprint = createHash('sha256').update(text).digest('hex');
    const db = this.crm.db;
    let messageId: string;
    let shouldSend: boolean;
    if (db.kind === 'mongo') {
      const queued = await db.atomic(async (tx) => {
        await tx.collection('messages').updateOne(
          { client_request_id: requestId },
          {
            $setOnInsert: {
              id: randomUUID(),
              conversation_id: conversationId,
              client_request_id: requestId,
              request_fingerprint: fingerprint,
              direction: 'outbound',
              sender_user_id: user.id,
              type: 'text',
              text,
              attachments: [],
              status: 'queued',
              error_code: null,
              created_at: await tx.now(),
            },
          },
          { upsert: true, session: tx.session },
        );
        const current = await tx.one<Record<string, any>>('messages', {
          client_request_id: requestId,
        });
        if (!current) throw new Error('Missing outbound message');
        if (current.request_fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com outra mensagem.');
        await this.authorizeSend(tx, user, context, current.status === 'queued');
        const claimed = await tx.update(
          'messages',
          { id: current.id, status: 'queued' },
          { $set: { status: 'sending', sending_started_at: await tx.now() } },
        );
        return { current, claimed: claimed.modifiedCount === 1 };
      });
      messageId = String(queued.current.id);
      shouldSend = queued.claimed;
      if (!shouldSend)
        return {
          id: messageId,
          status: queued.current.status,
          external_message_id: queued.current.external_message_id ?? null,
        };
    } else {
      const queued = await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
        await tx.query(
          `INSERT INTO messages(
             id,conversation_id,client_request_id,request_fingerprint,direction,sender_user_id,
             type,text,status,created_at
           ) VALUES($1,$2,$3,$4,'outbound',$5,'text',$6,'queued',clock_timestamp())
           ON CONFLICT(client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING`,
          [randomUUID(), conversationId, requestId, fingerprint, user.id, text],
        );
        const current = (
          await tx.query<{
            id: string;
            status: string;
            request_fingerprint: string;
            external_message_id: string | null;
          }>('SELECT * FROM messages WHERE client_request_id=$1 FOR UPDATE', [requestId])
        ).rows[0];
        if (!current) throw new Error('Missing outbound message');
        if (current.request_fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com outra mensagem.');
        await this.authorizeSend(tx, user, context, current.status === 'queued');
        const claimed = (
          await tx.query(
            `UPDATE messages SET status='sending',sending_started_at=clock_timestamp()
             WHERE id=$1 AND status='queued' RETURNING id`,
            [current.id],
          )
        ).rows.length;
        return { current, claimed: claimed === 1 };
      });
      messageId = queued.current.id;
      shouldSend = queued.claimed;
      if (!shouldSend)
        return {
          id: messageId,
          status: queued.current.status,
          external_message_id: queued.current.external_message_id,
        };
    }
    let response: Response;
    try {
      response = await this.request(
        `https://graph.facebook.com/${config.graphApiVersion}/${config.pageId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.pageAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient: { id: context.external_user_id },
            messaging_type: 'RESPONSE',
            message: { text },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      await this.setOutboundState(messageId, 'unknown', undefined, 'NETWORK_OR_TIMEOUT');
      throw new DomainError(
        'MESSENGER_SEND_UNKNOWN',
        'A Meta não confirmou o envio. Confira a conversa antes de tentar novamente.',
        502,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await this.setOutboundState(messageId, 'failed', undefined, `META_HTTP_${response.status}`);
      throw new DomainError(
        'MESSENGER_SEND_FAILED',
        'O Messenger recusou a mensagem. Atualize a conversa e verifique a integração.',
        502,
      );
    }
    const result = z
      .object({ recipient_id: z.string(), message_id: z.string() })
      .safeParse(await response.json().catch(() => null));
    if (!result.success) {
      await this.setOutboundState(messageId, 'unknown', undefined, 'INVALID_META_RESPONSE');
      throw new DomainError(
        'MESSENGER_SEND_UNKNOWN',
        'A Meta respondeu sem confirmar a mensagem. Confira a conversa antes de reenviar.',
        502,
      );
    }
    await this.setOutboundState(messageId, 'sent', result.data.message_id);
    return { id: messageId, status: 'sent', external_message_id: result.data.message_id };
  }

  async streamAttachment(
    user: User,
    conversationId: string,
    messageId: string,
    attachmentIndex: number,
    range?: string,
    signal?: AbortSignal,
    maxBytes?: number,
  ) {
    const context = await this.context(user, conversationId);
    const db = this.crm.db;
    const row =
      db.kind === 'mongo'
        ? await db.one<{ attachments?: unknown }>('messages', {
            id: messageId,
            conversation_id: context.id,
          })
        : (
            await db.query<{ attachments: unknown }>(
              'SELECT attachments FROM messages WHERE id=$1 AND conversation_id=$2',
              [messageId, context.id],
            )
          ).rows[0];
    if (!row) throw new DomainError('NOT_FOUND', 'Mídia não encontrada.', 404);
    let raw: unknown = row.attachments ?? [];
    if (typeof raw === 'string')
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new DomainError('MEDIA_UNAVAILABLE', 'Mídia indisponível.', 404);
      }
    const attachments = z.array(storedAttachmentSchema).max(20).safeParse(raw);
    const attachment = attachments.success ? attachments.data[attachmentIndex] : undefined;
    if (!attachment?.url || !trustedMediaUrl(attachment.url))
      throw new DomainError('MEDIA_UNAVAILABLE', 'Mídia indisponível.', 404);
    const response = await this.mediaProxy.open(user.id, attachment.url, range, signal, maxBytes);
    const received = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const contentType = mediaContentType(attachment.type, received);
    if (
      !/^(image\/(jpeg|png|gif|webp|avif)|audio\/(mpeg|mp4|aac|ogg|opus|wav|x-wav|webm|3gpp|amr)|video\/(mp4|webm|quicktime|ogg|3gpp))$/.test(
        contentType,
      )
    ) {
      await response.body.cancel().catch(() => {});
      throw new DomainError('MEDIA_UNAVAILABLE', 'A URL não contém uma mídia exibível.', 502);
    }
    return {
      body: response.body,
      contentType,
      contentLength: response.headers.get('content-length'),
      status: response.status,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
    };
  }

  async downloadImage(
    user: User,
    conversationId: string,
    messageId: string,
    attachmentIndex: number,
    signal?: AbortSignal,
  ) {
    const media = await this.streamAttachment(
      user,
      conversationId,
      messageId,
      attachmentIndex,
      undefined,
      signal,
      25 * 1024 * 1024,
    );
    if (!media.contentType.startsWith('image/')) {
      await media.body.cancel().catch(() => {});
      throw new DomainError('MEDIA_UNAVAILABLE', 'O arquivo recebido não é uma imagem.', 502);
    }
    return {
      ...media,
      fileName: `imagem-messenger-${messageId.slice(0, 8)}.${imageExtension(media.contentType)}`,
    };
  }

  async status() {
    if (!this.config)
      return {
        configured: false,
        state: 'disabled',
        pending: 0,
        retrying: 0,
        last_received_at: null,
        last_processed_at: null,
      };
    const db = this.crm.db;
    const row =
      db.kind === 'mongo'
        ? ((await db
            .collection('messenger_webhook_inbox')
            .aggregate([
              { $match: { page_id: this.config.pageId } },
              {
                $group: {
                  _id: null,
                  pending: { $sum: { $cond: [{ $eq: ['$processed_at', null] }, 1, 0] } },
                  retrying: {
                    $sum: {
                      $cond: [
                        {
                          $and: [{ $eq: ['$processed_at', null] }, { $ne: ['$last_error', null] }],
                        },
                        1,
                        0,
                      ],
                    },
                  },
                  last_received_at: { $max: '$received_at' },
                  last_processed_at: { $max: '$processed_at' },
                },
              },
              { $project: { _id: 0 } },
            ])
            .next()) ?? {
            pending: 0,
            retrying: 0,
            last_received_at: null,
            last_processed_at: null,
          })
        : (
            await db.query(
              `SELECT count(*) FILTER(WHERE processed_at IS NULL)::integer AS pending,
               count(*) FILTER(WHERE processed_at IS NULL AND last_error IS NOT NULL)::integer AS retrying,
               max(received_at) AS last_received_at,max(processed_at) AS last_processed_at
               FROM messenger_webhook_inbox WHERE page_id=$1`,
              [this.config.pageId],
            )
          ).rows[0];
    return { configured: true, state: 'configured', ...row };
  }
}

export async function registerMessenger(
  app: FastifyInstance,
  crm: CRM | MongoOperations,
  config?: MessengerConfig,
  runWorker = true,
  request?: MessengerFetch,
) {
  const central = new MessengerCentral(crm, config, request);
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.get('/webhooks/messenger', { config: { rateLimit: false } }, async (request, reply) => {
      if (!config) throw new DomainError('MESSENGER_DISABLED', 'Messenger não configurado.', 503);
      const query = request.query as Record<string, unknown>;
      if (
        query['hub.mode'] !== 'subscribe' ||
        typeof query['hub.verify_token'] !== 'string' ||
        !secretMatches(query['hub.verify_token'], config.verifyToken) ||
        typeof query['hub.challenge'] !== 'string'
      )
        throw new DomainError('INVALID_VERIFICATION', 'Verificação inválida.', 403);
      return reply.type('text/plain').send(query['hub.challenge']);
    });
    scope.post(
      '/webhooks/messenger',
      { bodyLimit: 1_048_576, config: { rateLimit: false } },
      async (request) => {
        if (!Buffer.isBuffer(request.body))
          throw new DomainError('INVALID_WEBHOOK', 'JSON obrigatório.', 400);
        await central.receive(request.body, request.headers['x-hub-signature-256']);
        return { received: true };
      },
    );
  });
  let active: Promise<void> | undefined;
  let lastStaleSendRecoveryAt = 0;
  const tick = () => {
    if (!active) {
      const now = Date.now();
      const shouldRecoverStaleSends = now - lastStaleSendRecoveryAt >= 15_000;
      if (shouldRecoverStaleSends) lastStaleSendRecoveryAt = now;
      active = Promise.resolve()
        .then(() => (shouldRecoverStaleSends ? central.recoverStaleSends() : undefined))
        .then(() => central.drain())
        .catch(() => app.log.error('Messenger inbox processing failed'))
        .finally(() => {
          active = undefined;
        });
    }
  };
  const timer = config && runWorker ? setInterval(tick, 1000) : undefined;
  timer?.unref();
  let profileActive: Promise<void> | undefined;
  const profileTimer =
    config && runWorker
      ? setInterval(() => {
          if (!profileActive)
            profileActive = central
              .drainProfiles()
              .catch(() => app.log.error('Messenger profile processing failed'))
              .finally(() => {
                profileActive = undefined;
              });
        }, 15_000)
      : undefined;
  profileTimer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    if (profileTimer) clearInterval(profileTimer);
    await active;
    await profileActive;
  });
  return central;
}
