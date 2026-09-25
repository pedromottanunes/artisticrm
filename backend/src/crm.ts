import { randomUUID, createHash } from 'node:crypto';
import type { Database, Sql } from './db.js';
import {
  closedStages,
  DomainError,
  isClosedStage,
  isValidDateOnly,
  requireManager,
  stageLabels,
  type Opportunity,
  type Stage,
  type User,
} from './types.js';
import { lockActor } from './access.js';
import { enqueuePushEvent } from './push-store.js';
import { wasDeleted } from './lead-deletion.js';
import {
  selectWeightedParticipant,
  type WeightedQueueParticipant,
  type WeightedQueueSelection,
} from './weighted-queue.js';

const selectOpportunity = `SELECT o.*, c.name, c.phone, c.email, c.residence_city, c.is_demo,
  COALESCE(NULLIF(c.instagram,''),(
    SELECT ci.username FROM contact_identities ci
    WHERE ci.contact_id=c.id AND ci.provider='instagram'
    ORDER BY ci.profile_updated_at DESC NULLS LAST LIMIT 1
  ),'') AS instagram,
  COALESCE((
    SELECT ci.profile_picture_url FROM contact_identities ci
    WHERE ci.contact_id=c.id AND ci.provider='instagram'
    ORDER BY ci.profile_updated_at DESC NULLS LAST LIMIT 1
  ),'') AS profile_picture_url
  FROM opportunities o JOIN contacts c ON c.id = o.contact_id`;
const closedStageSql = closedStages.map((stage) => `'${stage}'`).join(',');
export interface LeadInput {
  name: string;
  phone?: string;
  interest: string;
  unit: string;
  source: string;
  source_evidence?: string;
  meta_attribution?: MetaAttributionInput;
  identity?: ChannelIdentityInput;
  is_demo?: boolean;
}

export interface ChannelIdentityInput {
  provider: 'whatsapp' | 'instagram';
  account_id: string;
  external_user_id: string;
  username?: string;
  display_name?: string;
}

export interface MetaAttributionInput {
  provider: 'meta';
  channel: 'whatsapp' | 'instagram';
  source_type: 'ad';
  source_id?: string;
  source_url?: string;
  ctwa_clid?: string;
  headline?: string;
  body?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
}

type QueueUser = User & WeightedQueueParticipant;

