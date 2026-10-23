import { assertCommercial } from './lead-quality.js';
import { randomUUID } from 'node:crypto';
import { commandFingerprint, matchesCommandFingerprint } from './command-fingerprint.js';
import { CRM } from './crm.js';
import { deleteLeadData, type DeleteLeadInput } from './lead-deletion.js';
import type { Database, Sql } from './db.js';
import { lockActor } from './access.js';
import { assertSaleFinancialValues, commercialValues } from './commercial-fields.js';
import { transferProspects } from './instagram-prospects.js';
import { hashPassword, verifyPassword } from './auth.js';
import {
  DomainError,
  isValidDateOnly,
  requireManager,
  type SaleInput,
  type User,
  type Opportunity,
} from './types.js';
import { compactQueuePositions } from './weighted-queue.js';
import type { ConversationAccountScope } from './conversation-sharing.js';

export interface AppointmentRow {
  id: string;
  opportunity_id: string;
  starts_at: Date | string;
  unit: string;
  status: string;
  version: number;
}
export interface DeleteAttendantInput {
  expected_version: number;
  confirmation: 'EXCLUIR';
}

function conversationAccountScopeSql(
  accounts: ConversationAccountScope | undefined,
  firstParameter: number,
) {
  if (accounts === undefined)
    return { sql: "ca.provider IN ('instagram','messenger')", values: [] as string[] };
  const values: string[] = [];
  const clauses: string[] = [];
  if (accounts.instagram) {
    values.push(accounts.instagram);
    clauses.push(`(ca.provider='instagram' AND ca.external_account_id=$${firstParameter})`);
  }
  if (accounts.messenger) {
    values.push(accounts.messenger);
    clauses.push(
      `(ca.provider='messenger' AND ca.external_account_id=$${firstParameter + values.length - 1})`,
    );
  }
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE', values };
}

export class Operations extends CRM {
  constructor(
    db: Database,
    clock?: () => Date,
    private readonly conversationAccounts?: ConversationAccountScope,
  ) {
    super(db, clock);
  }

