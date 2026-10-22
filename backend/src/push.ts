import { createECDH, createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tokenHash } from './auth.js';
import { MongoTx } from './mongo-store.js';
import { DomainError, type Opportunity, type User } from './types.js';
import {
  cleanPush,
  getPush,
  inPushTransaction,
  putPush,
  pushOpportunity,
  pushUser,
  pushSession,
  readyPush,
  removePush,
  removePushSession,
  type PushDb,
  type PushRecord,
  type PushTx,
} from './push-store.js';
import { isLeadNotificationMuted } from './lead-notification-mutes.js';

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}
export function pushConfig(env: NodeJS.ProcessEnv): PushConfig | undefined {
  if (env.PUSH_ENABLED !== 'true') return;
  const {
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  } = env;
  try {
    if (
      !publicKey ||
      !privateKey ||
      !subject ||
      !/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/[^\s]+)$/.test(subject)
    )
      throw new Error();
    const pair = createECDH('prime256v1');
    pair.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    if (pair.getPublicKey().toString('base64url') !== publicKey) throw new Error();
    return { publicKey, privateKey, subject };
  } catch {
    throw new Error(
      'PUSH_ENABLED exige um par VAPID válido e VAPID_SUBJECT (mailto:email ou HTTPS).',
    );
  }
}

// Browser-created push services only. Never turn this API into a generic HTTP proxy.
export function validPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname !== '/' &&
      (url.hostname === 'fcm.googleapis.com' ||
        url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname.endsWith('.push.services.mozilla.com') ||
        url.hostname === 'web.push.apple.com' ||
        url.hostname.endsWith('.notify.windows.com'))
    );
  } catch {
    return false;
  }
}
const endpointSchema = z
  .string()
  .max(2048)
  .refine(validPushEndpoint, 'Serviço de notificações não reconhecido.');
const encodedKey = (length: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/)
    .max(100)
    .refine((v) => Buffer.from(v, 'base64url').length === length);
const subscriptionSchema = z
  .object({
    endpoint: endpointSchema,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: encodedKey(65), auth: encodedKey(16) }).strict(),
  })
  .strict();
const endpointBody = z.object({ endpoint: endpointSchema }).strict();
const subscriptionId = (endpoint: string) =>
  `sub:${createHash('sha256').update(endpoint).digest('hex')}`;
const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();
const MAX_SUBSCRIPTIONS = 500;
const MAX_EXPANSION_CHECKS = 500;
const isMessageEvent = (event: PushRecord) =>
  ['message.received', 'comment.received.owned'].includes(event.data.kind);
const leadTarget = (lead: Pick<Opportunity, 'state' | 'reserved_to' | 'owner_id'>) =>
  lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id;
const messageRoute = (state: unknown, target: unknown) => JSON.stringify([state, target ?? null]);

// A cache belongs to ONE transaction only. Reuse reads across events/devices,
// but always take a fresh snapshot before delivery (ownership, mute and access).
class PushSnapshot {
  private values = new Map<string, Promise<unknown>>();
  constructor(readonly tx: PushTx) {}
  private read<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.values.has(key)) this.values.set(key, load());
    return this.values.get(key)! as Promise<T>;
  }
  user(id: string) {
    return this.read(`user:${id}`, () => pushUser(this.tx, id));
  }
  opportunity(id: string) {
    return this.read(`lead:${id}`, () => pushOpportunity(this.tx, id));
  }
  muted(userId: string, opportunityId: string) {
    return this.read(`mute:${userId}:${opportunityId}`, () =>
      isLeadNotificationMuted(this.tx, userId, opportunityId),
    );
  }
  comment(accountId: string, commentId: string) {
    return this.read(`comment:${JSON.stringify([accountId, commentId])}`, async () =>
      this.tx instanceof MongoTx
        ? this.tx.one<Record<string, any>>('instagram_comments', {
            account_id: accountId,
            comment_id: commentId,
          })
        : (
            await this.tx.query<Record<string, any>>(
              'SELECT * FROM instagram_comments WHERE account_id=$1 AND comment_id=$2',
              [accountId, commentId],
            )
          ).rows[0],
    );
  }
}
export type PushSender = typeof webpush.sendNotification;