async function recordMetaAttribution(
  tx: Sql,
  opportunityId: string,
  externalId: string,
  attribution: MetaAttributionInput | undefined,
  receivedAt: Date,
) {
  if (!attribution) return;
  await tx.query(
    `INSERT INTO lead_attributions(
      id,opportunity_id,external_id,provider,channel,source_type,source_id,source_url,
      ctwa_clid,headline,body,media_type,image_url,video_url,thumbnail_url,received_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (external_id) DO NOTHING`,
    [
      randomUUID(),
      opportunityId,
      externalId,
      attribution.provider,
      attribution.channel,
      attribution.source_type,
      attribution.source_id ?? null,
      attribution.source_url ?? null,
      attribution.ctwa_clid ?? null,
      attribution.headline ?? null,
      attribution.body ?? null,
      attribution.media_type ?? null,
      attribution.image_url ?? null,
      attribution.video_url ?? null,
      attribution.thumbnail_url ?? null,
      receivedAt,
    ],
  );
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
    const eventId = randomUUID();
    const at = await this.now(tx);
    await tx.query('INSERT INTO audit_events VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      eventId,
      id,
      actor,
      kind,
      description,
      at,
      JSON.stringify(details),
    ]);
    await enqueuePushEvent(tx, eventId, id, kind, at);
  }
  private async next(
    tx: Sql,
    lastPosition: number,
  ): Promise<WeightedQueueSelection<QueueUser> | undefined> {
    const users = (
      await tx.query<QueueUser>(
        `SELECT * FROM users
        WHERE role='attendant' AND active AND queue_enabled
        ORDER BY id FOR UPDATE`,
      )
    ).rows;
    const selection = selectWeightedParticipant(users, lastPosition);
    if (!selection) return;
    for (const [id, credit] of selection.credits)
      await tx.query('UPDATE users SET queue_credit=$2 WHERE id=$1', [id, credit]);
    return selection;
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
          meta_attribution: input.meta_attribution,
          identity: input.identity,
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
      if (await wasDeleted(tx, externalId))
        throw new DomainError(
          'EVENT_DELETED',
          'Esta entrada pertence a um lead excluído permanentemente.',
          410,
        );
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
      let contact = input.identity
        ? (
            await tx.query<{ id: string }>(
              `SELECT c.id FROM contact_identities i
               JOIN contacts c ON c.id=i.contact_id
               WHERE i.provider=$1 AND i.channel_account_id=$2 AND i.external_user_id=$3`,
              [input.identity.provider, input.identity.account_id, input.identity.external_user_id],
            )
          ).rows[0]
        : undefined;
      if (!contact && input.phone)
        contact = (
          await tx.query<{ id: string }>('SELECT id FROM contacts WHERE phone=$1', [input.phone])
        ).rows[0];
      if (!contact) {
        contact = { id: randomUUID() };
        await tx.query('INSERT INTO contacts(id,name,phone,is_demo) VALUES ($1,$2,$3,$4)', [
          contact.id,
          input.name,
          input.phone ?? null,
          input.is_demo ?? false,
        ]);
      }
      if (input.identity)
        await tx.query(
          `INSERT INTO contact_identities(
            id,contact_id,provider,channel_account_id,external_user_id,username,display_name,last_seen_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (provider,channel_account_id,external_user_id) DO UPDATE SET
            username=CASE WHEN EXCLUDED.username='' THEN contact_identities.username ELSE EXCLUDED.username END,
            display_name=CASE WHEN EXCLUDED.display_name='' THEN contact_identities.display_name ELSE EXCLUDED.display_name END,
            last_seen_at=EXCLUDED.last_seen_at`,
          [
            randomUUID(),
            contact.id,
            input.identity.provider,
            input.identity.account_id,
            input.identity.external_user_id,
            input.identity.username ?? '',
            input.identity.display_name ?? '',
            now,
          ],
        );
      const existing = (
        await tx.query<{ id: string }>(
          `SELECT id FROM opportunities WHERE contact_id=$1 AND stage NOT IN (${closedStageSql}) FOR UPDATE`,
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
        await recordMetaAttribution(tx, existing.id, externalId, input.meta_attribution, now);
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
      const selection = returning ? undefined : await this.next(tx, settings.last_position);
      const attendant = selection?.selected;
      const id = randomUUID();
      const expires = attendant
        ? new Date(now.getTime() + settings.timeout_minutes * 60_000)
        : null;
      await tx.query(
        `INSERT INTO opportunities(id,contact_id,interest,unit,source,source_evidence,channel,state,reserved_to,created_at,expires_at,last_message_at,stage,consultation_status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,'NEW_LEAD','UNDEFINED')`,
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
          input.identity?.provider ?? 'manual',
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
      await recordMetaAttribution(tx, id, externalId, input.meta_attribution, now);
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
        attendant
          ? {
              reserved_to: attendant.id,
              queue_weight: attendant.queue_weight,
              total_active_weight: selection!.totalWeight,
            }
          : {},
      );
      return { id, duplicate: false };
    });
  }
  async expire() {
    return this.db.transaction(async (tx) => {
      const rows = (
        await tx.query<{ id: string; reserved_to: string | null }>(
          `UPDATE opportunities SET state='POOL', version=version+1
        WHERE state='RESERVED' AND expires_at <= $1 RETURNING id,reserved_to`,
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
          { reserved_to: row.reserved_to },
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
          { reserved_to: row.reserved_to },
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
    if (
      user.role === 'manager' ||
      row.owner_id === user.id ||
      (row.state === 'POOL' && user.role === 'attendant' && user.active)
    )
      return row;
    if (row.channel === 'instagram' && row.reserved_to === user.id) {
      const { phone: _phone, email: _email, ...summary } = row;
      return { ...summary, next_action: '' };
    }
    const {
      phone: _phone,
      email: _email,
      instagram: _instagram,
      profile_picture_url: _profilePicture,
      ...summary
    } = row;
    return {
      ...summary,
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
        'SELECT id,name,email,role,active,queue_enabled,queue_position,queue_weight,color,version,auth_version,must_change_password FROM users ORDER BY queue_position NULLS FIRST',
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
    const attributions = canEdit
      ? (
          await this.db.query(
            `SELECT id,provider,channel,source_type,source_id,source_url,headline,body,
              media_type,image_url,video_url,thumbnail_url,received_at
             FROM lead_attributions WHERE opportunity_id=$1 ORDER BY received_at DESC,id DESC`,
            [id],
          )
        ).rows
      : [];
    return { ...this.sanitize(row, user), history, appointments, attributions, can_edit: canEdit };
  }
  async update(
    user: User,
    id: string,
    input: {
      version: number;
      name: string;
      phone?: string | null;
      email?: string;
      residence_city?: string;
      instagram: string;
      interest: string;
      unit: string;
      stage: Stage;
      procedure_date: string | null;
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
      if (input.stage === 'CLOSED_WITH_DATE' && !isValidDateOnly(input.procedure_date))
        throw new DomainError(
          'PROCEDURE_DATE_REQUIRED',
          'Informe a data do procedimento para concluir como fechado com data.',
          400,
        );
      if (
        input.stage === 'DECLINED' &&
        (
          await tx.query(
            "SELECT id FROM appointments WHERE opportunity_id=$1 AND status='scheduled' LIMIT 1",
            [id],
          )
        ).rows.length
      )
        throw new DomainError(
          'OPEN_APPOINTMENTS',
          'Conclua ou cancele as consultas antes de declinar o lead.',
        );
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
      const contact = (
        await tx.query<{ phone: string | null; email: string; residence_city: string }>(
          'SELECT phone,email,residence_city FROM contacts WHERE id=$1 FOR UPDATE',
          [row.contact_id],
        )
      ).rows[0];
      const phone = input.phone === undefined ? contact.phone : input.phone;
      if (
        phone &&
        (
          await tx.query('SELECT id FROM contacts WHERE phone=$1 AND id<>$2 LIMIT 1', [
            phone,
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
        'UPDATE contacts SET name=$2,phone=$3,email=$4,instagram=$5,residence_city=$6 WHERE id=$1',
        [
          row.contact_id,
          input.name,
          phone,
          input.email ?? contact.email,
          input.instagram,
          input.residence_city ?? contact.residence_city,
        ],
      );
      await tx.query(
        `UPDATE opportunities SET interest=$2,unit=$3,stage=$4,next_action=$5,procedure_date=$6,
        consultation_status=CASE
          WHEN $4='CONSULTATION_NOT_SCHEDULED' THEN 'NOT_SCHEDULED'
          WHEN $4='NEW_LEAD' THEN 'UNDEFINED'
          ELSE consultation_status
        END,
        version=version+1,
        state=CASE WHEN $4 IN (${closedStageSql}) THEN 'CANCELLED' ELSE state END,
        reserved_to=CASE WHEN $4 IN (${closedStageSql}) THEN NULL ELSE reserved_to END,
        expires_at=CASE WHEN $4 IN (${closedStageSql}) THEN NULL ELSE expires_at END
        WHERE id=$1`,
        [
          id,
          input.interest,
          input.unit,
          input.stage,
          input.next_action,
          input.stage === 'CLOSED_WITH_DATE' ? input.procedure_date : null,
        ],
      );
      const previousLabel = stageLabels[row.stage];
      const nextLabel = stageLabels[input.stage];
      await this.audit(
        tx,
        id,
        user.id,
        'opportunity.updated',
        row.stage === input.stage
          ? `Cadastro atualizado por ${user.name}.`
          : `Qualificação alterada por ${user.name}: ${previousLabel} → ${nextLabel}.`,
        {
          previous_stage: row.stage,
          next_stage: input.stage,
          changed_fields: [
            'name',
            'phone',
            'email',
            'residence_city',
            'instagram',
            'interest',
            'unit',
            'stage',
            'procedure_date',
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
      if (isClosedStage(row.stage))
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
          'Já existe uma consulta agendada. Remarque ou cancele a consulta atual.',
        );
      const appointmentId = randomUUID();
      await tx.query(
        'INSERT INTO appointments(id,opportunity_id,starts_at,unit,created_by) VALUES ($1,$2,$3,$4,$5)',
        [appointmentId, id, input.starts_at, input.unit, user.id],
      );
      await tx.query(
        `UPDATE opportunities SET stage='FOLLOW_UP',consultation_status='SCHEDULED',version=version+1 WHERE id=$1`,
        [id],
      );
      await this.audit(
        tx,
        id,
        user.id,
        'appointment.created',
        `Consulta agendada por ${user.name} para ${new Date(input.starts_at).toISOString()}.${
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
  async configure(
    user: User,
    input: {
      version: number;
      timeout_minutes: number;
      participants: { id: string; enabled: boolean; weight?: number }[];
    },
  ) {
    requireManager(user);
    return this.db.transaction(async (tx) => {
      const settings = (
        await tx.query<{ version: number; last_position: number; timeout_minutes: number }>(
          'SELECT * FROM distribution_settings WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      await lockActor(tx, user);
      if (settings.version !== input.version)
        throw new DomainError('VERSION_CONFLICT', 'A configuração mudou. Atualize a tela.');
      if (
        new Set(input.participants.map((participant) => participant.id)).size !==
        input.participants.length
      )
        throw new DomainError('INVALID_INPUT', 'Atendente repetida na configuração.', 400);
      const attendants = (
        await tx.query<QueueUser>(
          "SELECT * FROM users WHERE role='attendant' ORDER BY id FOR UPDATE",
        )
      ).rows;
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
      if (queueChanged) await tx.query("UPDATE users SET queue_credit=0 WHERE role='attendant'");
      for (const participant of configured)
        await tx.query(
          `UPDATE users SET queue_enabled=$2,queue_weight=$3,
          version=version+CASE WHEN queue_enabled IS DISTINCT FROM $2 OR queue_weight IS DISTINCT FROM $3 THEN 1 ELSE 0 END
          WHERE id=$1 AND role='attendant'`,
          [participant.target.id, participant.enabled, participant.weight],
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
      // Reconcile entries that arrived while all attendants were paused.
      const pending = (
        await tx.query<Opportunity>(
          `SELECT * FROM opportunities WHERE state='PENDING' AND NOT needs_review ORDER BY created_at,id FOR UPDATE`,
        )
      ).rows;
      let last = settings.last_position;
      for (const row of pending) {
        const selection = await this.next(tx, last);
        if (!selection) break;
        const next = selection.selected;
        await tx.query(
          `UPDATE opportunities SET state='RESERVED',reserved_to=$2,expires_at=$3,version=version+1 WHERE id=$1`,
          [
            row.id,
            next.id,
            new Date((await this.now(tx)).getTime() + input.timeout_minutes * 60_000),
          ],
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
      await tx.query(
        `UPDATE distribution_settings
        SET timeout_minutes=$1,last_position=$2,version=version+1 WHERE id=1`,
        [input.timeout_minutes, last],
      );
      return { version: settings.version + 1 };
    });
  }
}