  async shareConversationPortfolio(
    actor: User,
    input: { source_user_id: string; reviewer_user_id: string },
    key: string,
  ) {
    requireManager(actor);
    if (input.source_user_id === input.reviewer_user_id)
      throw new DomainError(
        'INVALID_REVIEWER',
        'Escolha consultores diferentes para origem e acesso.',
        400,
      );
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      const currentActor = await lockActor(tx, actor, true);
      return this.command(
        tx,
        currentActor,
        key,
        { kind: 'conversation-portfolio.share', ...input },
        async () => {
          const users = (
            await tx.query<User>(
              'SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
              [[input.source_user_id, input.reviewer_user_id]],
            )
          ).rows;
          const source = users.find((user) => user.id === input.source_user_id);
          const reviewer = users.find((user) => user.id === input.reviewer_user_id);
          if (!source || source.role !== 'attendant')
            throw new DomainError('INVALID_SOURCE', 'Selecione um consultor de origem.', 400);
          if (!reviewer?.active || reviewer.role !== 'attendant')
            throw new DomainError('INVALID_REVIEWER', 'Selecione um consultor ativo.', 400);
          const existing = (
            await tx.query<{
              id: string;
              reviewer_user_id: string;
              version: number;
            }>(
              `SELECT id,reviewer_user_id,version FROM conversation_portfolio_shares
               WHERE source_user_id=$1 AND revoked_at IS NULL FOR UPDATE`,
              [source.id],
            )
          ).rows[0];
          if (existing?.reviewer_user_id === reviewer.id)
            return { id: existing.id, version: existing.version };
          const now = await this.now(tx);
          if (existing)
            await tx.query(
              `UPDATE conversation_portfolio_shares
               SET revoked_by=$2,revoked_at=$3,version=version+1 WHERE id=$1`,
              [existing.id, currentActor.id, now],
            );
          const id = randomUUID();
          await tx.query(
            `INSERT INTO conversation_portfolio_shares(
               id,source_user_id,reviewer_user_id,granted_by,granted_at,revoked_by,revoked_at,version
             ) VALUES($1,$2,$3,$4,$5,NULL,NULL,1)`,
            [id, source.id, reviewer.id, currentActor.id, now],
          );
          await this.audit(
            tx,
            null,
            currentActor.id,
            'conversation_portfolio.shared',
            `Carteira de conversas de ${source.name} compartilhada com ${reviewer.name}.`,
            {
              source_user_id: source.id,
              reviewer_user_id: reviewer.id,
              previous_reviewer_user_id: existing?.reviewer_user_id ?? null,
            },
          );
          return { id, version: 1 };
        },
      );
    });
  }

  async revokeConversationPortfolio(
    actor: User,
    sourceUserId: string,
    expectedVersion: number,
    key: string,
  ) {
    requireManager(actor);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      const currentActor = await lockActor(tx, actor, true);
      return this.command(
        tx,
        currentActor,
        key,
        { kind: 'conversation-portfolio.revoke', sourceUserId, expectedVersion },
        async () => {
          const share = (
            await tx.query<{
              id: string;
              reviewer_user_id: string;
              version: number;
            }>(
              `SELECT id,reviewer_user_id,version FROM conversation_portfolio_shares
               WHERE source_user_id=$1 AND revoked_at IS NULL FOR UPDATE`,
              [sourceUserId],
            )
          ).rows[0];
          if (!share) throw new DomainError('NOT_FOUND', 'Compartilhamento não encontrado.', 404);
          if (share.version !== expectedVersion)
            throw new DomainError('VERSION_CONFLICT', 'O compartilhamento mudou. Atualize a tela.');
          const now = await this.now(tx);
          await tx.query(
            `UPDATE conversation_portfolio_shares
             SET revoked_by=$2,revoked_at=$3,version=version+1 WHERE id=$1`,
            [share.id, currentActor.id, now],
          );
          await this.audit(
            tx,
            null,
            currentActor.id,
            'conversation_portfolio.revoked',
            'Acesso à carteira de conversas removido pela gestão.',
            { source_user_id: sourceUserId, reviewer_user_id: share.reviewer_user_id },
          );
          return { revoked: true };
        },
      );
    });
  }

  async assumeSharedConversation(actor: User, id: string, expectedVersion: number, key: string) {
    if (actor.role !== 'attendant')
      throw new DomainError('FORBIDDEN', 'Somente consultores podem assumir conversas.', 403);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      const currentActor = await lockActor(tx, actor);
      return this.command(
        tx,
        currentActor,
        key,
        { kind: 'conversation-portfolio.assume', id, expectedVersion },
        async () => {
          const row = (
            await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
          ).rows[0];
          if (!row || row.state === 'CANCELLED' || row.non_commercial_reason)
            throw new DomainError('NOT_FOUND', 'Conversa não disponível para revisão.', 404);
          if (row.version !== expectedVersion)
            throw new DomainError('VERSION_CONFLICT', 'A conversa mudou. Atualize a carteira.');
          if (!row.owner_id || row.owner_id === currentActor.id)
            throw new DomainError('NOT_AVAILABLE', 'Esta conversa não está mais compartilhada.');
          const granted = await tx.query(
            `SELECT id FROM conversation_portfolio_shares
             WHERE source_user_id=$1 AND reviewer_user_id=$2 AND revoked_at IS NULL FOR UPDATE`,
            [row.owner_id, currentActor.id],
          );
          if (!granted.rows.length)
            throw new DomainError('FORBIDDEN', 'O acesso a esta carteira foi removido.', 403);
          const accountScope = conversationAccountScopeSql(this.conversationAccounts, 2);
          const conversation = await tx.query(
            `SELECT cv.id FROM conversations cv
             JOIN channel_accounts ca ON ca.id=cv.channel_account_id
             WHERE cv.opportunity_id=$1 AND ${accountScope.sql}
             LIMIT 1 FOR UPDATE OF cv`,
            [id, ...accountScope.values],
          );
          if (!conversation.rows.length)
            throw new DomainError('NOT_FOUND', 'Esta oportunidade não possui conversa.', 404);
          const previousOwner = row.owner_id;
          await transferProspects(tx, row.id, currentActor.id, await this.now(tx));
          await tx.query(
            `UPDATE opportunities SET state='CLAIMED',owner_id=$2,reserved_to=NULL,expires_at=NULL,
             claimed_at=NULL,claim_mode='portfolio_share',accepted_by=NULL,reservation_origin=NULL,
             needs_review=false,metrics_owner_id=COALESCE(metrics_owner_id,$3),version=version+1
             WHERE id=$1`,
            [row.id, currentActor.id, previousOwner],
          );
          await this.audit(
            tx,
            row.id,
            currentActor.id,
            'opportunity.transferred',
            `Conversa assumida por ${currentActor.name} a partir da carteira compartilhada.`,
            {
              previous_owner: previousOwner,
              new_owner: currentActor.id,
              metrics_owner_id: row.metrics_owner_id ?? previousOwner,
              transfer_mode: 'portfolio_share',
            },
          );
          return { id: row.id, version: row.version + 1 };
        },
      );
    });
  }

  async deleteLead(actor: User, id: string, input: DeleteLeadInput, key: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      const currentActor = await lockActor(tx, actor, true);
      requireManager(currentActor);
      return this.command(tx, currentActor, key, { kind: 'lead.delete', id, ...input }, () =>
        deleteLeadData(tx, currentActor, id, input),
      );
    });
  }
  async command<T>(
    tx: Sql,
    user: User,
    key: string,
    payload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    // Commands always lock the actor exclusively before calling this method.
    const prior = (
      await tx.query<{ fingerprint: string; response: T }>(
        'SELECT * FROM operation_receipts WHERE actor_id=$1 AND key=$2',
        [user.id, key],
      )
    ).rows[0];
    if (prior) {
      if (!(await matchesCommandFingerprint(payload, prior.fingerprint)))
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com dados diferentes.');
      return prior.response;
    }
    const result = await work();
    const fingerprint = await commandFingerprint(payload);
    await tx.query('INSERT INTO operation_receipts VALUES($1,$2,$3,$4,$5)', [
      user.id,
      key,
      fingerprint,
      JSON.stringify(result),
      await this.now(tx),
    ]);
    return result;
  }
  async createAttendant(
    actor: User,
    input: { name: string; email: string; password: string; queue_position: number },
    key: string,
  ) {
    requireManager(actor);
    const hash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'user.create', ...input }, async () => {
        const occupied = await tx.query(
          'SELECT id FROM users WHERE lower(email)=$1 OR queue_position=$2',
          [input.email.toLowerCase(), input.queue_position],
        );
        if (occupied.rows.length)
          throw new DomainError('USER_CONFLICT', 'Login ou posição de rodízio já utilizados.');
        const id = randomUUID();
        await tx.query(
          `INSERT INTO users(id,name,email,password_hash,role,queue_position,queue_enabled,must_change_password)
          VALUES($1,$2,$3,$4,'attendant',$5,true,false)`,
          [id, input.name, input.email.toLowerCase(), hash, input.queue_position],
        );
        await tx.query("UPDATE users SET queue_credit=0 WHERE role='attendant'");
        await tx.query('UPDATE distribution_settings SET version=version+1 WHERE id=1');
        await this.audit(
          tx,
          null,
          actor.id,
          'user.created',
          'Atendente criada com login e senha definidos pela gestão.',
          { user_id: id },
        );
        return { id };
      });
    });
  }
  async updateAttendant(
    actor: User,
    id: string,
    input: {
      expected_version: number;
      name: string;
      active: boolean;
      replacement_id?: string;
      reason: string;
    },
    key: string,
  ) {
    requireManager(actor);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      // Managers cannot be edited by this endpoint. Actor-first then attendants by ID is a fixed order.
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'user.update', id, ...input }, async () => {
        const locked = (
          await tx.query<User>(
            'SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
            [[id, ...(input.replacement_id ? [input.replacement_id] : [])]],
          )
        ).rows;
        const target = locked.find((u) => u.id === id);
        if (!target || target.role !== 'attendant')
          throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
        if (target.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'A conta mudou. Atualize antes de salvar.');
        if (!input.active) {
          const owned = (
            await tx.query<Opportunity>(
              `SELECT * FROM opportunities WHERE state<>'CANCELLED'
            AND (owner_id=$1 OR (state='RESERVED' AND reserved_to=$1)) ORDER BY id FOR UPDATE`,
              [id],
            )
          ).rows;
          const replacement = locked.find((u) => u.id === input.replacement_id);
          if (input.replacement_id) {
            if (!replacement?.active || replacement.role !== 'attendant' || replacement.id === id)
              throw new DomainError(
                'INVALID_REPLACEMENT',
                'Selecione outra atendente ativa para receber os atendimentos e reservas atuais.',
              );
            for (const row of owned)
              await this.assign(
                tx,
                row,
                replacement,
                actor,
                `Desativação de conta: ${input.reason}`,
              );
          } else {
            const sourceOwned = owned.filter((row) => row.owner_id === id);
            if (owned.length) {
              const share = await tx.query(
                `SELECT id FROM conversation_portfolio_shares
                 WHERE source_user_id=$1 AND revoked_at IS NULL FOR UPDATE`,
                [id],
              );
              if (!share.rows.length)
                throw new DomainError(
                  'REPLACEMENT_REQUIRED',
                  'Compartilhe a carteira de conversas antes de desativar esta atendente ou selecione uma substituta para transferir tudo.',
                  409,
                );
            }
            if (sourceOwned.length) {
              const accountScope = conversationAccountScopeSql(this.conversationAccounts, 2);
              const withoutConversation = await tx.query(
                `SELECT o.id FROM opportunities o
                 WHERE o.owner_id=$1 AND o.state<>'CANCELLED'
                    AND NOT EXISTS (
                      SELECT 1 FROM conversations c
                      JOIN channel_accounts ca ON ca.id=c.channel_account_id
                      WHERE c.opportunity_id=o.id AND ${accountScope.sql}
                    )
                 LIMIT 1`,
                [id, ...accountScope.values],
              );
              if (withoutConversation.rows.length)
                throw new DomainError(
                  'TRANSFER_REQUIRED',
                  'Existem leads sem conversa nessa carteira. Transfira esses leads antes de desativar a atendente.',
                  409,
                );
            }
            const reservations = owned.filter(
              (row) => row.state === 'RESERVED' && row.reserved_to === id && row.owner_id !== id,
            );
            for (const row of reservations) {
              await tx.query(
                `UPDATE opportunities SET state='POOL',reserved_to=NULL,expires_at=NULL,
                 reservation_origin=NULL,version=version+1 WHERE id=$1`,
                [row.id],
              );
              await this.audit(
                tx,
                row.id,
                actor.id,
                'reservation.released',
                'Reserva liberada no bolsão durante a desativação da conta.',
                { reserved_to: id },
              );
            }
          }
          await tx.query(
            "UPDATE lead_compensations SET status='revoked' WHERE user_id=$1 AND status='pending'",
            [id],
          );
          await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
          await tx.query(
            `UPDATE conversation_portfolio_shares
             SET revoked_by=$2,revoked_at=clock_timestamp(),version=version+1
             WHERE reviewer_user_id=$1 AND revoked_at IS NULL`,
            [id, actor.id],
          );
        }
        await tx.query(
          `UPDATE users SET name=$2,active=$3,queue_enabled=CASE WHEN NOT $3 THEN false ELSE queue_enabled END,
          queue_credit=CASE WHEN NOT $3 THEN 0 ELSE queue_credit END,
          version=version+1,auth_version=auth_version+CASE WHEN active IS DISTINCT FROM $3 THEN 1 ELSE 0 END WHERE id=$1`,
          [id, input.name, input.active],
        );
        if (target.active !== input.active)
          await tx.query("UPDATE users SET queue_credit=0 WHERE role='attendant'");
        await tx.query('UPDATE distribution_settings SET version=version+1 WHERE id=1');
        await this.audit(
          tx,
          null,
          actor.id,
          'user.updated',
          `Conta de atendimento atualizada. ${input.reason}`,
          { user_id: id, previous_active: target.active, active: input.active },
        );
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
    return this.db.transaction(async (tx) => {
      const settings = (
        await tx.query<{ last_position: number }>(
          'SELECT last_position FROM distribution_settings WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'user.delete', id, ...input }, async () => {
        const target = (await tx.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]))
          .rows[0];
        if (!target || target.role !== 'attendant')
          throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
        if (target.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'A conta mudou. Atualize antes de excluir.');
        if (target.active)
          throw new DomainError(
            'ACTIVE_USER',
            'Desative a atendente antes da exclusão permanente.',
            400,
          );
        const linked = await tx.query(
          `SELECT id FROM opportunities
           WHERE owner_id=$1 OR reserved_to=$1 OR metrics_owner_id=$1 LIMIT 1 FOR UPDATE`,
          [id],
        );
        if (linked.rows.length)
          throw new DomainError(
            'USER_HAS_LEADS',
            'Esta conta possui histórico de leads e métricas. Mantenha-a desativada para preservar os relatórios.',
            409,
          );
        const shared = await tx.query(
          `SELECT id FROM conversation_portfolio_shares
           WHERE source_user_id=$1 OR reviewer_user_id=$1 LIMIT 1 FOR UPDATE`,
          [id],
        );
        if (shared.rows.length)
          throw new DomainError(
            'USER_HAS_PORTFOLIO_HISTORY',
            'Esta conta possui histórico de compartilhamento de carteiras. Mantenha-a desativada.',
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
        await tx.query('UPDATE appointments SET created_by=$2 WHERE created_by=$1', [id, actor.id]);
        await tx.query('UPDATE audit_events SET actor_id=NULL WHERE actor_id=$1', [id]);
        await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        await tx.query('DELETE FROM claims WHERE user_id=$1', [id]);
        await tx.query('DELETE FROM operation_receipts WHERE actor_id=$1', [id]);
        await tx.query(
          "DELETE FROM push_records WHERE kind='subscription' AND data->>'userId'=$1",
          [id],
        );
        await tx.query('DELETE FROM users WHERE id=$1', [id]);
        const remaining = (
          await tx.query<Pick<User, 'id' | 'queue_position'>>(
            "SELECT id,queue_position FROM users WHERE role='attendant' ORDER BY queue_position,id FOR UPDATE",
          )
        ).rows;
        const compacted = compactQueuePositions(remaining, settings.last_position);
        for (const attendant of remaining)
          await tx.query(
            `UPDATE users SET queue_position=$2,queue_credit=0,
            version=version+CASE WHEN queue_position IS DISTINCT FROM $2 THEN 1 ELSE 0 END
            WHERE id=$1`,
            [attendant.id, compacted.positions.get(attendant.id)],
          );
        await tx.query(
          'UPDATE distribution_settings SET last_position=$1,version=version+1 WHERE id=1',
          [compacted.lastPosition],
        );
        return { deleted: true };
      });
    });
  }
  private async assign(tx: Sql, row: Opportunity, target: User, actor: User, reason: string) {
    await transferProspects(tx, row.id, target.id, await this.now(tx));
    // Transfer is an administrative assignment, not an attendant's acceptance.
    await tx.query(
      `UPDATE opportunities SET state='CLAIMED',owner_id=$2,reserved_to=NULL,expires_at=NULL,
      claimed_at=NULL,claim_mode='transfer',accepted_by=NULL,reservation_origin=NULL,needs_review=false,version=version+1 WHERE id=$1`,
      [row.id, target.id],
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
    input: { expected_version: number; target_id: string; reason: string },
    key: string,
  ) {
    requireManager(actor);
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'transfer', id, ...input }, async () => {
        const target = (
          await tx.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [input.target_id])
        ).rows[0];
        if (!target?.active || target.role !== 'attendant')
          throw new DomainError('INVALID_ASSIGNEE', 'Selecione uma atendente ativa.', 400);
        const row = (
          await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
        if (row.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'O lead mudou. Reabra a ficha.');
        if (row.state === 'CANCELLED')
          throw new DomainError(
            'CLOSED',
            'Oportunidade encerrada: crie uma nova entrada para revisão.',
          );
        if (row.owner_id === target.id)
          throw new DomainError('SAME_OWNER', 'A atendente já é responsável por este lead.');
        await this.assign(tx, row, target, actor, input.reason);
        return { id, version: row.version + 1 };
      });
    });
  }
  async changeAppointment(
    actor: User,
    id: string,
    input: {
      expected_version: number;
      status: 'scheduled' | 'attended' | 'no_show' | 'cancelled';
      starts_at: string;
      unit: string;
      reason: string;
    },
    key: string,
  ) {
    return this.db.transaction(async (tx) => {
      await lockActor(tx, actor, true);
      return this.command(
        tx,
        actor,
        key,
        { kind: 'appointment.update', id, ...input },
        async () => {
          const initial = (
            await tx.query<AppointmentRow>('SELECT * FROM appointments WHERE id=$1', [id])
          ).rows[0];
          if (!initial) throw new DomainError('NOT_FOUND', 'Consulta não encontrada.', 404);
          // Opportunity first, then appointment, matching schedule/close/transfer lock ordering.
          const row = (
            await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [
              initial.opportunity_id,
            ])
          ).rows[0];
          if (actor.role !== 'manager' && row.owner_id !== actor.id)
            throw new DomainError('NOT_FOUND', 'Consulta não encontrada.', 404);
          const appointment = (
            await tx.query<AppointmentRow>('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [
              id,
            ])
          ).rows[0];
          if (appointment.version !== input.expected_version)
            throw new DomainError('VERSION_CONFLICT', 'A consulta mudou. Atualize a ficha.');
          if (appointment.status !== 'scheduled')
            throw new DomainError(
              'APPOINTMENT_CLOSED',
              'Consulta concluída ou cancelada não pode ser reescrita. Crie outra consulta.',
            );
          const now = await this.now(tx);
          if (input.status === 'scheduled' && new Date(input.starts_at) <= now)
            throw new DomainError('INVALID_DATE', 'Escolha um horário futuro.', 400);
          if (
            (input.status === 'attended' || input.status === 'no_show') &&
            new Date(appointment.starts_at) > now
          )
            throw new DomainError(
              'INVALID_DATE',
              'Não é possível registrar presença em uma consulta futura.',
              400,
            );
          const startsAt = input.status === 'scheduled' ? input.starts_at : appointment.starts_at;
          const unit = input.status === 'scheduled' ? input.unit : appointment.unit;
          await tx.query(
            'UPDATE appointments SET starts_at=$2,unit=$3,status=$4,version=version+1 WHERE id=$1',
            [id, startsAt, unit, input.status],
          );
          const consultationStatus = {
            scheduled: 'SCHEDULED',
            attended: 'ATTENDED',
            no_show: 'NO_SHOW',
            cancelled: 'CANCELLED',
          }[input.status];
          await tx.query(
            'UPDATE opportunities SET consultation_status=$2,version=version+1 WHERE id=$1',
            [row.id, consultationStatus],
          );
          const actionLabel = {
            scheduled: 'remarcada',
            attended: 'com comparecimento confirmado',
            no_show: 'marcada como não compareceu',
            cancelled: 'cancelada',
          }[input.status];
          await this.audit(
            tx,
            row.id,
            actor.id,
            'appointment.updated',
            `Consulta ${actionLabel}. Motivo: ${input.reason}`,
            {
              appointment_id: id,
              before: {
                starts_at: appointment.starts_at,
                unit: appointment.unit,
                status: appointment.status,
              },
              after: { starts_at: startsAt, unit, status: input.status },
            },
          );
          return { id, version: appointment.version + 1 };
        },
      );
    });
  }
  async recordSale(actor: User, id: string, input: SaleInput, key: string) {
    return this.db.transaction(async (tx) => {
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'sale.record', id, ...input }, async () => {
        const row = (
          await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!row || (actor.role !== 'manager' && row.owner_id !== actor.id))
          throw new DomainError('NOT_FOUND', 'Lead não encontrado neste perfil.', 404);
        assertCommercial(row);
        if (row.version !== input.expected_version)
          throw new DomainError('VERSION_CONFLICT', 'A ficha mudou. Reabra antes de salvar.');
        if (input.procedure_date && !isValidDateOnly(input.procedure_date))
          throw new DomainError(
            'INVALID_PROCEDURE_DATE',
            'Informe uma data de cirurgia válida.',
            400,
          );
        const commercial = commercialValues(row, {
          ...input,
          sale_seller_name: input.sale_seller_name ?? (row.sale_seller_name || actor.name),
        });
        assertSaleFinancialValues(commercial);
        await this.prepareAttendance(tx, id, input.attendance);
        if (
          (
            await tx.query('SELECT id FROM contacts WHERE phone=$1 AND id<>$2 LIMIT 1', [
              input.phone,
              row.contact_id,
            ])
          ).rows.length
        )
          throw new DomainError(
            'PHONE_CONFLICT',
            'Este telefone já pertence a outro contato. Abra a ficha correspondente.',
            409,
          );
        await tx.query(
          `UPDATE contacts SET name=$2,phone=$3,residence_city=$4,
             instagram=COALESCE($5,instagram) WHERE id=$1`,
          [row.contact_id, input.name, input.phone, input.residence_city, input.instagram ?? null],
        );
        const now = await this.now(tx);
        const stage = input.procedure_date ? 'CLOSED_WITH_DATE' : 'CLOSED_WITHOUT_DATE';
        await tx.query(
          `UPDATE opportunities SET
             unit=$2,procedure_date=$3,stage=$4,
             sale_completed_at=COALESCE(sale_completed_at,$5),
             sale_seller_name=$6,
             consultant=$7,total_value_cents=$8,down_payment_cents=$9,
             hair_grade_classification=$10,has_pack=$11,contract_status=$12,
             next_action=COALESCE($13,next_action),
             consultation_status=COALESCE($14::text,consultation_status),pack_quantity=$15,
             total_value_text=$16,down_payment_text=$17,version=version+1
           WHERE id=$1`,
          [
            id,
            input.unit,
            input.procedure_date,
            stage,
            now,
            commercial.sale_seller_name,
            commercial.consultant,
            commercial.total_value_cents,
            commercial.down_payment_cents,
            commercial.hair_grade_classification,
            commercial.has_pack,
            commercial.contract_status,
            input.next_action ?? null,
            input.attendance ?? null,
            commercial.pack_quantity,
            commercial.total_value_text,
            commercial.down_payment_text,
          ],
        );
        await this.audit(
          tx,
          id,
          actor.id,
          row.sale_completed_at ? 'sale.updated' : 'sale.completed',
          row.sale_completed_at
            ? `Dados da venda atualizados por ${actor.name}.`
            : `Venda concluída por ${actor.name}.`,
          {
            beneficiary_id: row.owner_id,
            seller: commercial.sale_seller_name,
            consultant: commercial.consultant,
            total_value_cents: commercial.total_value_cents,
            down_payment_cents: commercial.down_payment_cents,
            total_value_text: commercial.total_value_text,
            down_payment_text: commercial.down_payment_text,
            contract_status: commercial.contract_status,
            attendance: input.attendance ?? row.consultation_status,
          },
        );
        return { id, version: row.version + 1 };
      });
    });
  }
  async changePassword(user: User, currentPassword: string, newPassword: string) {
    if (currentPassword === newPassword)
      throw new DomainError('SAME_PASSWORD', 'A nova senha precisa ser diferente.', 400);
    const hash = await hashPassword(newPassword);
    return this.db.transaction(async (tx) => {
      const target = (
        await tx.query<User & { password_hash: string }>(
          'SELECT * FROM users WHERE id=$1 FOR UPDATE',
          [user.id],
        )
      ).rows[0];
      if (!target?.active || target.auth_version !== user.auth_version)
        throw new DomainError('UNAUTHENTICATED', 'Sessão revogada.', 401);
      if (!(await verifyPassword(currentPassword, target.password_hash)))
        throw new DomainError('INVALID_CREDENTIALS', 'Senha atual incorreta.', 400);
      await tx.query(
        'UPDATE users SET password_hash=$2,must_change_password=false,auth_version=auth_version+1,version=version+1 WHERE id=$1',
        [user.id, hash],
      );
      await tx.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
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
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      await lockActor(tx, actor, true);
      return this.command(
        tx,
        actor,
        key,
        { kind: 'password.reset', id, password, version },
        async () => {
          const target = (await tx.query<User>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]))
            .rows[0];
          if (!target || target.role !== 'attendant')
            throw new DomainError('NOT_FOUND', 'Atendente não encontrada.', 404);
          if (target.version !== version)
            throw new DomainError(
              'VERSION_CONFLICT',
              'A conta mudou. Atualize antes de redefinir.',
            );
          await tx.query(
            'UPDATE users SET password_hash=$2,must_change_password=false,auth_version=auth_version+1,version=version+1 WHERE id=$1',
            [id, hash],
          );
          await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
          await this.audit(
            tx,
            null,
            actor.id,
            'password.reset',
            'Senha redefinida pela gestão e sessões revogadas.',
            { user_id: id },
          );
          return { ok: true };
        },
      );
    });
  }
}
