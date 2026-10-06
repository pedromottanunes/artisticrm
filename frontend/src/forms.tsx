import { useEffect, useState, useRef, useId, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  CalendarDays,
  Save,
  MessageCircle,
  Clock3,
  ShieldCheck,
  Trash2,
  CircleUserRound,
  Copy,
} from 'lucide-react';
import {
  api,
  ApiError,
  consultationStatusLabels,
  contractStatusLabels,
  isClosedStage,
  stages,
  type Detail,
  type Snapshot,
  type User,
} from './api';
import { Transfer, AppointmentEditor } from './operations';
import { Modal, Source, Badge, dateLabel } from './components';
import { InstagramProspectForm } from './instagram-prospects';
import { LeadMarketing } from './lead-marketing';
import { LeadMobileHeader } from './lead-mobile-header';

export function LeadForm(props: {
  isManager: boolean;
  users: User[];
  onClose: () => void;
  onCreated: (result: { id: string; duplicate: boolean }) => Promise<void>;
  onOpenLead: (id: string) => void;
}) {
  const [prospects, setProspects] = useState(!props.isManager);
  return prospects ? (
    <InstagramProspectForm {...props} onManual={() => setProspects(false)} />
  ) : (
    <ManualLeadForm
      isManager={props.isManager}
      onClose={props.onClose}
      onCreated={props.onCreated}
      onProspects={() => setProspects(true)}
    />
  );
}

