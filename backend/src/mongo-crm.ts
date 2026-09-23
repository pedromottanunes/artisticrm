import { createHash, randomUUID } from 'node:crypto';
import { enqueuePushEvent } from './push-store.js';
import { deleteLeadData, wasDeleted, type DeleteLeadInput } from './lead-deletion.js';
import { MongoStore, MongoTx, mongoUser } from './mongo-store.js';
import {
  DomainError,
  isClosedStage,
  isValidDateOnly,
  requireManager,
  stageLabels,
  type User,
  type Opportunity,
} from './types.js';
import type { CRM, LeadInput } from './crm.js';
import type { DeleteAttendantInput, Operations } from './operations.js';
import { hashPassword, verifyPassword } from './auth.js';
import type { Document } from 'mongodb';
import {
  compactQueuePositions,
  selectWeightedParticipant,
  type WeightedQueueParticipant,
  type WeightedQueueSelection,
} from './weighted-queue.js';

type QueueUser = User & WeightedQueueParticipant;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function publicUser(user: Document): User {
  const {
    id,
    name,
    email,
    role,
    active,
    queue_enabled,
    queue_position,
    queue_weight,
    color,
    version,
    auth_version,
    must_change_password,
  } = user;
  return {
    id,
    name,
    email,
    role,
    active,
    queue_enabled,
    queue_position,
    queue_weight: queue_weight ?? 1,
    color,
    version,
    auth_version,
    must_change_password,
  };
}

