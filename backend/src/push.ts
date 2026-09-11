import { createECDH, createHash, randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tokenHash } from './auth.js';
import { DomainError, type User } from './types.js';
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
  private async recipient(tx: PushTx, subscription: PushRecord, now: Date) {
    if (
      subscription.expires_at <= now.toISOString() ||
      subscription.data.publicKey !== this.config?.publicKey
    )
      return null;
    const user = await pushUser(tx, subscription.data.userId);
    return user?.active &&
      !user.must_change_password &&
      user.auth_version === subscription.data.authVersion
      ? user
      : null;
  }
  private async message(tx: PushTx, event: PushRecord, user: User, now: Date) {
    const lead = await pushOpportunity(tx, event.data.opportunityId);
    if (!lead || ['WON', 'LOST'].includes(lead.stage) || lead.state !== event.data.state)
      return null;
    const target = lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id;
    if (
      target !== event.data.target ||
      (lead.state === 'RESERVED' && (!lead.expires_at || new Date(lead.expires_at) <= now))
    )
      return null;
    const manager = user.role === 'manager';
    if (!manager && lead.state !== 'POOL' && target !== user.id) return null;
    if (!['POOL', 'RESERVED', 'CLAIMED', 'PENDING'].includes(lead.state)) return null;
    return {
      title: 'Artisti CRM',
      body:
        lead.state === 'POOL'
          ? 'Há uma oportunidade disponível no bolsão. Abra o CRM para conferir.'
          : manager
            ? 'Há uma nova movimentação na distribuição. Abra o CRM para conferir.'
            : lead.state === 'CLAIMED'
              ? 'Uma oportunidade foi atribuída a você. Abra o CRM para conferir.'
              : 'Você recebeu uma oportunidade. Abra o CRM para conferir o prazo e assumir.',
      page: manager ? 'distribution' : lead.state === 'POOL' ? 'pool' : 'mine',
      tag: `artisti-${lead.id}`,
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
        !(await this.recipient(tx, subscription, now))
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
            tag: 'artisti-test',
          },
        },
      });
    });
    return { ok: true };
  }
  // Events are persisted in the same transaction as each distribution change.
  // Expand atomically, lease briefly, then perform network I/O outside the DB lock.
  async tick() {
    const now = await this.clock();
    const jobs = await inPushTransaction(this.db, async (tx) => {
      await cleanPush(tx, now.toISOString());
      if (!this.config) return [];
      const subscriptions = await readyPush(
        tx,
        'subscription',
        now.toISOString(),
        MAX_SUBSCRIPTIONS + 1,
      );
      for (const event of await readyPush(tx, 'event', now.toISOString(), 50)) {
        for (const subscription of subscriptions) {
          if (subscription.data.createdAt > event.data.createdAt) continue;
          const user = await this.recipient(tx, subscription, now);
          if (!user) continue;
          const message = await this.message(tx, event, user, now);
          if (!message) continue;
          await putPush(tx, {
            id: `job:${event.id}:${subscription.id}`,
            kind: 'job',
            available_at: now.toISOString(),
            expires_at: event.expires_at,
            data: {
              subId: subscription.id,
              revision: subscription.data.revision,
              event,
              message,
              attempts: 0,
            },
          });
        }
        await removePush(tx, event.id);
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
    const subscription = await inPushTransaction(this.db, async (tx) => {
      const currentJob = await getPush(tx, job.id);
      if (!currentJob || currentJob.data.lease !== job.data.lease) return null;
      const sub = await getPush(tx, job.data.subId);
      const user =
        sub && sub.data.revision === job.data.revision && (await this.recipient(tx, sub, now));
      if (
        !user ||
        job.expires_at <= now.toISOString() ||
        (job.data.event && !(await this.message(tx, job.data.event, user, now)))
      ) {
        await removePush(tx, job.id);
        return null;
      }
      return sub;
    });
    if (!subscription || !this.config) return;
    let status = 200;
    try {
      await this.send(subscription.data.subscription, JSON.stringify(job.data.message), {
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
