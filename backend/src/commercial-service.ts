import { randomUUID } from 'node:crypto';
import { MongoTx } from './mongo-store.js';
import { DomainError, type Opportunity, type User } from './types.js';
import {
  assessCommercial,
  saoPauloDate,
  type VerifiedPayment,
  type VerifiedContract,
} from './commercial-domain.js';
import {
  AnalysisFailure,
  extractionSchema,
  inspectEvidence,
  normalizeIdentifier,
  normalizeRecipientIdentifier,
  normalizeName,
  type CommercialAnalyzer,
  type CommercialConfig,
  type EvidenceCategory,
  type Extraction,
} from './commercial-ai.js';
import {
  commercialTransaction,
  commercialAccess,
  getCommercial,
  caseRecords,
  saveCommercial,
  newCommercial,
  fingerprint,
  saveCommercialFile,
  readCommercialFile,
  transactionUsed,
  claimPayment,
  paymentClaimed,
  releasePaymentClaims,
  commercialHistory,
  commercialBeneficiaries,
  type CommercialDb,
  type CommercialTx,
  type CommercialRecord,
} from './commercial-store.js';
import { enqueuePushEvent } from './push-store.js';

const MAX_FILES_PER_CASE = 120;
const MAX_ATTEMPTS = 3;
const LEASE_MS = 120_000;
const recordNotFound = () =>
  new DomainError('DOCUMENT_NOT_FOUND', 'Documento ou análise não encontrado.', 404);
const conflict = () =>
  new DomainError(
    'COMMERCIAL_CONFLICT',
    'A checagem mudou. Atualize a ficha e tente novamente.',
    409,
  );

export class CommercialService {
  constructor(
    public db: CommercialDb,
    public config: CommercialConfig,
    private analyzer: CommercialAnalyzer,
    private clock = () => new Date(),
  ) {}

  private assessment(
    opportunity: Opportunity,
    records: CommercialRecord[],
    now: Date,
    registered = !!opportunity.sale_completed_at,
  ) {
    const payments = records
      .filter((r) => r.kind === 'payment')
      .map((r) => ({ id: r.id, ...r.data })) as VerifiedPayment[];
    const contract = records.find((r) => r.kind === 'contract')?.data as
      VerifiedContract | undefined;
    const legacyMinimum = records.find((r) => r.kind === 'case')?.data.legacy_minimum_cents;
    return assessCommercial({
      payments,
      contract: contract ?? null,
      sale_registered: registered,
      today: saoPauloDate(now),
      legacy_minimum_cents: legacyMinimum,
      blocking_review: records.some(
        (r) => r.kind === 'evidence' && r.data.status !== 'superseded' && r.data.blocking === true,
      ),
    });
  }

