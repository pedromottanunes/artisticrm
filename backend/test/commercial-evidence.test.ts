import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { openDatabase, migrate } from '../src/db.js';
import { openMongo, initializeMongo, mongoUser } from '../src/mongo-store.js';
import { Operations } from '../src/operations.js';
import { MongoOperations } from '../src/mongo-crm.js';
import { seedDemo } from '../src/seed.js';
import { tokenHash } from '../src/auth.js';
import { buildApp } from '../src/app.js';
import { AnalysisFailure, commercialConfig, type Extraction } from '../src/commercial-ai.js';
import type { CommercialDb } from '../src/commercial-store.js';
import type { User } from '../src/types.js';

const blank: Extraction = {
  patient_name: 'Paciente Teste',
  readable: true,
  warnings: [],
  payment: null,
  contract: null,
  fields: {
    total_value_cents: null,
    hair_grade_classification: null,
    pack_quantity: null,
    procedure_date: null,
  },
};
const paid = (amount = 200000, transaction = 'E12345678901234567890'): Extraction => ({
  ...blank,
  payment: {
    amount_cents: amount,
    paid_on: '2026-11-29',
    payer_name: 'Paciente Teste',
    recipient_name: 'Clínica teste',
    recipient_identifier: '12345678000190',
    transaction_id: transaction,
    state: 'completed',
  },
});