export class PushService {
  constructor(
    readonly db: PushDb,
    readonly config: PushConfig | undefined,
    readonly clock: () => Promise<Date>,
    private send: PushSender = webpush.sendNotification,
  ) {}
  private requireConfig() {
    if (!this.config)
      throw new DomainError(
        'PUSH_DISABLED',
        'Notificações ainda não foram ativadas no servidor.',
        503,
      );
    return this.config;
  }
  async subscribe(user: User, body: unknown, sessionHash: string) {
    const config = this.requireConfig();
    const subscription = subscriptionSchema.parse(body);
    const now = await this.clock();
    await inPushTransaction(this.db, async (tx) => {
      const current = await pushUser(tx, user.id);
      if (
        !current?.active ||
        current.must_change_password ||
        current.auth_version !== user.auth_version ||
        !(await pushSession(tx, sessionHash, user.id, user.auth_version, now))
      )
        throw new DomainError('UNAUTHENTICATED', 'Entre novamente.', 401);
      await cleanPush(tx, now.toISOString());
      const id = subscriptionId(subscription.endpoint);
      const previous = await getPush(tx, id);
      const all = await readyPush(tx, 'subscription', now.toISOString(), MAX_SUBSCRIPTIONS + 1);
      if (
        (!previous && all.length >= MAX_SUBSCRIPTIONS) ||
        (previous?.data.userId !== user.id &&
          all.filter((s) => s.data.userId === user.id).length >= 10)
      )
        throw new DomainError(
          'DEVICE_LIMIT',
          'Limite de aparelhos atingido. Desative os avisos em um aparelho antigo.',
          409,
        );
      const same =
        previous?.data.userId === user.id &&
        previous.data.authVersion === user.auth_version &&
        previous.data.publicKey === config.publicKey &&
        JSON.stringify(previous.data.subscription.keys) === JSON.stringify(subscription.keys);
      await putPush(tx, {
        id,
        kind: 'subscription',
        available_at: now.toISOString(),
        expires_at: later(now, 30 * 86400000),
        data: {
          subscription,
          userId: user.id,
          authVersion: user.auth_version,
          sessionHash,
          publicKey: config.publicKey,
          revision: same ? previous!.data.revision : randomUUID(),
          createdAt: same ? previous!.data.createdAt : now.toISOString(),
        },
      });
    });
    return { ok: true };
  }
  async unsubscribe(user: User, body: unknown) {
    const { endpoint } = endpointBody.parse(body);
    await inPushTransaction(this.db, async (tx) => {
      const row = await getPush(tx, subscriptionId(endpoint));
      if (row?.data.userId === user.id) await removePush(tx, row.id);
    });
    return { ok: true };
  }
  async logout(sessionHash: string) {
    const now = await this.clock();
    await inPushTransaction(this.db, async (tx) => {
      await removePushSession(tx, sessionHash);
      for (const row of await readyPush(
        tx,
        'subscription',
        now.toISOString(),
        MAX_SUBSCRIPTIONS + 1,
      ))
        if (row.data.sessionHash === sessionHash) await removePush(tx, row.id);
    });
  }
  private async recipient(reads: PushSnapshot, subscription: PushRecord, now: Date) {
    if (
      subscription.expires_at <= now.toISOString() ||
      subscription.data.publicKey !== this.config?.publicKey
    )
      return null;
    const user = await reads.user(subscription.data.userId);
    return user?.active &&
      !user.must_change_password &&
      user.auth_version === subscription.data.authVersion
      ? user
      : null;
  }
  private async message(reads: PushSnapshot, event: PushRecord, user: User, now: Date) {
    if (event.data.kind === 'comment.received') {
      if (user.role !== 'manager' && !user.queue_enabled) return null;
      const comment = await reads.comment(event.data.accountId, event.data.commentId);
      if (
        !comment ||
        comment.ignored ||
        comment.opportunity_id ||
        new Date(comment.reply_deadline_at) <= now
      )
        return null;
      return {
        title: 'Artisti CRM',
        body: 'Novo comentário disponível no bolsão.',
        page: 'comments',
        userId: user.id,
        tag: `artisti-${createHash('sha256').update(event.id).digest('hex').slice(0, 32)}`,
      };
    }
    if (event.data.kind === 'lead.deleted') {
      if (user.role !== 'manager' && event.data.target !== user.id) return null;
      return {
        title: 'Artisti CRM',
        body: 'Um lead foi excluído pela gestão. Sua lista foi atualizada.',
        page: user.role === 'manager' ? 'central' : 'mine',
        userId: user.id,
        tag: `artisti-${createHash('sha256').update(event.id).digest('hex').slice(0, 32)}`,
      };
    }
    const lead = await reads.opportunity(event.data.opportunityId);
    if (!lead || lead.non_commercial_reason) return null;
    const kind = String(event.data.kind);
    const received = kind === 'message.received' || kind === 'comment.received.owned';
    const movement = [
      'opportunity.claimed',
      'opportunity.transferred',
      'opportunity.updated',
      'appointment.created',
      'appointment.updated',
      'sale.completed',
      'sale.updated',
      'lead.repeated',
    ].includes(kind);
    if (!received && !movement && lead.state === 'CANCELLED') return null;
    const target = lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id;
    const manager = user.role === 'manager';
    if (lead.state === 'POOL' && !manager && !user.queue_enabled) return null;
    if (received) {
      // A message follows the current responsible attendant, even if ownership
      // changed between webhook persistence and push expansion.
      if (!manager && lead.state !== 'POOL' && target !== user.id) return null;
      if (!['POOL', 'RESERVED', 'CLAIMED', 'PENDING', 'CANCELLED'].includes(lead.state))
        return null;
      if (!manager && (await reads.muted(user.id, lead.id))) return null;
    } else if (movement) {
      // Preserve each completed business action. A later action must not erase
      // an earlier notification that was already committed to the audit trail.
      if (!manager && event.data.target !== user.id && event.data.previousTarget !== user.id)
        return null;
    } else {
      // Distribution notices describe current work. Discard them if their
      // reservation, state or responsible attendant is no longer current.
      if (
        lead.state !== event.data.state ||
        target !== event.data.target ||
        (lead.state === 'RESERVED' && (!lead.expires_at || new Date(lead.expires_at) <= now))
      )
        return null;
      if (!manager && lead.state !== 'POOL' && target !== user.id) return null;
      if (!['POOL', 'RESERVED', 'CLAIMED', 'PENDING'].includes(lead.state)) return null;
    }
    const descriptions: Record<string, string> = {
      'message.received': 'Nova mensagem de um lead. Abra o CRM para conferir.',
      'comment.received.owned': 'Um lead comentou no Instagram. Abra o CRM para conferir.',
      'opportunity.claimed': 'Um lead foi assumido. Abra o CRM para conferir.',
      'opportunity.updated': 'O cadastro ou a qualificação de um lead foi atualizado.',
      'appointment.created': 'Uma consulta foi agendada. Abra o CRM para conferir.',
      'appointment.updated': 'Uma consulta ou o comparecimento foi atualizado.',
      'sale.completed': 'Uma venda foi registrada. Abra o CRM para conferir.',
      'sale.updated': 'Uma venda foi atualizada. Abra o CRM para conferir.',
      'lead.repeated': 'Um lead entrou em contato novamente. Abra o CRM para conferir.',
      'opportunity.transferred': 'Um lead foi transferido. Abra o CRM para conferir.',
    };
    const canOpenChat = received && (manager || lead.owner_id === user.id);
    const body =
      kind === 'opportunity.transferred' && !manager
        ? event.data.previousTarget === user.id
          ? 'Um lead foi transferido da sua carteira. Sua lista foi atualizada.'
          : 'Um lead foi atribuído a você. Abra o CRM para conferir.'
        : descriptions[kind];
    return {
      title: 'Artisti CRM',
      body:
        body ??
        (lead.state === 'POOL'
          ? 'Há uma oportunidade disponível no bolsão. Abra o CRM para conferir.'
          : manager
            ? 'Há uma nova movimentação na distribuição. Abra o CRM para conferir.'
            : lead.state === 'CLAIMED'
              ? 'Uma oportunidade foi atribuída a você. Abra o CRM para conferir.'
              : 'Você recebeu uma oportunidade. Abra o CRM para conferir o prazo e assumir.'),
      page: canOpenChat ? 'inbox' : manager ? 'central' : lead.state === 'POOL' ? 'pool' : 'mine',
      opportunityId: canOpenChat ? lead.id : undefined,
      userId: user.id,
      // Each message must alert, even when it belongs to an already-notified lead.
      tag: `artisti-${createHash('sha256').update(event.id).digest('hex').slice(0, 32)}`,
    };
  }
  async test(user: User, body: unknown) {
    this.requireConfig();
    const { endpoint } = endpointBody.parse(body);
    const now = await this.clock();
    await inPushTransaction(this.db, async (tx) => {
      const subscription = await getPush(tx, subscriptionId(endpoint));
      if (
        !subscription ||
        subscription.data.userId !== user.id ||
        !(await this.recipient(new PushSnapshot(tx), subscription, now))
      )
        throw new DomainError(
          'NOT_SUBSCRIBED',
          'Ative as notificações neste aparelho novamente.',
          409,
        );
      await putPush(tx, {
        id: `test:${randomUUID()}`,
        kind: 'job',
        available_at: now.toISOString(),
        expires_at: later(now, 300000),
        data: {
          subId: subscription.id,
          revision: subscription.data.revision,
          attempts: 0,
          message: {
            title: 'Artisti CRM',
            body: 'Notificações funcionando neste aparelho.',
            page: 'settings',
            tag: `artisti-test-${randomUUID()}`,
            userId: user.id,
          },
        },
      });
    });
    return { ok: true };
  }
  private deliveryJob(
    event: PushRecord,
    subscription: PushRecord,
    message: Record<string, unknown>,
    now: Date,
    routing: string | undefined,
    attempts = 0,
  ): PushRecord {
    return {
      id: `job:${event.id}:${subscription.id}`,
      kind: 'job',
      available_at: now.toISOString(),
      expires_at: event.expires_at,
      data: {
        subId: subscription.id,
        revision: subscription.data.revision,
        event,
        message,
        routing,
        attempts,
      },
    };
  }
  private async keepMessageRouting(
    tx: PushTx,
    event: PushRecord,
    issued: Set<string>,
    routing: string | undefined,
  ) {
    // Dormant until expiry: not polled as pending work. This small checkpoint
    // prevents a retry/transfer from recreating already delivered or muted jobs.
    // It uses the existing indexed store and the original one-hour retention.
    await putPush(tx, {
      ...event,
      available_at: event.expires_at,
      data: { ...event.data, issuedSubscriptions: [...issued], routing },
    });
  }
  private async rerouteMessage(
    reads: PushSnapshot,
    job: PushRecord,
    event: PushRecord,
    lead: Opportunity,
    now: Date,
    releasePrevious: boolean,
  ) {
    const checkpoint = await getPush(reads.tx, event.id);
    const routing = messageRoute(lead.state, leadTarget(lead));
    const issued = new Set<string>(checkpoint?.data.issuedSubscriptions ?? []);
    // Other pending devices of the same event can observe the same transfer.
    // Only the first transaction needs to discover the new recipients.
    if (checkpoint?.data.routing === routing) {
      if (releasePrevious && issued.delete(job.data.subId))
        await this.keepMessageRouting(reads.tx, event, issued, routing);
      return;
    }
    const subscriptions = await readyPush(
      reads.tx,
      'subscription',
      now.toISOString(),
      MAX_SUBSCRIPTIONS + 1,
    );
    if (!checkpoint?.data.issuedSubscriptions) {
      // Rolling-deploy compatibility: old jobs have no checkpoint. Preserve
      // their original recipients, and never overwrite a pending/leased job.
      for (const subscription of subscriptions) {
        if (subscription.data.createdAt > event.data.createdAt) continue;
        const user = await reads.user(subscription.data.userId);
        if (
          user &&
          (user.role === 'manager' || event.data.state === 'POOL' || user.id === event.data.target)
        )
          issued.add(subscription.id);
      }
    }
    issued.add(job.data.subId);
    for (const subscription of subscriptions) {
      if (issued.has(subscription.id) || subscription.data.createdAt > event.data.createdAt)
        continue;
      const user = await this.recipient(reads, subscription, now);
      if (!user) continue;
      const message = await this.message(reads, event, user, now);
      if (!message) continue;
      const next = this.deliveryJob(
        event,
        subscription,
        message,
        now,
        routing,
        Math.max(0, job.data.attempts - 1),
      );
      if (!(await getPush(reads.tx, next.id))) await putPush(reads.tx, next);
      issued.add(subscription.id);
    }
    // An undelivered former-owner job may become eligible again on a later
    // transfer back. Delivered jobs and explicit mutes remain recorded above.
    if (releasePrevious) issued.delete(job.data.subId);
    await this.keepMessageRouting(reads.tx, event, issued, routing);
  }
  // Events are persisted in the same transaction as each distribution change.
  // Expand atomically, lease briefly, then perform network I/O outside the DB lock.
  async tick() {
    const now = await this.clock();
    const jobs = await inPushTransaction(this.db, async (tx) => {
      await cleanPush(tx, now.toISOString());
      if (!this.config) return [];
      const reads = new PushSnapshot(tx);
      const events = await readyPush(tx, 'event', now.toISOString(), 50);
      const subscriptions = events.length
        ? await readyPush(tx, 'subscription', now.toISOString(), MAX_SUBSCRIPTIONS + 1)
        : [];
      // Bound work under the distribution lock even with many devices. The
      // remaining events stay durable for subsequent ticks, in the same order.
      const limit = Math.max(
        1,
        Math.floor(MAX_EXPANSION_CHECKS / Math.max(1, subscriptions.length)),
      );
      for (const event of events.slice(0, limit)) {
        const received = isMessageEvent(event);
        const lead = received ? await reads.opportunity(event.data.opportunityId) : null;
        const routing = lead ? messageRoute(lead.state, leadTarget(lead)) : undefined;
        const issued = new Set<string>();
        for (const subscription of subscriptions) {
          if (subscription.data.createdAt > event.data.createdAt) continue;
          const user = await this.recipient(reads, subscription, now);
          if (!user) continue;
          const message = await this.message(reads, event, user, now);
          if (!message) continue;
          await putPush(tx, this.deliveryJob(event, subscription, message, now, routing));
          issued.add(subscription.id);
        }
        if (received && issued.size) await this.keepMessageRouting(tx, event, issued, routing);
        else await removePush(tx, event.id);
      }
      const pending = await readyPush(tx, 'job', now.toISOString(), 12);
      for (const job of pending) {
        job.available_at = later(now, 60000);
        job.data.lease = randomUUID();
        job.data.attempts += 1;
        await putPush(tx, job);
      }
      return pending;
    });
    for (let i = 0; i < jobs.length; i += 4)
      await Promise.all(jobs.slice(i, i + 4).map((job) => this.deliver(job)));
  }
  private async deliver(job: PushRecord) {
    const now = await this.clock();
    const delivery = await inPushTransaction(this.db, async (tx) => {
      const currentJob = await getPush(tx, job.id);
      if (!currentJob || currentJob.data.lease !== job.data.lease) return null;
      if (job.expires_at <= now.toISOString()) {
        await removePush(tx, job.id);
        return null;
      }
      const reads = new PushSnapshot(tx);
      const sub = await getPush(tx, job.data.subId);
      const user =
        sub && sub.data.revision === job.data.revision && (await this.recipient(reads, sub, now));
      const event: PushRecord | undefined = job.data.event;
      const message =
        user && (event ? await this.message(reads, event, user, now) : job.data.message);
      if (event && isMessageEvent(event)) {
        const lead = await reads.opportunity(event.data.opportunityId);
        const previousRouting =
          currentJob.data.routing ?? messageRoute(event.data.state, event.data.target);
        const routing = lead ? messageRoute(lead.state, leadTarget(lead)) : undefined;
        if (lead && !lead.non_commercial_reason && routing !== previousRouting) {
          const releasePrevious =
            !!user &&
            user.role !== 'manager' &&
            !message &&
            lead.state !== 'POOL' &&
            leadTarget(lead) !== user.id &&
            !(await reads.muted(user.id, lead.id));
          await this.rerouteMessage(reads, currentJob, event, lead, now, releasePrevious);
          if (message) {
            currentJob.data.routing = routing;
            await putPush(tx, currentJob);
          }
        }
      }
      if (!user || !message) {
        await removePush(tx, job.id);
        return null;
      }
      return { subscription: sub!, message };
    });
    if (!delivery || !this.config) return;
    const { subscription, message } = delivery;
    let status = 200;
    try {
      await this.send(subscription.data.subscription, JSON.stringify(message), {
        vapidDetails: this.config,
        timeout: 8000,
        urgency: 'high',
        TTL: Math.max(
          1,
          Math.min(300, Math.floor((Date.parse(job.expires_at) - now.getTime()) / 1000)),
        ),
      });
    } catch (error) {
      status = Number((error as { statusCode?: number }).statusCode) || 503;
    }
    await inPushTransaction(this.db, async (tx) => {
      const current = await getPush(tx, job.id);
      if (!current || current.data.lease !== job.data.lease) return;
      if (status === 404 || status === 410) {
        const sub = await getPush(tx, subscription.id);
        if (sub && sub.data.revision === job.data.revision) await removePush(tx, sub.id);
      }
      if (status < 300 || [400, 404, 410].includes(status) || job.data.attempts >= 5)
        await removePush(tx, job.id);
      else {
        current.available_at = later(
          await this.clock(),
          Math.min(300000, 15000 * 2 ** (job.data.attempts - 1)),
        );
        await putPush(tx, current);
      }
    });
  }
}

export function registerPush(
  app: FastifyInstance,
  db: PushDb,
  clock: () => Promise<Date>,
  config?: PushConfig,
  start = true,
  send?: PushSender,
) {
  const service = new PushService(db, config, clock, send);
  app.get('/api/v1/push/config', async () => ({
    enabled: !!config,
    publicKey: config?.publicKey ?? null,
  }));
  app.post(
    '/api/v1/push/subscriptions',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) =>
      service.subscribe(request.user, request.body, tokenHash(request.cookies.artisti_session!)),
  );
  app.delete('/api/v1/push/subscriptions', async (request) =>
    service.unsubscribe(request.user, request.body),
  );
  app.post(
    '/api/v1/push/test',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.user?.id ?? request.ip,
        },
      },
    },
    async (request) => service.test(request.user, request.body),
  );
  let running: Promise<void> | null = null;
  const tick = () => {
    if (!running)
      running = service
        .tick()
        .catch(() => app.log.error('Push queue processing failed'))
        .finally(() => {
          running = null;
        });
  };
  const timer = start ? setInterval(tick, config ? 5000 : 60000) : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await running;
  });
  return service;
}