function ManualLeadForm({
  isManager,
  onClose,
  onCreated,
  onProspects,
}: {
  isManager: boolean;
  onClose: () => void;
  onCreated: (result: { id: string; duplicate: boolean }) => Promise<void>;
  onProspects: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const pending = useRef(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const result = await api<{ id: string; duplicate: boolean }>('/opportunities', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify(values),
      });
      await onCreated(result);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo lead"
      titleAccessory={
        <button className="button outline compact" disabled={busy} onClick={onProspects}>
          Reservas Instagram
        </button>
      }
      description={
        isManager
          ? 'Novo contato entra no rodízio. Retornos após encerramento aguardam revisão da gestão.'
          : 'O novo lead ficará vinculado a você, sem passar pelo rodízio.'
      }
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="modal-body form-grid">
          <label className="full">
            Nome do contato
            <input
              name="name"
              required
              minLength={2}
              maxLength={160}
              placeholder="Como podemos chamar essa pessoa?"
              autoFocus
            />
          </label>
          <label className="full">
            WhatsApp com país e DDD
            <input
              name="phone"
              type="tel"
              required
              placeholder="+55 (48) 99999-9999"
              maxLength={24}
            />
            <small>
              O telefone identifica o contato. Repetições preservam o atendimento aberto.
            </small>
          </label>
          <label>
            Unidade
            <input name="unit" defaultValue="A definir" maxLength={160} />
          </label>
          <label className="full">
            Origem informada
            <select name="source" defaultValue={isManager ? 'Cadastro manual' : 'Indicação'}>
              <option>Cadastro manual</option>
              <option>Não identificada</option>
              <option>Google Ads</option>
              <option>Meta Ads</option>
              <option>Indicação</option>
            </select>
            <small>Esta informação não comprova vínculo com uma campanha.</small>
          </label>
          <div className="inline-info full">
            <ShieldCheck size={18} />
            <span>Nenhuma mensagem será enviada automaticamente.</span>
          </div>
          {error && (
            <p className="form-error full" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="button outline" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="button gold" disabled={busy}>
            {busy ? 'Salvando…' : isManager ? 'Cadastrar e distribuir' : 'Cadastrar lead'}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function LeadDetail({
  initialTab = 'cadastro',
  detail,
  connected,
  isManager,
  onClose,
  onSaved,
  onDeleted,
  onClaim,
  onWhatsApp,
  busy,
  users,
}: {
  detail: Detail;
  initialTab?: string;
  connected: boolean;
  isManager: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDeleted: () => Promise<void>;
  onClaim: () => void;
  onWhatsApp: () => void;
  busy: boolean;
  users: User[];
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(initialTab);
  const [selectedStage, setSelectedStage] = useState(detail.stage);
  const [selectedAttendance, setSelectedAttendance] = useState(
    detail.consultation_status === 'ATTENDED' || detail.consultation_status === 'NO_SHOW'
      ? detail.consultation_status
      : '',
  );
  const [confirmation, setConfirmation] = useState('');
  const [copied, setCopied] = useState(false);
  const instagramUsername = detail.instagram?.replace(/^@+/, '').trim();
  const scheduledAppointment = detail.appointments.find(
    (appointment) => appointment.status === 'scheduled',
  );
  const attendanceAppointment = scheduledAppointment
    ? undefined
    : [...detail.appointments]
        .filter(
          (appointment) => appointment.status === 'attended' || appointment.status === 'no_show',
        )
        .sort(
          (left, right) => new Date(right.starts_at).getTime() - new Date(left.starts_at).getTime(),
        )[0];
  const attendancePending = Boolean(
    scheduledAppointment && new Date(scheduledAppointment.starts_at).getTime() > Date.now(),
  );
  const deleteCommand = useRef<{ key: string; version: number } | null>(null);
  const saleCommand = useRef<{ key: string; payload: string } | null>(null);
  const deleting = useRef(false);
  useEffect(() => {
    setSelectedStage(detail.stage);
    setSelectedAttendance(
      detail.consultation_status === 'ATTENDED' || detail.consultation_status === 'NO_SHOW'
        ? detail.consultation_status
        : '',
    );
    setCopied(false);
  }, [detail.consultation_status, detail.id, detail.stage]);
  const remove = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!isManager || deleting.current || saving || !connected || confirmation !== 'EXCLUIR')
      return;
    deleting.current = true;
    setSaving(true);
    setError('');
    deleteCommand.current ??= { key: crypto.randomUUID(), version: detail.version };
    try {
      await api(`/opportunities/${detail.id}`, {
        method: 'DELETE',
        headers: { 'Idempotency-Key': deleteCommand.current.key },
        body: JSON.stringify({ expected_version: deleteCommand.current.version, confirmation }),
      });
      await onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      deleting.current = false;
      setSaving(false);
    }
  };
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const phone = normalizeLeadPhone(String(fields.phone ?? ''));
      if (phone === null)
        throw new Error('Informe um telefone com DDD. Para outro país, use + e o código do país.');
      await api(`/opportunities/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: fields.name,
          phone,
          residence_city: fields.residence_city,
          instagram: detail.instagram ?? '',
          interest: fields.interest,
          unit: fields.unit,
          stage: fields.stage,
          next_action: fields.next_action,
          attendance: fields.attendance || undefined,
          procedure_date:
            selectedStage === 'CLOSED_WITH_DATE' ? String(fields.procedure_date) : null,
          version: detail.version,
        }),
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const recordSale = async () => {
    const formElement = formRef.current;
    if (!formElement || saving || !connected || !formElement.reportValidity()) return;
    setSaving(true);
    setError('');
    const form = new FormData(formElement);
    try {
      const phone = normalizeLeadPhone(String(form.get('phone') ?? ''));
      if (!phone)
        throw new Error('Informe um telefone com DDD. Para outro país, use + e o código do país.');
      const payload = JSON.stringify({
        expected_version: detail.version,
        name: form.get('name'),
        phone,
        residence_city: form.get('residence_city'),
        instagram: detail.instagram ?? '',
        next_action: form.get('next_action'),
        attendance: form.get('attendance') || undefined,
        consultant: form.get('consultant'),
        total_value_cents: currencyToCents(String(form.get('total_value'))),
        down_payment_cents: currencyToCents(String(form.get('down_payment'))),
        hair_grade_classification: form.get('hair_grade_classification'),
        has_pack: form.get('has_pack') === 'true',
        unit: form.get('unit'),
        procedure_date: form.get('procedure_date') || null,
        contract_status: form.get('contract_status'),
      });
      if (saleCommand.current && saleCommand.current.payload !== payload)
        throw new Error('Reenvie os mesmos dados antes de alterar uma venda sem confirmação.');
      saleCommand.current ??= { key: crypto.randomUUID(), payload };
      await api(`/opportunities/${detail.id}/sale`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': saleCommand.current.key },
        body: payload,
      });
      saleCommand.current = null;
      await onSaved();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status < 500) saleCommand.current = null;
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const copySale = async () => {
    try {
      await navigator.clipboard.writeText(saleText(detail));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError(
        'Não foi possível copiar. Autorize o acesso à área de transferência e tente novamente.',
      );
    }
  };
  const schedule = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const fields = new FormData(e.currentTarget);
    try {
      await api(`/opportunities/${detail.id}/appointments`, {
        method: 'POST',
        body: JSON.stringify({
          starts_at: new Date(fields.get('starts_at') as string).toISOString(),
          unit: fields.get('unit'),
          expected_version: detail.version,
        }),
      });
      setTab('historico');
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={detail.name}
      titleAccessory={
        instagramUsername ? (
          <a
            className="lead-instagram-link"
            href={`https://www.instagram.com/${encodeURIComponent(instagramUsername)}/`}
            target="_blank"
            rel="noreferrer"
          >
            @{instagramUsername}
            <ArrowRight size={13} />
          </a>
        ) : undefined
      }
      leading={
        detail.channel === 'instagram' ? (
          <span className="lead-profile-avatar" aria-hidden="true">
            <CircleUserRound size={24} />
            {detail.profile_picture_url && (
              <img
                src={detail.profile_picture_url}
                alt=""
                referrerPolicy="no-referrer"
                onError={(event) => event.currentTarget.remove()}
              />
            )}
          </span>
        ) : undefined
      }
      onClose={() => {
        if (!deleting.current) onClose();
      }}
      wide
      className={`lead-detail-modal${tab === 'cadastro' ? ' is-registration' : ''}`}
      mobileHeading={
        <LeadMobileHeader
          name={detail.name}
          formId={formId}
          editable={tab === 'cadastro' && detail.can_edit}
          canConverse={!isManager && detail.state === 'CLAIMED'}
          connected={connected}
          saving={saving || deleting.current}
          hasSale={Boolean(detail.sale_completed_at)}
          copied={copied}
          onClose={() => {
            if (!deleting.current) onClose();
          }}
          onConversation={onWhatsApp}
          onCopy={() => void copySale()}
          onSale={() => void recordSale()}
        />
      }
    >
      <div className="detail-summary">
        <Badge state={detail.state} />
        {detail.consultation_status !== 'UNDEFINED' && (
          <span className={`consultation-badge is-${detail.consultation_status.toLowerCase()}`}>
            {consultationStatusLabels[detail.consultation_status]}
          </span>
        )}
        <Source value={detail.source} />
        {detail.is_demo && <span className="demo-tag">CONTATO FICTÍCIO</span>}
      </div>
      <div className="detail-tabs">
        {[
          { id: 'cadastro', label: 'Cadastro comercial', step: 1 },
          ...(detail.can_edit && !isClosedStage(detail.stage)
            ? [{ id: 'agendar', label: 'Agendar consulta', step: 2 }]
            : []),
          ...(detail.can_edit
            ? [
                { id: 'avaliacoes', label: 'Consultas', step: 3 },
                { id: 'historico', label: 'Histórico', step: 4 },
              ]
            : []),
          ...(isManager ? [{ id: 'transferir', label: 'Atribuir / transferir', step: null }] : []),
          ...(isManager && detail.can_edit
            ? [{ id: 'excluir', label: 'Excluir lead', step: null }]
            : []),
        ].map((item) => (
          <button
            className={`${tab === item.id ? 'active' : ''}${item.id === 'excluir' ? ' destructive' : ''}`}
            aria-label={item.label}
            disabled={saving}
            onClick={() => {
              setTab(item.id);
              setConfirmation('');
              setError('');
            }}
            key={item.id}
          >
            {item.step && <span className="tab-step">{item.step}</span>}
            <span className="lead-desktop-tab-label">{item.label}</span>
            <span className="lead-mobile-tab-label">
              {item.id === 'cadastro' ? 'Cadastro' : item.id === 'agendar' ? 'Agenda' : item.label}
            </span>
          </button>
        ))}
      </div>
      {tab === 'excluir' && isManager && detail.can_edit && (
        <form onSubmit={remove}>
          <div className="modal-body form-grid">
            <div className="delete-warning full" id="delete-warning">
              <h3>Excluir permanentemente {detail.name}?</h3>
              <p>
                Sem lixeira e sem opção de desfazer. O lead, seu histórico e todos os seus
                agendamentos serão apagados do CRM.
              </p>
              <p>
                Se houver outro atendimento do mesmo contato, ele será preservado. Esta ação não
                apaga conversas no WhatsApp.
              </p>
              <p>Para apenas encerrar o atendimento e manter o histórico, não use a exclusão.</p>
            </div>
            <label className="full">
              Digite EXCLUIR para confirmar
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="delete-warning"
                disabled={saving || !connected}
                required
                pattern="EXCLUIR"
              />
            </label>
            {error && (
              <p className="form-error full" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button
              type="button"
              className="button outline"
              disabled={saving}
              onClick={() => {
                setTab('cadastro');
                setConfirmation('');
                setError('');
              }}
            >
              Cancelar
            </button>
            <button
              className="button danger"
              disabled={saving || !connected || confirmation !== 'EXCLUIR'}
            >
              <Trash2 size={16} />
              {saving ? 'Excluindo…' : 'Excluir permanentemente'}
            </button>
          </div>
        </form>
      )}
      {tab === 'cadastro' && (
        <form id={formId} ref={formRef} onSubmit={save} key={detail.id + ':' + detail.version}>
          <div className="lead-form-scroll">
            <fieldset className="modal-body commercial-form" disabled={!detail.can_edit || saving}>
              <section className="commercial-panel commercial-lead-data">
                <div className="commercial-section-heading">
                  <div>
                    <span>DADOS DO LEAD</span>
                    <h3>Cadastro e atendimento</h3>
                  </div>
                </div>
                <div className="commercial-fields">
                  <label>
                    Nome
                    <input
                      name="name"
                      defaultValue={detail.name}
                      required
                      minLength={2}
                      maxLength={160}
                    />
                  </label>
                  <LeadPhoneField
                    initialPhone={detail.phone ?? ''}
                    canOpen={!isManager && detail.state === 'CLAIMED' && detail.can_edit && !saving}
                    isDemo={detail.is_demo}
                  />
                  <label>
                    Cidade de residência
                    <input
                      name="residence_city"
                      defaultValue={detail.residence_city ?? ''}
                      minLength={2}
                      maxLength={160}
                      placeholder="Ex.: Criciúma"
                      required
                    />
                  </label>
                  <label>
                    Cidade onde opera / unidade
                    <input
                      name="unit"
                      defaultValue={detail.unit}
                      minLength={2}
                      maxLength={160}
                      required
                    />
                  </label>
                  <label>
                    Qualificação
                    <select
                      name="stage"
                      value={selectedStage}
                      onChange={(event) => setSelectedStage(event.target.value)}
                    >
                      {Object.entries(stages).map(([key, label]) => (
                        <option
                          disabled={
                            (detail.stage === 'DECLINED' && key !== 'DECLINED') ||
                            (isClosedStage(detail.stage) && !isClosedStage(key))
                          }
                          key={key}
                          value={key}
                        >
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Compareceu?
                    <select
                      name="attendance"
                      value={selectedAttendance}
                      disabled={Boolean(attendanceAppointment) || attendancePending}
                      onChange={(event) => {
                        const attendance = event.target.value;
                        setSelectedAttendance(attendance);
                        if (
                          attendance &&
                          (selectedStage === 'NEW_LEAD' ||
                            selectedStage === 'CONSULTATION_NOT_SCHEDULED')
                        )
                          setSelectedStage('FOLLOW_UP');
                      }}
                    >
                      <option value="">
                        {attendancePending ? 'Disponível após o horário' : 'Não informado'}
                      </option>
                      <option value="ATTENDED">Sim</option>
                      <option value="NO_SHOW">Não</option>
                    </select>
                    {attendanceAppointment && (
                      <small>Confirmação vinculada à consulta registrada.</small>
                    )}
                  </label>
                  <label className="commercial-next-action">
                    Próxima ação
                    <textarea
                      name="next_action"
                      defaultValue={detail.next_action}
                      maxLength={1000}
                      placeholder="Qual é o próximo passo deste atendimento?"
                      rows={4}
                    />
                  </label>
                  <input type="hidden" name="interest" value={detail.interest} />
                </div>
              </section>

              <section className="commercial-panel commercial-closing">
                <div className="commercial-section-heading">
                  <div>
                    <span>FECHAMENTO</span>
                    <h3>
                      {detail.sale_completed_at ? 'Dados da venda' : 'Registrar venda concluída'}
                    </h3>
                  </div>
                  {detail.sale_completed_at ? <strong>Venda registrada</strong> : null}
                </div>
                <div className="commercial-fields">
                  <label>
                    Quem fez a venda
                    <input
                      value={detail.sale_seller_name || 'Preenchido automaticamente ao registrar'}
                      readOnly
                    />
                  </label>
                  <label>
                    Consultor
                    <input
                      name="consultant"
                      defaultValue={detail.consultant}
                      minLength={2}
                      maxLength={160}
                      required
                    />
                  </label>
                  <label>
                    Valor total
                    <input
                      name="total_value"
                      inputMode="decimal"
                      defaultValue={currencyInput(detail.total_value_cents)}
                      placeholder="15.000,00"
                      required
                    />
                  </label>
                  <label>
                    Valor da entrada
                    <input
                      name="down_payment"
                      inputMode="decimal"
                      defaultValue={currencyInput(detail.down_payment_cents)}
                      placeholder="1.500,00"
                      required
                    />
                  </label>
                  <label>
                    Grau e classificação A
                    <input
                      name="hair_grade_classification"
                      defaultValue={detail.hair_grade_classification}
                      maxLength={160}
                      placeholder="Ex.: grau 3 A1"
                      required
                    />
                  </label>
                  <label>
                    Teve pack?
                    <select
                      name="has_pack"
                      defaultValue={detail.has_pack === true ? 'true' : 'false'}
                    >
                      <option value="false">Não</option>
                      <option value="true">Sim</option>
                    </select>
                  </label>
                  <label>
                    Data da cirurgia
                    <input
                      name="procedure_date"
                      type="date"
                      defaultValue={detail.procedure_date?.slice(0, 10) ?? ''}
                      required={selectedStage === 'CLOSED_WITH_DATE'}
                    />
                  </label>
                  <label>
                    Assinou contrato?
                    <select
                      name="contract_status"
                      defaultValue={detail.contract_status ?? 'awaiting'}
                    >
                      <option value="awaiting">Aguardando</option>
                      <option value="signed">Sim</option>
                      <option value="not_signed">Não</option>
                    </select>
                  </label>
                </div>
              </section>
            </fieldset>
            <div className="detail-evidence">
              <LinkEvidence />
              <p>
                <strong>Evidência de origem</strong>
                {detail.source_evidence}
              </p>
            </div>
            <LeadMarketing key={detail.id} detail={detail} isManager={isManager} />
          </div>
          {error && (
            <p className="form-error in-modal" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions commercial-actions">
            {!isManager && detail.state === 'CLAIMED' && detail.can_edit && (
              <button
                className="button outline lead-secondary-action"
                type="button"
                disabled={!connected}
                onClick={onWhatsApp}
              >
                <MessageCircle size={16} />
                {detail.channel === 'instagram' ? 'Abrir conversa' : 'WhatsApp'}
              </button>
            )}
            {detail.can_edit ? (
              <div className="commercial-action-group">
                <button
                  className="button outline lead-secondary-action"
                  type="button"
                  disabled={!detail.sale_completed_at || saving}
                  onClick={() => void copySale()}
                >
                  <Copy size={16} />
                  {copied ? 'Copiado!' : 'Copiar para WhatsApp'}
                </button>
                <button
                  className="button outline lead-primary-save"
                  disabled={!connected || saving}
                  formNoValidate
                >
                  <Save size={16} />
                  {saving ? 'Salvando…' : 'Salvar cadastro'}
                </button>
                <button
                  className="button gold lead-secondary-action"
                  type="button"
                  disabled={!connected || saving}
                  onClick={() => void recordSale()}
                >
                  <Save size={16} />
                  {saving
                    ? 'Salvando…'
                    : detail.sale_completed_at
                      ? 'Atualizar venda'
                      : 'Registrar venda'}
                </button>
              </div>
            ) : (
              !isManager && (
                <button
                  type="button"
                  className="button gold"
                  disabled={!connected || busy}
                  onClick={onClaim}
                >
                  {busy ? 'Confirmando…' : 'Assumir lead'}
                  <Check size={16} />
                </button>
              )
            )}
          </div>
        </form>
      )}
      {tab === 'agendar' && (
        <form onSubmit={schedule}>
          <div className="modal-body form-grid">
            <div className="inline-info full">
              <CalendarDays size={20} />
              <span>
                A consulta será registrada na Agenda e o lead passará automaticamente para Em
                follow-up.
              </span>
            </div>
            <div className="schedule-fields full">
              <label className="schedule-date-field">
                Data e horário
                <input name="starts_at" type="datetime-local" required />
                <small>
                  Fuso deste dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                </small>
              </label>
              <label>
                Unidade
                <input
                  name="unit"
                  defaultValue={detail.unit}
                  required
                  minLength={2}
                  maxLength={160}
                />
              </label>
            </div>
            {error && (
              <p className="form-error full" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button className="button gold" disabled={!connected || saving}>
              {saving ? 'Agendando…' : 'Confirmar consulta'}
              <Check size={16} />
            </button>
          </div>
        </form>
      )}
      {tab === 'avaliacoes' && (
        <div className="modal-body">
          {detail.appointments.map((a) => (
            <AppointmentEditor
              key={a.id + ':' + a.version}
              appointment={a}
              connected={connected}
              onSaved={onSaved}
            />
          ))}
          {!detail.appointments.length && <p className="help-text">Nenhuma consulta registrada.</p>}
        </div>
      )}
      {tab === 'transferir' && isManager && (
        <Transfer detail={detail} users={users} connected={connected} onSaved={onSaved} />
      )}
      {tab === 'historico' && (
        <div className="modal-body timeline">
          {detail.history.map((event) => (
            <div className="timeline-event" key={event.id}>
              <span>
                <Clock3 size={14} />
              </span>
              <div>
                <small>{dateLabel(event.created_at, true)}</small>
                <p>{event.description}</p>
              </div>
            </div>
          ))}
          {!detail.history.length && <p className="muted">Nenhum evento registrado.</p>}
        </div>
      )}
    </Modal>
  );
}

function currencyToCents(input: string) {
  const compact = input.replace(/\s|R\$/gi, '');
  const decimal = compact.includes(',')
    ? compact.replace(/\./g, '').replace(',', '.')
    : /^\d{1,3}(\.\d{3})+$/.test(compact)
      ? compact.replace(/\./g, '')
      : compact;
  const value = Number(decimal);
  if (!Number.isFinite(value) || value < 0) throw new Error('Informe valores financeiros válidos.');
  return Math.round(value * 100);
}

function currencyInput(cents: number | null) {
  return cents === null ? '' : (cents / 100).toFixed(2).replace('.', ',');
}

function money(cents: number | null) {
  return cents === null
    ? 'A definir'
    : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function channelLabel(channel: Detail['channel']) {
  if (channel === 'instagram') return 'Instagram Direct';
  if (channel === 'whatsapp') return 'WhatsApp';
  return 'Cadastro manual';
}

function saleOrigin(detail: Detail) {
  const campaign = detail.attributions[0]?.headline?.trim();
  return campaign ? `${detail.source} — ${campaign}` : detail.source;
}

function dateOnly(value: string | null) {
  return value ? value.slice(0, 10).split('-').reverse().join('/') : 'A definir';
}

// Unprefixed national numbers use Brazil. An explicit + always takes precedence.
// Persist the normalized value too, so the existing WhatsApp action uses the same number.
function normalizeLeadPhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, '');
  if (!compact) return '';
  if (!/^\+?[1-9]\d{9,14}$/.test(compact)) return null;
  const digits = compact.replace(/^\+/, '');
  return !compact.startsWith('+') && (digits.length === 10 || digits.length === 11)
    ? `55${digits}`
    : digits;
}

function LeadPhoneField({
  initialPhone,
  canOpen,
  isDemo,
}: {
  initialPhone: string;
  canOpen: boolean;
  isDemo: boolean;
}) {
  const id = useId();
  // The API stores international digits without +. Restore it to avoid interpreting
  // a saved short international number as a newly entered Brazilian number.
  const [phone, setPhone] = useState(
    /^[1-9]\d{9,14}$/.test(initialPhone) ? `+${initialPhone}` : initialPhone,
  );
  const digits = normalizeLeadPhone(phone);
  const href = canOpen && !isDemo && digits ? `https://wa.me/${digits}` : undefined;
  const title = isDemo
    ? 'Contato fictício: WhatsApp indisponível.'
    : !canOpen
      ? 'Disponível para o atendente responsável pelo lead.'
      : !digits
        ? 'Informe o telefone com DDD. Para outro país, use + e o código do país.'
        : 'Abrir conversa no WhatsApp';
  return (
    <div className="lead-phone-field">
      <label htmlFor={id}>Telefone</label>
      <div className="lead-phone-control">
        <input
          id={id}
          name="phone"
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          placeholder="+55 (48) 99999-9999"
          maxLength={24}
          aria-describedby={`${id}-hint`}
          required
        />
        {href ? (
          <a
            className="lead-phone-whatsapp"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir WhatsApp deste telefone"
            title={title}
          >
            <MessageCircle size={20} aria-hidden="true" />
          </a>
        ) : (
          <button
            type="button"
            className="lead-phone-whatsapp"
            disabled
            aria-label="Abrir WhatsApp deste telefone"
            title={title}
          >
            <MessageCircle size={20} aria-hidden="true" />
          </button>
        )}
      </div>
      <small id={`${id}-hint`}>
        Brasil: DDD + número. Outro país: use +código. Obrigatório para venda.
      </small>
    </div>
  );
}

function phoneText(value?: string) {
  if (!value) return 'A definir';
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length === 13)
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.startsWith('55') && digits.length === 12)
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return digits ? `+${digits}` : value;
}

function saleText(detail: Detail) {
  return [
    `Nome completo paciente: ${detail.name}`,
    `Telefone: ${phoneText(detail.phone)}`,
    `Cidade residência: ${detail.residence_city || 'A definir'}`,
    `Quem fez a venda: ${detail.sale_seller_name || 'A definir'}`,
    `Consultor: ${detail.consultant || 'A definir'}`,
    `Valor total: ${money(detail.total_value_cents)}`,
    `Valor entrada: ${money(detail.down_payment_cents)}`,
    `Grau e classificação A: ${detail.hair_grade_classification || 'A definir'}`,
    `De onde veio: ${saleOrigin(detail)}`,
    `Se teve pack ou não: ${detail.has_pack ? 'sim' : 'não'}`,
    `Cidade q opera: ${detail.unit || 'A definir'}`,
    `Data da cirurgia: ${dateOnly(detail.procedure_date)}`,
    `Assinou contrato: ${detail.contract_status ? contractStatusLabels[detail.contract_status] : 'Aguardando'}`,
  ].join('\n');
}
const LinkEvidence = () => <ShieldCheck size={18} />;

export function QueueSettings({
  data,
  connected,
  onSaved,
  onNotice,
}: {
  data: Snapshot;
  connected: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const members = data.users.filter((u) => u.role === 'attendant');
  const [participants, setParticipants] = useState(() =>
    Object.fromEntries(
      members.map((member) => [
        member.id,
        {
          enabled: member.active && member.queue_enabled,
          weight: (member.queue_weight ?? 1) as 1 | 2 | 3 | 4 | 5,
        },
      ]),
    ),
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submitting.current || !connected) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const fields = new FormData(e.currentTarget);
    try {
      await api('/distribution/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          version: data.settings.version,
          timeout_minutes: Number(fields.get('timeout')),
          participants: members.map((member) => ({
            id: member.id,
            enabled: participants[member.id]?.enabled ?? false,
            weight: participants[member.id]?.weight ?? 1,
          })),
        }),
      });
      onNotice('Configuração salva. Reservas existentes mantêm o prazo original.');
      await onSaved();
    } catch (error) {
      setError(
        `${(error as Error).message} Feche e reabra a configuração para consultar os dados atuais.`,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Quem participa da fila</h2>
          <p>Defina quem recebe novos leads e a prioridade de cada atendente.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="queue-settings">
          {members.map((u) => (
            <div className="queue-participant" key={u.id}>
              <span className="queue-number">0{u.queue_position}</span>
              <span className="queue-participant-name">
                <strong>{u.name}</strong>
                {!u.active && <small>Conta inativa</small>}
              </span>
              <label className="queue-participation">
                <span>Participa</span>
                <input
                  type="checkbox"
                  disabled={!u.active}
                  checked={participants[u.id]?.enabled ?? false}
                  aria-label={`Habilitar ${u.name} no rodízio`}
                  onChange={(event) =>
                    setParticipants((current) => ({
                      ...current,
                      [u.id]: {
                        ...(current[u.id] ?? { weight: 1 }),
                        enabled: event.target.checked,
                      },
                    }))
                  }
                />
              </label>
              <label className="queue-weight">
                <span>Peso</span>
                <select
                  value={participants[u.id]?.weight ?? 1}
                  disabled={!u.active}
                  aria-label={`Peso de ${u.name} no rodízio`}
                  onChange={(event) =>
                    setParticipants((current) => ({
                      ...current,
                      [u.id]: {
                        ...(current[u.id] ?? { enabled: false }),
                        weight: Number(event.target.value) as 1 | 2 | 3 | 4 | 5,
                      },
                    }))
                  }
                >
                  <option value={1}>1x — Um lead</option>
                  <option value={2}>2x — Dois leads seguidos</option>
                  <option value={3}>3x — Três leads seguidos</option>
                  <option value={4}>4x — Quatro leads seguidos</option>
                  <option value={5}>5x — Cinco leads seguidos</option>
                </select>
              </label>
            </div>
          ))}
          <label className="timeout-label">
            Prazo para aceite
            <div>
              <input
                name="timeout"
                type="number"
                min={1}
                max={60}
                required
                defaultValue={data.settings.timeout_minutes}
              />
              <span>minutos</span>
            </div>
          </label>
          <p className="help-text">
            O peso define quantos novos leads seguidos cada atendente recebe antes de o rodízio
            avançar. Ele não altera leads já distribuídos nem capturas do bolsão. Pausar uma
            atendente impede apenas novas reservas automáticas.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button className="button gold" disabled={busy || !connected}>
            <Save size={16} />
            {busy ? 'Salvando…' : 'Salvar configuração'}
          </button>
        </div>
      </form>
    </section>
  );
}
