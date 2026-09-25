import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import { registerWhatsApp, type WhatsAppConfig } from './whatsapp.js';
import { registerInstagram, type InstagramConfig, type InstagramFetch } from './instagram.js';
import {
  registerMetaMarketing,
  type MetaMarketingConfig,
  type MetaMarketingFetch,
} from './meta-marketing.js';
import type { Database } from './db.js';
import { Operations } from './operations.js';
import { MongoOperations, publicUser } from './mongo-crm.js';
import type { MongoStore } from './mongo-store.js';
import { distributionBoard, distributionQuery } from './distribution.js';
import { reportsOverview, reportsQuery } from './reports.js';
import { tokenHash, verifyPassword } from './auth.js';
import { loginSchema, passwordSchema } from './credentials.js';
import { registerPush, type PushConfig, type PushSender } from './push.js';
import { DomainError, requireManager, stages, type User } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}
const uuid = z.string().uuid();
const idParams = z.object({ id: uuid });
const shortText = z.string().trim().max(160);
const optionalPhone = z
  .string()
  .transform((value) => value.replace(/[^\d+]/g, '').replace(/^\+/, ''))
  .pipe(
    z.union([
      z.literal(''),
      z.string().regex(/^[1-9]\d{9,14}$/, 'Informe o telefone com código do país e DDD.'),
    ]),
  )
  .transform((value) => value || null);
const leadSchema = z
  .object({
    name: shortText.min(2),
    phone: z
      .string()
      .transform((v) => v.replace(/[^\d+]/g, '').replace(/^\+/, ''))
      .pipe(z.string().regex(/^[1-9]\d{9,14}$/, 'Informe o telefone com código do país e DDD.')),
    interest: shortText.default(''),
    unit: shortText.default('A definir'),
    source: z
      .enum(['Não identificada', 'Google Ads', 'Meta Ads', 'Indicação', 'Cadastro manual'])
      .default('Cadastro manual'),
  })
  .strict();