export class MongoOperations {
  async deleteLead(actor: User, id: string, input: DeleteLeadInput, key: string) {
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(tx, actor, key, { kind: 'lead.delete', id, ...input }, () =>
        deleteLeadData(tx, actor, id, input),
      );
    });
  }
  constructor(
    public db: MongoStore,
    private clock?: () => Date,
  ) {}
  async now(tx: MongoTx = this.db) {
    return this.clock ? this.clock() : tx.now();
  }
  async actor(tx: MongoTx, actor: User, allowPasswordChange = false) {
    const current = await tx.one('users', { id: actor.id });
    if (
      !current?.active ||
      current.auth_version !== actor.auth_version ||
      current.role !== actor.role
    )
      throw new DomainError('UNAUTHENTICATED', 'Acesso revogado. Entre novamente.', 401);
    if (current.must_change_password && !allowPasswordChange)
      throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha para continuar.', 403);
    return current;
  }
  async audit(
    tx: MongoTx,
    id: string | null,
    actor: string | null,
    kind: string,
    description: string,
    details: unknown = {},
  ) {
    const eventId = randomUUID();
    const at = await this.now(tx);
    await tx.insert('audit_events', {
      id: eventId,
      opportunity_id: id,
      actor_id: actor,
      kind,
      description,
      details,
      created_at: at,
    });
    await enqueuePushEvent(tx, eventId, id, kind, at);
  }
  async command<T>(
    tx: MongoTx,
    actor: User,
    key: string,
    payload: unknown,
    work: () => Promise<T>,
  ) {
    // Password-bearing commands must not leave a fast offline password verifier
    // in the receipt table. Preserve idempotency with the same slow salted hash.
    const sensitive = !!payload && typeof payload === 'object' && 'password' in payload;
    const serialized = JSON.stringify(payload);
    const prior = await tx.one('operation_receipts', { actor_id: actor.id, key });
    if (prior) {
      const matches = sensitive
        ? await verifyPassword(serialized, prior.fingerprint)
        : prior.fingerprint === digest(payload);
      if (!matches)
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com outros dados.');
      return prior.response as T;
    }
    const response = await work();
    const fingerprint = sensitive ? await hashPassword(serialized) : digest(payload);
    await tx.insert('operation_receipts', {
      actor_id: actor.id,
      key,
      fingerprint,
      response,
      created_at: await this.now(tx),
    });
    return response;
  }
  private async next(
    tx: MongoTx,
    last: number,
  ): Promise<WeightedQueueSelection<QueueUser> | undefined> {
    const users = await tx.many<QueueUser>(
      'users',
      { role: 'attendant', active: true, queue_enabled: true },
      { id: 1 },
    );
    const selection = selectWeightedParticipant(users, last);
    if (!selection) return;
    for (const [id, credit] of selection.credits)
      await tx.update('users', { id }, { $set: { queue_credit: credit } });
    return selection;
  }
  async ingest(
    input: LeadInput,
    externalId: string,
    actor: string | null,
    authenticatedUser?: User,
  ) {
    const fingerprint = digest({
      name: input.name,
      phone: input.phone,
      interest: input.interest,
      unit: input.unit,
      source: input.source,
      source_evidence: input.source_evidence,
      meta_attribution: input.meta_attribution,
      identity: input.identity,
      is_demo: input.is_demo ?? false,
    });
    return this.db.atomic(async (tx) => {
      if (authenticatedUser) await this.actor(tx, authenticatedUser);
      if (await wasDeleted(tx, externalId))
        throw new DomainError(
          'EVENT_DELETED',
          'Esta entrada pertence a um lead excluído permanentemente.',
          410,
        );
      const prior = await tx.one('inbound_events', { external_id: externalId });
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Evento reutilizado com outros dados.');
        return { id: prior.opportunity_id as string, duplicate: true };
      }
      const now = await this.now(tx);
      const identity = input.identity
        ? await tx.one('contact_identities', {
            provider: input.identity.provider,
            channel_account_id: input.identity.account_id,
            external_user_id: input.identity.external_user_id,
          })
        : null;
      let contact = identity ? await tx.one('contacts', { id: identity.contact_id }) : null;
      if (!contact && input.phone) contact = await tx.one('contacts', { phone: input.phone });
      if (!contact) {
        contact = {
          id: randomUUID(),
          name: input.name,
          ...(input.phone ? { phone: input.phone } : {}),
          email: '',
          instagram: '',
          is_demo: input.is_demo ?? false,
        };
        await tx.insert('contacts', contact);
      }
      if (input.identity)
        await tx.collection('contact_identities').updateOne(
          {
            provider: input.identity.provider,
            channel_account_id: input.identity.account_id,
            external_user_id: input.identity.external_user_id,
          },
          {
            $setOnInsert: {
              id: randomUUID(),
              contact_id: contact.id,
              provider: input.identity.provider,
              channel_account_id: input.identity.account_id,
              external_user_id: input.identity.external_user_id,
            },
            $set: {
              ...(input.identity.username ? { username: input.identity.username } : {}),
              ...(input.identity.display_name
                ? { display_name: input.identity.display_name }
                : {}),
              last_seen_at: now,
            },
          },
          { upsert: true, session: tx.session },
        );
      const existing = await tx.one<Opportunity>('opportunities', {
        contact_id: contact.id,
        open: true,
      });
      if (existing) {
        await tx.update('opportunities', { id: existing.id }, { $set: { last_message_at: now } });
        await tx.insert('inbound_events', {
          external_id: externalId,
          opportunity_id: existing.id,
          received_at: now,
          fingerprint,
        });
        if (input.meta_attribution)
          await tx.insert('lead_attributions', {
            id: randomUUID(),
            opportunity_id: existing.id,
            external_id: externalId,
            ...input.meta_attribution,
            received_at: now,
          });
        await this.audit(
          tx,
          existing.id,
          actor,
          'lead.repeated',
          'Nova entrada vinculada ao contato existente. Responsável preservado.',
        );
        return { id: existing.id, duplicate: true };
      }
      const returning = !!(await tx.count('opportunities', { contact_id: contact.id }));
      const settings = (await tx.one('distribution_settings', { id: 1 }))!;
      const selection = returning ? undefined : await this.next(tx, settings.last_position);
      const next = selection?.selected;
      const id = randomUUID();
      await tx.insert('opportunities', {
        id,
        contact_id: contact.id,
        interest: input.interest,
        unit: input.unit,
        source: input.source,
        channel: input.identity?.provider ?? 'manual',
        source_evidence: input.is_demo
          ? 'Cenário fictício de demonstração'
          : (input.source_evidence ?? 'Informada manualmente; sem vínculo verificado com anúncio'),
        state: next ? 'RESERVED' : 'PENDING',
        reserved_to: next?.id ?? null,
        owner_id: null,
        created_at: now,
        expires_at: next ? new Date(now.getTime() + settings.timeout_minutes * 60_000) : null,
        last_message_at: now,
        claimed_at: null,
        needs_review: returning,
        open: true,
        next_action: '',
        stage: 'CONSULTATION_NOT_SCHEDULED',
        procedure_date: null,
        version: 1,
      });
      if (next)
        await tx.update(
          'distribution_settings',
          { id: 1 },
          { $set: { last_position: next.queue_position } },
        );
      await tx.insert('inbound_events', {
        external_id: externalId,
        opportunity_id: id,
        received_at: now,
        fingerprint,
      });
      if (input.meta_attribution)
        await tx.insert('lead_attributions', {
          id: randomUUID(),
          opportunity_id: id,
          external_id: externalId,
          ...input.meta_attribution,
          received_at: now,
        });
      await this.audit(
        tx,
        id,
        actor,
        'lead.created',
        next
          ? `Distribuído para ${next.name}. Reserva de ${settings.timeout_minutes} minutos.`
          : returning
            ? 'Contato retornou após encerramento. Aguardando revisão da gestão.'
            : 'Aguardando distribuição: não há atendente habilitada.',
        next
          ? {
              reserved_to: next.id,
              queue_weight: next.queue_weight,
              total_active_weight: selection!.totalWeight,
            }
          : {},
      );
      return { id, duplicate: false };
    });
  }
  async expire() {
    const cutoff = await this.now();
    // Avoid a transaction/write fence on every poll when nothing is due.
    if (
      !(await this.db.count('opportunities', {
        state: 'RESERVED',
        expires_at: { $lte: cutoff },
      }))
    )
      return 0;
    let total = 0;
    // Drain the overdue backlog at this cutoff, in short atomic batches. This matters
    // after a sleeping server resumes: a read must not leave the 101st lead reserved.
    for (;;) {
      const processed = await this.db.atomic(async (tx) => {
        const rows = await tx.many<Opportunity>(
          'opportunities',
          { state: 'RESERVED', expires_at: { $lte: cutoff } },
          { expires_at: 1, id: 1 },
          100,
        );
        if (!rows.length) return 0;
        await tx.update(
          'opportunities',
          { id: { $in: rows.map((row) => row.id) }, state: 'RESERVED' },
          { $set: { state: 'POOL' }, $inc: { version: 1 } },
        );
        const recordedAt = await this.now(tx);
        for (const row of rows)
          await enqueuePushEvent(tx, randomUUID(), row.id, 'reservation.expired', recordedAt);
        await tx.collection('audit_events').insertMany(
          rows.map((row) => ({
            id: randomUUID(),
            opportunity_id: row.id,
            actor_id: null,
            kind: 'reservation.expired',
            description: 'Reserva vencida. Lead disponível no bolsão.',
            details: { reserved_to: row.reserved_to },
            created_at: recordedAt,
          })),
          { session: tx.session },
        );
        return rows.length;
      });
      total += processed;
      if (processed < 100) return total;
    }
  }
  async claim(user: User, id: string, mode: 'pool' | 'reservation', version: number, key: string) {
    if (user.role !== 'attendant')
      throw new DomainError('FORBIDDEN', 'Somente atendentes podem assumir.', 403);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const fingerprint = digest({ id, mode, version });
      const replay = await tx.one('claims', { user_id: user.id, key });
      const row = await tx.one<Opportunity>('opportunities', { id });
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada.');
        if (!row || row.state !== 'CLAIMED' || row.owner_id !== user.id)
          throw new DomainError('CLAIM_SUPERSEDED', 'A responsabilidade mudou. Atualize a tela.');
        return replay.response as { id: string; version: number };
      }
      if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
      const now = await this.now(tx);
      const expired =
        row.state === 'RESERVED' && new Date(row.expires_at!).getTime() <= now.getTime();
      if (mode === 'reservation' && (expired || row.state === 'POOL'))
        throw new DomainError('RESERVATION_EXPIRED', 'O prazo terminou. Atualize o bolsão.');
      if (row.state === 'CLAIMED')
        throw new DomainError('ALREADY_CLAIMED', 'Este lead já foi assumido.');
      if (mode === 'reservation' && (row.state !== 'RESERVED' || row.reserved_to !== user.id))
        throw new DomainError('FORBIDDEN', 'Reserva de outra atendente.', 403);
      if (mode === 'pool' && row.state !== 'POOL' && !expired)
        throw new DomainError('NOT_AVAILABLE', 'Lead não está disponível no bolsão.');
      if (row.version !== version)
        throw new DomainError('VERSION_CONFLICT', 'O lead mudou. Atualize.');
      if (expired)
        await this.audit(
          tx,
          id,
          null,
          'reservation.expired',
          'Reserva vencida. Lead disponível no bolsão.',
          { reserved_to: row.reserved_to },
        );
      await tx.update(
        'opportunities',
        { id, version },
        { $set: { state: 'CLAIMED', owner_id: user.id, claimed_at: now }, $inc: { version: 1 } },
      );
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.claimed',
        `Lead assumido por ${user.name}. O aceite não confirma envio de mensagem.`,
      );
      const response = { id, version: version + 1 };
      await tx.insert('claims', { user_id: user.id, key, fingerprint, response });
      return response;
    });
  }
  private visible(user: User) {
    return user.role === 'manager'
      ? {}
      : {
          $or: [
            { owner_id: user.id },
            { state: 'RESERVED', reserved_to: user.id },
            { state: 'POOL' },
          ],
        };
  }
  private async enrich(
    tx: MongoTx,
    row: Opportunity,
    user: User,
    loadedContact?: Document,
  ): Promise<Opportunity> {
    const contact = loadedContact ?? (await tx.one('contacts', { id: row.contact_id }));
    if (!contact) throw new Error('Missing contact');
    const { id: _id, ...fields } = contact;
    const full = { ...row, ...fields } as Opportunity;
    if (
      user.role === 'manager' ||
      row.owner_id === user.id ||
      (row.state === 'POOL' && user.role === 'attendant' && user.active)
    )
      return full;
    const { phone: _phone, email: _email, instagram: _instagram, ...safe } = full;
    return {
      ...safe,
      next_action: '',
    };
  }
  async snapshot(user: User) {
    await this.expire();
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const rows = await tx.many<Opportunity>(
        'opportunities',
        this.visible(user),
        { created_at: -1 },
        500,
      );
      const contacts = new Map(
        (await tx.many('contacts', { id: { $in: rows.map((r) => r.contact_id) } })).map((c) => [
          c.id,
          c,
        ]),
      );
      const opportunities: Opportunity[] = [];
      for (const row of rows)
        opportunities.push(await this.enrich(tx, row, user, contacts.get(row.contact_id)));
      const users = (await tx.many('users', {}, { queue_position: 1 })).map(publicUser);
      const appointments = await tx
        .collection('appointments')
        .aggregate(
          [
            {
              $lookup: {
                from: 'opportunities',
                localField: 'opportunity_id',
                foreignField: 'id',
                as: 'opportunity',
              },
            },
            { $unwind: '$opportunity' },
            ...(user.role === 'manager' ? [] : [{ $match: { 'opportunity.owner_id': user.id } }]),
            {
              $lookup: {
                from: 'contacts',
                localField: 'opportunity.contact_id',
                foreignField: 'id',
                as: 'contact',
              },
            },
            { $unwind: '$contact' },
            { $set: { name: '$contact.name', owner_id: '$opportunity.owner_id' } },
            { $project: { _id: 0, contact: 0, opportunity: 0 } },
            { $sort: { starts_at: 1 } },
          ],
          { session: tx.session },
        )
        .toArray();
      const s = (await tx.one('distribution_settings', { id: 1 }))!;
      return {
        user,
        users,
        opportunities,
        appointments,
        settings: {
          id: 1,
          last_position: s.last_position,
          timeout_minutes: s.timeout_minutes,
          version: s.version,
        },
        server_time: (await this.now(tx)).toISOString(),
        demo: false,
        limit: 500,
      };
    }, true);
  }
  async detail(user: User, id: string) {
    await this.expire();
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const row = await tx.one<Opportunity>('opportunities', { id, ...this.visible(user) });
      if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado neste perfil.', 404);
      const canEdit = user.role === 'manager' || row.owner_id === user.id;
      const history = canEdit
        ? (await tx.many('audit_events', { opportunity_id: id }, { created_at: -1 })).map(
            ({ id, kind, description, created_at }) => ({ id, kind, description, created_at }),
          )
        : [];
      const appointments = canEdit
        ? await tx.many('appointments', { opportunity_id: id }, { starts_at: 1 })
        : [];
      const attributions = canEdit
        ? (
            await tx.many('lead_attributions', { opportunity_id: id }, { received_at: -1, id: -1 })
          ).map(
            ({
              id,
              provider,
              channel,
              source_type,
              source_id,
              source_url,
              headline,
              body,
              media_type,
              image_url,
              video_url,
              thumbnail_url,
              received_at,
            }) => ({
              id,
              provider,
              channel,
              source_type,
              source_id,
              source_url,
              headline,
              body,
              media_type,
              image_url,
              video_url,
              thumbnail_url,
              received_at,
            }),
          )
        : [];
      return {
        ...(await this.enrich(tx, row, user)),
        history,
        appointments,
        attributions,
        can_edit: canEdit,
      };
    }, true);
  }
  async update(user: User, id: string, input: Parameters<CRM['update']>[2]) {
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const row = await tx.one<Opportunity>('opportunities', { id });
      if (!row || (user.role !== 'manager' && row.owner_id !== user.id))
        throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
      if (row.version !== input.version)
        throw new DomainError('VERSION_CONFLICT', 'O cadastro mudou.');
      if (input.stage === 'CLOSED_WITH_DATE' && !isValidDateOnly(input.procedure_date))
        throw new DomainError(
          'PROCEDURE_DATE_REQUIRED',
          'Informe a data do procedimento para concluir como fechado com data.',
          400,
        );
      if (
        input.stage === 'DECLINED' &&
        (await tx.count('appointments', { opportunity_id: id, status: 'scheduled' }))
      )
        throw new DomainError('OPEN_APPOINTMENTS', 'Conclua ou cancele as consultas.');
      if (row.stage === 'DECLINED' && input.stage !== 'DECLINED')
        throw new DomainError(
          'REENTRY_PENDING',
          'Um lead declinado não pode ser reaberto. Uma nova entrada deve ser criada.',
        );
      if (isClosedStage(row.stage) && !isClosedStage(input.stage))
        throw new DomainError(
          'REENTRY_PENDING',
          'Uma qualificação encerrada não pode voltar ao atendimento ativo.',
        );
      await tx.update(
        'contacts',
        { id: row.contact_id },
        { $set: { name: input.name, email: input.email, instagram: input.instagram } },
      );
      await tx.update(
        'opportunities',
        { id },
        {
          $set: {
            interest: input.interest,
            unit: input.unit,
            stage: input.stage,
            procedure_date: input.stage === 'CLOSED_WITH_DATE' ? input.procedure_date : null,
            next_action: input.next_action,
            state: isClosedStage(input.stage) ? 'CANCELLED' : row.state,
            ...(isClosedStage(input.stage) ? { reserved_to: null, expires_at: null } : {}),
            open: !isClosedStage(input.stage),
          },
          $inc: { version: 1 },
        },
      );
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.updated',
        row.stage === input.stage
          ? `Cadastro atualizado por ${user.name}.`
          : `Qualificação alterada por ${user.name}: ${stageLabels[row.stage]} → ${stageLabels[input.stage]}.`,
        { previous_stage: row.stage, next_stage: input.stage },
      );
      return { id, version: row.version + 1 };
    });
  }
  async schedule(user: User, id: string, input: Parameters<CRM['schedule']>[2]) {
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const row = await tx.one<Opportunity>('opportunities', { id });
      if (!row || (user.role !== 'manager' && row.owner_id !== user.id))
        throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
      if (row.version !== input.expected_version)
        throw new DomainError('VERSION_CONFLICT', 'O lead mudou.');
      if (isClosedStage(row.stage)) throw new DomainError('CLOSED', 'Oportunidade encerrada.');
      if (new Date(input.starts_at) <= (await this.now(tx)))
        throw new DomainError('INVALID_DATE', 'Escolha um horário futuro.', 400);
      if (await tx.count('appointments', { opportunity_id: id, status: 'scheduled' }))
        throw new DomainError('OPEN_APPOINTMENT', 'Já existe uma consulta agendada.');
      const appointmentId = randomUUID();
      await tx.insert('appointments', {
        id: appointmentId,
        opportunity_id: id,
        starts_at: new Date(input.starts_at),
        unit: input.unit,
        created_by: user.id,
        status: 'scheduled',
        version: 1,
      });
      await tx.update(
        'opportunities',
        { id },
        { $set: { stage: 'FOLLOW_UP' }, $inc: { version: 1 } },
      );
      await this.audit(
        tx,
        id,
        user.id,
        'appointment.created',
        `Consulta agendada por ${user.name}.${
          row.stage === 'FOLLOW_UP'
            ? ''
            : ` Qualificação: ${stageLabels[row.stage]} → ${stageLabels.FOLLOW_UP}.`
        }`,
        {
          appointment_id: appointmentId,
          previous_stage: row.stage,
          next_stage: 'FOLLOW_UP',
        },
      );
      return { id: appointmentId };
    });
  }
  async configure(user: User, input: Parameters<CRM['configure']>[1]) {
    requireManager(user);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, user);
      const settings = (await tx.one('distribution_settings', { id: 1 }))!;
      if (settings.version !== input.version)
        throw new DomainError('VERSION_CONFLICT', 'A configuração mudou.');
      if (
        new Set(input.participants.map((participant) => participant.id)).size !==
        input.participants.length
      )
        throw new DomainError('INVALID_INPUT', 'Atendente repetida na configuração.', 400);
      const attendants = await tx.many<QueueUser>('users', { role: 'attendant' }, { id: 1 });
      const configured = input.participants.map((participant) => {
        const target = attendants.find((attendant) => attendant.id === participant.id);
        if (!target)
          throw new DomainError('INVALID_INPUT', 'Atendente inválida na configuração.', 400);
        if (participant.enabled && !target.active)
          throw new DomainError(
            'INVALID_INPUT',
            'Uma conta inativa não pode entrar no rodízio.',
            400,
          );
        const weight = participant.weight ?? target.queue_weight;
        if (!Number.isInteger(weight) || weight < 1 || weight > 3)
          throw new DomainError('INVALID_INPUT', 'O peso deve estar entre 1 e 3.', 400);
        return { target, enabled: participant.enabled && target.active, weight };
      });
      const queueChanged = configured.some(
        ({ target, enabled, weight }) =>
          target.queue_enabled !== enabled || target.queue_weight !== weight,
      );
      if (queueChanged)
        for (const attendant of attendants)
          await tx.update('users', { id: attendant.id }, { $set: { queue_credit: 0 } });
      for (const participant of configured)
        if (
          participant.target.queue_enabled !== participant.enabled ||
          participant.target.queue_weight !== participant.weight
        )
          await tx.update(
            'users',
            { id: participant.target.id },
            {
              $set: {
                queue_enabled: participant.enabled,
                queue_weight: participant.weight,
              },
              $inc: { version: 1 },
            },
          );
      await this.audit(
        tx,
        null,
        user.id,
        'queue.updated',
        `Fila atualizada. Prazo para novas reservas: ${input.timeout_minutes} minutos.`,
        {
          timeout_minutes: input.timeout_minutes,
          participants: configured.map(({ target, enabled, weight }) => ({
            id: target.id,
            enabled,
            weight,
          })),
        },
      );
      const pending = await tx.many<Opportunity>(
        'opportunities',
        { state: 'PENDING', needs_review: false },
        { created_at: 1, id: 1 },
      );
      let last = settings.last_position;
      for (const row of pending) {
        const selection = await this.next(tx, last);
        if (!selection) break;
        const next = selection.selected;
        await tx.update(
          'opportunities',
          { id: row.id },
          {
            $set: {
              state: 'RESERVED',
              reserved_to: next.id,
              expires_at: new Date((await this.now(tx)).getTime() + input.timeout_minutes * 60_000),
            },
            $inc: { version: 1 },
          },
        );
        last = next.queue_position!;
        await this.audit(
          tx,
          row.id,
          user.id,
          'reservation.created',
          `Pendência distribuída para ${next.name}.`,
          {
            reserved_to: next.id,
            queue_weight: next.queue_weight,
            total_active_weight: selection.totalWeight,
          },
        );
      }
      await tx.update(
        'distribution_settings',
        { id: 1 },
        {
          $set: { timeout_minutes: input.timeout_minutes, last_position: last },
          $inc: { version: 1 },
        },
      );
      return { version: settings.version + 1 };
    });
  }
  async createAttendant(
    actor: User,
    input: Parameters<Operations['createAttendant']>[1],
    key: string,
  ) {
    requireManager(actor);
    const hash = await hashPassword(input.password);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(tx, actor, key, { kind: 'user.create', ...input }, async () => {
        if (
          await tx.count('users', {
            $or: [{ email: input.email.toLowerCase() }, { queue_position: input.queue_position }],
          })
        )
          throw new DomainError('USER_CONFLICT', 'Login ou posição já utilizados.');
        const user = mongoUser({
          name: input.name,
          email: input.email,
          password_hash: hash,
          role: 'attendant',
          queue_position: input.queue_position,
          must_change_password: false,
        });
        await tx.insert('users', user);
        for (const attendant of await tx.many('users', { role: 'attendant' }, { id: 1 }))
          await tx.update('users', { id: attendant.id }, { $set: { queue_credit: 0 } });
        await tx.update('distribution_settings', { id: 1 }, { $inc: { version: 1 } });
        await this.audit(
          tx,
          null,
          actor.id,
          'user.created',
          'Atendente criada com login e senha definidos pela gestão.',
          { user_id: user.id },
        );
        return { id: user.id };
      });
    });
  }
  private async assign(tx: MongoTx, row: Opportunity, target: User, actor: User, reason: string) {
    await tx.update(
      'opportunities',
      { id: row.id },
      {
        $set: {
          state: 'CLAIMED',
          owner_id: target.id,
          reserved_to: null,
          expires_at: null,
          claimed_at: null,
          needs_review: false,
        },
        $inc: { version: 1 },
      },
    );
    await this.audit(
      tx,
      row.id,
      actor.id,
      'opportunity.transferred',
      `Atribuído pela gestão para ${target.name}. Motivo: ${reason}`,
      { previous_owner: row.owner_id, previous_reserved_to: row.reserved_to, new_owner: target.id },
    );
  }
  async transfer(
    actor: User,
    id: string,
    input: Parameters<Operations['transfer']>[2],
    key: string,
  ) {
    requireManager(actor);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(tx, actor, key, { kind: 'transfer', id, ...input }, async () => {
        const target = await tx.one<User>('users', {
          id: input.target_id,
          active: true,
          role: 'attendant',
        });
        if (!target)
          throw new DomainError('INVALID_ASSIGNEE', 'Selecione uma atendente ativa.', 400);
        const row = await tx.one<Opportunity>('opportunities', { id });
        if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
        if (row.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'O lead mudou.');
        if (isClosedStage(row.stage)) throw new DomainError('CLOSED', 'Oportunidade encerrada.');
        if (row.owner_id === target.id)
          throw new DomainError('SAME_OWNER', 'A atendente já é responsável.');
        await this.assign(tx, row, target, actor, input.reason);
        return { id, version: row.version + 1 };
      });
    });
  }
  async updateAttendant(
    actor: User,
    id: string,
    input: Parameters<Operations['updateAttendant']>[2],
    key: string,
  ) {
    requireManager(actor);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(tx, actor, key, { kind: 'user.update', id, ...input }, async () => {
        const target = await tx.one<User>('users', { id, role: 'attendant' });
        if (!target) throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
        if (target.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'A conta mudou.');
        if (!input.active) {
          const owned = await tx.many<Opportunity>('opportunities', {
            open: true,
            $or: [{ owner_id: id }, { state: 'RESERVED', reserved_to: id }],
          });
          const replacement = input.replacement_id
            ? await tx.one<User>('users', {
                id: input.replacement_id,
                active: true,
                role: 'attendant',
              })
            : null;
          if (owned.length && (!replacement || replacement.id === id))
            throw new DomainError(
              'REPLACEMENT_REQUIRED',
              'Selecione outra atendente ativa para receber os atendimentos.',
            );
          for (const row of owned)
            await this.assign(tx, row, replacement!, actor, `Desativação: ${input.reason}`);
          await tx.remove('sessions', { user_id: id });
        }
        await tx.update(
          'users',
          { id },
          {
            $set: {
              name: input.name,
              active: input.active,
              queue_enabled: input.active ? target.queue_enabled : false,
              ...(!input.active ? { queue_credit: 0 } : {}),
            },
            $inc: { version: 1, auth_version: target.active === input.active ? 0 : 1 },
          },
        );
        if (target.active !== input.active)
          for (const attendant of await tx.many('users', { role: 'attendant' }, { id: 1 }))
            await tx.update('users', { id: attendant.id }, { $set: { queue_credit: 0 } });
        await tx.update('distribution_settings', { id: 1 }, { $inc: { version: 1 } });
        await this.audit(tx, null, actor.id, 'user.updated', `Conta atualizada. ${input.reason}`, {
          user_id: id,
          previous_active: target.active,
          active: input.active,
        });
        return { id, version: target.version + 1 };
      });
    });
  }
  async deleteAttendant(actor: User, id: string, input: DeleteAttendantInput, key: string) {
    requireManager(actor);
    if (input.confirmation !== 'EXCLUIR')
      throw new DomainError(
        'CONFIRMATION_REQUIRED',
        'Digite EXCLUIR para confirmar a exclusão permanente.',
        400,
      );
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(tx, actor, key, { kind: 'user.delete', id, ...input }, async () => {
        const target = await tx.one<User>('users', { id, role: 'attendant' });
        if (!target) throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
        if (target.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'A conta mudou. Atualize antes de excluir.');
        if (target.active)
          throw new DomainError(
            'ACTIVE_USER',
            'Desative a atendente antes da exclusão permanente.',
            400,
          );
        if (
          await tx.count('opportunities', {
            $or: [{ owner_id: id }, { reserved_to: id }],
          })
        )
          throw new DomainError(
            'USER_HAS_LEADS',
            'Exclua ou transfira todos os leads vinculados antes de apagar a atendente.',
            409,
          );
        await this.audit(
          tx,
          null,
          actor.id,
          'user.deleted',
          'Conta de atendente excluída permanentemente.',
          { user_id: id, name: target.name, login: target.email },
        );
        await tx.update('appointments', { created_by: id }, { $set: { created_by: actor.id } });
        await tx.remove('sessions', { user_id: id });
        await tx.remove('claims', { user_id: id });
        await tx.remove('operation_receipts', { actor_id: id });
        await tx.remove('push_records', { kind: 'subscription', 'data.userId': id });
        await tx.remove('users', { id });
        const settings = (await tx.one('distribution_settings', { id: 1 }))!;
        const remaining = await tx.many<QueueUser>(
          'users',
          { role: 'attendant' },
          { queue_position: 1, id: 1 },
        );
        const compacted = compactQueuePositions(remaining, settings.last_position);
        for (const attendant of remaining) {
          const queuePosition = compacted.positions.get(attendant.id)!;
          await tx.update(
            'users',
            { id: attendant.id },
            {
              $set: { queue_position: queuePosition, queue_credit: 0 },
              ...(attendant.queue_position === queuePosition ? {} : { $inc: { version: 1 } }),
            },
          );
        }
        await tx.update(
          'distribution_settings',
          { id: 1 },
          {
            $set: { last_position: compacted.lastPosition },
            $inc: { version: 1 },
          },
        );
        return { deleted: true };
      });
    });
  }
  async changeAppointment(
    actor: User,
    id: string,
    input: Parameters<Operations['changeAppointment']>[2],
    key: string,
  ) {
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(
        tx,
        actor,
        key,
        { kind: 'appointment.update', id, ...input },
        async () => {
          const a = await tx.one('appointments', { id });
          const row = a
            ? await tx.one<Opportunity>('opportunities', { id: a.opportunity_id })
            : null;
          if (!a || !row || (actor.role !== 'manager' && row.owner_id !== actor.id))
            throw new DomainError('NOT_FOUND', 'Consulta não encontrada.', 404);
          if (a.version !== input.expected_version)
            throw new DomainError('VERSION_CONFLICT', 'A consulta mudou.');
          if (a.status !== 'scheduled')
            throw new DomainError(
              'APPOINTMENT_CLOSED',
              'Consulta encerrada não pode ser reescrita.',
            );
          const now = await this.now(tx);
          if (
            (input.status === 'scheduled' && new Date(input.starts_at) <= now) ||
            (input.status === 'completed' && new Date(a.starts_at) > now)
          )
            throw new DomainError('INVALID_DATE', 'Horário inválido para esta operação.', 400);
          const starts_at = input.status === 'scheduled' ? new Date(input.starts_at) : a.starts_at;
          const unit = input.status === 'scheduled' ? input.unit : a.unit;
          await tx.update(
            'appointments',
            { id },
            { $set: { starts_at, unit, status: input.status }, $inc: { version: 1 } },
          );
          await tx.update('opportunities', { id: row.id }, { $inc: { version: 1 } });
          await this.audit(
            tx,
            row.id,
            actor.id,
            'appointment.updated',
            `Consulta atualizada. Motivo: ${input.reason}`,
            {
              appointment_id: id,
              before: { starts_at: a.starts_at, unit: a.unit, status: a.status },
              after: { starts_at, unit, status: input.status },
            },
          );
          return { id, version: a.version + 1 };
        },
      );
    });
  }
  async changePassword(user: User, currentPassword: string, newPassword: string) {
    if (currentPassword === newPassword)
      throw new DomainError('SAME_PASSWORD', 'A nova senha precisa ser diferente.', 400);
    const hash = await hashPassword(newPassword);
    return this.db.atomic(async (tx) => {
      const target = await this.actor(tx, user, true);
      if (!(await verifyPassword(currentPassword, target.password_hash)))
        throw new DomainError('INVALID_CREDENTIALS', 'Senha atual incorreta.', 400);
      await tx.update(
        'users',
        { id: user.id },
        {
          $set: { password_hash: hash, must_change_password: false },
          $inc: { auth_version: 1, version: 1 },
        },
      );
      await tx.remove('sessions', { user_id: user.id });
      await this.audit(
        tx,
        null,
        user.id,
        'password.changed',
        'Senha alterada e todas as sessões encerradas.',
      );
      return { ok: true };
    });
  }
  async resetPassword(actor: User, id: string, password: string, version: number, key: string) {
    requireManager(actor);
    const hash = await hashPassword(password);
    return this.db.atomic(async (tx) => {
      await this.actor(tx, actor);
      return this.command(
        tx,
        actor,
        key,
        { kind: 'password.reset', id, password, version },
        async () => {
          const target = await tx.one<User>('users', { id, role: 'attendant' });
          if (!target) throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
          if (target.version !== version)
            throw new DomainError('VERSION_CONFLICT', 'A conta mudou.');
          await tx.update(
            'users',
            { id },
            {
              $set: { password_hash: hash, must_change_password: false },
              $inc: { auth_version: 1, version: 1 },
            },
          );
          await tx.remove('sessions', { user_id: id });
          await this.audit(
            tx,
            null,
            actor.id,
            'password.reset',
            'Senha redefinida e sessões revogadas.',
            { user_id: id },
          );
          return { ok: true };
        },
      );
    });
  }
}