  private async command<T extends Record<string, any>>(
    actor: User,
    id: string,
    key: string,
    payload: unknown,
    revision: number | undefined,
    action: string,
    work: (tx: CommercialTx, row: Opportunity, state: CommercialRecord, now: string) => Promise<T>,
  ) {
    const now = this.clock();
    return commercialTransaction(this.db, async (tx) => {
      const row = await commercialAccess(tx, id, actor, true);
      const receiptId = `command:${id}:${actor.id}:${key}`;
      const digest = fingerprint(JSON.stringify({ action, payload }));
      const receipt = await getCommercial(tx, receiptId);
      if (receipt) {
        if (receipt.data.fingerprint !== digest)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'Use a mesma solicitação ao repetir o envio.',
            409,
          );
        return receipt.data.response as T & { revision: number };
      }
      const state =
        (await getCommercial(tx, `case:${id}`)) ??
        newCommercial(
          id,
          'case',
          {
            revision: 0,
            legacy_minimum_cents: null,
          },
          now.toISOString(),
          `case:${id}`,
        );
      if (revision !== undefined && revision !== state.data.revision) throw conflict();
      const result = await work(tx, row, state, now.toISOString());
      state.data.revision++;
      state.updated_at = now.toISOString();
      await saveCommercial(tx, state);
      const records = await caseRecords(tx, id);
      // Financial readiness is cached independently of the old sale-registration command.
      // Read/list APIs combine it with the CURRENT opportunity.sale_completed_at.
      state.data.assessment = this.assessment(row, records, now, true);
      await saveCommercial(tx, state);
      const response = { ...result, revision: state.data.revision as number };
      await saveCommercial(
        tx,
        newCommercial(
          id,
          'command',
          { fingerprint: digest, response },
          now.toISOString(),
          receiptId,
        ),
      );
      await saveCommercial(
        tx,
        newCommercial(
          id,
          'audit',
          {
            action,
            actor_id: actor.id,
            revision: state.data.revision,
            result: result,
            reason: typeof payload === 'object' && payload ? (payload as any).reason : undefined,
          },
          now.toISOString(),
        ),
      );
      return response;
    });
  }

  async summary(actor: User, id: string) {
    return commercialTransaction(this.db, async (tx) => {
      const row = await commercialAccess(tx, id, actor);
      const records = await caseRecords(tx, id);
      const state = records.find((r) => r.kind === 'case');
      const assessment = this.assessment(row, records, this.clock());
      const evidence = records
        .filter((r) => r.kind === 'evidence')
        .map((r) => ({
          id: r.id,
          ...r.data,
          created_at: r.created_at,
          url: `/api/v1/opportunities/${id}/commercial/evidence/${r.id}/image`,
        }));
      return {
        enabled: true,
        ai_enabled: this.config.aiEnabled,
        auto_validate: this.config.autoValidate,
        recipient_check_configured: !!this.config.recipientIdentifiers.length,
        revision: state?.data.revision ?? 0,
        can_review: actor.role === 'manager',
        assessment,
        beneficiary_id: (await commercialBeneficiaries(tx, [id])).get(id) ?? null,
        evidence,
        payments: records.filter((r) => r.kind === 'payment').map((r) => ({ id: r.id, ...r.data })),
        contract: records.find((r) => r.kind === 'contract')?.data ?? null,
        jobs: records
          .filter((r) => r.kind === 'job')
          .map((r) => ({
            id: r.id,
            status: r.data.status,
            category: r.data.category,
            evidence_ids: r.data.evidence_ids,
            attempts: r.data.attempts,
            error: r.data.error ?? null,
            reasons: r.data.reasons ?? [],
            result: r.data.result ?? null,
          })),
        suggestions: state?.data.suggestions ?? {},
        history: (await commercialHistory(tx, id)).map((r) => ({
          id: r.id,
          at: r.created_at,
          action: r.data.action,
          reason: r.data.reason ?? null,
          actor_id: r.data.actor_id ?? null,
        })),
        validated_at: state?.data.validated_at ?? null,
        late_validation:
          !!assessment.expected_payment_on &&
          !!state?.data.validated_at &&
          saoPauloDate(new Date(state.data.validated_at)) > assessment.expected_payment_on,
      };
    });
  }

  async upload(
    actor: User,
    id: string,
    key: string,
    category: EvidenceCategory,
    bytes: Buffer,
    mime: string,
  ) {
    // Authorize BEFORE decoding a potentially expensive image.
    await commercialTransaction(this.db, (tx) => commercialAccess(tx, id, actor));
    const image = await inspectEvidence(bytes, mime);
    return this.command(
      actor,
      id,
      key,
      { category, hash: image.hash },
      undefined,
      'evidence.uploaded',
      async (tx, _row, _state, now) => {
        const existing = await caseRecords(tx, id, 'evidence');
        const duplicate = existing.find(
          (r) =>
            r.data.hash === image.hash &&
            r.data.category === category &&
            r.data.status !== 'superseded',
        );
        if (duplicate) return { evidence_id: duplicate.id, duplicate: true };
        if (existing.length >= MAX_FILES_PER_CASE)
          throw new DomainError(
            'DOCUMENT_LIMIT',
            'Limite de documentos deste paciente atingido. Peça revisão à gestão.',
            400,
          );
        const evidenceId = randomUUID();
        await saveCommercialFile(tx, evidenceId, id, bytes);
        await saveCommercial(
          tx,
          newCommercial(
            id,
            'evidence',
            {
              category,
              hash: image.hash,
              mime,
              bytes: bytes.length,
              status: 'uploaded',
              uploaded_by: actor.id,
              width: image.width,
              height: image.height,
            },
            now,
            evidenceId,
          ),
        );
        return { evidence_id: evidenceId, duplicate: false };
      },
    );
  }

  async image(actor: User, id: string, evidenceId: string) {
    const source = await commercialTransaction(this.db, async (tx) => {
      await commercialAccess(tx, id, actor);
      const evidence = await getCommercial(tx, evidenceId);
      if (evidence?.kind !== 'evidence' || evidence.opportunity_id !== id) throw recordNotFound();
      const now = this.clock();
      const viewId = `view:${evidenceId}:${actor.id}:${saoPauloDate(now)}`;
      if (!(await getCommercial(tx, viewId)))
        await saveCommercial(
          tx,
          newCommercial(
            id,
            'audit',
            { action: 'evidence.viewed', actor_id: actor.id, evidence_id: evidenceId },
            now.toISOString(),
            viewId,
          ),
        );
      return {
        bytes: await readCommercialFile(tx, evidenceId, id),
        mime: evidence.data.mime as string,
      };
    });
    // Decoding is outside the transaction. Serve only a metadata-free derivative.
    return (await inspectEvidence(source.bytes, source.mime)).normalized;
  }

  async analyze(actor: User, id: string, key: string, evidenceIds: string[], revision: number) {
    return this.command(
      actor,
      id,
      key,
      { evidenceIds, revision },
      revision,
      'analysis.requested',
      async (tx, _row, _state, now) => {
        const unique = [...new Set(evidenceIds)];
        const evidence = await Promise.all(unique.map((eid) => getCommercial(tx, eid)));
        if (
          evidence.some(
            (r) =>
              !r ||
              r.kind !== 'evidence' ||
              r.opportunity_id !== id ||
              !['uploaded', 'failed', 'needs_review'].includes(r.data.status),
          )
        )
          throw conflict();
        const category = evidence[0]!.data.category as EvidenceCategory;
        if (evidence.some((r) => r!.data.category !== category))
          throw new DomainError(
            'MIXED_DOCUMENTS',
            'Agrupe documentos da mesma categoria para a checagem.',
            400,
          );
        const jobs = await caseRecords(tx, id, 'job');
        if (jobs.length >= 120)
          throw new DomainError(
            'ANALYSIS_LIMIT',
            'Limite de análises atingido. Peça revisão à gestão.',
            400,
          );
        const job = newCommercial(
          id,
          'job',
          {
            category,
            evidence_ids: unique,
            status: this.config.aiEnabled ? 'queued' : 'needs_review',
            attempts: 0,
            available_at: now,
            lease_until: null,
            lease_token: null,
            reasons: this.config.aiEnabled ? [] : ['AI_DISABLED'],
            error: null,
          },
          now,
        );
        // Re-reading the same files must not leave old pending money counted twice.
        for (const old of jobs)
          if (
            (old.data.evidence_ids as string[]).some((eid) => unique.includes(eid)) &&
            ['needs_review', 'failed'].includes(old.data.status)
          ) {
            old.data.status = 'cancelled';
            old.data.lease_token = null;
            await saveCommercial(tx, old);
            // A partial resubmission must not strand the other pages on a cancelled job.
            // Keep unresolved financial conflicts blocking even while they await a new check.
            for (const sibling of await caseRecords(tx, id, 'evidence')) {
              if (
                sibling.data.job_id === old.id &&
                !unique.includes(sibling.id) &&
                sibling.data.status !== 'superseded'
              ) {
                sibling.data.status = 'uploaded';
                sibling.data.job_id = null;
                await saveCommercial(tx, sibling);
              }
            }
            const candidate = await getCommercial(tx, `payment:${old.id}`);
            if (candidate?.data.status === 'pending') {
              candidate.data.status = 'superseded';
              await saveCommercial(tx, candidate);
            }
          }
        for (const file of evidence) {
          file!.data.status = this.config.aiEnabled ? 'queued' : 'needs_review';
          file!.data.job_id = job.id;
          await saveCommercial(tx, file!);
        }
        await saveCommercial(tx, job);
        if (!this.config.aiEnabled)
          await enqueuePushEvent(tx, randomUUID(), id, 'commercial.checked', new Date(now));
        return { job_id: job.id };
      },
    );
  }

  async retry(actor: User, id: string, key: string, jobId: string, revision: number) {
    return this.command(
      actor,
      id,
      key,
      { jobId, revision },
      revision,
      'analysis.retried',
      async (tx, _row, _state, now) => {
        if (!this.config.aiEnabled)
          throw new DomainError('AI_DISABLED', 'Leitura por IA ainda não habilitada.', 409);
        const job = await getCommercial(tx, jobId);
        if (
          !job ||
          job.opportunity_id !== id ||
          job.kind !== 'job' ||
          !['failed', 'needs_review'].includes(job.data.status)
        )
          throw conflict();
        const files = await Promise.all(
          (job.data.evidence_ids as string[]).map((eid) => getCommercial(tx, eid)),
        );
        if (files.some((f) => !f || f.data.job_id !== jobId || f.data.status === 'superseded'))
          throw conflict();
        // A fresh manual retry is auditable, but remains inside the daily/provider limits.
        job.data = {
          ...job.data,
          status: 'queued',
          attempts: 0,
          available_at: now,
          error: null,
          lease_token: null,
        };
        await saveCommercial(tx, job);
        for (const file of files) {
          file!.data.status = 'queued';
          await saveCommercial(tx, file!);
        }
        return { job_id: jobId };
      },
    );
  }

  async supersede(
    actor: User,
    id: string,
    key: string,
    evidenceId: string,
    revision: number,
    reason: string,
  ) {
    return this.command(
      actor,
      id,
      key,
      { evidenceId, revision, reason },
      revision,
      'evidence.superseded',
      async (tx, _row, state, now) => {
        const records = await caseRecords(tx, id);
        const evidence = records.find((r) => r.kind === 'evidence' && r.id === evidenceId);
        if (!evidence || evidence.data.status === 'superseded') throw conflict();
        evidence.data.status = 'superseded';
        await saveCommercial(tx, evidence);
        for (const record of records) {
          if (
            !Array.isArray(record.data.evidence_ids) ||
            !record.data.evidence_ids.includes(evidenceId)
          )
            continue;
          if (record.kind === 'job') {
            record.data.status = 'cancelled';
            record.data.lease_token = null;
          }
          if (record.kind === 'payment' || record.kind === 'contract')
            record.data.status = 'superseded';
          if (record.kind === 'payment') await releasePaymentClaims(tx, record.id);
          if (record.kind === 'job')
            for (const sibling of records) {
              if (
                sibling.kind === 'evidence' &&
                sibling.id !== evidenceId &&
                sibling.data.job_id === record.id &&
                sibling.data.status !== 'superseded'
              ) {
                sibling.data.status = 'uploaded';
                sibling.data.job_id = null;
                await saveCommercial(tx, sibling);
              }
            }
          await saveCommercial(tx, record);
        }
        state.data.suggestions = Object.fromEntries(
          Object.entries(state.data.suggestions ?? {}).filter(
            ([, value]) => !(value as { evidence_ids: string[] }).evidence_ids.includes(evidenceId),
          ),
        );
        await enqueuePushEvent(tx, randomUUID(), id, 'commercial.checked', new Date(now));
        return { evidence_id: evidenceId };
      },
    );
  }

  private validationReasons(
    row: Opportunity,
    result: Extraction,
    category: EvidenceCategory,
    human: boolean,
  ) {
    const reasons: string[] = [];
    const today = saoPauloDate(this.clock());
    if (!human) {
      if (!this.config.autoValidate) reasons.push('AUTO_VALIDATION_DISABLED');
      if (!result.readable || result.warnings.length) reasons.push('DOCUMENT_UNCLEAR');
      const name = normalizeName(result.patient_name ?? '');
      if (!name.includes(' ') || name !== normalizeName(row.name)) reasons.push('PATIENT_MISMATCH');
    }
    if (category === 'payment') {
      const payment = result.payment;
      if (
        !payment?.amount_cents ||
        !payment.paid_on ||
        payment.state !== 'completed' ||
        payment.paid_on > today
      )
        reasons.push('PAYMENT_NOT_PROVEN');
      if (
        !human &&
        (!payment?.recipient_identifier ||
          !this.config.recipientIdentifiers.includes(
            normalizeRecipientIdentifier(payment.recipient_identifier),
          ))
      )
        reasons.push('RECIPIENT_REVIEW');
      if (!human && normalizeIdentifier(payment?.transaction_id ?? '').length < 6)
        reasons.push('TRANSACTION_ID_MISSING');
    }
    if (category === 'signature') {
      if (
        result.contract?.state !== 'signed' ||
        !result.contract.signed_on ||
        result.contract.signed_on > today
      )
        reasons.push('SIGNATURE_NOT_PROVEN');
    }
    if (category === 'surgery' && !result.fields.procedure_date)
      reasons.push('SURGERY_DATE_MISSING');
    if (
      category === 'contract_summary' &&
      Object.values(result.fields).every((value) => value === null)
    )
      reasons.push('EMPTY_EXTRACTION');
    return reasons;
  }

  private async applyResult(
    tx: CommercialTx,
    row: Opportunity,
    state: CommercialRecord,
    job: CommercialRecord,
    result: Extraction,
    human: boolean,
    now: string,
  ) {
    const category = job.data.category as EvidenceCategory;
    const evidenceIds = job.data.evidence_ids as string[];
    const reasons = this.validationReasons(row, result, category, human);
    const records = await caseRecords(tx, row.id);
    const files = records.filter((r) => r.kind === 'evidence' && evidenceIds.includes(r.id));
    if (
      files.length !== evidenceIds.length ||
      files.some((f) => f.data.status === 'superseded' || f.data.job_id !== job.id)
    )
      throw conflict();
    // Failed/unreadable rechecks do not resolve an earlier financial contradiction.
    // Clear it only after a successful check or an explicit rejection/supersession.
    let blocking = files.some((file) => file.data.blocking === true);
    if (category === 'payment' && result.payment?.amount_cents && result.payment.paid_on) {
      const payment = result.payment;
      const normalizedTransaction = normalizeIdentifier(payment.transaction_id ?? '');
      const txKey = normalizedTransaction ? fingerprint(normalizedTransaction) : null;
      const existing = records.find(
        (r) =>
          r.kind === 'payment' &&
          r.data.status === 'confirmed' &&
          txKey &&
          r.data.transaction_key === txKey,
      );
      const paymentId = existing?.id ?? `payment:${job.id}`;
      const claimKeys = files.map((file) => `image:${file.data.hash}`);
      if (txKey) claimKeys.push(`transaction:${txKey}`);
      if (txKey && (await transactionUsed(tx, txKey, paymentId))) reasons.push('DUPLICATE_PAYMENT');
      if (await paymentClaimed(tx, claimKeys, paymentId)) reasons.push('DUPLICATE_PAYMENT');
      if (
        existing &&
        (existing.data.amount_cents !== payment.amount_cents ||
          existing.data.paid_on !== payment.paid_on)
      ) {
        reasons.push('PAYMENT_CONFLICT');
        blocking = true;
      }
      if (
        !txKey &&
        records.some(
          (r) =>
            r.kind === 'payment' &&
            r.id !== paymentId &&
            r.data.status === 'confirmed' &&
            (r.data.evidence_ids as string[]).some((eid) =>
              files.some((file) => records.find((e) => e.id === eid)?.data.hash === file.data.hash),
            ),
        )
      )
        reasons.push('DUPLICATE_PAYMENT');
      if (!reasons.length) await claimPayment(tx, claimKeys, paymentId, row.id);
      if (!existing)
        await saveCommercial(
          tx,
          newCommercial(
            row.id,
            'payment',
            {
              amount_cents: payment.amount_cents,
              paid_on: payment.paid_on,
              status: reasons.length ? 'pending' : 'confirmed',
              transaction_key: txKey,
              evidence_ids: evidenceIds,
              verified_by: human ? 'human' : 'ai',
              verified_at: reasons.length ? null : now,
            },
            now,
            paymentId,
          ),
        );
      else if (!reasons.length) {
        existing.data.evidence_ids = [...new Set([...existing.data.evidence_ids, ...evidenceIds])];
        await saveCommercial(tx, existing);
        const priorCandidate = records.find(
          (r) => r.id === `payment:${job.id}` && r.id !== paymentId,
        );
        if (priorCandidate) {
          priorCandidate.data.status = 'superseded';
          await saveCommercial(tx, priorCandidate);
        }
      }
    }
    if (!human && ['contract_summary', 'surgery'].includes(category)) {
      for (const [field, value] of Object.entries(result.fields)) {
        if (value === null || (category === 'surgery' && field !== 'procedure_date')) continue;
        const declared =
          field === 'procedure_date'
            ? row.procedure_date
              ? new Date(row.procedure_date).toISOString().slice(0, 10)
              : null
            : (row as unknown as Record<string, unknown>)[field];
        const previous = state.data.suggestions?.[field]?.value;
        const comparable = (v: unknown) => (typeof v === 'string' ? normalizeName(v) : v);
        if (
          [declared, previous].some(
            (v) => v !== null && v !== undefined && v !== '' && comparable(v) !== comparable(value),
          )
        )
          reasons.push('FIELD_CONFLICT');
      }
    }
    if (category === 'signature' && result.contract?.signed_on) {
      const previous = records.find((r) => r.kind === 'contract');
      if (
        !human &&
        previous?.data.status === 'confirmed' &&
        previous.data.signed_on !== result.contract.signed_on
      ) {
        reasons.push('SIGNATURE_CONFLICT');
        blocking = true;
      }
      if (!reasons.length)
        await saveCommercial(
          tx,
          newCommercial(
            row.id,
            'contract',
            {
              signed_on: result.contract.signed_on,
              contract_id: result.contract.contract_id,
              status: 'confirmed',
              evidence_ids: evidenceIds,
              verified_by: human ? 'human' : 'ai',
              verified_at: now,
            },
            now,
            `contract:${row.id}`,
          ),
        );
    }
    if (human && reasons.length)
      throw new DomainError(
        'REVIEW_INCOMPLETE',
        'Ainda faltam fatos válidos ou existe pagamento duplicado. Corrija os dados ou rejeite a evidência.',
        400,
      );
    const status = reasons.length ? 'needs_review' : 'confirmed';
    if (!reasons.length) blocking = false;
    for (const file of files) {
      file.data = { ...file.data, status, blocking, reasons };
      file.updated_at = now;
      await saveCommercial(tx, file);
    }
    job.data = {
      ...job.data,
      status: reasons.length ? 'needs_review' : 'done',
      result,
      reasons,
      lease_token: null,
      lease_until: null,
    };
    job.updated_at = now;
    await saveCommercial(tx, job);
    await saveCommercial(
      tx,
      newCommercial(
        row.id,
        'extraction',
        {
          job_id: job.id,
          result,
          reasons,
          provider: human ? 'human' : 'gemini',
          model: human ? null : this.config.model,
          schema_version: 1,
        },
        now,
      ),
    );
    if (!reasons.length) {
      state.data.validated_at = now;
      // Suggestions remain separate from the legacy form; only proven category fields.
      if (category === 'contract_summary' || category === 'surgery') {
        const fields =
          category === 'surgery' ? { procedure_date: result.fields.procedure_date } : result.fields;
        for (const [field, value] of Object.entries(fields))
          if (value !== null)
            state.data.suggestions = {
              ...state.data.suggestions,
              [field]: { value, evidence_ids: evidenceIds, validated_at: now },
            };
      }
    }
    return { job_id: job.id, status, reasons };
  }

  async review(
    actor: User,
    id: string,
    key: string,
    jobId: string,
    revision: number,
    decision: 'confirm' | 'reject',
    result: Extraction | undefined,
    reason: string,
  ) {
    if (actor.role !== 'manager')
      throw new DomainError('FORBIDDEN', 'Somente a gestão pode resolver exceções.', 403);
    return this.command(
      actor,
      id,
      key,
      { jobId, revision, decision, result, reason },
      revision,
      'evidence.reviewed',
      async (tx, row, state, now) => {
        const job = await getCommercial(tx, jobId);
        if (
          !job ||
          job.opportunity_id !== id ||
          job.kind !== 'job' ||
          !['needs_review', 'failed'].includes(job.data.status)
        )
          throw conflict();
        if (decision === 'confirm') {
          const outcome = await this.applyResult(
            tx,
            row,
            state,
            job,
            extractionSchema.parse(result),
            true,
            now,
          );
          await enqueuePushEvent(tx, randomUUID(), id, 'commercial.checked', new Date(now));
          return outcome;
        }
        for (const record of await caseRecords(tx, id)) {
          if (
            record.kind === 'evidence' &&
            record.data.job_id === jobId &&
            record.data.status !== 'superseded'
          ) {
            record.data.status = 'rejected';
            record.data.blocking = false;
            await saveCommercial(tx, record);
          }
          if (record.id === `payment:${jobId}` && record.data.status !== 'confirmed') {
            record.data.status = 'rejected';
            await saveCommercial(tx, record);
          }
        }
        job.data.status = 'rejected';
        job.data.lease_token = null;
        await saveCommercial(tx, job);
        await enqueuePushEvent(tx, randomUUID(), id, 'commercial.checked', new Date(now));
        return { job_id: jobId, status: 'rejected', reasons: [] as string[] };
      },
    );
  }

  async legacyPolicy(
    actor: User,
    id: string,
    key: string,
    revision: number,
    minimum: 150000 | 200000,
    reason: string,
  ) {
    if (actor.role !== 'manager')
      throw new DomainError(
        'FORBIDDEN',
        'Somente a gestão pode conferir a vigência histórica.',
        403,
      );
    return this.command(
      actor,
      id,
      key,
      { revision, minimum, reason },
      revision,
      'legacy.policy_reviewed',
      async (tx, row, state) => {
        const assessment = this.assessment(row, await caseRecords(tx, id), this.clock());
        if (!assessment.closing_started_on || assessment.closing_started_on >= '2026-10-01')
          throw new DomainError('POLICY_FIXED', 'Desde 01/10/2026, o mínimo é R$ 2.000.', 400);
        state.data.legacy_minimum_cents = minimum;
        return { minimum_cents: minimum };
      },
    );
  }

  private async claimJob() {
    const now = this.clock().toISOString();
    return commercialTransaction(this.db, async (tx) => {
      // Budget is a daily call cap, including retries. A single document serializes
      // worker reservations only; it does not lock the lead distribution queue.
      const budgetId = `budget:${saoPauloDate(this.clock())}`;
      if (tx instanceof MongoTx) {
        await tx
          .collection('commercial_budgets')
          .updateOne(
            { _id: budgetId as any },
            { $setOnInsert: { calls: 0 }, $inc: { fence: 1 } },
            { upsert: true, session: tx.session },
          );
        const budget = await tx
          .collection('commercial_budgets')
          .findOne({ _id: budgetId as any }, { session: tx.session });
        if ((budget?.calls ?? 0) >= this.config.dailyAnalysisLimit) return null;
      } else {
        await tx.query(
          'INSERT INTO commercial_budgets(id,calls) VALUES($1,0) ON CONFLICT DO NOTHING',
          [budgetId],
        );
        const budget = (
          await tx.query<{ calls: number }>(
            'SELECT calls FROM commercial_budgets WHERE id=$1 FOR UPDATE',
            [budgetId],
          )
        ).rows[0];
        if (budget.calls >= this.config.dailyAnalysisLimit) return null;
      }
      const job =
        tx instanceof MongoTx
          ? (
              await tx.many<CommercialRecord>(
                'commercial_records',
                {
                  kind: 'job',
                  'data.attempts': { $lt: MAX_ATTEMPTS },
                  $or: [
                    { 'data.status': 'queued', 'data.available_at': { $lte: now } },
                    { 'data.status': 'processing', 'data.lease_until': { $lte: now } },
                  ],
                },
                { created_at: 1 },
                1,
              )
            )[0]
          : (
              await tx.query<CommercialRecord>(
                `SELECT * FROM commercial_records WHERE kind='job' AND (data->>'attempts')::int<$2
          AND ((data->>'status'='queued' AND data->>'available_at'<=$1) OR (data->>'status'='processing' AND data->>'lease_until'<=$1))
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
                [now, MAX_ATTEMPTS],
              )
            ).rows[0];
      if (!job) return null;
      job.data = {
        ...job.data,
        status: 'processing',
        attempts: job.data.attempts + 1,
        lease_token: randomUUID(),
        lease_until: new Date(this.clock().getTime() + LEASE_MS).toISOString(),
      };
      await saveCommercial(tx, job);
      if (tx instanceof MongoTx)
        await tx
          .collection('commercial_budgets')
          .updateOne({ _id: budgetId as any }, { $inc: { calls: 1 } }, { session: tx.session });
      else await tx.query('UPDATE commercial_budgets SET calls=calls+1 WHERE id=$1', [budgetId]);
      return job;
    });
  }

  async runOne(signal = new AbortController().signal) {
    if (!this.config.aiEnabled || signal.aborted) return false;
    // A crash on the final attempt must not leave a job stuck in processing forever.
    const expired =
      this.db.kind === 'mongo'
        ? await this.db.many<CommercialRecord>(
            'commercial_records',
            {
              kind: 'job',
              'data.status': 'processing',
              'data.attempts': { $gte: MAX_ATTEMPTS },
              'data.lease_until': { $lte: this.clock().toISOString() },
            },
            {},
            10,
          )
        : (
            await this.db.query<CommercialRecord>(
              `SELECT * FROM commercial_records WHERE kind='job' AND data->>'status'='processing'
        AND (data->>'attempts')::int >= $1 AND data->>'lease_until'<=$2 LIMIT 10`,
              [MAX_ATTEMPTS, this.clock().toISOString()],
            )
          ).rows;
    for (const abandoned of expired)
      await this.failJob(abandoned, new AnalysisFailure(false, 'AI_ATTEMPTS_EXHAUSTED'));
    const job = await this.claimJob();
    if (!job) return false;
    try {
      const images = await commercialTransaction(this.db, async (tx) => {
        await commercialAccess(tx, job.opportunity_id, null);
        const files = await Promise.all(
          (job.data.evidence_ids as string[]).map(async (eid) => {
            const file = await getCommercial(tx, eid);
            if (!file || file.data.status === 'superseded' || file.data.job_id !== job.id)
              throw conflict();
            return {
              bytes: await readCommercialFile(tx, eid, job.opportunity_id),
              mime: file.data.mime as string,
            };
          }),
        );
        return files;
      });
      const result = extractionSchema.parse(
        await this.analyzer(
          images,
          job.data.category,
          AbortSignal.any([signal, AbortSignal.timeout(55_000)]),
        ),
      );
      await commercialTransaction(this.db, async (tx) => {
        const row = await commercialAccess(tx, job.opportunity_id, null, true);
        const current = await getCommercial(tx, job.id);
        if (
          !current ||
          current.data.status !== 'processing' ||
          current.data.lease_token !== job.data.lease_token ||
          current.data.lease_until <= this.clock().toISOString()
        )
          return;
        const state = await getCommercial(tx, `case:${row.id}`);
        if (!state) return;
        const now = this.clock();
        const outcome = await this.applyResult(
          tx,
          row,
          state,
          current,
          result,
          false,
          now.toISOString(),
        );
        state.data.revision++;
        state.data.assessment = this.assessment(
          row,
          [...(await caseRecords(tx, row.id)).filter((r) => r.kind !== 'case'), state],
          now,
          true,
        );
        state.updated_at = now.toISOString();
        await saveCommercial(tx, state);
        await saveCommercial(
          tx,
          newCommercial(
            row.id,
            'audit',
            {
              action: 'analysis.completed',
              job_id: job.id,
              outcome,
              revision: state.data.revision,
            },
            now.toISOString(),
          ),
        );
        await enqueuePushEvent(tx, randomUUID(), row.id, 'commercial.checked', now);
      });
    } catch (error) {
      await this.failJob(job, error);
    }
    return true;
  }

  private async failJob(job: CommercialRecord, error: unknown) {
    await commercialTransaction(this.db, async (tx) => {
      let row: Opportunity;
      try {
        row = await commercialAccess(tx, job.opportunity_id, null, true, true);
      } catch (e) {
        if (e instanceof DomainError && e.status === 404) return;
        throw e;
      }
      const current = await getCommercial(tx, job.id);
      if (
        !current ||
        current.data.status !== 'processing' ||
        current.data.lease_token !== job.data.lease_token
      )
        return;
      // A contact reclassified during processing must not poison the worker queue.
      // Preserve its files, but never apply financial facts to a non-commercial lead.
      if (row.non_commercial_reason) {
        current.data.status = 'cancelled';
        current.data.lease_token = null;
        current.data.error = 'NON_COMMERCIAL';
        await saveCommercial(tx, current);
        for (const file of await caseRecords(tx, row.id, 'evidence')) {
          if (file.data.job_id !== job.id || file.data.status === 'superseded') continue;
          file.data.status = 'uploaded';
          file.data.job_id = null;
          // Classification is not a financial review. Keep unresolved conflicts
          // blocked if management later restores this contact.
          await saveCommercial(tx, file);
        }
        const candidate = await getCommercial(tx, `payment:${job.id}`);
        if (candidate?.data.status === 'pending') {
          candidate.data.status = 'superseded';
          await saveCommercial(tx, candidate);
        }
        const state = await getCommercial(tx, `case:${row.id}`);
        if (state) {
          state.data.revision++;
          state.data.assessment = this.assessment(
            row,
            await caseRecords(tx, row.id),
            this.clock(),
            true,
          );
          await saveCommercial(tx, state);
        }
        await saveCommercial(
          tx,
          newCommercial(
            row.id,
            'audit',
            {
              action: 'analysis.cancelled',
              job_id: job.id,
              reason: 'Contato classificado como não comercial.',
            },
            this.clock().toISOString(),
          ),
        );
        return;
      }
      const retry =
        error instanceof AnalysisFailure && error.retryable && current.data.attempts < MAX_ATTEMPTS;
      const now = this.clock();
      current.data.status = retry ? 'queued' : 'failed';
      current.data.error = error instanceof AnalysisFailure ? error.code : 'ANALYSIS_FAILED';
      current.data.available_at = new Date(
        now.getTime() + 30_000 * current.data.attempts,
      ).toISOString();
      current.data.lease_token = null;
      await saveCommercial(tx, current);
      for (const file of await caseRecords(tx, row.id, 'evidence'))
        if (file.data.job_id === job.id && file.data.status !== 'superseded') {
          file.data.status = retry ? 'queued' : 'failed';
          await saveCommercial(tx, file);
        }
      const state = await getCommercial(tx, `case:${row.id}`);
      if (state) {
        state.data.revision++;
        await saveCommercial(tx, state);
      }
      if (!retry) await enqueuePushEvent(tx, randomUUID(), row.id, 'commercial.checked', now);
    });
  }
}
