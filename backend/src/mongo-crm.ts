import { createHash, randomUUID } from 'node:crypto';
import { enqueuePushEvent } from './push-store.js';
import { deleteLeadData, wasDeleted, type DeleteLeadInput } from './lead-deletion.js';
import { MongoStore, MongoTx, mongoUser } from './mongo-store.js';
import { DomainError, requireManager, type User, type Opportunity } from './types.js';
import type { CRM, LeadInput } from './crm.js';
import type { Operations } from './operations.js';
import { hashPassword, verifyPassword } from './auth.js';
import type { Document } from 'mongodb';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = (stage: string) => ['WON', 'LOST'].includes(stage);
export function publicUser(user: Document): User {
  const {
    id,
    name,
    email,
    role,
    active,
    queue_enabled,
    queue_position,
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
  private async next(tx: MongoTx, last: number) {
    const users = await tx.many<User>(
      'users',
      { role: 'attendant', active: true, queue_enabled: true },
      { queue_position: 1 },
    );
    return users.find((u) => u.queue_position! > last) ?? users[0];
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
      let contact = await tx.one('contacts', { phone: input.phone });
      if (!contact) {
        contact = {
          id: randomUUID(),
          name: input.name,
          phone: input.phone,
          email: '',
          instagram: '',
          is_demo: input.is_demo ?? false,
        };
        await tx.insert('contacts', contact);
      }
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
      const next = returning ? undefined : await this.next(tx, settings.last_position);
      const id = randomUUID();
      await tx.insert('opportunities', {
        id,
        contact_id: contact.id,
        interest: input.interest,
        unit: input.unit,
        source: input.source,
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
        stage: 'TO_QUALIFY',
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
    if (user.role === 'manager' || row.owner_id === user.id) return full;
    const { phone: _phone, email: _email, instagram: _instagram, ...safe } = full;
    return {
      ...safe,
      name: row.state === 'POOL' ? 'Contato disponível' : full.name,
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
      return { ...(await this.enrich(tx, row, user)), history, appointments, can_edit: canEdit };
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
      if (input.stage === 'WON')
        throw new DomainError('CONTRACT_REQUIRED', 'Validação de contrato ainda não implementada.');
      if (
        input.stage === 'LOST' &&
        (await tx.count('appointments', { opportunity_id: id, status: 'scheduled' }))
      )
        throw new DomainError('OPEN_APPOINTMENTS', 'Conclua ou cancele as avaliações.');
      if (row.stage === 'LOST' && input.stage !== 'LOST')
        throw new DomainError('REENTRY_PENDING', 'Reabertura depende da política de reentrada.');
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
            next_action: input.next_action,
            state: input.stage === 'LOST' ? 'CANCELLED' : row.state,
            open: !closed(input.stage),
          },
          $inc: { version: 1 },
        },
      );
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.updated',
        `Cadastro atualizado por ${user.name}. Etapa: ${input.stage}.`,
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
      if (closed(row.stage)) throw new DomainError('CLOSED', 'Oportunidade encerrada.');
      if (new Date(input.starts_at) <= (await this.now(tx)))
        throw new DomainError('INVALID_DATE', 'Escolha um horário futuro.', 400);
      if (await tx.count('appointments', { opportunity_id: id, status: 'scheduled' }))
        throw new DomainError('OPEN_APPOINTMENT', 'Já existe uma avaliação agendada.');
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
        { $set: { stage: 'EVALUATION_SCHEDULED' }, $inc: { version: 1 } },
      );
      await this.audit(
        tx,
        id,
        user.id,
        'appointment.created',
        `Avaliação agendada por ${user.name}.`,
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
      for (const p of input.participants)
        await tx.update(
          'users',
          { id: p.id, role: 'attendant', active: true },
          { $set: { queue_enabled: p.enabled }, $inc: { version: 1 } },
        );
      await tx.update(
        'distribution_settings',
        { id: 1 },
        { $set: { timeout_minutes: input.timeout_minutes }, $inc: { version: 1 } },
      );
      await this.audit(
        tx,
        null,
        user.id,
        'queue.updated',
        `Fila atualizada. Prazo para novas reservas: ${input.timeout_minutes} minutos.`,
      );
      const pending = await tx.many<Opportunity>(
        'opportunities',
        { state: 'PENDING', needs_review: false },
        { created_at: 1, id: 1 },
      );
      let last = settings.last_position;
      for (const row of pending) {
        const next = await this.next(tx, last);
        if (!next) break;
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
        last = next.queue_position;
        await this.audit(
          tx,
          row.id,
          user.id,
          'reservation.created',
          `Pendência distribuída para ${next.name}.`,
        );
      }
      await tx.update('distribution_settings', { id: 1 }, { $set: { last_position: last } });
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
          throw new DomainError('USER_CONFLICT', 'E-mail ou posição já utilizados.');
        const user = mongoUser({
          name: input.name,
          email: input.email,
          password_hash: hash,
          role: 'attendant',
          queue_position: input.queue_position,
          must_change_password: true,
        });
        await tx.insert('users', user);
        await tx.update('distribution_settings', { id: 1 }, { $inc: { version: 1 } });
        await this.audit(
          tx,
          null,
          actor.id,
          'user.created',
          'Atendente criada. Troca de senha exigida no primeiro acesso.',
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
        if (closed(row.stage)) throw new DomainError('CLOSED', 'Oportunidade encerrada.');
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
            },
            $inc: { version: 1, auth_version: target.active === input.active ? 0 : 1 },
          },
        );
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
            throw new DomainError('NOT_FOUND', 'Avaliação não encontrada.', 404);
          if (a.version !== input.expected_version)
            throw new DomainError('VERSION_CONFLICT', 'A avaliação mudou.');
          if (a.status !== 'scheduled')
            throw new DomainError(
              'APPOINTMENT_CLOSED',
              'Avaliação encerrada não pode ser reescrita.',
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
            `Avaliação atualizada. Motivo: ${input.reason}`,
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
              $set: { password_hash: hash, must_change_password: true },
              $inc: { auth_version: 1, version: 1 },
            },
          );
          await tx.remove('sessions', { user_id: id });
          await this.audit(
            tx,
            null,
            actor.id,
            'password.reset',
            'Senha temporária redefinida e sessões revogadas.',
            { user_id: id },
          );
          return { ok: true };
        },
      );
    });
  }
}
