import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CRM, LeadInput, MetaAttributionInput } from './crm.js';
import type { MongoOperations } from './mongo-crm.js';
import { DomainError } from './types.js';
import { wasDeleted } from './lead-deletion.js';

export interface WhatsAppConfig {
  appSecret: string;
  verifyToken: string;
  wabaId: string;
  phoneNumberId: string;
}

// No default identifiers or credentials. Partial configuration fails closed.
export function whatsappConfig(env: NodeJS.ProcessEnv): WhatsAppConfig | undefined {
  if (env.WHATSAPP_ENABLED !== 'true') return undefined;
  const config = {
    appSecret: env.WHATSAPP_APP_SECRET,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    wabaId: env.WHATSAPP_WABA_ID,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
  };
  const parsed = z
    .object({
      appSecret: z.string().min(16),
      verifyToken: z.string().min(32),
      wabaId: z.string().regex(/^\d+$/),
      phoneNumberId: z.string().regex(/^\d+$/),
    })
    .safeParse(config);
  if (!parsed.success)
    throw new Error('Configuração WhatsApp incompleta ou inválida. Consulte WHATSAPP.md.');
  return parsed.data;
}

function secretMatches(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
const message = z.object({
  id: z.string().min(1).max(512),
  from: z.string().regex(/^[1-9]\d{9,14}$/),
  type: z.string(),
  referral: z
    .object({
      source_type: z.string().trim().max(50).nullish(),
      source_id: z.string().trim().max(512).nullish(),
      source_url: z.string().trim().max(4096).nullish(),
      ctwa_clid: z.string().trim().max(2048).nullish(),
      headline: z.string().trim().max(1000).nullish(),
      body: z.string().trim().max(4000).nullish(),
      media_type: z.string().trim().max(50).nullish(),
      image_url: z.string().trim().max(4096).nullish(),
      video_url: z.string().trim().max(4096).nullish(),
      thumbnail_url: z.string().trim().max(4096).nullish(),
    })
    .optional(),
});
const envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: z.string(),
        changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(1000),
      }),
    )
    .max(1000),
});
const valueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: z.string() }),
  contacts: z
    .array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() }))
    .optional(),
  messages: z.array(message).max(1000).optional(),
});

type Referral = NonNullable<z.infer<typeof message>['referral']>;
const present = (value: string | null | undefined) => value || undefined;
function metaAttribution(referral: Referral | undefined): MetaAttributionInput | undefined {
  if (referral?.source_type !== 'ad') return;
  const source_id = present(referral.source_id);
  const source_url = present(referral.source_url);
  const ctwa_clid = present(referral.ctwa_clid);
  // A signed payload still needs an ad/click identifier before it is treated as attribution.
  if (!source_id && !source_url && !ctwa_clid) return;
  return {
    provider: 'meta',
    channel: 'whatsapp',
    source_type: 'ad',
    source_id,
    source_url,
    ctwa_clid,
    headline: present(referral.headline),
    body: present(referral.body),
    media_type: present(referral.media_type),
    image_url: present(referral.image_url),
    video_url: present(referral.video_url),
    thumbnail_url: present(referral.thumbnail_url),
  };
}

export class WhatsAppCentral {
  constructor(
    private crm: CRM | MongoOperations,
    private config?: WhatsAppConfig,
  ) {}

