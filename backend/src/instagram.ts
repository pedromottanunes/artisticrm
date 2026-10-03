import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CRM, LeadInput, MetaAttributionInput } from './crm.js';
import type { MongoOperations } from './mongo-crm.js';
import type { MongoTx } from './mongo-store.js';
import { DomainError, type Opportunity, type User } from './types.js';
import { wasDeleted } from './lead-deletion.js';
import { enqueuePushEvent } from './push-store.js';
import { InstagramComments, commentChangeSchema, type CommentEvent } from './instagram-comments.js';
import { MediaProxy, trustedMediaUrl } from './media-proxy.js';

export interface InstagramConfig {
  appSecret: string;
  verifyToken: string;
  accountId: string;
  accessToken: string;
  graphApiVersion: string;
  username?: string;
  profileLookup?: boolean;
}

export type InstagramFetch = typeof fetch;

export function instagramConfig(env: NodeJS.ProcessEnv): InstagramConfig | undefined {
  if (env.INSTAGRAM_ENABLED !== 'true') return undefined;
  const parsed = z
    .object({
      appSecret: z.string().min(16),
      verifyToken: z.string().min(32),
      accountId: z.string().regex(/^\d+$/),
      accessToken: z.string().min(20),
      graphApiVersion: z.string().regex(/^v\d+\.\d+$/),
      username: z.string().trim().max(100).optional(),
    })
    .safeParse({
      appSecret: env.INSTAGRAM_APP_SECRET,
      verifyToken: env.INSTAGRAM_VERIFY_TOKEN,
      accountId: env.INSTAGRAM_ACCOUNT_ID,
      accessToken: env.INSTAGRAM_ACCESS_TOKEN,
      graphApiVersion: env.META_GRAPH_VERSION,
      username: env.INSTAGRAM_USERNAME || undefined,
    });
  if (!parsed.success)
    throw new Error(
      'Configuração Instagram incompleta ou inválida. Consulte PLANO-TECNICO-INSTAGRAM-CRM.md.',
    );
  return parsed.data;
}

function secretMatches(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

const identifier = z.string().trim().min(1).max(512);
const referralSchema = z
  .object({
    source: z.string().trim().max(50).nullish(),
    type: z.string().trim().max(50).nullish(),
    source_type: z.string().trim().max(50).nullish(),
    source_id: z.string().trim().max(512).nullish(),
    source_url: z.string().trim().max(4096).nullish(),
    referer_uri: z.string().trim().max(4096).nullish(),
    ad_id: z.string().trim().max(512).nullish(),
    ref: z.string().trim().max(2048).nullish(),
    headline: z.string().trim().max(1000).nullish(),
    body: z.string().trim().max(4000).nullish(),
    ads_context_data: z
      .object({
        ad_id: z.string().trim().max(512).nullish(),
        ad_title: z.string().trim().max(1000).nullish(),
        photo_url: z.string().trim().max(4096).nullish(),
        video_url: z.string().trim().max(4096).nullish(),
      })
      .nullish(),
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

const imageAttachmentTypes = new Set(['image', 'photo', 'animated_image']);
const audioAttachmentTypes = new Set(['audio', 'voice', 'voice_message']);
const videoAttachmentTypes = new Set(['video']);
const isTrustedInstagramMediaUrl = trustedMediaUrl;

function imageExtension(contentType: string) {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/gif') return 'gif';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/avif') return 'avif';
  return 'jpg';
}

function mediaContentType(type: string, received: string) {
  if (received && received !== 'application/octet-stream') return received;
  const normalized = type.toLowerCase();
  if (imageAttachmentTypes.has(normalized)) return 'image/jpeg';
  if (audioAttachmentTypes.has(normalized)) return 'audio/mpeg';
  if (videoAttachmentTypes.has(normalized)) return 'video/mp4';
  return received;
}

const userProfileSchema = z
  .object({
    id: identifier,
    name: z.string().trim().max(200).nullish(),
    username: z.string().trim().max(100).nullish(),
    profile_pic: z.string().url().max(4096).nullish(),
  })
  .passthrough();

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
        referral: referralSchema.optional(),
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
  object: z.literal('instagram'),
  entry: z
    .array(
      z.object({
        id: identifier,
        time: z.number().int().nonnegative().optional(),
        messaging: z.array(z.unknown()).max(1000).optional(),
        changes: z.array(z.unknown()).max(1000).optional(),
      }),
    )
    .max(1000),
});

type Referral = z.infer<typeof referralSchema>;
type Attachment = z.infer<typeof storedAttachmentSchema>;

interface NormalizedInstagramEvent {
  lead: LeadInput;
  sender_id: string;
  external_message_id: string;
  deferred_referral: boolean;
  message: {
    type: string;
    text: string;
    attachments: Attachment[];
    created_at: string;
  };
}

interface ConversationContext {
  id: string;
  opportunity_id: string;
  contact_id: string;
  last_message_at: Date | string;
  state: string;
  owner_id: string | null;
  reserved_to: string | null;
  external_user_id: string;
  last_inbound_at?: Date | string | null;
  private_reply_comment_id?: string | null;
  private_reply_message_id?: string | null;
  private_reply_started_at?: Date | string | null;
}

const present = (value: string | null | undefined) => value || undefined;

function metaAttribution(referral: Referral | undefined): MetaAttributionInput | undefined {
  if (!referral) return;
  const sourceId = present(
    referral.ad_id ?? referral.ads_context_data?.ad_id ?? referral.source_id,
  );
  const explicitlyAnAd =
    referral.source_type?.toLowerCase() === 'ad' ||
    referral.source?.toUpperCase() === 'ADS' ||
    Boolean(referral.ad_id);
  if (!explicitlyAnAd || !sourceId) return;
  const mediaUrl =
    present(referral.ads_context_data?.photo_url) ?? present(referral.ads_context_data?.video_url);
  return {
    provider: 'meta',
    channel: 'instagram',
    source_type: 'ad',
    source_id: sourceId,
    source_url: present(referral.source_url ?? referral.referer_uri),
    headline: present(referral.headline ?? referral.ads_context_data?.ad_title),
    body: present(referral.body),
    media_type: referral.ads_context_data?.video_url
      ? 'video'
      : referral.ads_context_data?.photo_url
        ? 'image'
        : undefined,
    image_url:
      referral.ads_context_data?.photo_url && mediaUrl
        ? referral.ads_context_data.photo_url
        : undefined,
    video_url:
      referral.ads_context_data?.video_url && mediaUrl
        ? referral.ads_context_data.video_url
        : undefined,
  };
}

