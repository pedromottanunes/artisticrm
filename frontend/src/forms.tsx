import { useEffect, useState, useRef, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  CalendarDays,
  Save,
  MessageCircle,
  Clock3,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { api, isClosedStage, stages, type Detail, type Snapshot, type User } from './api';
import { Transfer, AppointmentEditor } from './operations';
import { Modal, Source, Badge, Avatar, dateLabel } from './components';

export function LeadForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const values = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api('/opportunities', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify(values),
      });
      await onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Novo lead"
      description="Novo contato entra no rodízio. Retornos após encerramento aguardam revisão da gestão."
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
            Interesse
            <select name="interest">
              <option>Avaliação capilar</option>
              <option>Transplante capilar</option>
              <option>Tratamento capilar</option>
              <option>Outros</option>
            </select>
          </label>
          <label>
            Unidade
            <input name="unit" defaultValue="A definir" maxLength={160} />
          </label>
          <label className="full">
            Origem informada
            <select name="source">
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
            <span>
              Use apenas dados de teste nesta etapa. Nenhuma mensagem será enviada automaticamente.
            </span>
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
            {busy ? 'Distribuindo…' : 'Cadastrar e distribuir'}
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
  const [confirmation, setConfirmation] = useState('');
  const deleteCommand = useRef<{ key: string; version: number } | null>(null);
  const deleting = useRef(false);
  useEffect(() => setSelectedStage(detail.stage), [detail.id, detail.stage]);
  const remove = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (deleting.current || saving || !connected || confirmation !== 'EXCLUIR') return;
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
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(`/opportunities/${detail.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          ...fields,
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
      description={detail.interest || 'Interesse a identificar'}
      onClose={() => {
        if (!deleting.current) onClose();
      }}
      wide
      className="lead-detail-modal"
    >
      <div className="detail-summary">
        <Badge state={detail.state} />
        <Source value={detail.source} />
        {detail.is_demo && <span className="demo-tag">CONTATO FICTÍCIO</span>}
      </div>
      <div className="detail-tabs">
        {[
          'cadastro',
          ...(detail.can_edit && !isClosedStage(detail.stage) ? ['agendar'] : []),
          ...(detail.can_edit ? ['avaliacoes', 'historico'] : []),
          ...(isManager ? ['transferir'] : []),
          ...(detail.can_edit ? ['excluir'] : []),
        ].map((item) => (
          <button
            className={tab === item ? 'active' : ''}
            disabled={saving}
            onClick={() => {
              setTab(item);
              setConfirmation('');
              setError('');
            }}
            key={item}
          >
            {item === 'cadastro'
              ? 'Cadastro'
              : item === 'agendar'
                ? 'Agendar consulta'
                : item === 'avaliacoes'
                  ? 'Consultas'
                  : item === 'transferir'
                    ? 'Atribuir / transferir'
                    : item === 'excluir'
                      ? 'Excluir lead'
                      : 'Histórico'}
          </button>
        ))}
      </div>
      {tab === 'excluir' && detail.can_edit && (
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
        <form ref={formRef} onSubmit={save} key={detail.id + ':' + detail.version}>
          <fieldset
            className="modal-body form-grid"
            disabled={!detail.can_edit || !connected || saving}
          >
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
            <label>
              WhatsApp
              <input value={detail.phone ?? 'Disponível após assumir'} readOnly />
              <small>Alteração de identidade exige tratamento de duplicidade.</small>
            </label>
            <label>
              E-mail
              <input name="email" type="email" defaultValue={detail.email ?? ''} maxLength={200} />
            </label>
            <label>
              Instagram
              <input
                name="instagram"
                defaultValue={detail.instagram ?? ''}
                maxLength={160}
                placeholder="@perfil (opcional)"
              />
            </label>
            <label>
              Interesse
              <input name="interest" defaultValue={detail.interest} maxLength={160} />
            </label>
            <label>
              Unidade
              <input name="unit" defaultValue={detail.unit} maxLength={160} />
            </label>
            <div className="qualification-fields full">
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
              {selectedStage === 'CLOSED_WITH_DATE' && (
                <label className="procedure-date-field">
                  Data do procedimento
                  <input
                    name="procedure_date"
                    type="date"
                    defaultValue={detail.procedure_date?.slice(0, 10) ?? ''}
                    required
                  />
                </label>
              )}
            </div>
            <label className="full">
              Próxima ação
              <textarea
                name="next_action"
                defaultValue={detail.next_action}
                maxLength={1000}
                placeholder="Qual é o próximo passo deste atendimento?"
                rows={3}
              />
            </label>
          </fieldset>
          <div className="detail-evidence">
            <LinkEvidence />
            <p>
              <strong>Evidência de origem</strong>
              {detail.source_evidence}
            </p>
          </div>
          {!!detail.attributions.length && (
            <section className="meta-attributions" aria-label="Origens de anúncios da Meta">
              <header>
                <div>
                  <span>ORIGEM DO ANÚNCIO</span>
                  <h3>Referência recebida pela Meta</h3>
                </div>
                <span className="verified-origin">
                  <ShieldCheck size={14} /> Verificada
                </span>
              </header>
              {detail.attributions.map((attribution, index) => {
                const sourceUrl = safeHttpUrl(attribution.source_url);
                return (
                  <article className="meta-attribution" key={attribution.id}>
                    <div className="meta-attribution-title">
                      <strong>{attribution.headline || 'Anúncio da Meta'}</strong>
                      <span>
                        {index === 0 ? 'Mais recente' : dateLabel(attribution.received_at, true)}
                      </span>
                    </div>
                    {attribution.body && <p>{attribution.body}</p>}
                    <dl>
                      {attribution.source_id && (
                        <div>
                          <dt>ID do anúncio</dt>
                          <dd>{attribution.source_id}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Recebido em</dt>
                        <dd>{dateLabel(attribution.received_at, true)}</dd>
                      </div>
                      {attribution.media_type && (
                        <div>
                          <dt>Formato</dt>
                          <dd>{attribution.media_type}</dd>
                        </div>
                      )}
                    </dl>
                    {sourceUrl && (
                      <a href={sourceUrl} target="_blank" rel="noreferrer">
                        Abrir referência do anúncio <ArrowRight size={14} />
                      </a>
                    )}
                  </article>
                );
              })}
            </section>
          )}
          {error && (
            <p className="form-error in-modal" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            {!isManager && detail.state === 'CLAIMED' && detail.can_edit && (
              <button
                className="button outline"
                type="button"
                disabled={!connected}
                onClick={onWhatsApp}
              >
                <MessageCircle size={16} />
                WhatsApp
              </button>
            )}
            {detail.can_edit ? (
              <button className="button gold" disabled={!connected || saving}>
                <Save size={16} />
                {saving ? 'Salvando…' : 'Salvar alterações'}
              </button>
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
const LinkEvidence = () => <ShieldCheck size={18} />;

function safeHttpUrl(value?: string | null) {
  if (!value) return;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return;
  }
}

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
          participants: members.map((u) => ({ id: u.id, enabled: fields.get(u.id) === 'on' })),
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
          <p>A ordem é sequencial, independentemente de estar online.</p>
        </div>
      </div>
      <form onSubmit={submit}>
        <div className="queue-settings">
          {members.map((u) => (
            <label className="queue-toggle" key={u.id}>
              <span className="queue-number">0{u.queue_position}</span>
              <Avatar user={u} />
              <strong>{u.name}</strong>
              <input
                type="checkbox"
                name={u.id}
                disabled={!u.active}
                defaultChecked={u.queue_enabled}
                aria-label={`Habilitar ${u.name} no rodízio`}
              />
            </label>
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
            Pausar uma atendente impede novas reservas. As reservas atuais continuam com ela até o
            prazo original. Todas as atendentes com acesso ativo podem assumir leads do bolsão,
            inclusive as pausadas no rodízio. Leads sem destino serão distribuídos ao reativar a
            equipe.
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
