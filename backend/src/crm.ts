import { randomUUID, createHash } from 'node:crypto';
import type { Database, Sql } from './db.js';
import { DomainError, requireManager, type Opportunity, type User } from './types.js';
import { lockActor } from './access.js';

const selectOpportunity = `SELECT o.*, c.name, c.phone, c.email, c.instagram, c.is_demo
  FROM opportunities o JOIN contacts c ON c.id = o.contact_id`;
export interface LeadInput {
  name: string;
  phone: string;
  interest: string;
  unit: string;
  source: string;
  source_evidence?: string;
  is_demo?: boolean;
}

export class CRM {
  constructor(
    public db: Database,
    private clock?: () => Date,
  ) {}
  async now(tx: Sql = this.db) {
    return this.clock
      ? this.clock()
      : new Date((await tx.query<{ now: string }>('SELECT clock_timestamp() AS now')).rows[0].now);
  }
  async audit(
    tx: Sql,
    id: string | null,
    actor: string | null,
    kind: string,
    description: string,
    details: unknown = {},
  ) {
    await tx.query('INSERT INTO audit_events VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      randomUUID(),
      id,
      actor,
      kind,
      description,
      await this.now(tx),
      JSON.stringify(details),
    ]);
  }
  async ingest(
    input: LeadInput,
    externalId: string,
    actor: string | null,
    authenticatedUser?: User,
  ) {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          name: input.name,
          phone: input.phone,
          interest: input.interest,
          unit: input.unit,
          source: input.source,
          source_evidence: input.source_evidence,
          is_demo: input.is_demo ?? false,
        }),
      )
      .digest('hex');
    return this.db.transaction(async (tx) => {
      // One short queue transaction serializes cursor and identity creation across API instances.
      const settings = (
        await tx.query<{ last_position: number; timeout_minutes: number }>(
          'SELECT * FROM distribution_settings WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      if (authenticatedUser) await lockActor(tx, authenticatedUser);
      const duplicate = (
        await tx.query<{ opportunity_id: string; fingerprint: string }>(
          'SELECT opportunity_id,fingerprint FROM inbound_events WHERE external_id=$1',
          [externalId],
        )
      ).rows[0];
      if (duplicate) {
        if (duplicate.fingerprint && duplicate.fingerprint !== fingerprint)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'Esta solicitação já foi usada com outros dados. Reabra o formulário para um novo cadastro.',
          );
        return { id: duplicate.opportunity_id, duplicate: true };
      }
      const now = await this.now(tx);
      let contact = (
        await tx.query<{ id: string }>('SELECT id FROM contacts WHERE phone=$1', [input.phone])
      ).rows[0];
      if (!contact) {
        contact = { id: randomUUID() };
        await tx.query('INSERT INTO contacts(id,name,phone,is_demo) VALUES ($1,$2,$3,$4)', [
          contact.id,
          input.name,
          input.phone,
          input.is_demo ?? false,
        ]);
      }
      const existing = (
        await tx.query<{ id: string }>(
          "SELECT id FROM opportunities WHERE contact_id=$1 AND stage NOT IN ('WON','LOST') FOR UPDATE",
          [contact.id],
        )
      ).rows[0];
      if (existing) {
        await tx.query('UPDATE opportunities SET last_message_at=$2 WHERE id=$1', [
          existing.id,
          now,
        ]);
        await tx.query('INSERT INTO inbound_events VALUES ($1,$2,$3,$4)', [
          externalId,
          existing.id,
          now,
          fingerprint,
        ]);
        await this.audit(
          tx,
          existing.id,
          actor,
          'lead.repeated',
          'Nova entrada vinculada ao contato existente. Responsável preservado.',
        );
        return { id: existing.id, duplicate: true };
      }
      // Closed opportunities retain history. A returning contact requires manager review.
      const returning = !!(
        await tx.query('SELECT id FROM opportunities WHERE contact_id=$1 LIMIT 1', [contact.id])
      ).rows.length;
      const attendant = returning
        ? undefined
        : (
            await tx.query<User>(
              `SELECT * FROM users WHERE role='attendant' AND active AND queue_enabled
        ORDER BY CASE WHEN queue_position > $1 THEN 0 ELSE 1 END, queue_position LIMIT 1`,
              [settings.last_position],
            )
          ).rows[0];
      const id = randomUUID();
      const expires = attendant
        ? new Date(now.getTime() + settings.timeout_minutes * 60_000)
        : null;
      await tx.query(
        `INSERT INTO opportunities(id,contact_id,interest,unit,source,source_evidence,state,reserved_to,created_at,expires_at,last_message_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9)`,
        [
          id,
          contact.id,
          input.interest,
          input.unit,
          input.source,
          input.is_demo
            ? 'Cenário fictício de demonstração'
            : (input.source_evidence ??
              'Informada manualmente; sem vínculo verificado com anúncio'),
          attendant ? 'RESERVED' : 'PENDING',
          attendant?.id ?? null,
          now,
          expires,
        ],
      );
      if (returning) await tx.query('UPDATE opportunities SET needs_review=true WHERE id=$1', [id]);
      if (attendant)
        await tx.query('UPDATE distribution_settings SET last_position=$1 WHERE id=1', [
          attendant.queue_position,
        ]);
      await tx.query('INSERT INTO inbound_events VALUES ($1,$2,$3,$4)', [
        externalId,
        id,
        now,
        fingerprint,
      ]);
      await this.audit(
        tx,
        id,
        actor,
        'lead.created',
        attendant
          ? `Distribuído para ${attendant.name}. Reserva de ${settings.timeout_minutes} minutos.`
          : returning
            ? 'Contato retornou após encerramento. Aguardando revisão da gestão.'
            : 'Aguardando distribuição: não há atendente habilitada.',
      );
      return { id, duplicate: false };
    });
  }
  async expire() {
    return this.db.transaction(async (tx) => {
      const rows = (
        await tx.query<{ id: string }>(
          `UPDATE opportunities SET state='POOL', version=version+1
        WHERE state='RESERVED' AND expires_at <= $1 RETURNING id`,
          [await this.now(tx)],
        )
      ).rows;
      for (const row of rows)
        await this.audit(
          tx,
          row.id,
          null,
          'reservation.expired',
          'Reserva vencida. Lead disponível no bolsão.',
        );
      return rows.length;
    });
  }
  async claim(user: User, id: string, mode: 'pool' | 'reservation', version: number, key: string) {
    if (user.role !== 'attendant')
      throw new DomainError(
        'FORBIDDEN',
        'Somente atendentes habilitadas podem disputar o bolsão.',
        403,
      );
    return this.db.transaction(async (tx) => {
      // Serialize a user's idempotency keys, including accidental reuse for another resource.
      const currentUser = await lockActor(tx, user, true);
      if (currentUser.role !== 'attendant')
        throw new DomainError('FORBIDDEN', 'Participação no rodízio indisponível.', 403);
      const fingerprint = JSON.stringify({ id, mode, version });
      const replay = (
        await tx.query<{ fingerprint: string; response: { id: string; version: number } }>(
          'SELECT * FROM claims WHERE user_id=$1 AND key=$2',
          [user.id, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'Esta chave já foi usada em outra operação.',
          );
        const current = (
          await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR SHARE', [id])
        ).rows[0];
        if (!current || current.state !== 'CLAIMED' || current.owner_id !== user.id)
          throw new DomainError(
            'CLAIM_SUPERSEDED',
            'O aceite foi registrado anteriormente, mas a responsabilidade mudou. Atualize a tela.',
          );
        return replay.response;
      }
      const row = (
        await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
      const now = await this.now(tx);
      const expired =
        row.state === 'RESERVED' && new Date(row.expires_at!).getTime() <= now.getTime();
      if (mode === 'reservation' && (expired || row.state === 'POOL'))
        throw new DomainError(
          'RESERVATION_EXPIRED',
          'O prazo terminou. Atualize o bolsão para disputar este lead.',
        );
      if (row.state === 'CLAIMED')
        throw new DomainError(
          'ALREADY_CLAIMED',
          'Este lead já foi assumido. Atualizamos o bolsão.',
        );
      if (mode === 'reservation' && (row.state !== 'RESERVED' || row.reserved_to !== user.id))
        throw new DomainError('FORBIDDEN', 'Esta reserva não pertence a você.', 403);
      if (mode === 'pool' && row.state !== 'POOL' && !expired)
        throw new DomainError('NOT_AVAILABLE', 'Este lead não está no bolsão.');
      if (row.version !== version)
        throw new DomainError('VERSION_CONFLICT', 'Este lead mudou. Atualize e tente novamente.');
      // A claim can observe expiry before the periodic reconciler. Record the same
      // transition while holding the opportunity lock; a later sweep cannot duplicate it.
      if (expired)
        await this.audit(
          tx,
          id,
          null,
          'reservation.expired',
          'Reserva vencida. Lead disponível no bolsão.',
        );
      await tx.query(
        `UPDATE opportunities SET state='CLAIMED',owner_id=$2,claimed_at=$3,version=version+1 WHERE id=$1`,
        [id, user.id, now],
      );
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.claimed',
        `Lead assumido por ${user.name}. O aceite não confirma envio de mensagem.`,
      );
      const response = { id, version: row.version + 1 };
      await tx.query('INSERT INTO claims VALUES ($1,$2,$3,$4)', [
        user.id,
        key,
        fingerprint,
        JSON.stringify(response),
      ]);
      return response;
    });
  }
  private visible(row: Opportunity, user: User) {
    return (
      user.role === 'manager' ||
      row.owner_id === user.id ||
      (row.state === 'RESERVED' && row.reserved_to === user.id) ||
      (row.state === 'POOL' && user.role === 'attendant' && user.active)
    );
  }
  private sanitize(row: Opportunity, user: User): Opportunity {
    if (user.role === 'manager' || row.owner_id === user.id) return row;
    const { phone: _phone, email: _email, instagram: _instagram, ...summary } = row;
    return {
      ...summary,
      name: row.state === 'POOL' ? 'Contato disponível' : row.name,
      next_action: '',
    };
  }
  async snapshot(user: User) {
    await this.expire();
    const rows = (
      await this.db.query<Opportunity>(
        `${selectOpportunity}
      WHERE ($1::boolean OR o.owner_id=$2 OR (o.state='RESERVED' AND o.reserved_to=$2) OR (o.state='POOL' AND $3::boolean))
      ORDER BY o.created_at DESC LIMIT 500`,
        [user.role === 'manager', user.id, user.role === 'attendant' && user.active],
      )
    ).rows;
    const users = (
      await this.db.query<User>(
        'SELECT id,name,email,role,active,queue_enabled,queue_position,color,version,auth_version,must_change_password FROM users ORDER BY queue_position NULLS FIRST',
      )
    ).rows;
    const opportunities = rows
      .filter((o) => this.visible(o, user))
      .map((o) => this.sanitize(o, user));
    const appointments = (
      await this.db.query(
        `SELECT a.*,c.name, o.owner_id FROM appointments a JOIN opportunities o ON o.id=a.opportunity_id
      JOIN contacts c ON c.id=o.contact_id WHERE ($1::boolean OR o.owner_id=$2) ORDER BY a.starts_at`,
        [user.role === 'manager', user.id],
      )
    ).rows;
    const settings = (await this.db.query('SELECT * FROM distribution_settings WHERE id=1'))
      .rows[0];
    return {
      user,
      users,
      opportunities,
      appointments,
      settings,
      server_time: (await this.now()).toISOString(),
      demo: true,
      limit: 500,
    };
  }
  async detail(user: User, id: string) {
    await this.expire();
    const row = (await this.db.query<Opportunity>(`${selectOpportunity} WHERE o.id=$1`, [id]))
      .rows[0];
    if (!row || !this.visible(row, user))
      throw new DomainError('NOT_FOUND', 'Lead não encontrado neste perfil.', 404);
    const canEdit = user.role === 'manager' || row.owner_id === user.id;
    const history = canEdit
      ? (
          await this.db.query(
            'SELECT id,kind,description,created_at FROM audit_events WHERE opportunity_id=$1 ORDER BY created_at DESC',
            [id],
          )
        ).rows
      : [];
    const appointments = canEdit
      ? (
          await this.db.query(
            'SELECT * FROM appointments WHERE opportunity_id=$1 ORDER BY starts_at',
            [id],
          )
        ).rows
      : [];
    return { ...this.sanitize(row, user), history, appointments, can_edit: canEdit };
  }
  async update(
    user: User,
    id: string,
    input: {
      version: number;
      name: string;
      email: string;
      instagram: string;
      interest: string;
      unit: string;
      stage: string;
      next_action: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      await lockActor(tx, user);
      const row = (
        await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row || (user.role !== 'manager' && row.owner_id !== user.id))
        throw new DomainError('NOT_FOUND', 'Lead não encontrado neste perfil.', 404);
      if (row.version !== input.version)
        throw new DomainError(
          'VERSION_CONFLICT',
          'O cadastro foi alterado. Reabra a ficha antes de salvar.',
        );
      if (input.stage === 'WON')
        throw new DomainError(
          'CONTRACT_REQUIRED',
          'Validação de contrato será implementada na etapa comercial. Não é possível confirmar venda nesta versão.',
        );
      if (
        input.stage === 'LOST' &&
        (
          await tx.query(
            "SELECT id FROM appointments WHERE opportunity_id=$1 AND status='scheduled' LIMIT 1",
            [id],
          )
        ).rows.length
      )
        throw new DomainError(
          'OPEN_APPOINTMENTS',
          'Conclua ou cancele as avaliações antes de encerrar o lead.',
        );
      if (row.stage === 'LOST' && input.stage !== 'LOST')
        throw new DomainError(
          'REENTRY_PENDING',
          'Reabertura depende da política de reentrada, ainda em validação.',
        );
      await tx.query('UPDATE contacts SET name=$2,email=$3,instagram=$4 WHERE id=$1', [
        row.contact_id,
        input.name,
        input.email,
        input.instagram,
      ]);
      await tx.query(
        `UPDATE opportunities SET interest=$2,unit=$3,stage=$4,next_action=$5,version=version+1,
        state=CASE WHEN $4='LOST' THEN 'CANCELLED' ELSE state END WHERE id=$1`,
        [id, input.interest, input.unit, input.stage, input.next_action],
      );
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.updated',
        `Cadastro atualizado por ${user.name}. Etapa: ${input.stage}.`,
        {
          previous_stage: row.stage,
          next_stage: input.stage,
          changed_fields: [
            'name',
            'email',
            'instagram',
            'interest',
            'unit',
            'stage',
            'next_action',
          ],
        },
      );
      return { id, version: row.version + 1 };
    });
  }
  async schedule(
    user: User,
    id: string,
    input: { starts_at: string; unit: string; expected_version: number },
  ) {
    return this.db.transaction(async (tx) => {
      await lockActor(tx, user);
      const row = (
        await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
      ).rows[0];
      if (!row || (user.role !== 'manager' && row.owner_id !== user.id))
        throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
      if (row.version !== input.expected_version)
        throw new DomainError('VERSION_CONFLICT', 'O lead mudou. Reabra a ficha.');
      if (['LOST', 'WON'].includes(row.stage))
        throw new DomainError('CLOSED', 'A oportunidade está encerrada.');
      if (new Date(input.starts_at) <= (await this.now(tx)))
        throw new DomainError('INVALID_DATE', 'Escolha um horário futuro.', 400);
      if (
        (
          await tx.query(
            "SELECT id FROM appointments WHERE opportunity_id=$1 AND status='scheduled' LIMIT 1",
            [id],
          )
        ).rows.length
      )
        throw new DomainError(
          'OPEN_APPOINTMENT',
          'Já existe uma avaliação agendada. Remarque ou cancele a avaliação atual.',
        );
      const appointmentId = randomUUID();
      await tx.query(
        'INSERT INTO appointments(id,opportunity_id,starts_at,unit,created_by) VALUES ($1,$2,$3,$4,$5)',
        [appointmentId, id, input.starts_at, input.unit, user.id],
      );
      await tx.query(
        `UPDATE opportunities SET stage='EVALUATION_SCHEDULED',version=version+1 WHERE id=$1`,
        [id],
      );
      await this.audit(
        tx,
        id,
        user.id,
        'appointment.created',
        `Avaliação agendada por ${user.name} para ${new Date(input.starts_at).toISOString()}.`,
      );
      return { id: appointmentId };
    });
  }
  async configure(
    user: User,
    input: {
      version: number;
      timeout_minutes: number;
      participants: { id: string; enabled: boolean }[];
    },
  ) {
    requireManager(user);
    return this.db.transaction(async (tx) => {
      const settings = (
        await tx.query<{ version: number }>(
          'SELECT * FROM distribution_settings WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      await lockActor(tx, user);
      if (settings.version !== input.version)
        throw new DomainError('VERSION_CONFLICT', 'A configuração mudou. Atualize a tela.');
      for (const p of input.participants)
        await tx.query(
          `UPDATE users SET queue_enabled=$2,version=version+1 WHERE id=$1 AND role='attendant' AND active`,
          [p.id, p.enabled],
        );
      await tx.query(
        'UPDATE distribution_settings SET timeout_minutes=$1,version=version+1 WHERE id=1',
        [input.timeout_minutes],
      );
      await this.audit(
        tx,
        null,
        user.id,
        'queue.updated',
        `Fila atualizada. Prazo para novas reservas: ${input.timeout_minutes} minutos.`,
      );
      // Reconcile entries that arrived while all attendants were paused.
      const pending = (
        await tx.query<Opportunity>(
          `SELECT * FROM opportunities WHERE state='PENDING' AND NOT needs_review ORDER BY created_at,id FOR UPDATE`,
        )
      ).rows;
      for (const row of pending) {
        const next = (
          await tx.query<User>(`SELECT * FROM users WHERE active AND queue_enabled AND role='attendant'
          ORDER BY CASE WHEN queue_position>(SELECT last_position FROM distribution_settings WHERE id=1) THEN 0 ELSE 1 END,queue_position LIMIT 1`)
        ).rows[0];
        if (!next) break;
        await tx.query(
          `UPDATE opportunities SET state='RESERVED',reserved_to=$2,expires_at=$3,version=version+1 WHERE id=$1`,
          [
            row.id,
            next.id,
            new Date((await this.now(tx)).getTime() + input.timeout_minutes * 60_000),
          ],
        );
        await tx.query('UPDATE distribution_settings SET last_position=$1 WHERE id=1', [
          next.queue_position,
        ]);
        await this.audit(
          tx,
          row.id,
          user.id,
          'reservation.created',
          `Pendência distribuída para ${next.name}.`,
        );
      }
      return { version: settings.version + 1 };
    });
  }
}
