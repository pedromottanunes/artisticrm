import { randomUUID, createHash } from 'node:crypto';
import { CRM } from './crm.js';
import { deleteLeadData, type DeleteLeadInput } from './lead-deletion.js';
import type { Sql } from './db.js';
import { lockActor } from './access.js';
import { hashPassword, verifyPassword } from './auth.js';
import { DomainError, requireManager, type User, type Opportunity } from './types.js';

export interface AppointmentRow {
  id: string;
  opportunity_id: string;
  starts_at: Date | string;
  unit: string;
  status: string;
  version: number;
}
export class Operations extends CRM {
  async deleteLead(actor: User, id: string, input: DeleteLeadInput, key: string) {
    return this.db.transaction(async (tx) => {
      await tx.query('SELECT id FROM distribution_settings WHERE id=1 FOR UPDATE');
      await lockActor(tx, actor, true);
      return this.command(tx, actor, key, { kind: 'lead.delete', id, ...input }, () =>
        deleteLeadData(tx, actor, id, input),
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
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const prior = (
      await tx.query<{ fingerprint: string; response: T }>(
        'SELECT * FROM operation_receipts WHERE actor_id=$1 AND key=$2',
        [user.id, key],
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada com dados diferentes.');
      return prior.response;
    }
    const result = await work();
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
          throw new DomainError('USER_CONFLICT', 'E-mail ou posição de rodízio já utilizados.');
        const id = randomUUID();
        await tx.query(
          `INSERT INTO users(id,name,email,password_hash,role,queue_position,queue_enabled,must_change_password)
          VALUES($1,$2,$3,$4,'attendant',$5,true,true)`,
          [id, input.name, input.email.toLowerCase(), hash, input.queue_position],
        );
        await tx.query('UPDATE distribution_settings SET version=version+1 WHERE id=1');
        await this.audit(
          tx,
          null,
          actor.id,
          'user.created',
          'Atendente criada. Troca de senha exigida no primeiro acesso.',
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
              `SELECT * FROM opportunities WHERE stage NOT IN ('WON','LOST')
            AND (owner_id=$1 OR (state='RESERVED' AND reserved_to=$1)) ORDER BY id FOR UPDATE`,
              [id],
            )
          ).rows;
          const replacement = locked.find((u) => u.id === input.replacement_id);
          if (
            owned.length &&
            (!replacement?.active || replacement.role !== 'attendant' || replacement.id === id)
          )
            throw new DomainError(
              'REPLACEMENT_REQUIRED',
              'Selecione outra atendente ativa para receber os atendimentos e reservas atuais.',
            );
          for (const row of owned) {
            await this.assign(
              tx,
              row,
              replacement!,
              actor,
              `Desativação de conta: ${input.reason}`,
            );
          }
          await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        }
        await tx.query(
          `UPDATE users SET name=$2,active=$3,queue_enabled=CASE WHEN NOT $3 THEN false ELSE queue_enabled END,
          version=version+1,auth_version=auth_version+CASE WHEN active IS DISTINCT FROM $3 THEN 1 ELSE 0 END WHERE id=$1`,
          [id, input.name, input.active],
        );
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
  private async assign(tx: Sql, row: Opportunity, target: User, actor: User, reason: string) {
    // Transfer is an administrative assignment, not an attendant's acceptance.
    await tx.query(
      `UPDATE opportunities SET state='CLAIMED',owner_id=$2,reserved_to=NULL,expires_at=NULL,
      claimed_at=NULL,needs_review=false,version=version+1 WHERE id=$1`,
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
        if (['WON', 'LOST'].includes(row.stage))
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
      status: 'scheduled' | 'completed' | 'cancelled';
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
          if (!initial) throw new DomainError('NOT_FOUND', 'Avaliação não encontrada.', 404);
          // Opportunity first, then appointment, matching schedule/close/transfer lock ordering.
          const row = (
            await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [
              initial.opportunity_id,
            ])
          ).rows[0];
          if (actor.role !== 'manager' && row.owner_id !== actor.id)
            throw new DomainError('NOT_FOUND', 'Avaliação não encontrada.', 404);
          const appointment = (
            await tx.query<AppointmentRow>('SELECT * FROM appointments WHERE id=$1 FOR UPDATE', [
              id,
            ])
          ).rows[0];
          if (appointment.version !== input.expected_version)
            throw new DomainError('VERSION_CONFLICT', 'A avaliação mudou. Atualize a ficha.');
          if (appointment.status !== 'scheduled')
            throw new DomainError(
              'APPOINTMENT_CLOSED',
              'Avaliação concluída ou cancelada não pode ser reescrita. Crie outra avaliação.',
            );
          const now = await this.now(tx);
          if (input.status === 'scheduled' && new Date(input.starts_at) <= now)
            throw new DomainError('INVALID_DATE', 'Escolha um horário futuro.', 400);
          if (input.status === 'completed' && new Date(appointment.starts_at) > now)
            throw new DomainError(
              'INVALID_DATE',
              'Não é possível concluir uma avaliação futura.',
              400,
            );
          const startsAt = input.status === 'scheduled' ? input.starts_at : appointment.starts_at;
          const unit = input.status === 'scheduled' ? input.unit : appointment.unit;
          await tx.query(
            'UPDATE appointments SET starts_at=$2,unit=$3,status=$4,version=version+1 WHERE id=$1',
            [id, startsAt, unit, input.status],
          );
          await tx.query('UPDATE opportunities SET version=version+1 WHERE id=$1', [row.id]);
          await this.audit(
            tx,
            row.id,
            actor.id,
            'appointment.updated',
            `Avaliação ${input.status === 'scheduled' ? 'remarcada' : input.status === 'completed' ? 'concluída' : 'cancelada'}. Motivo: ${input.reason}`,
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
            'UPDATE users SET password_hash=$2,must_change_password=true,auth_version=auth_version+1,version=version+1 WHERE id=$1',
            [id, hash],
          );
          await tx.query('DELETE FROM sessions WHERE user_id=$1', [id]);
          await this.audit(
            tx,
            null,
            actor.id,
            'password.reset',
            'Senha temporária redefinida pela gestão e sessões revogadas.',
            { user_id: id },
          );
          return { ok: true };
        },
      );
    });
  }
}
