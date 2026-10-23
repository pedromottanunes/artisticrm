import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CommercialService } from './commercial-service.js';
import { commercialList, commercialListQuery } from './commercial-list.js';
import {
  evidenceCategories,
  extractionSchema,
  MAX_EVIDENCE_BYTES,
  type CommercialConfig,
  type CommercialAnalyzer,
  geminiAnalyzer,
} from './commercial-ai.js';
import type { CommercialDb } from './commercial-store.js';
import { DomainError } from './types.js';

const params = z.object({ id: z.string().uuid(), item: z.string().uuid().optional() });
const revision = z.number().int().min(0);
const reason = z.string().trim().min(10, 'Descreva o motivo da decisão.').max(500);
const commandKey = (headers: Record<string, unknown>) =>
  z.string().uuid().parse(headers['idempotency-key']);

export function registerCommercial(
  app: FastifyInstance,
  db: CommercialDb,
  config: CommercialConfig,
  options: { analyzer?: CommercialAnalyzer; clock?: () => Date; reconcile?: boolean } = {},
) {
  const service = new CommercialService(
    db,
    config,
    options.analyzer ?? geminiAnalyzer(config),
    options.clock,
  );
  const base = '/api/v1/opportunities/:id/commercial';
  const requireEnabled = async () => {
    if (!config.enabled)
      throw new DomainError(
        'COMMERCIAL_DISABLED',
        'Checagem documental ainda não habilitada.',
        404,
      );
  };
  app.get('/api/v1/commercial/config', async () => ({ enabled: config.enabled }));
  app.get('/api/v1/commercial/cases', { preHandler: requireEnabled }, async (request) =>
    commercialList(db, request.user, commercialListQuery.parse(request.query), options.clock?.()),
  );
  app.get(base, { preHandler: requireEnabled }, async (request) =>
    service.summary(request.user, params.parse(request.params).id),
  );
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp'],
    { parseAs: 'buffer', bodyLimit: MAX_EVIDENCE_BYTES },
    (_req, body, done) => done(null, body),
  );
  app.post(
    `${base}/evidence`,
    {
      bodyLimit: MAX_EVIDENCE_BYTES,
      preHandler: requireEnabled,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const category = z
        .object({ category: z.enum(evidenceCategories) })
        .strict()
        .parse(request.query).category;
      if (!Buffer.isBuffer(request.body))
        throw new DomainError('INVALID_FILE_TYPE', 'Envie uma imagem JPG, PNG ou WebP.', 400);
      const result = await service.upload(
        request.user,
        params.parse(request.params).id,
        commandKey(request.headers),
        category,
        request.body,
        String(request.headers['content-type']).split(';')[0],
      );
      return reply.code(201).send(result);
    },
  );
  app.get(
    `${base}/evidence/:item/image`,
    { preHandler: requireEnabled },
    async (request, reply) => {
      const { id, item } = params.parse(request.params);
      const image = await service.image(request.user, id, item!);
      return reply
        .type('image/jpeg')
        .header('Content-Disposition', 'inline; filename="evidencia.jpg"')
        .header('Cache-Control', 'private, no-store')
        .send(image);
    },
  );
  app.post(`${base}/analyses`, { preHandler: requireEnabled }, async (request, reply) => {
    const input = z
      .object({
        evidence_ids: z.array(z.string().uuid()).min(1).max(4),
        expected_revision: revision,
      })
      .strict()
      .parse(request.body);
    const result = await service.analyze(
      request.user,
      params.parse(request.params).id,
      commandKey(request.headers),
      input.evidence_ids,
      input.expected_revision,
    );
    return reply.code(202).send(result);
  });
  app.post(`${base}/analyses/:item/retry`, { preHandler: requireEnabled }, async (request) => {
    const { id, item } = params.parse(request.params);
    const input = z.object({ expected_revision: revision }).strict().parse(request.body);
    return service.retry(
      request.user,
      id,
      commandKey(request.headers),
      item!,
      input.expected_revision,
    );
  });
  app.post(`${base}/analyses/:item/review`, { preHandler: requireEnabled }, async (request) => {
    const { id, item } = params.parse(request.params);
    const input = z
      .object({
        expected_revision: revision,
        decision: z.enum(['confirm', 'reject']),
        result: extractionSchema.optional(),
        reason,
      })
      .strict()
      .parse(request.body);
    return service.review(
      request.user,
      id,
      commandKey(request.headers),
      item!,
      input.expected_revision,
      input.decision,
      input.result,
      input.reason,
    );
  });
  app.post(`${base}/evidence/:item/supersede`, { preHandler: requireEnabled }, async (request) => {
    const { id, item } = params.parse(request.params);
    const input = z.object({ expected_revision: revision, reason }).strict().parse(request.body);
    return service.supersede(
      request.user,
      id,
      commandKey(request.headers),
      item!,
      input.expected_revision,
      input.reason,
    );
  });
  app.post(`${base}/legacy-policy`, { preHandler: requireEnabled }, async (request) => {
    const input = z
      .object({
        expected_revision: revision,
        minimum_cents: z.union([z.literal(150000), z.literal(200000)]),
        reason,
      })
      .strict()
      .parse(request.body);
    return service.legacyPolicy(
      request.user,
      params.parse(request.params).id,
      commandKey(request.headers),
      input.expected_revision,
      input.minimum_cents,
      input.reason,
    );
  });
  let running: Promise<void> | null = null;
  const controller = new AbortController();
  const timer =
    config.enabled && config.aiEnabled && config.workerEnabled && options.reconcile !== false
      ? setInterval(() => {
          if (running) return;
          running = service
            .runOne(controller.signal)
            .then(() => {})
            .catch(() => app.log.error('Commercial worker failed'))
            .finally(() => {
              running = null;
            });
        }, 5000)
      : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    controller.abort();
    await running;
  });
  return service;
}
