import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CRM, LeadInput } from './crm.js';
import { DomainError } from './types.js';

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
    .object({ source_type: z.string().optional(), source_id: z.string().optional() })
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

export class WhatsAppCentral {
  constructor(
    private crm: CRM,
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
          const metaAd = msg.referral?.source_type === 'ad' && !!msg.referral.source_id;
          events.push({
            id: `whatsapp:${config.phoneNumberId}:${msg.id}`,
            lead: {
              name: name || 'Contato WhatsApp',
              phone: msg.from,
              interest: '',
              unit: 'A definir',
              source: metaAd ? 'Meta Ads' : 'Não identificada',
              source_evidence: metaAd
                ? 'Webhook WhatsApp assinado com referência de anúncio Meta.'
                : 'Entrada confirmada pelo WhatsApp central. Origem de marketing não atribuída.',
            },
          });
        }
      }
    }
    // Persist the entire batch before acknowledging. No chat bodies/media are stored.
    await this.crm.db.transaction(async (tx) => {
      for (const event of events)
        await tx.query(
          `INSERT INTO whatsapp_inbox(event_id,phone_number_id,lead)
          VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING`,
          [event.id, config.phoneNumberId, JSON.stringify(event.lead)],
        );
    });
  }

  async drain(limit = 25) {
    if (!this.config) return;
    for (let i = 0; i < limit; i++) {
      const lease = randomUUID();
      const row = await this.crm.db.transaction(async (tx) => {
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
        await this.crm.db.query(
          `UPDATE whatsapp_inbox SET processed_at=clock_timestamp(),
          opportunity_id=$3,lease_id=NULL,last_error=NULL WHERE event_id=$1 AND lease_id=$2`,
          [row.event_id, lease, result.id],
        );
      } catch {
        const seconds = Math.min(300, 2 ** Math.min(row.attempts + 1, 8));
        await this.crm.db.query(
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
    const row = (
      await this.crm.db.query(
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
  crm: CRM,
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