export async function buildApp(
  db: Database | MongoStore,
  options: {
    clock?: () => Date;
    reconcile?: boolean;
    production?: boolean;
    appOrigin?: string;
    staticRoot?: string;
    whatsapp?: WhatsAppConfig;
    instagram?: InstagramConfig;
    instagramFetch?: InstagramFetch;
    metaMarketing?: MetaMarketingConfig;
    metaMarketingFetch?: MetaMarketingFetch;
    push?: PushConfig;
    pushSender?: PushSender;
    rateLimitMax?: number;
  } = {},
) {
  const app = Fastify({
    logger: options.production ? { level: 'error' } : false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 32_768,
    trustProxy: options.production ? (_address, hop) => hop === 0 : false,
  });
  const crm =
    db.kind === 'mongo'
      ? new MongoOperations(db, options.clock)
      : new Operations(db, options.clock);
  const metaMarketingRuntime = registerMetaMarketing(
    db,
    options.metaMarketing,
    options.reconcile !== false,
    options.metaMarketingFetch,
    options.clock,
  );
  await app.register(cookie);
  await app.register(rateLimit, { max: options.rateLimitMax ?? 240, timeWindow: '1 minute' });
  app.decorateRequest('user');
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    if (options.production)
      reply
        .header('Strict-Transport-Security', 'max-age=31536000')
        .header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net https://lookaside.fbsbx.com https://*.fbsbx.com; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        );
    if (!request.url.startsWith('/api/')) return;
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      const allowedOrigins = options.production
        ? [new URL(options.appOrigin!).origin]
        : [
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:5175',
            'http://localhost:4173',
            'http://127.0.0.1:4173',
            'http://127.0.0.1:3333',
            'http://localhost:3333',
          ];
      if (origin && !allowedOrigins.includes(origin)) {
        throw new DomainError('FORBIDDEN', 'Origem não permitida.', 403);
      }
      if (request.headers['x-artisti-client'] !== 'web')
        throw new DomainError('FORBIDDEN', 'Cabeçalho de segurança ausente.', 403);
    }
    if (request.url.split('?')[0] === '/api/v1/auth/login' || request.url === '/api/health') return;
    const token = request.cookies.artisti_session;
    if (!token) throw new DomainError('UNAUTHENTICATED', 'Entre para continuar.', 401);
    const session =
      db.kind === 'mongo'
        ? await db.one('sessions', {
            token_hash: tokenHash(token),
            expires_at: { $gt: await crm.now() },
          })
        : null;
    const mongoUser =
      db.kind === 'mongo' && session
        ? await db.one('users', {
            id: session.user_id,
            active: true,
            auth_version: session.auth_version,
          })
        : null;
    const user =
      db.kind === 'mongo'
        ? mongoUser
          ? publicUser(mongoUser)
          : undefined
        : (
            await db.query<User>(
              `SELECT u.id,u.name,u.email,u.role,u.active,u.queue_enabled,u.queue_position,u.queue_weight,u.color,u.version,u.auth_version,u.must_change_password FROM sessions s
      JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2 AND u.active AND s.auth_version=u.auth_version`,
              [tokenHash(token), await crm.now()],
            )
          ).rows[0];
    if (!user)
      throw new DomainError('UNAUTHENTICATED', 'Sua sessão expirou. Entre novamente.', 401);
    request.user = user;
    if (
      user.must_change_password &&
      !['/api/v1/me', '/api/v1/workspace', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(
        request.url.split('?')[0],
      )
    )
      throw new DomainError(
        'PASSWORD_CHANGE_REQUIRED',
        'Altere sua senha antes de acessar os dados.',
        403,
      );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError)
      return reply.status(400).send({
        code: 'INVALID_INPUT',
        message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(';'),
        request_id: request.id,
      });
    if (error instanceof DomainError)
      return reply
        .status(error.status)
        .send({ code: error.code, message: error.message, request_id: request.id });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500)
      return reply.status(status).send({
        code: 'REQUEST_ERROR',
        message: status === 429 ? 'Muitas tentativas. Aguarde um minuto.' : 'Requisição inválida.',
        request_id: request.id,
      });
    app.log.error(
      { requestId: request.id, code: (error as { code?: string }).code },
      'Request failed',
    );
    return reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: 'Não foi possível concluir. Tente novamente.',
      request_id: request.id,
    });
  });
  app.get('/api/health', async () => {
    if (db.kind === 'mongo') await db.database.command({ ping: 1 });
    else await db.query('SELECT 1');
    return {
      status: 'ok',
      mode: options.production ? 'staging' : db.kind === 'mongo' ? 'development' : 'local-demo',
    };
  });
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({
          login: loginSchema.optional(),
          // Compatibilidade durante a atualização de clientes que ainda enviam "email".
          email: loginSchema.optional(),
          password: passwordSchema,
        })
        .strict()
        .refine((value) => Boolean(value.login || value.email), {
          message: 'Informe o login.',
          path: ['login'],
        })
        .parse(request.body);
      const login = input.login ?? input.email!;
      const user =
        db.kind === 'mongo'
          ? await db.one<User & { password_hash: string }>('users', {
              email: login,
              active: true,
            })
          : (
              await db.query<User & { password_hash: string }>(
                'SELECT * FROM users WHERE lower(email)=$1 AND active',
                [login],
              )
            ).rows[0];
      if (!user || !(await verifyPassword(input.password, user.password_hash)))
        throw new DomainError('INVALID_CREDENTIALS', 'Login ou senha incorretos.', 401);
      const token = randomBytes(32).toString('base64url');
      if (db.kind === 'mongo')
        await db.atomic(async (tx) => {
          const current = await tx.one('users', { id: user.id });
          if (!current?.active || current.auth_version !== user.auth_version)
            throw new DomainError(
              'INVALID_CREDENTIALS',
              'Credenciais alteradas. Entre novamente.',
              401,
            );
          await tx.insert('sessions', {
            token_hash: tokenHash(token),
            user_id: user.id,
            expires_at: new Date(
              (options.clock ? options.clock() : await tx.now()).getTime() + 8 * 3_600_000,
            ),
            auth_version: user.auth_version,
          });
        });
      else
        await db.transaction(async (tx) => {
          const current = (
            await tx.query<User>('SELECT * FROM users WHERE id=$1 FOR SHARE', [user.id])
          ).rows[0];
          if (!current.active || current.auth_version !== user.auth_version)
            throw new DomainError(
              'INVALID_CREDENTIALS',
              'Credenciais alteradas. Entre novamente.',
              401,
            );
          await tx.query('INSERT INTO sessions VALUES ($1,$2,$3,$4)', [
            tokenHash(token),
            user.id,
            new Date((await new Operations(db, options.clock).now(tx)).getTime() + 8 * 3_600_000),
            user.auth_version,
          ]);
        });
      reply.setCookie('artisti_session', token, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: !!options.production,
        maxAge: 8 * 3600,
      });
      return { ok: true };
    },
  );
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await push.logout(tokenHash(request.cookies.artisti_session!));
    reply.clearCookie('artisti_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/v1/me', async (request) => request.user);
  app.get('/api/v1/workspace', async (request) =>
    request.user.must_change_password
      ? {
          user: request.user,
          users: [],
          opportunities: [],
          appointments: [],
          settings: { version: 0, timeout_minutes: 10, last_position: 0 },
          server_time: (await crm.now()).toISOString(),
          demo: !options.production && db.kind !== 'mongo',
          limit: 0,
        }
      : { ...(await crm.snapshot(request.user)), demo: !options.production && db.kind !== 'mongo' },
  );
  app.get('/api/v1/distribution/board', async (request) => {
    requireManager(request.user);
    const query = distributionQuery.parse(request.query);
    await crm.expire();
    return distributionBoard(db, request.user, query, () => crm.now());
  });
  app.get('/api/v1/reports/overview', async (request) => {
    requireManager(request.user);
    const query = reportsQuery.parse(request.query);
    await crm.expire();
    return reportsOverview(db, request.user, query, () => crm.now());
  });
  app.get('/api/v1/opportunities/:id', async (request) =>
    crm.detail(request.user, idParams.parse(request.params).id),
  );
  app.post('/api/v1/opportunities', async (request, reply) => {
    requireManager(request.user);
    const input = leadSchema.parse(request.body);
    const key = z.string().min(8).max(100).parse(request.headers['idempotency-key']);
    const result = await crm.ingest(
      input,
      `manual:${request.user.id}:${key}`,
      request.user.id,
      request.user,
    );
    return reply.status(result.duplicate ? 200 : 201).send(result);
  });
  app.post('/api/v1/opportunities/:id/claim', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        expected_version: z.number().int().positive(),
        mode: z.enum(['reservation', 'pool']),
      })
      .strict()
      .parse(request.body);
    const key = z.string().min(8).max(100).parse(request.headers['idempotency-key']);
    return crm.claim(request.user, id, body.mode, body.expected_version, key);
  });
  app.delete('/api/v1/opportunities/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        expected_version: z.number().int().positive(),
        confirmation: z.literal('EXCLUIR'),
      })
      .strict()
      .parse(request.body);
    const key = z.string().min(8).max(100).parse(request.headers['idempotency-key']);
    return crm.deleteLead(request.user, id, body, key);
  });
  app.post('/api/v1/opportunities/:id/whatsapp-link', async (request) => {
    const row = await crm.detail(request.user, idParams.parse(request.params).id);
    if (row.owner_id !== request.user.id)
      throw new DomainError(
        'FORBIDDEN',
        'Assuma o lead no perfil de atendimento antes de abrir o contato.',
        403,
      );
    if (row.is_demo)
      throw new DomainError('DEMO_CONTACT', 'Contato fictício: nenhum WhatsApp será aberto.', 400);
    if (!row.phone)
      throw new DomainError(
        'PHONE_UNAVAILABLE',
        'Este contato chegou por outro canal e ainda não informou um telefone.',
        400,
      );
    return { url: `https://wa.me/${row.phone}` };
  });
  app.patch('/api/v1/opportunities/:id', async (request) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        name: shortText.min(2),
        phone: optionalPhone.optional(),
        email: z.union([z.literal(''), z.string().email().max(200)]).optional(),
        residence_city: shortText.optional(),
        instagram: shortText,
        interest: shortText,
        unit: shortText,
        stage: z.enum(stages),
        procedure_date: z.union([z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/), z.null()]),
        next_action: z.string().trim().max(1000),
      })
      .strict()
      .parse(request.body);
    return crm.update(request.user, idParams.parse(request.params).id, input);
  });
  app.put('/api/v1/opportunities/:id/sale', async (request) => {
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        name: shortText.min(2),
        phone: optionalPhone.refine((value) => value !== null, 'Informe o telefone do paciente.'),
        residence_city: shortText.min(2),
        instagram: shortText.optional(),
        next_action: z.string().trim().max(1000).optional(),
        consultant: shortText.min(2),
        total_value_cents: z.number().int().min(0).max(2_000_000_000),
        down_payment_cents: z.number().int().min(0).max(2_000_000_000),
        hair_grade_classification: shortText.min(1),
        has_pack: z.boolean(),
        unit: shortText.min(2),
        procedure_date: z.union([z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/), z.null()]),
        contract_status: z.enum(['awaiting', 'signed', 'not_signed']),
      })
      .strict()
      .parse(request.body);
    return crm.recordSale(
      request.user,
      idParams.parse(request.params).id,
      input,
      commandKey(request.headers),
    );
  });
  app.post('/api/v1/opportunities/:id/appointments', async (request) => {
    const input = z
      .object({
        starts_at: z.string().datetime({ offset: true }),
        unit: shortText.min(2),
        expected_version: z.number().int().positive(),
      })
      .strict()
      .parse(request.body);
    return crm.schedule(request.user, idParams.parse(request.params).id, input);
  });
  app.patch('/api/v1/distribution/settings', async (request) => {
    const input = z
      .object({
        version: z.number().int().positive(),
        timeout_minutes: z.number().int().min(1).max(60),
        participants: z
          .array(
            z.object({
              id: uuid,
              enabled: z.boolean(),
              weight: z.number().int().min(1).max(3).optional(),
            }),
          )
          .max(30),
      })
      .strict()
      .parse(request.body);
    return crm.configure(request.user, input);
  });
  app.get('/api/v1/integrations/status', async (request) => {
    requireManager(request.user);
    const metaMarketingStatus = await metaMarketingRuntime.marketing.status();
    return ['whatsapp', 'instagram', 'meta-ads', 'google-ads', 'web-push', 'gtm'].map((id) => ({
      id,
      status:
        (id === 'whatsapp' && options.whatsapp) ||
        (id === 'instagram' && options.instagram) ||
        (id === 'meta-ads' && metaMarketingStatus.configured) ||
        (id === 'web-push' && options.push)
          ? 'configured'
          : 'not_connected',
      last_sync: id === 'meta-ads' ? metaMarketingStatus.last_completed_at : null,
    }));
  });
  const commandKey = (headers: Record<string, unknown>) =>
    z.string().min(8).max(100).parse(headers['idempotency-key']);
  const password = passwordSchema;
  const reason = z.string().trim().min(5, 'Explique o motivo em pelo menos 5 caracteres.').max(500);
  app.post('/api/v1/users', async (request, reply) => {
    requireManager(request.user);
    const input = z
      .object({
        name: shortText.min(2),
        login: loginSchema.optional(),
        // Compatibilidade com o formulário anterior durante o deploy.
        email: loginSchema.optional(),
        password,
        queue_position: z.number().int().min(1).max(99),
      })
      .strict()
      .refine((value) => Boolean(value.login || value.email), {
        message: 'Informe o login.',
        path: ['login'],
      })
      .parse(request.body);
    const login = input.login ?? input.email!;
    if (options.production && login.endsWith('@demo.artisti.local'))
      throw new DomainError('INVALID_INPUT', 'Use um login de acesso próprio.', 400);
    return reply.code(201).send(
      await crm.createAttendant(
        request.user,
        {
          name: input.name,
          email: login,
          password: input.password,
          queue_position: input.queue_position,
        },
        commandKey(request.headers),
      ),
    );
  });
  app.patch('/api/v1/users/:id', async (request) => {
    const input = z
      .object({
        name: shortText.min(2),
        active: z.boolean(),
        expected_version: z.number().int().positive(),
        replacement_id: uuid.optional(),
        reason,
      })
      .strict()
      .parse(request.body);
    return crm.updateAttendant(
      request.user,
      idParams.parse(request.params).id,
      input,
      commandKey(request.headers),
    );
  });
  app.delete('/api/v1/users/:id', async (request) => {
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        confirmation: z.literal('EXCLUIR'),
      })
      .strict()
      .parse(request.body);
    return crm.deleteAttendant(
      request.user,
      idParams.parse(request.params).id,
      input,
      commandKey(request.headers),
    );
  });
  app.post(
    '/api/v1/users/:id/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request) => {
      const input = z
        .object({ password, expected_version: z.number().int().positive() })
        .strict()
        .parse(request.body);
      return crm.resetPassword(
        request.user,
        idParams.parse(request.params).id,
        input.password,
        input.expected_version,
        commandKey(request.headers),
      );
    },
  );
  app.post(
    '/api/v1/auth/password',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = z
        .object({ current_password: z.string().min(1).max(128), new_password: password })
        .strict()
        .parse(request.body);
      const result = await crm.changePassword(
        request.user,
        input.current_password,
        input.new_password,
      );
      reply.clearCookie('artisti_session', { path: '/' });
      return result;
    },
  );
  app.post('/api/v1/opportunities/:id/transfer', async (request) => {
    const input = z
      .object({ expected_version: z.number().int().positive(), target_id: uuid, reason })
      .strict()
      .parse(request.body);
    return crm.transfer(
      request.user,
      idParams.parse(request.params).id,
      input,
      commandKey(request.headers),
    );
  });
  app.patch('/api/v1/appointments/:id', async (request) => {
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        status: z.enum(['scheduled', 'attended', 'no_show', 'cancelled']),
        starts_at: z.string().datetime({ offset: true }),
        unit: shortText.min(2),
        reason,
      })
      .strict()
      .parse(request.body);
    return crm.changeAppointment(
      request.user,
      idParams.parse(request.params).id,
      input,
      commandKey(request.headers),
    );
  });
  const central = await registerWhatsApp(app, crm, options.whatsapp, options.reconcile !== false);
  const instagram = await registerInstagram(
    app,
    crm,
    options.instagram,
    options.reconcile !== false,
    options.instagramFetch,
  );
  const push = registerPush(
    app,
    db,
    () => crm.now(),
    options.push,
    options.reconcile !== false,
    options.pushSender,
  );
  app.get('/api/v1/whatsapp/status', async (request) => {
    requireManager(request.user);
    return central.status();
  });
  app.get('/api/v1/instagram/status', async (request) => {
    requireManager(request.user);
    return instagram.status();
  });
  app.get('/api/v1/meta-marketing/status', async (request) => {
    requireManager(request.user);
    return metaMarketingRuntime.marketing.status();
  });
  app.post('/api/v1/meta-marketing/sync', async (request) => {
    requireManager(request.user);
    const input = z
      .object({ days: z.number().int().min(1).max(31).default(7) })
      .strict()
      .parse(request.body ?? {});
    return metaMarketingRuntime.marketing.sync(input.days);
  });
  app.get('/api/v1/reports/meta-ads', async (request) => {
    requireManager(request.user);
    const query = z
      .object({ from: z.string().date(), to: z.string().date() })
      .strict()
      .parse(request.query);
    return metaMarketingRuntime.marketing.report(query.from, query.to);
  });
  app.get('/api/v1/conversations', async (request) => {
    const query = z
      .object({ view: z.enum(['mine', 'reserved', 'pool', 'all']).optional() })
      .parse(request.query);
    return instagram.list(
      request.user,
      query.view ?? (request.user.role === 'manager' ? 'all' : 'mine'),
    );
  });
  app.get('/api/v1/conversations/:id/messages', async (request) =>
    instagram.messages(request.user, idParams.parse(request.params).id),
  );
  app.post('/api/v1/conversations/:id/read', async (request) =>
    instagram.markRead(request.user, idParams.parse(request.params).id),
  );
  app.post('/api/v1/conversations/:id/messages', async (request) => {
    const input = z
      .object({ text: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(request.body);
    return instagram.send(
      request.user,
      idParams.parse(request.params).id,
      input.text,
      commandKey(request.headers),
    );
  });
  let reconciling = false;
  const timer =
    options.reconcile === false
      ? null
      : setInterval(() => {
          if (reconciling) return;
          reconciling = true;
          void crm
            .expire()
            .catch(() => app.log.error('Expiry reconciliation failed'))
            .finally(() => {
              reconciling = false;
            });
        }, 5000);
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await metaMarketingRuntime.close();
  });
  if (options.staticRoot) {
    await app.register(fastifyStatic, { root: options.staticRoot, index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/'))
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Rota não encontrada.' });
      if (request.method === 'GET' && !request.url.split('?')[0].includes('.'))
        return reply.sendFile('index.html');
      return reply.status(404).send({ message: 'Não encontrado.' });
    });
  }
  return { app, crm, central, instagram, metaMarketing: metaMarketingRuntime.marketing, push };
}