for (const kind of ['SQL', 'Mongo'] as const)
  test(`evidências comerciais: ${kind}`, { timeout: 120_000 }, async (t) => {
    let replica: MongoMemoryReplSet | undefined;
    let db: CommercialDb;
    if (kind === 'SQL') {
      db = await openDatabase();
      await migrate(db);
      await seedDemo(new Operations(db), false);
    } else {
      replica = await MongoMemoryReplSet.create({
        binary: { version: '8.0.12' },
        replSet: { count: 1, args: ['--setParameter', 'ttlMonitorEnabled=false'] },
      });
      db = await openMongo(replica.getUri(), `commercial_${randomUUID().replaceAll('-', '')}`);
      await initializeMongo(db);
      for (const [index, role] of ['manager', 'attendant', 'attendant'].entries())
        await db.insert('users', {
          ...mongoUser({
            name: `User ${index}`,
            email: `user${index}`,
            password_hash: 'unused',
            role: role as 'manager' | 'attendant',
            queue_position: index || null,
            color: '#000000',
          }),
          must_change_password: false,
        });
    }
    const users =
      db.kind === 'mongo'
        ? await db.many<User>('users', {}, { queue_position: 1 })
        : (await db.query<User>('SELECT * FROM users ORDER BY queue_position NULLS FIRST')).rows;
    const [manager, owner, stranger] = users;
    let extraction = paid();
    let analyzeImage = async () => structuredClone(extraction);
    const clock = () => new Date('2026-12-06T15:00:00Z');
    const config = {
      ...commercialConfig({}),
      enabled: true,
      aiEnabled: true,
      autoValidate: true,
      model: 'synthetic-test',
      recipientIdentifiers: ['12345678000190'],
    };
    const runtime = await buildApp(db, {
      reconcile: false,
      clock,
      commercial: config,
      commercialAnalyzer: async () => analyzeImage(),
    });
    const { app, crm, commercial } = runtime;
    const headersFor = async (user: User) => {
      const token = randomUUID();
      const session = {
        token_hash: tokenHash(token),
        user_id: user.id,
        auth_version: user.auth_version,
        expires_at: new Date('2027-01-01T00:00:00Z'),
      };
      if (db.kind === 'mongo') await db.insert('sessions', session);
      else
        await db.query(
          'INSERT INTO sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)',
          Object.values(session),
        );
      return { cookie: `artisti_session=${token}`, 'x-artisti-client': 'web' };
    };
    const headers = await headersFor(owner),
      otherHeaders = await headersFor(stranger),
      master = await headersFor(manager);
    let n = 0;
    const create = async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/opportunities',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: {
          name: 'Paciente Teste',
          phone: `55489999${String(++n).padStart(4, '0')}`,
          unit: 'Teste',
          source: 'Indicação',
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().id as string;
    };
    const get = async (id: string) =>
      (await app.inject({ url: `/api/v1/opportunities/${id}/commercial`, headers })).json();
    const image = async (color: number) =>
      sharp({
        create: { width: 80, height: 80, channels: 3, background: { r: color, g: 80, b: 120 } },
      })
        .png()
        .toBuffer();
    const upload = async (id: string, category = 'payment', color = 10, key = randomUUID()) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/commercial/evidence?category=${category}`,
        // Each synthetic patient is an independent test client; keep the real upload limiter.
        remoteAddress: `127.0.0.${n}`,
        headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': key },
        payload: await image(color),
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json();
    };
    const analyze = async (id: string, eid: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/opportunities/${id}/commercial/analyses`,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: { evidence_ids: [eid], expected_revision: (await get(id)).revision },
      });
      assert.equal(response.statusCode, 202, response.body);
      await commercial.runOne();
      return response.json().job_id as string;
    };
    const sale = async (id: string, seller = owner) => {
      const detail = await crm.detail(seller, id);
      return crm.recordSale(
        seller,
        id,
        {
          expected_version: detail.version,
          name: 'Paciente Teste',
          phone: detail.phone!,
          residence_city: '',
          consultant: seller.name,
          total_value_cents: 1500000,
          down_payment_cents: 200000,
          hair_grade_classification: '3A',
          has_pack: false,
          unit: 'Teste',
          procedure_date: null,
          contract_status: 'signed',
        },
        randomUUID(),
      );
    };
    const list = async (requestHeaders = headers, query = 'status=all') => {
      const response = await app.inject({
        url: `/api/v1/commercial/cases?${query}`,
        headers: requestHeaders,
      });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    try {
      await t.test('upload privado, idempotente, autorização e imagem inválida', async () => {
        const id = await create(),
          key = randomUUID();
        const first = await upload(id, 'payment', 10, key);
        assert.deepEqual(await upload(id, 'payment', 10, key), first);
        assert.equal((await get(id)).evidence.length, 1);
        const url = `/api/v1/opportunities/${id}/commercial/evidence/${first.evidence_id}/image`;
        assert.equal((await app.inject({ url, headers: otherHeaders })).statusCode, 404);
        assert.equal((await app.inject({ url })).statusCode, 401);
        const download = await app.inject({ url, headers });
        assert.equal(download.statusCode, 200);
        assert.match(download.headers['cache-control']!, /no-store/);
        const bad = await app.inject({
          method: 'POST',
          url: `/api/v1/opportunities/${id}/commercial/evidence?category=payment`,
          headers: { ...headers, 'content-type': 'image/png', 'idempotency-key': randomUUID() },
          payload: Buffer.from('<script>bad</script>'),
        });
        assert.equal(bad.statusCode, 400);
      });
      await t.test(
        'sinal + contrato geram competência correta; não mexem no rodízio nem registram venda',
        async () => {
          const id = await create();
          const before = await crm.detail(owner, id);
          const settings =
            db.kind === 'mongo'
              ? await db.one('distribution_settings', { id: 1 })
              : (await db.query('SELECT * FROM distribution_settings')).rows[0];
          extraction = paid();
          await analyze(id, (await upload(id)).evidence_id);
          let state = await get(id);
          assert.equal(state.assessment.confirmed_cents, 200000);
          assert.equal(state.assessment.eligible, false);
          extraction = {
            ...blank,
            contract: { signed_on: '2026-12-05', state: 'signed', contract_id: 'CTR001' },
          };
          await analyze(id, (await upload(id, 'signature', 20)).evidence_id);
          state = await get(id);
          assert.deepEqual(state.assessment.reasons, ['SALE_NOT_REGISTERED']);
          const after = await crm.detail(owner, id);
          assert.equal(after.sale_completed_at, null);
          assert.equal(after.version, before.version);
          assert.equal(after.owner_id, before.owner_id);
          const settingsAfter =
            db.kind === 'mongo'
              ? await db.one('distribution_settings', { id: 1 })
              : (await db.query('SELECT * FROM distribution_settings')).rows[0];
          assert.deepEqual(settingsAfter, settings);
          // Existing sale command remains the only way to register the commercial sale.
          await crm.recordSale(
            owner,
            id,
            {
              expected_version: after.version,
              name: 'Paciente Teste',
              phone: after.phone!,
              residence_city: '',
              consultant: owner.name,
              total_value_cents: 1500000,
              down_payment_cents: 200000,
              hair_grade_classification: '3A',
              has_pack: false,
              unit: 'Teste',
              procedure_date: null,
              contract_status: 'signed',
            },
            randomUUID(),
          );
          state = await get(id);
          assert.equal(state.assessment.eligible, true);
          assert.equal(state.assessment.expected_payment_on, '2026-12-10');
          const list = await app.inject({
            url: '/api/v1/commercial/cases?status=eligible',
            headers,
          });
          assert.equal(list.statusCode, 200, list.body);
          assert.ok(list.json().rows.some((r: any) => r.id === id));
          assert.equal(
            (
              await app.inject({
                url: '/api/v1/commercial/cases?status=all',
                headers: otherHeaders,
              })
            ).json().total,
            0,
          );
        },
      );
      await t.test(
        'transação repetida não conta em outro paciente; revisão humana não burla duplicidade',
        async () => {
          const id = await create();
          extraction = paid();
          const job = await analyze(id, (await upload(id, 'payment', 30)).evidence_id);
          const state = await get(id);
          assert.equal(state.assessment.confirmed_cents, 0);
          assert.ok(state.jobs[0].reasons.includes('DUPLICATE_PAYMENT'));
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/analyses/${job}/review`,
            headers: { ...master, 'idempotency-key': randomUUID() },
            payload: {
              expected_revision: state.revision,
              decision: 'confirm',
              result: extraction,
              reason: 'Conferência manual de teste',
            },
          });
          assert.equal(response.statusCode, 400);
        },
      );
      await t.test(
        'divergência vai para gestão; consultor não confirma; substituição revoga fato',
        async () => {
          const id = await create();
          extraction = { ...paid(50000, 'EOTHER001'), patient_name: 'Outra Pessoa' };
          const eid = (await upload(id, 'payment', 40)).evidence_id;
          const job = await analyze(id, eid);
          let state = await get(id);
          assert.equal(state.assessment.confirmed_cents, 0);
          assert.equal(state.assessment.pending_cents, 50000);
          const data = {
            expected_revision: state.revision,
            decision: 'confirm',
            result: extraction,
            reason: 'Pagamento por familiar conferido pela gestão.',
          };
          const url = `/api/v1/opportunities/${id}/commercial/analyses/${job}/review`;
          assert.equal(
            (
              await app.inject({
                method: 'POST',
                url,
                headers: { ...headers, 'idempotency-key': randomUUID() },
                payload: data,
              })
            ).statusCode,
            403,
          );
          const confirmed = await app.inject({
            method: 'POST',
            url,
            headers: { ...master, 'idempotency-key': randomUUID() },
            payload: data,
          });
          assert.equal(confirmed.statusCode, 200, confirmed.body);
          state = await get(id);
          assert.equal(state.assessment.confirmed_cents, 50000);
          const response = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/evidence/${eid}/supersede`,
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: {
              expected_revision: state.revision,
              reason: 'Documento anexado incorretamente.',
            },
          });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal((await get(id)).assessment.confirmed_cents, 0);
        },
      );
      await t.test(
        'exclusão autorizada remove arquivos e tarefas; trabalho antigo não ressuscita lead',
        async () => {
          const id = await create();
          const file = await upload(id, 'payment', 50);
          const detail = await crm.detail(owner, id);
          await crm.deleteLead(
            manager,
            id,
            { expected_version: detail.version, confirmation: 'EXCLUIR' },
            randomUUID(),
          );
          assert.equal(
            (
              await app.inject({
                url: `/api/v1/opportunities/${id}/commercial/evidence/${file.evidence_id}/image`,
                headers: master,
              })
            ).statusCode,
            404,
          );
          const count =
            db.kind === 'mongo'
              ? await db.count('commercial_files', { opportunity_id: id })
              : Number(
                  (
                    await db.query<{ count: string }>(
                      'SELECT count(*) FROM commercial_files WHERE opportunity_id=$1',
                      [id],
                    )
                  ).rows[0].count,
                );
          assert.equal(count, 0);
        },
      );
      await t.test(
        'dois workers não aplicam o mesmo pagamento; resultado antigo não vale após desconsiderar',
        async () => {
          const id = await create();
          const file = await upload(id, 'payment', 60);
          const queued = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/analyses`,
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: {
              evidence_ids: [file.evidence_id],
              expected_revision: (await get(id)).revision,
            },
          });
          assert.equal(queued.statusCode, 202);
          let release!: (value: Extraction) => void;
          let entered!: () => void;
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let calls = 0;
          analyzeImage = () => {
            calls++;
            entered();
            return new Promise<Extraction>((resolve) => {
              release = resolve;
            });
          };
          const running = commercial.runOne();
          await started;
          assert.equal(await commercial.runOne(), false);
          assert.equal(calls, 1);
          const revision = (await get(id)).revision;
          const removed = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/evidence/${file.evidence_id}/supersede`,
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: {
              expected_revision: revision,
              reason: 'Documento substituído durante a análise.',
            },
          });
          assert.equal(removed.statusCode, 200);
          release(paid(200000, 'STALE-TRANSACTION'));
          await running;
          assert.equal((await get(id)).assessment.confirmed_cents, 0);
          assert.equal((await get(id)).jobs[0].status, 'cancelled');
          analyzeImage = async () => structuredClone(extraction);
        },
      );
      await t.test(
        'última tentativa interrompida é recuperada; teto diário não confirma pagamentos',
        async () => {
          const id = await create();
          const file = await upload(id, 'payment', 70);
          const queued = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/analyses`,
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: {
              evidence_ids: [file.evidence_id],
              expected_revision: (await get(id)).revision,
            },
          });
          assert.equal(queued.statusCode, 202);
          config.dailyAnalysisLimit = 0;
          assert.equal(await commercial.runOne(), false);
          assert.equal((await get(id)).jobs[0].status, 'queued');
          config.dailyAnalysisLimit = 100;
          const jobId = queued.json().job_id;
          const data = {
            category: 'payment',
            evidence_ids: [file.evidence_id],
            status: 'processing',
            attempts: 3,
            lease_token: 'interrupted',
            lease_until: '2026-12-06T14:00:00.000Z',
          };
          if (db.kind === 'mongo')
            await db.update('commercial_records', { id: jobId }, { $set: { data } });
          else
            await db.query('UPDATE commercial_records SET data=$2 WHERE id=$1', [
              jobId,
              JSON.stringify(data),
            ]);
          await commercial.runOne();
          const recovered = await get(id);
          assert.equal(recovered.jobs[0].status, 'failed');
          assert.equal(recovered.jobs[0].error, 'AI_ATTEMPTS_EXHAUSTED');
          assert.equal(recovered.assessment.confirmed_cents, 0);
        },
      );
      await t.test(
        'contato marcado não comercial cancela a checagem sem travar os próximos pacientes',
        async () => {
          const id = await create();
          const file = await upload(id, 'payment', 80);
          const queued = await app.inject({
            method: 'POST',
            url: `/api/v1/opportunities/${id}/commercial/analyses`,
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: {
              evidence_ids: [file.evidence_id],
              expected_revision: (await get(id)).revision,
            },
          });
          assert.equal(queued.statusCode, 202);
          const mark = await app.inject({
            method: 'PUT',
            url: `/api/v1/opportunities/${id}/quality`,
            headers,
            payload: {
              reason: 'ADVERTISING',
              expected_version: (await crm.detail(owner, id)).version,
            },
          });
          assert.equal(mark.statusCode, 200, mark.body);
          assert.equal(await commercial.runOne(), true);
          const stored =
            db.kind === 'mongo'
              ? await db.one<any>('commercial_records', { id: queued.json().job_id })
              : (
                  await db.query<any>('SELECT * FROM commercial_records WHERE id=$1', [
                    queued.json().job_id,
                  ])
                ).rows[0];
          assert.equal(stored.data.status, 'cancelled');
          const next = await create();
          extraction = paid(50000, 'AFTER-NON-COMMERCIAL');
          await analyze(next, (await upload(next, 'payment', 90)).evidence_id);
          assert.equal((await get(next)).assessment.confirmed_cents, 50000);
        },
      );
      for (const [index, category] of (['payment', 'signature'] as const).entries()) {
        await t.test(
          `divergência de ${category} continua bloqueada na fila, falha e leitura inconclusiva`,
          async () => {
            const id = await create();
            const validPayment = paid(200000, `AUDIT-RETRY-${category}`);
            const validSignature: Extraction = {
              ...blank,
              contract: { signed_on: '2026-12-05', state: 'signed', contract_id: 'AUDIT' },
            };
            extraction = validPayment;
            await analyze(id, (await upload(id, 'payment', 100 + index * 10)).evidence_id);
            extraction = validSignature;
            await analyze(id, (await upload(id, 'signature', 101 + index * 10)).evidence_id);
            await sale(id);
            assert.equal((await get(id)).assessment.eligible, true);
            extraction =
              category === 'payment'
                ? paid(50000, `AUDIT-RETRY-${category}`)
                : {
                    ...blank,
                    contract: { signed_on: '2026-12-04', state: 'signed', contract_id: 'AUDIT' },
                  };
            const job = await analyze(
              id,
              (await upload(id, category, 102 + index * 10)).evidence_id,
            );
            const assertBlocked = async () => {
              assert.equal((await get(id)).assessment.eligible, false);
              assert.ok((await get(id)).assessment.reasons.includes('EVIDENCE_REVIEW'));
              assert.equal(
                (await list()).rows.find((r: any) => r.id === id).assessment.eligible,
                false,
              );
            };
            const retry = async () =>
              commercial.retry(owner, id, randomUUID(), job, (await get(id)).revision);
            await assertBlocked();
            await retry();
            await assertBlocked();
            analyzeImage = async () => {
              assert.equal(
                (await get(id)).jobs.find((j: any) => j.id === job).status,
                'processing',
              );
              await assertBlocked();
              throw new AnalysisFailure(false, 'AUDIT_FAILURE');
            };
            try {
              await commercial.runOne();
            } finally {
              analyzeImage = async () => structuredClone(extraction);
            }
            assert.equal((await get(id)).jobs.find((j: any) => j.id === job).status, 'failed');
            await assertBlocked();
            extraction = { ...blank, readable: false };
            await retry();
            await commercial.runOne();
            await assertBlocked();
            extraction = category === 'payment' ? validPayment : validSignature;
            await retry();
            await commercial.runOne();
            assert.equal((await get(id)).assessment.eligible, true);
            assert.equal(
              (await list()).rows.find((r: any) => r.id === id).assessment.eligible,
              true,
            );
          },
        );
      }
      await t.test(
        'reanalisar parte de um grupo libera as outras páginas para nova checagem',
        async () => {
          const id = await create();
          const first = (await upload(id, 'payment', 130)).evidence_id;
          const second = (await upload(id, 'payment', 131)).evidence_id;
          extraction = { ...blank, readable: false };
          const original = await commercial.analyze(
            owner,
            id,
            randomUUID(),
            [first, second],
            (await get(id)).revision,
          );
          await commercial.runOne();
          const replacement = await commercial.analyze(
            owner,
            id,
            randomUUID(),
            [first],
            (await get(id)).revision,
          );
          let state = await get(id);
          assert.equal(state.jobs.find((j: any) => j.id === original.job_id).status, 'cancelled');
          assert.equal(state.evidence.find((e: any) => e.id === second).status, 'uploaded');
          assert.equal(state.evidence.find((e: any) => e.id === second).job_id, null);
          await commercial.runOne();
          const secondJob = await commercial.analyze(
            owner,
            id,
            randomUUID(),
            [second],
            (await get(id)).revision,
          );
          await commercial.runOne();
          await commercial.review(
            manager,
            id,
            randomUUID(),
            secondJob.job_id,
            (await get(id)).revision,
            'confirm',
            paid(50000, 'GROUP-RESTORED'),
            'Documento conferido após reagrupar as páginas.',
          );
          state = await get(id);
          assert.equal(state.jobs.find((j: any) => j.id === secondJob.job_id).status, 'done');
          assert.equal(
            state.jobs.find((j: any) => j.id === replacement.job_id).status,
            'needs_review',
          );
          assert.equal(state.assessment.confirmed_cents, 50000);
        },
      );
      for (const [index, category] of (['payment', 'signature'] as const).entries()) {
        await t.test(
          `restaurar contato não resolve divergência documental de ${category}`,
          async () => {
            const id = await create();
            const validPayment = paid(200000, `QUALITY-RETRY-${category}`);
            const validSignature: Extraction = {
              ...blank,
              contract: { signed_on: '2026-12-05', state: 'signed', contract_id: 'QUALITY' },
            };
            extraction = validPayment;
            await analyze(id, (await upload(id, 'payment', 180 + index * 10)).evidence_id);
            extraction = validSignature;
            await analyze(id, (await upload(id, 'signature', 181 + index * 10)).evidence_id);
            extraction =
              category === 'payment'
                ? paid(50000, `QUALITY-RETRY-${category}`)
                : {
                    ...blank,
                    contract: { signed_on: '2026-12-04', state: 'signed', contract_id: 'QUALITY' },
                  };
            const file = (await upload(id, category, 182 + index * 10)).evidence_id;
            const job = await analyze(id, file);
            assert.ok((await get(id)).assessment.reasons.includes('EVIDENCE_REVIEW'));
            await commercial.retry(owner, id, randomUUID(), job, (await get(id)).revision);
            const quality = async (reason: string | null) => {
              const response = await app.inject({
                method: 'PUT',
                url: `/api/v1/opportunities/${id}/quality`,
                headers: master,
                payload: { reason, expected_version: (await crm.detail(manager, id)).version },
              });
              assert.equal(response.statusCode, 200, response.body);
            };
            await quality('ADVERTISING');
            await commercial.runOne();
            await quality(null);
            await sale(id);
            const restored = await get(id);
            assert.equal(restored.jobs.find((j: any) => j.id === job).status, 'cancelled');
            assert.equal(restored.evidence.find((e: any) => e.id === file).status, 'uploaded');
            assert.equal(restored.assessment.eligible, false);
            assert.ok(restored.assessment.reasons.includes('EVIDENCE_REVIEW'));
            assert.equal(
              (await list()).rows.find((r: any) => r.id === id).assessment.eligible,
              false,
            );
            // Only a new, consistent check may clear the earlier contradiction.
            extraction = category === 'payment' ? validPayment : validSignature;
            await analyze(id, file);
            assert.equal((await get(id)).assessment.eligible, true);
          },
        );
      }
      await t.test(
        'beneficiário vem da primeira venda, não do anexo, gestor ou transferência posterior',
        async () => {
          const id = await create();
          await upload(id, 'contract_summary', 140);
          assert.equal((await get(id)).beneficiary_id, null);
          await crm.transfer(
            manager,
            id,
            {
              expected_version: (await crm.detail(owner, id)).version,
              target_id: stranger.id,
              reason: 'Transferência anterior à venda',
            },
            randomUUID(),
          );
          // A manager records the sale for the current consultant, not for themself.
          await sale(id, manager);
          assert.equal((await commercial.summary(stranger, id)).beneficiary_id, stranger.id);
          await crm.transfer(
            manager,
            id,
            {
              expected_version: (await crm.detail(stranger, id)).version,
              target_id: owner.id,
              reason: 'Transferência posterior à venda',
            },
            randomUUID(),
          );
          await sale(id, owner); // Editing the sale must not replace the first attribution.
          assert.equal((await get(id)).beneficiary_id, stranger.id);
          const row = (await list(master)).rows.find((r: any) => r.id === id);
          assert.equal(row.owner_id, owner.id);
          assert.equal(row.beneficiary_id, stranger.id);
        },
      );
      await t.test(
        'venda histórica não usa o primeiro upload nem inventa beneficiário para lançamento do gestor',
        async () => {
          const id = await create();
          await sale(id);
          if (db.kind === 'mongo')
            await db.update(
              'audit_events',
              { opportunity_id: id, kind: 'sale.completed' },
              { $unset: { 'details.beneficiary_id': '' } },
            );
          else
            await db.query(
              "UPDATE audit_events SET details=details-'beneficiary_id' WHERE opportunity_id=$1 AND kind='sale.completed'",
              [id],
            );
          await crm.transfer(
            manager,
            id,
            {
              expected_version: (await crm.detail(owner, id)).version,
              target_id: stranger.id,
              reason: 'Transferência de venda histórica',
            },
            randomUUID(),
          );
          assert.equal((await commercial.summary(stranger, id)).beneficiary_id, owner.id);
          const unknown = await create();
          await sale(unknown, manager);
          if (db.kind === 'mongo')
            await db.update(
              'audit_events',
              { opportunity_id: unknown, kind: 'sale.completed' },
              { $unset: { 'details.beneficiary_id': '' } },
            );
          else
            await db.query(
              "UPDATE audit_events SET details=details-'beneficiary_id' WHERE opportunity_id=$1 AND kind='sale.completed'",
              [unknown],
            );
          assert.equal((await get(unknown)).beneficiary_id, null);
        },
      );
      await t.test(
        'vendas sem anexos entram nas pendências com paginação e autorização, sem incluir leads não vendidos',
        async () => {
          const unsold = await create();
          const ids = [];
          for (let i = 0; i < 21; i++) {
            const id = await create();
            await sale(id);
            ids.push(id);
          }
          const first = await list(headers, 'status=pending');
          assert.equal(first.rows.length, 20);
          const rows = [...first.rows];
          for (let page = 2; page <= Math.ceil(first.total / 20); page++)
            rows.push(...(await list(headers, `status=pending&page=${page}`)).rows);
          assert.equal(new Set(rows.map((r: any) => r.id)).size, first.total);
          for (const id of ids) {
            const row = rows.find((r: any) => r.id === id);
            assert.ok(row, id);
            assert.equal(row.beneficiary_id, owner.id);
            assert.equal(row.assessment.confirmed_cents, 0);
            assert.equal(row.assessment.remaining_cents, 200000);
            assert.deepEqual(row.assessment.reasons, ['DEPOSIT_INCOMPLETE', 'CONTRACT_PENDING']);
            assert.equal(row.assessment.eligible, false);
          }
          assert.ok(!rows.some((r: any) => r.id === unsold));
          assert.ok(!(await list(otherHeaders)).rows.some((r: any) => ids.includes(r.id)));
          assert.ok(
            !(await list(headers, 'status=eligible')).rows.some((r: any) => ids.includes(r.id)),
          );
          assert.equal((await list(master, `status=pending&owner=${owner.id}`)).total, first.total);
        },
      );
    } finally {
      await app.close();
      await db.close();
      await replica?.stop();
    }
  });