function eventDate(timestamp: number | undefined) {
  if (!timestamp) return new Date();
  const value = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function normalizeEvent(
  input: z.infer<typeof messagingEventSchema>,
  config: InstagramConfig,
): NormalizedInstagramEvent | undefined {
  if (
    input.recipient.id !== config.accountId ||
    input.sender.id === config.accountId ||
    input.message?.is_echo
  )
    return;
  const referral = input.referral ?? input.message?.referral ?? input.postback?.referral;
  const attribution = metaAttribution(referral);
  const attachments = (input.message?.attachments ?? []).map((item) => ({
    type: item.type,
    ...(item.payload?.url ? { url: item.payload.url } : {}),
  }));
  const eventKind = input.message ? 'message' : input.postback ? 'postback' : 'referral';
  if (eventKind === 'referral' && !attribution) return;
  const eventFingerprint = createHash('sha256')
    .update(JSON.stringify(input.postback ?? referral ?? {}))
    .digest('hex')
    .slice(0, 24);
  const externalMessageId =
    input.message?.mid ??
    input.postback?.mid ??
    `${eventKind}:${input.sender.id}:${input.timestamp ?? 'without-timestamp'}:${eventFingerprint}`;
  const text = input.message?.text ?? input.postback?.title ?? input.postback?.payload ?? '';
  return {
    sender_id: input.sender.id,
    external_message_id: externalMessageId,
    deferred_referral: eventKind === 'referral',
    message: {
      type: input.message
        ? input.message.text
          ? 'text'
          : (attachments[0]?.type ?? 'unsupported')
        : eventKind,
      text,
      attachments,
      created_at: eventDate(input.timestamp).toISOString(),
    },
    lead: {
      name: 'Contato Instagram',
      interest: 'Direct do Instagram',
      unit: 'A definir',
      source: attribution ? 'Meta Ads' : 'Instagram — origem orgânica',
      source_evidence: attribution
        ? 'Webhook do Instagram assinado com referência de anúncio enviada pela Meta.'
        : 'Entrada confirmada pelo Instagram Direct; nenhuma referência de anúncio foi fornecida.',
      meta_attribution: attribution,
      identity: {
        provider: 'instagram',
        account_id: config.accountId,
        external_user_id: input.sender.id,
      },
    },
  };
}

function parseStoredEvent(value: unknown): NormalizedInstagramEvent | CommentEvent {
  return (typeof value === 'string' ? JSON.parse(value) : value) as
    NormalizedInstagramEvent | CommentEvent;
}

export class InstagramCentral {
  readonly comments: InstagramComments;
  private mediaProxy: MediaProxy;
  private profilePausedUntil = 0;
  constructor(
    private crm: CRM | MongoOperations,
    private config?: InstagramConfig,
    private request: InstagramFetch = fetch,
  ) {
    this.comments = new InstagramComments(crm.db, config, request);
    this.mediaProxy = new MediaProxy(request);
  }

  async receive(raw: Buffer, signature: unknown) {
    const config = this.config;
    if (!config) throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
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
      throw new DomainError('INVALID_WEBHOOK', 'Evento do Instagram inválido.', 400);
    }

    const events: { id: string; value: NormalizedInstagramEvent | CommentEvent }[] = [];
    for (const entry of envelope.entry) {
      if (entry.id !== config.accountId) continue;
      for (const change of entry.changes ?? []) {
        const parsed = commentChangeSchema.safeParse(change);
        if (!parsed.success || parsed.data.value.from.id === config.accountId || !entry.time)
          continue;
        const comment = parsed.data.value;
        events.push({
          id: `instagram-comment:${config.accountId}:${comment.id}`,
          value: {
            kind: 'comment',
            comment_id: comment.id,
            sender_id: comment.from.id,
            username: comment.from.username ?? '',
            text: comment.text,
            media_id: comment.media?.id ?? '',
            created_at: eventDate(entry.time).toISOString(),
          },
        });
      }
      for (const rawEvent of entry.messaging ?? []) {
        const parsed = messagingEventSchema.safeParse(rawEvent);
        if (!parsed.success) continue;
        const value = normalizeEvent(parsed.data, config);
        if (value)
          events.push({
            id: `instagram:${config.accountId}:${value.external_message_id}`,
            value,
          });
      }
    }

    const db = this.crm.db;
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        const now = await tx.now();
        for (const [index, event] of events.entries()) {
          if (await wasDeleted(tx, event.id)) continue;
          const receivedAt = new Date(now.getTime() + index);
          await tx.collection('instagram_webhook_inbox').updateOne(
            { event_id: event.id },
            {
              $setOnInsert: {
                event_id: event.id,
                instagram_account_id: config.accountId,
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
            `INSERT INTO instagram_webhook_inbox(
               event_id,instagram_account_id,event,received_at,available_at
             ) VALUES (
               $1,$2,$3,clock_timestamp() + ($4 * interval '1 millisecond'),
               clock_timestamp() + ($4 * interval '1 millisecond')
             ) ON CONFLICT (event_id) DO NOTHING`,
            [event.id, config.accountId, JSON.stringify(event.value), index],
          );
        }
      });
    return events.length;
  }

  private async deferReferral(eventId: string, lease: string, value: NormalizedInstagramEvent) {
    const attribution = value.lead.meta_attribution;
    if (!attribution) return;
    const config = this.config!;
    const db = this.crm.db;
    if (db.kind === 'mongo')
      return db.atomic(async (tx) => {
        const now = await tx.now();
        await tx.collection('instagram_pending_referrals').updateOne(
          { account_id: config.accountId, sender_external_id: value.sender_id },
          {
            $set: {
              source_event_id: eventId,
              attribution,
              received_at: now,
              expires_at: new Date(now.getTime() + 24 * 60 * 60_000),
            },
          },
          { upsert: true, session: tx.session },
        );
        await tx.update(
          'instagram_webhook_inbox',
          { event_id: eventId, lease_id: lease },
          {
            $set: {
              processed_at: now,
              lease_id: null,
              last_error: null,
            },
          },
        );
      });
    return db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO instagram_pending_referrals(
           account_id,sender_external_id,source_event_id,attribution,received_at,expires_at
         ) VALUES ($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '24 hours')
         ON CONFLICT (account_id,sender_external_id) DO UPDATE SET
           source_event_id=EXCLUDED.source_event_id,attribution=EXCLUDED.attribution,
           received_at=EXCLUDED.received_at,expires_at=EXCLUDED.expires_at`,
        [config.accountId, value.sender_id, eventId, JSON.stringify(attribution)],
      );
      await tx.query(
        `UPDATE instagram_webhook_inbox SET processed_at=clock_timestamp(),lease_id=NULL,last_error=NULL
         WHERE event_id=$1 AND lease_id=$2`,
        [eventId, lease],
      );
    });
  }

  private async pendingReferral(senderId: string) {
    const config = this.config!;
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      const row = await db.one<{ source_event_id: string; attribution: MetaAttributionInput }>(
        'instagram_pending_referrals',
        {
          account_id: config.accountId,
          sender_external_id: senderId,
          expires_at: { $gt: await db.now() },
        },
      );
      return row ? { sourceEventId: row.source_event_id, attribution: row.attribution } : undefined;
    }
    const row = (
      await db.query<{ source_event_id: string; attribution: MetaAttributionInput }>(
        `SELECT source_event_id,attribution FROM instagram_pending_referrals
         WHERE account_id=$1 AND sender_external_id=$2 AND expires_at>clock_timestamp()`,
        [config.accountId, senderId],
      )
    ).rows[0];
    return row ? { sourceEventId: row.source_event_id, attribution: row.attribution } : undefined;
  }

  private async refreshProfile(senderId: string, opportunityId: string) {
    const config = this.config!;
    if (config.profileLookup === false) return;
    const db = this.crm.db;
    try {
      const identity =
        db.kind === 'mongo'
          ? await db.one('contact_identities', {
              provider: 'instagram',
              channel_account_id: config.accountId,
              external_user_id: senderId,
            })
          : (
              await db.query<{
                username: string;
                profile_picture_url: string;
                profile_updated_at: Date | string | null;
              }>(
                `SELECT username,profile_picture_url,profile_updated_at FROM contact_identities
                 WHERE provider='instagram' AND channel_account_id=$1 AND external_user_id=$2`,
                [config.accountId, senderId],
              )
            ).rows[0];
      const lastUpdate = identity?.profile_updated_at
        ? new Date(identity.profile_updated_at as Date | string)
        : null;
      const checkedAt = db.kind === 'mongo' ? await db.now() : new Date();
      if (lastUpdate && checkedAt.getTime() - lastUpdate.getTime() < 24 * 60 * 60_000) return;

      const url = new URL(
        `https://graph.instagram.com/${config.graphApiVersion}/${encodeURIComponent(senderId)}`,
      );
      url.searchParams.set('fields', 'id,name,username,profile_pic');
      const response = await this.request(url, {
        headers: { Authorization: `Bearer ${config.accessToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500)
          this.profilePausedUntil = Date.now() + 15 * 60_000;
        await response.body?.cancel().catch(() => {});
        return;
      }
      const profile = userProfileSchema.safeParse(await response.json());
      if (!profile.success || profile.data.id !== senderId) return;
      const displayName = profile.data.name ?? '';
      const username = profile.data.username ?? '';
      const picture = profile.data.profile_pic ?? '';
      const contactName = displayName || (username ? `@${username}` : '');

      if (db.kind === 'mongo')
        await db.atomic(async (tx) => {
          const now = await tx.now();
          const opportunity = await tx.one<Opportunity>('opportunities', { id: opportunityId });
          if (!opportunity) return;
          await tx.update(
            'contact_identities',
            {
              contact_id: opportunity.contact_id,
              provider: 'instagram',
              channel_account_id: config.accountId,
              external_user_id: senderId,
            },
            {
              $set: {
                ...(username ? { username } : {}),
                ...(displayName ? { display_name: displayName } : {}),
                ...(picture ? { profile_picture_url: picture } : {}),
                profile_updated_at: now,
                profile_check_after: new Date(now.getTime() + 24 * 60 * 60_000),
              },
            },
          );
          const contact = await tx.one('contacts', { id: opportunity.contact_id });
          if (!contact) return;
          await tx.update(
            'contacts',
            { id: opportunity.contact_id },
            {
              $set: {
                ...(contactName && (!contact.name || contact.name === 'Contato Instagram')
                  ? { name: contactName }
                  : {}),
                ...(username ? { instagram: username } : {}),
              },
            },
          );
        });
      else
        await db.transaction(async (tx) => {
          const row = (
            await tx.query<{ contact_id: string }>(
              `UPDATE contact_identities ci SET
                 username=CASE WHEN $3='' THEN ci.username ELSE $3 END,
                 display_name=CASE WHEN $4='' THEN ci.display_name ELSE $4 END,
                 profile_picture_url=CASE WHEN $5='' THEN ci.profile_picture_url ELSE $5 END,
                 profile_updated_at=clock_timestamp(),profile_check_after=clock_timestamp()+interval '24 hours'
               FROM opportunities o
               WHERE o.id=$1 AND ci.contact_id=o.contact_id AND ci.provider='instagram'
                 AND ci.channel_account_id=$2 AND ci.external_user_id=$6
               RETURNING ci.contact_id`,
              [opportunityId, config.accountId, username, displayName, picture, senderId],
            )
          ).rows[0];
          if (!row) return;
          await tx.query(
            `UPDATE contacts SET
               name=CASE WHEN $2<>'' AND (name='' OR name='Contato Instagram') THEN $2 ELSE name END,
               instagram=CASE WHEN $3='' THEN instagram ELSE $3 END
             WHERE id=$1`,
            [row.contact_id, contactName, username],
          );
        });
    } catch {
      // Profile data is optional. A transient Meta/CDN failure must never block the message.
    }
  }

  async drainProfiles(limit = 3) {
    const config = this.config;
    if (!config || config.profileLookup === false || this.profilePausedUntil > Date.now()) return;
    const db = this.crm.db;
    for (let index = 0; index < limit; index++) {
      const filter = {
        provider: 'instagram',
        channel_account_id: config.accountId,
        profile_pending: true,
        $or: [{ profile_check_after: { $lte: new Date() } }, { profile_check_after: null }],
      };
      // No transaction/write fence while the optional profile queue is empty.
      const candidate =
        db.kind === 'mongo'
          ? await db.collection('contact_identities').findOne(filter, { projection: { id: 1 } })
          : (
              await db.query(
                "SELECT id FROM contact_identities WHERE provider='instagram' AND channel_account_id=$1 AND profile_pending AND profile_check_after<=clock_timestamp() LIMIT 1",
                [config.accountId],
              )
            ).rows[0];
      if (!candidate) return;
      const job =
        db.kind === 'mongo'
          ? await db.atomic(async (tx) => {
              const identity = await tx.one('contact_identities', { ...filter, id: candidate.id });
              if (!identity) return;
              await tx.update(
                'contact_identities',
                { id: identity.id },
                {
                  $set: {
                    profile_pending: false,
                    profile_check_after: new Date(Date.now() + 15 * 60_000),
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
                  `UPDATE contact_identities SET profile_pending=false,profile_check_after=clock_timestamp()+interval '15 minutes'
          WHERE id=$1 AND profile_pending AND profile_check_after<=clock_timestamp() RETURNING external_user_id,profile_opportunity_id`,
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
      if (job?.opportunity) await this.refreshProfile(job.sender, job.opportunity);
      if (this.profilePausedUntil > Date.now()) return;
    }
  }

  private async persistInbound(
    eventId: string,
    lease: string,
    value: NormalizedInstagramEvent,
    opportunityId: string,
    pendingReferralEventId?: string,
  ) {
    const config = this.config!;
    const db = this.crm.db;
    if (db.kind === 'mongo')
      return db.atomic(async (tx) => {
        const now = await tx.now();
        const opportunity = await tx.one<Opportunity>('opportunities', { id: opportunityId });
        if (!opportunity) throw new Error('Missing opportunity');
        let account = await tx.one('channel_accounts', {
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
        const insertedMessage = await tx.collection('messages').updateOne(
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
        if (insertedMessage.upsertedCount)
          await enqueuePushEvent(
            tx,
            `instagram:${eventId}`,
            opportunityId,
            'message.received',
            now,
          );
        if (insertedMessage.upsertedCount && config.profileLookup !== false)
          await tx.update(
            'contact_identities',
            {
              provider: 'instagram',
              channel_account_id: config.accountId,
              external_user_id: value.sender_id,
            },
            { $set: { profile_pending: true, profile_opportunity_id: opportunityId } },
          );
        if (pendingReferralEventId)
          await tx.collection('instagram_pending_referrals').deleteOne(
            {
              account_id: config.accountId,
              sender_external_id: value.sender_id,
              source_event_id: pendingReferralEventId,
            },
            { session: tx.session },
          );
        await tx.update(
          'instagram_webhook_inbox',
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
          `INSERT INTO channel_accounts(
             id,provider,external_account_id,username,status,graph_api_version
           ) VALUES ($1,'instagram',$2,$3,'active',$4)
           ON CONFLICT (provider,external_account_id) DO UPDATE SET
             username=CASE WHEN EXCLUDED.username='' THEN channel_accounts.username ELSE EXCLUDED.username END,
             graph_api_version=EXCLUDED.graph_api_version,
             status='active',updated_at=clock_timestamp()
           RETURNING id`,
          [randomUUID(), config.accountId, config.username ?? '', config.graphApiVersion],
        )
      ).rows[0];
      const createdAt = new Date(value.message.created_at);
      const conversation = (
        await tx.query<{ id: string }>(
          `INSERT INTO conversations(
             id,channel_account_id,contact_id,opportunity_id,status,last_message_at,last_inbound_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,'open',$5,$5,clock_timestamp(),clock_timestamp())
           ON CONFLICT (channel_account_id,opportunity_id) DO UPDATE SET
             last_message_at=GREATEST(conversations.last_message_at,EXCLUDED.last_message_at),
             last_inbound_at=GREATEST(conversations.last_inbound_at,EXCLUDED.last_inbound_at),
             updated_at=clock_timestamp()
           RETURNING id`,
          [randomUUID(), account.id, opportunity.contact_id, opportunityId, createdAt],
        )
      ).rows[0];
      const insertedMessage = await tx.query<{ id: string }>(
        `INSERT INTO messages(
           id,conversation_id,external_message_id,direction,sender_external_id,type,text,attachments,status,created_at
         ) VALUES ($1,$2,$3,'inbound',$4,$5,$6,$7,'received',$8)
         ON CONFLICT (external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING RETURNING id`,
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
      if (insertedMessage.rows.length)
        await enqueuePushEvent(
          tx,
          `instagram:${eventId}`,
          opportunityId,
          'message.received',
          new Date((await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now),
        );
      if (insertedMessage.rows.length && config.profileLookup !== false)
        await tx.query(
          `UPDATE contact_identities SET profile_pending=true,profile_opportunity_id=$3 WHERE provider='instagram' AND channel_account_id=$1 AND external_user_id=$2`,
          [config.accountId, value.sender_id, opportunityId],
        );
      if (pendingReferralEventId)
        await tx.query(
          `DELETE FROM instagram_pending_referrals
           WHERE account_id=$1 AND sender_external_id=$2 AND source_event_id=$3`,
          [config.accountId, value.sender_id, pendingReferralEventId],
        );
      await tx.query(
        `UPDATE instagram_webhook_inbox SET processed_at=clock_timestamp(),opportunity_id=$3,
           conversation_id=$4,lease_id=NULL,last_error=NULL WHERE event_id=$1 AND lease_id=$2`,
        [eventId, lease, opportunityId, conversation.id],
      );
      return conversation.id;
    });
  }

  async drain(limit = 25) {
    const config = this.config;
    if (!config) return;
    const db = this.crm.db;
    if (
      db.kind === 'mongo' &&
      !(await db.collection('instagram_webhook_inbox').findOne(
        {
          processed_at: null,
          available_at: { $lte: new Date() },
          instagram_account_id: config.accountId,
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
                await tx.many<{
                  event_id: string;
                  event: NormalizedInstagramEvent;
                  attempts: number;
                }>(
                  'instagram_webhook_inbox',
                  {
                    processed_at: null,
                    available_at: { $lte: now },
                    instagram_account_id: config.accountId,
                  },
                  { received_at: 1, event_id: 1 },
                  1,
                )
              )[0];
              if (!selected) return;
              await tx.update(
                'instagram_webhook_inbox',
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
                await tx.query<{ event_id: string; event: unknown; attempts: number }>(
                  `SELECT event_id,event,attempts FROM instagram_webhook_inbox
                   WHERE processed_at IS NULL AND available_at<=clock_timestamp()
                     AND instagram_account_id=$1
                   ORDER BY received_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
                  [config.accountId],
                )
              ).rows[0];
              if (!selected) return;
              await tx.query(
                `UPDATE instagram_webhook_inbox SET lease_id=$2,attempts=attempts+1,
                   available_at=clock_timestamp()+interval '2 minutes' WHERE event_id=$1`,
                [selected.event_id, lease],
              );
              return selected;
            });
      if (!row) return;
      try {
        const value = parseStoredEvent(row.event);
        if ('kind' in value && value.kind === 'comment') {
          await this.comments.persist(value, row.event_id, lease);
          continue;
        }
        if (!('lead' in value)) continue;
        if (value.deferred_referral) {
          await this.deferReferral(row.event_id, lease, value);
          continue;
        }
        const pending = await this.pendingReferral(value.sender_id);
        if (pending && !value.lead.meta_attribution) {
          value.lead.meta_attribution = pending.attribution;
          value.lead.source = 'Meta Ads';
          value.lead.source_evidence =
            'ReferÃªncia de anÃºncio recebida pela Meta antes da primeira mensagem.';
        }
        await this.comments.recoverRecipient(value.sender_id);
        const result = await this.crm.ingest(value.lead, row.event_id, null);
        await this.persistInbound(row.event_id, lease, value, result.id, pending?.sourceEventId);
      } catch {
        const seconds = Math.min(300, 2 ** Math.min(row.attempts + 1, 8));
        if (db.kind === 'mongo')
          await db.update(
            'instagram_webhook_inbox',
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
            `UPDATE instagram_webhook_inbox SET lease_id=NULL,last_error='PROCESSING_FAILED',
               available_at=clock_timestamp()+($3 * interval '1 second')
             WHERE event_id=$1 AND lease_id=$2`,
            [row.event_id, lease, seconds],
          );
      }
    }
  }

  private async context(user: User, conversationId: string): Promise<ConversationContext> {
    const config = this.config;
    if (!config) throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
    const db = this.crm.db;
    let context: ConversationContext | null;
    if (db.kind === 'mongo') {
      context =
        (await db
          .collection('conversations')
          .aggregate<ConversationContext>([
            { $match: { id: conversationId } },
            {
              $lookup: {
                from: 'channel_accounts',
                localField: 'channel_account_id',
                foreignField: 'id',
                as: 'account',
              },
            },
            { $unwind: '$account' },
            {
              $match: {
                'account.provider': 'instagram',
                'account.external_account_id': config.accountId,
              },
            },
            {
              $lookup: {
                from: 'opportunities',
                localField: 'opportunity_id',
                foreignField: 'id',
                as: 'opportunity',
              },
            },
            { $unwind: '$opportunity' },
            {
              $lookup: {
                from: 'contact_identities',
                let: { contactId: '$contact_id' },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$contact_id', '$$contactId'] },
                          { $eq: ['$provider', 'instagram'] },
                          { $eq: ['$channel_account_id', config.accountId] },
                        ],
                      },
                    },
                  },
                  { $limit: 1 },
                ],
                as: 'identity',
              },
            },
            { $unwind: '$identity' },
            {
              $project: {
                _id: 0,
                id: 1,
                opportunity_id: 1,
                contact_id: 1,
                last_message_at: 1,
                last_inbound_at: 1,
                private_reply_comment_id: 1,
                private_reply_message_id: 1,
                private_reply_started_at: 1,
                state: '$opportunity.state',
                owner_id: '$opportunity.owner_id',
                reserved_to: '$opportunity.reserved_to',
                external_user_id: {
                  $ifNull: ['$instagram_recipient_id', '$identity.external_user_id'],
                },
              },
            },
          ])
          .next()) ?? null;
    } else
      context =
        (
          await db.query<ConversationContext>(
            `SELECT cv.id,cv.opportunity_id,cv.contact_id,cv.last_message_at,cv.last_inbound_at,
                    cv.private_reply_comment_id,cv.private_reply_message_id,cv.private_reply_started_at,
                    o.state,o.owner_id,o.reserved_to,
                    COALESCE(cv.instagram_recipient_id,ci.external_user_id) AS external_user_id
             FROM conversations cv
             JOIN opportunities o ON o.id=cv.opportunity_id
             JOIN channel_accounts ca ON ca.id=cv.channel_account_id
             JOIN LATERAL (SELECT * FROM contact_identities i WHERE i.contact_id=cv.contact_id
               AND i.provider='instagram' AND i.channel_account_id=ca.external_account_id
               ORDER BY i.username DESC LIMIT 1) ci ON TRUE
             WHERE cv.id=$1 AND ca.provider='instagram' AND ca.external_account_id=$2`,
            [conversationId, config.accountId],
          )
        ).rows[0] ?? null;
    if (!context) throw new DomainError('NOT_FOUND', 'Conversa não encontrada.', 404);
    if (user.role !== 'manager' && context.owner_id !== user.id)
      throw new DomainError('FORBIDDEN', 'Assuma o lead para acessar esta conversa.', 403);
    return context;
  }

  async list(user: User, view: 'mine' | 'reserved' | 'pool' | 'all' = 'mine') {
    if (!this.config) return { configured: false, conversations: [] as Record<string, unknown>[] };
    if (view === 'all' && user.role !== 'manager')
      throw new DomainError('FORBIDDEN', 'Visão completa restrita à gestão.', 403);
    const db = this.crm.db;
    const opportunityFilter =
      user.role === 'manager'
        ? view === 'all'
          ? {}
          : view === 'mine'
            ? { owner_id: user.id }
            : { state: view === 'reserved' ? 'RESERVED' : 'POOL' }
        : view === 'mine'
          ? { owner_id: user.id }
          : view === 'reserved'
            ? { state: 'RESERVED', reserved_to: user.id }
            : user.active
              ? { state: 'POOL' }
              : { id: '__inactive_user_cannot_view_pool__' };
    if (db.kind === 'mongo') {
      const account = await db.one('channel_accounts', {
        provider: 'instagram',
        external_account_id: this.config.accountId,
      });
      if (!account) return { configured: true, conversations: [] };
      const all = user.role === 'manager' && view === 'all';
      const conversations = await db
        .collection(all ? 'conversations' : 'opportunities')
        .aggregate<Record<string, unknown>>([
          ...(all
            ? [
                { $match: { channel_account_id: account.id } },
                { $sort: { last_message_at: -1, id: 1 } },
                { $limit: 100 },
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
                { $match: opportunityFilter },
                {
                  $project: {
                    _id: 0,
                    opportunity: {
                      id: '$id',
                      state: '$state',
                      owner_id: '$owner_id',
                      reserved_to: '$reserved_to',
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
                    newRoot: { $mergeObjects: ['$conversation', { opportunity: '$opportunity' }] },
                  },
                },
              ]),
          { $sort: { last_message_at: -1, id: 1 } },
          { $limit: 100 },
          {
            $lookup: {
              from: 'contacts',
              localField: 'contact_id',
              foreignField: 'id',
              as: 'contact',
            },
          },
          { $set: { contact: { $first: '$contact' } } },
          {
            $lookup: {
              from: 'contact_identities',
              let: { contactId: '$contact_id' },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$contact_id', '$$contactId'] },
                        { $eq: ['$provider', 'instagram'] },
                        { $eq: ['$channel_account_id', this.config.accountId] },
                      ],
                    },
                  },
                },
                { $limit: 1 },
              ],
              as: 'identity',
            },
          },
          { $set: { identity: { $first: '$identity' } } },
          {
            $project: {
              _id: 0,
              id: 1,
              opportunity_id: '$opportunity.id',
              contact_name: { $ifNull: ['$contact.name', 'Contato Instagram'] },
              instagram_username: { $ifNull: ['$identity.username', ''] },
              profile_picture_url: { $ifNull: ['$identity.profile_picture_url', ''] },
              state: '$opportunity.state',
              owner_id: '$opportunity.owner_id',
              reserved_to: '$opportunity.reserved_to',
              last_message_at: 1,
              last_inbound_at: 1,
              private_reply_comment_id: 1,
              private_reply_message_id: 1,
              private_reply_started_at: 1,
            },
          },
        ])
        .toArray();
      const modes = await this.comments.modes(conversations);
      const unread = await this.unreadConversationIds(
        user.id,
        conversations.map((conversation) => String(conversation.id)),
      );
      return {
        configured: true,
        conversations: conversations.map((conversation, index) => {
          const mode = modes[index];
          return {
            id: conversation.id,
            opportunity_id: conversation.opportunity_id,
            contact_name: conversation.contact_name,
            instagram_username: conversation.instagram_username,
            profile_picture_url: conversation.profile_picture_url,
            state: conversation.state,
            owner_id: conversation.owner_id,
            reserved_to: conversation.reserved_to,
            last_message_at: conversation.last_message_at,
            unread: unread.has(String(conversation.id)),
            messaging_mode: mode,
            can_send:
              conversation.state === 'CLAIMED' &&
              conversation.owner_id === user.id &&
              ['direct', 'private_reply'].includes(mode),
          };
        }),
      };
    }
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
          : view === 'reserved'
            ? "o.state='RESERVED' AND o.reserved_to=$2"
            : user.active
              ? "o.state='POOL'"
              : 'FALSE';
    const rows = (
      await db.query<
        Opportunity & {
          conversation_id: string;
          contact_name: string;
          instagram_username: string;
          profile_picture_url: string;
          conversation_last_message_at: Date | string;
          last_inbound_at: Date | string | null;
          private_reply_comment_id: string | null;
          private_reply_message_id: string | null;
          private_reply_started_at: Date | string | null;
        }
      >(
        `SELECT o.*,cv.id AS conversation_id,c.name AS contact_name,
                ci.username AS instagram_username,ci.profile_picture_url,
                cv.last_message_at AS conversation_last_message_at,cv.last_inbound_at,
                cv.private_reply_comment_id,cv.private_reply_message_id,cv.private_reply_started_at
         FROM conversations cv
         JOIN opportunities o ON o.id=cv.opportunity_id
         JOIN contacts c ON c.id=cv.contact_id
         JOIN channel_accounts ca ON ca.id=cv.channel_account_id
         JOIN LATERAL (SELECT * FROM contact_identities i WHERE i.contact_id=cv.contact_id
           AND i.provider='instagram' AND i.channel_account_id=ca.external_account_id
           ORDER BY i.username DESC LIMIT 1) ci ON TRUE
          WHERE ca.provider='instagram' AND ca.external_account_id=$1
            AND (${visibility})
          ORDER BY cv.last_message_at DESC,cv.id LIMIT 100`,
        visibility.includes('$2') ? [this.config.accountId, user.id] : [this.config.accountId],
      )
    ).rows;
    const modes = await this.comments.modes(rows);
    const unread = await this.unreadConversationIds(
      user.id,
      rows.map((row) => row.conversation_id),
    );
    return {
      configured: true,
      conversations: rows.map((row, index) => {
        const mode = modes[index];
        return {
          id: row.conversation_id,
          opportunity_id: row.id,
          contact_name: row.contact_name,
          instagram_username: row.instagram_username,
          profile_picture_url: row.profile_picture_url,
          state: row.state,
          owner_id: row.owner_id,
          reserved_to: row.reserved_to,
          last_message_at: row.conversation_last_message_at,
          unread: unread.has(row.conversation_id),
          messaging_mode: mode,
          can_send:
            row.state === 'CLAIMED' &&
            row.owner_id === user.id &&
            ['direct', 'private_reply'].includes(mode),
        };
      }),
    };
  }

  private async unreadConversationIds(userId: string, conversationIds: string[]) {
    const unread = new Set<string>();
    if (!conversationIds.length) return unread;
    const db = this.crm.db;
    if (db.kind === 'mongo') {
      const latestInbound = await db
        .collection('conversations')
        .aggregate<{ id: string }>([
          { $match: { id: { $in: conversationIds } } },
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
                { $limit: 1 },
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
      for (const inbound of latestInbound) unread.add(inbound.id);
      return unread;
    }
    const rows = (
      await db.query<{ conversation_id: string }>(
        `SELECT selected.conversation_id
         FROM unnest($1::uuid[]) AS selected(conversation_id)
         JOIN LATERAL (
           SELECT id,created_at FROM messages
           WHERE conversation_id=selected.conversation_id AND direction='inbound'
           ORDER BY created_at DESC,id DESC LIMIT 1
         ) inbound ON TRUE
         LEFT JOIN conversation_reads reads
           ON reads.conversation_id=selected.conversation_id AND reads.user_id=$2
         LEFT JOIN messages read_message ON read_message.id=reads.last_read_message_id
         WHERE read_message.id IS NULL
            OR (read_message.created_at,read_message.id)<(inbound.created_at,inbound.id)`,
        [conversationIds, userId],
      )
    ).rows;
    for (const row of rows) unread.add(row.conversation_id);
    return unread;
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
          .find(
            {
              conversation_id: context.id,
              $or: [
                { created_at: { $gt: cursor.created_at } },
                { created_at: cursor.created_at, id: { $gt: cursor.id } },
              ],
            },
            { projection },
          )
          .sort({ created_at: 1, id: 1 })
          .limit(201)
          .toArray();
      } else
        messages = (
          await db
            .collection('messages')
            .find({ conversation_id: context.id }, { projection })
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
                  error_code,sent_at,delivered_at,read_at,created_at
           FROM messages WHERE conversation_id=$1 AND (created_at,id)>($2,$3)
           ORDER BY created_at,id LIMIT 201`,
          [context.id, cursor.created_at, cursor.id],
        )
      ).rows;
    } else
      messages = (
        await db.query(
          `SELECT * FROM (
             SELECT id,external_message_id,direction,sender_user_id,type,text,attachments,status,
                    error_code,sent_at,delivered_at,read_at,created_at
             FROM messages WHERE conversation_id=$1
             ORDER BY created_at DESC,id DESC LIMIT 201
           ) recent ORDER BY created_at,id`,
          [context.id],
        )
      ).rows;
    const hasMore = messages.length > 200;
    const messagingMode = await this.comments.mode(context);
    if (hasMore) messages = afterMessageId ? messages.slice(0, 200) : messages.slice(-200);
    return {
      conversation_id: context.id,
      opportunity_id: context.opportunity_id,
      can_send:
        context.state === 'CLAIMED' &&
        context.owner_id === user.id &&
        ['direct', 'private_reply'].includes(messagingMode),
      messaging_mode: messagingMode,
      last_message_at: context.last_message_at,
      has_more: hasMore,
      messages,
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
    if (media.contentLength && Number(media.contentLength) > 25 * 1024 * 1024) {
      await media.body.cancel().catch(() => {});
      throw new DomainError('MEDIA_TOO_LARGE', 'A imagem excede o limite permitido.', 413);
    }
    return {
      ...media,
      fileName: `imagem-instagram-${messageId.slice(0, 8)}.${imageExtension(media.contentType)}`,
    };
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

    let rawAttachments: unknown = row.attachments ?? [];
    if (typeof rawAttachments === 'string')
      try {
        rawAttachments = JSON.parse(rawAttachments);
      } catch {
        throw new DomainError('MEDIA_UNAVAILABLE', 'Mídia indisponível.', 404);
      }
    const attachments = z.array(storedAttachmentSchema).max(20).safeParse(rawAttachments);
    const attachment = attachments.success ? attachments.data[attachmentIndex] : undefined;
    if (!attachment?.url || !isTrustedInstagramMediaUrl(attachment.url))
      throw new DomainError('MEDIA_UNAVAILABLE', 'Mídia indisponível.', 404);

    const response = await this.mediaProxy.open(user.id, attachment.url, range, signal, maxBytes);

    const receivedContentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const contentType = mediaContentType(attachment.type, receivedContentType);
    if (
      !/^(image\/(jpeg|png|gif|webp|avif)|audio\/(mpeg|mp4|aac|ogg|opus|wav|x-wav|webm|3gpp|amr)|video\/(mp4|webm|quicktime|ogg|3gpp))$/.test(
        contentType,
      )
    ) {
      await response.body.cancel().catch(() => {});
      throw new DomainError('MEDIA_UNAVAILABLE', 'A URL não contém uma mídia exibível.', 502);
    }
    const contentLength = response.headers.get('content-length');
    return {
      body: response.body,
      contentType,
      contentLength,
      status: response.status,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
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
          throw new DomainError('INVALID_MESSAGE', 'Mensagem nÃ£o pertence Ã  conversa.', 400);
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
          await tx.collection('conversation_reads').updateOne(
            { conversation_id: context.id, user_id: user.id },
            {
              $set: {
                last_read_message_id: target?.id ?? null,
                read_at: await tx.now(),
              },
            },
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
        throw new DomainError('INVALID_MESSAGE', 'Mensagem nÃ£o pertence Ã  conversa.', 400);
      if (!target) return { read: true };
      await db.query(
        `INSERT INTO conversation_reads(conversation_id,user_id,last_read_message_id,read_at)
         VALUES ($1,$2,$3,clock_timestamp())
         ON CONFLICT (conversation_id,user_id) DO UPDATE SET
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

  private async setOutboundState(
    id: string,
    status: 'sent' | 'failed' | 'unknown',
    externalMessageId?: string,
    errorCode?: string,
  ) {
    const db = this.crm.db;
    const now = db.kind === 'mongo' ? await db.now() : new Date();
    if (db.kind === 'mongo') {
      const message = await db.one('messages', { id });
      await db.update(
        'messages',
        { id },
        {
          $set: {
            status,
            sending_started_at: null,
            ...(externalMessageId ? { external_message_id: externalMessageId, sent_at: now } : {}),
            ...(errorCode ? { error_code: errorCode } : { error_code: null }),
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
               external_message_id=COALESCE($3,external_message_id),
               error_code=$4,sent_at=CASE WHEN $2='sent' THEN clock_timestamp() ELSE sent_at END
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
      await db
        .collection('instagram_pending_referrals')
        .deleteMany({ expires_at: { $lte: await db.now() } });
      const result = await db.collection('messages').updateMany(
        {
          direction: 'outbound',
          status: 'sending',
          private_reply_binding_pending: { $ne: true },
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
    await db.query('DELETE FROM instagram_pending_referrals WHERE expires_at<=clock_timestamp()');
    const result = await db.query<{ id: string }>(
      `UPDATE messages SET status='unknown',error_code='PROCESS_INTERRUPTED',sending_started_at=NULL
       WHERE direction='outbound' AND status='sending'
         AND NOT private_reply_binding_pending
         AND COALESCE(sending_started_at,created_at) <= clock_timestamp()-($1 * interval '1 millisecond')
       RETURNING id`,
      [maxAgeMs],
    );
    return result.rows.length;
  }

  async send(user: User, conversationId: string, text: string, key: string) {
    const config = this.config;
    if (!config) throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
    const context = await this.context(user, conversationId);
    if (context.state !== 'CLAIMED' || context.owner_id !== user.id)
      throw new DomainError('FORBIDDEN', 'Aceite o lead antes de responder.', 403);
    const requestId = `instagram:${conversationId}:${user.id}:${key}`;
    const fingerprint = createHash('sha256').update(text).digest('hex');
    const db = this.crm.db;
    let messageId: string;
    let shouldSend = false;
    let recipient: { id: string } | { comment_id: string } = { id: context.external_user_id };
    const replay =
      db.kind === 'mongo'
        ? await db.one('messages', { client_request_id: requestId })
        : (await db.query('SELECT id FROM messages WHERE client_request_id=$1', [requestId]))
            .rows[0];
    if (!replay && (await this.comments.mode(context)) === 'private_reply')
      await this.comments.verifyPrivateReply(context.private_reply_comment_id!);
    if (db.kind === 'mongo') {
      const queued = await db.atomic(async (tx) => {
        const candidateId = randomUUID();
        await tx.collection('messages').updateOne(
          { client_request_id: requestId },
          {
            $setOnInsert: {
              id: candidateId,
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
        const current = await tx.one('messages', { client_request_id: requestId });
        if (!current) throw new Error('Missing outbound message');
        if (current.request_fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com outra mensagem.');
        const target =
          current.status === 'queued'
            ? await this.comments.authorizeSend(
                tx,
                user,
                conversationId,
                current.id as string,
                context.external_user_id,
              )
            : undefined;
        const claimed = await tx.update(
          'messages',
          { id: current.id, status: 'queued' },
          { $set: { status: 'sending', sending_started_at: await tx.now() } },
        );
        return { current, claimed: claimed.modifiedCount === 1, target };
      });
      messageId = queued.current.id as string;
      shouldSend = queued.claimed;
      if (queued.target) recipient = queued.target;
      if (!shouldSend) {
        if (queued.current.private_reply_binding_pending)
          return this.comments.completePrivateReply(messageId);
        return {
          id: messageId,
          status: queued.current.status,
          external_message_id: queued.current.external_message_id ?? null,
        };
      }
    } else {
      const queued = await db.transaction(async (tx) => {
        await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
        await tx.query(
          `INSERT INTO messages(
             id,conversation_id,client_request_id,request_fingerprint,direction,sender_user_id,
             type,text,status,created_at
           ) VALUES ($1,$2,$3,$4,'outbound',$5,'text',$6,'queued',clock_timestamp())
           ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING`,
          [randomUUID(), conversationId, requestId, fingerprint, user.id, text],
        );
        const current = (
          await tx.query<{
            id: string;
            status: string;
            request_fingerprint: string;
            external_message_id: string | null;
            private_reply_binding_pending: boolean;
          }>('SELECT * FROM messages WHERE client_request_id=$1 FOR UPDATE', [requestId])
        ).rows[0];
        if (!current) throw new Error('Missing outbound message');
        if (current.request_fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com outra mensagem.');
        const target =
          current.status === 'queued'
            ? await this.comments.authorizeSend(
                tx,
                user,
                conversationId,
                current.id,
                context.external_user_id,
              )
            : undefined;
        const claimed =
          (
            await tx.query<{ id: string }>(
              `UPDATE messages SET status='sending',sending_started_at=clock_timestamp()
               WHERE id=$1 AND status='queued' RETURNING id`,
              [current.id],
            )
          ).rows.length === 1;
        return { current, claimed, target };
      });
      messageId = queued.current.id;
      shouldSend = queued.claimed;
      if (queued.target) recipient = queued.target;
      if (!shouldSend) {
        if (queued.current.private_reply_binding_pending)
          return this.comments.completePrivateReply(messageId);
        return {
          id: messageId,
          status: queued.current.status,
          external_message_id: queued.current.external_message_id,
        };
      }
    }

    let response: Response;
    try {
      response = await this.request(
        `https://graph.instagram.com/${config.graphApiVersion}/${config.accountId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recipient,
            message: { text },
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      await this.setOutboundState(messageId, 'unknown', undefined, 'NETWORK_OR_TIMEOUT');
      throw new DomainError(
        'INSTAGRAM_SEND_UNKNOWN',
        'A Meta não confirmou o envio. Verifique a conversa antes de tentar novamente.',
        502,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      await this.setOutboundState(messageId, 'failed', undefined, `META_HTTP_${response.status}`);
      throw new DomainError(
        'INSTAGRAM_SEND_FAILED',
        'O Instagram recusou a mensagem. Atualize a conversa e verifique a integração.',
        502,
      );
    }
    const result = z
      .object({ recipient_id: z.string(), message_id: z.string() })
      .safeParse(await response.json().catch(() => null));
    if (!result.success) {
      await this.setOutboundState(messageId, 'unknown', undefined, 'INVALID_META_RESPONSE');
      throw new DomainError(
        'INSTAGRAM_SEND_UNKNOWN',
        'A Meta respondeu sem confirmar a mensagem. Verifique antes de reenviar.',
        502,
      );
    }
    if ('comment_id' in recipient)
      return this.comments.confirmPrivateReply(
        messageId,
        result.data.recipient_id,
        result.data.message_id,
      );
    await this.setOutboundState(messageId, 'sent', result.data.message_id);
    return { id: messageId, status: 'sent', external_message_id: result.data.message_id };
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
            .collection('instagram_webhook_inbox')
            .aggregate([
              {
                $match: { instagram_account_id: this.config.accountId },
              },
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
              `SELECT count(*) FILTER (WHERE processed_at IS NULL)::integer AS pending,
                      count(*) FILTER (WHERE processed_at IS NULL AND last_error IS NOT NULL)::integer AS retrying,
                      max(received_at) AS last_received_at,max(processed_at) AS last_processed_at
               FROM instagram_webhook_inbox WHERE instagram_account_id=$1`,
              [this.config.accountId],
            )
          ).rows[0];
    return {
      configured: true,
      state: 'configured',
      account_id: this.config.accountId,
      graph_api_version: this.config.graphApiVersion,
      ...row,
    };
  }
}

export async function registerInstagram(
  app: FastifyInstance,
  crm: CRM | MongoOperations,
  config?: InstagramConfig,
  runWorker = true,
  request: InstagramFetch = fetch,
) {
  const staleSendRecoveryIntervalMs = 60_000;
  const central = new InstagramCentral(crm, config, request);
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.get('/webhooks/instagram', { config: { rateLimit: false } }, async (req, reply) => {
      if (!config) throw new DomainError('INSTAGRAM_DISABLED', 'Instagram não configurado.', 503);
      const query = req.query as Record<string, unknown>;
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
      '/webhooks/instagram',
      { bodyLimit: 1_048_576, config: { rateLimit: false } },
      async (req) => {
        if (!Buffer.isBuffer(req.body))
          throw new DomainError('INVALID_WEBHOOK', 'JSON obrigatório.', 400);
        await central.receive(req.body, req.headers['x-hub-signature-256']);
        return { received: true };
      },
    );
  });
  let active: Promise<void> | undefined;
  let lastStaleSendRecoveryAt = 0;
  let lastPrivateReplyRecoveryAt = 0;
  const tick = () => {
    if (!active) {
      const now = Date.now();
      const shouldRecoverStaleSends = now - lastStaleSendRecoveryAt >= staleSendRecoveryIntervalMs;
      if (shouldRecoverStaleSends) lastStaleSendRecoveryAt = now;
      const shouldRecoverPrivateReplies = now - lastPrivateReplyRecoveryAt >= 15_000;
      if (shouldRecoverPrivateReplies) lastPrivateReplyRecoveryAt = now;
      active = Promise.resolve()
        .then(() => (shouldRecoverStaleSends ? central.recoverStaleSends() : undefined))
        .then(() =>
          shouldRecoverPrivateReplies
            ? central.comments
                .recoverPrivateReplies()
                .catch(() => app.log.error('Instagram private reply recovery failed'))
            : undefined,
        )
        .then(() => central.drain())
        .catch(() => app.log.error('Instagram inbox processing failed'))
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
              .catch(() => app.log.error('Instagram profile processing failed'))
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