  async receive(raw: Buffer, signature: unknown) {
    const config = this.config;
    if (!config) throw new DomainError('WHATSAPP_DISABLED', 'Central não configurada.', 503);
    if (
      typeof signature !== 'string' ||
      !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
      !timingSafeEqual(
        createHmac('sha256', config.appSecret).update(raw).digest(),
        Buffer.from(signature.slice(7), 'hex'),
      )
    )
      throw new DomainError('INVALID_SIGNATURE', 'Assinatura inválida.', 401);
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      throw new DomainError('INVALID_WEBHOOK', 'Evento inválido.', 400);
    }
    const events: { id: string; lead: LeadInput }[] = [];
    for (const entry of parsed.entry) {
      if (entry.id !== config.wabaId) continue;
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue; // No echoes, historical sync or other fields.
        const metadata = z
          .object({ metadata: z.object({ phone_number_id: z.string() }) })
          .safeParse(change.value);
        if (!metadata.success || metadata.data.metadata.phone_number_id !== config.phoneNumberId)
          continue;
        const result = valueSchema.safeParse(change.value);
        if (!result.success)
          throw new DomainError('INVALID_WEBHOOK', 'Mensagem sem identificação válida.', 400);
        const value = result.data;
        for (const msg of value.messages ?? []) {
          const name = value.contacts
            ?.find((c) => c.wa_id === msg.from)
            ?.profile?.name?.trim()
            .slice(0, 160);
          const attribution = metaAttribution(msg.referral);
          events.push({
            id: `whatsapp:${config.phoneNumberId}:${msg.id}`,
            lead: {
              name: name || 'Contato WhatsApp',
              phone: msg.from,
              interest: '',
              unit: 'A definir',
              source: attribution ? 'Meta Ads' : 'Não identificada',
              source_evidence: attribution
                ? 'Webhook WhatsApp assinado com referência de anúncio enviada pela Meta.'
                : 'Entrada confirmada pelo WhatsApp central. Origem de marketing não atribuída.',
              meta_attribution: attribution,
              identity: {
                provider: 'whatsapp',
                account_id: config.phoneNumberId,
                external_user_id: msg.from,
                display_name: name,
              },
            },
          });
        }
      }
    }
    // Persist the entire batch before acknowledging. Chat bodies/media are not stored;
    // only the normalized ad referral supplied by Meta is retained.
    const db = this.crm.db;
    if (db.kind === 'mongo')
      await db.atomic(async (tx) => {
        const now = await tx.now();
        for (const event of events) {
          if (await wasDeleted(tx, event.id)) continue;
          await tx.collection('whatsapp_inbox').updateOne(
            { event_id: event.id },
            {
              $setOnInsert: {
                event_id: event.id,
                phone_number_id: config.phoneNumberId,
                lead: event.lead,
                received_at: now,
                available_at: now,
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
        await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
        for (const event of events) {
          if (await wasDeleted(tx, event.id)) continue;
          await tx.query(
            `INSERT INTO whatsapp_inbox(event_id,phone_number_id,lead)
          VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`,
            [event.id, config.phoneNumberId, JSON.stringify(event.lead)],
          );
        }
      });
  }

  async drain(limit = 25) {
    if (!this.config) return;
    const db = this.crm.db;
    // Do not acquire the domain write fence on an empty inbox every second.
    if (
      db.kind === 'mongo' &&
      !(await db.count('whatsapp_inbox', {
        processed_at: null,
        available_at: { $lte: await db.now() },
        phone_number_id: this.config.phoneNumberId,
      }))
    )
      return;
    for (let i = 0; i < limit; i++) {
      const lease = randomUUID();
      const row =
        db.kind === 'mongo'
          ? await db.atomic(async (tx) => {
              const now = await tx.now();
              const selected = (
                await tx.many<{ event_id: string; lead: LeadInput; attempts: number }>(
                  'whatsapp_inbox',
                  {
                    processed_at: null,
                    available_at: { $lte: now },
                    phone_number_id: this.config!.phoneNumberId,
                  },
                  { received_at: 1, event_id: 1 },
                  1,
                )
              )[0];
              if (!selected) return;
              await tx.update(
                'whatsapp_inbox',
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
                await tx.query<{ event_id: string; lead: LeadInput; attempts: number }>(
                  `SELECT event_id,lead,attempts FROM whatsapp_inbox
           WHERE processed_at IS NULL AND available_at <= clock_timestamp() AND phone_number_id=$1
           ORDER BY received_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
                  [this.config!.phoneNumberId],
                )
              ).rows[0];
              if (!selected) return;
              await tx.query(
                `UPDATE whatsapp_inbox SET lease_id=$2,attempts=attempts+1,
          available_at=clock_timestamp()+interval '2 minutes' WHERE event_id=$1`,
                [selected.event_id, lease],
              );
              return selected;
            });
      if (!row) return;
      try {
        // Ingest itself is idempotent: crash after commit, before marking done, is safe.
        const result = await this.crm.ingest(row.lead, row.event_id, null);
        if (db.kind === 'mongo')
          await db.update(
            'whatsapp_inbox',
            { event_id: row.event_id, lease_id: lease },
            {
              $set: {
                processed_at: await db.now(),
                opportunity_id: result.id,
                lease_id: null,
                last_error: null,
              },
            },
          );
        else
          await db.query(
            `UPDATE whatsapp_inbox SET processed_at=clock_timestamp(),
          opportunity_id=$3,lease_id=NULL,last_error=NULL WHERE event_id=$1 AND lease_id=$2`,
            [row.event_id, lease, result.id],
          );
      } catch {
        const seconds = Math.min(300, 2 ** Math.min(row.attempts + 1, 8));
        if (db.kind === 'mongo')
          await db.update(
            'whatsapp_inbox',
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
            `UPDATE whatsapp_inbox SET lease_id=NULL,last_error='PROCESSING_FAILED',
          available_at=clock_timestamp()+($3 * interval '1 second') WHERE event_id=$1 AND lease_id=$2`,
            [row.event_id, lease, seconds],
          );
      }
    }
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
            .collection('whatsapp_inbox')
            .aggregate([
              { $match: { phone_number_id: this.config.phoneNumberId } },
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
              `SELECT
      count(*) FILTER (WHERE processed_at IS NULL)::integer AS pending,
      count(*) FILTER (WHERE processed_at IS NULL AND last_error IS NOT NULL)::integer AS retrying,
      max(received_at) AS last_received_at, max(processed_at) AS last_processed_at
      FROM whatsapp_inbox WHERE phone_number_id=$1`,
              [this.config.phoneNumberId],
            )
          ).rows[0];
    return { configured: true, state: 'configured', ...row };
  }
}

export async function registerWhatsApp(
  app: FastifyInstance,
  crm: CRM | MongoOperations,
  config?: WhatsAppConfig,
  runWorker = true,
) {
  const central = new WhatsAppCentral(crm, config);
  await app.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    scope.get('/webhooks/whatsapp', { config: { rateLimit: false } }, async (request, reply) => {
      if (!config) throw new DomainError('WHATSAPP_DISABLED', 'Central não configurada.', 503);
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
      '/webhooks/whatsapp',
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
  const tick = () => {
    if (!active)
      active = central
        .drain()
        .catch(() => app.log.error('WhatsApp inbox processing failed'))
        .finally(() => {
          active = undefined;
        });
  };
  const timer = config && runWorker ? setInterval(tick, 1000) : undefined;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await active;
  });
  return central;
}
