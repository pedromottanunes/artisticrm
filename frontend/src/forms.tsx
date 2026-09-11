import { useState, useRef, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  CalendarDays,
  Save,
  MessageCircle,
  Clock3,
  ShieldCheck,
} from 'lucide-react';
import { api, stages, type Detail, type Snapshot, type User } from './api';
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
  onClaim: () => void;
  onWhatsApp: () => void;
  busy: boolean;
  users: User[];
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(initialTab);
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
        body: JSON.stringify({ ...fields, version: detail.version }),
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
      onClose={onClose}
      wide
    >
      <div className="detail-summary">
        <Badge state={detail.state} />
        <Source value={detail.source} />
        {detail.is_demo && <span className="demo-tag">CONTATO FICTÍCIO</span>}
      </div>
      <div className="detail-tabs">
        {[
          'cadastro',
          ...(detail.can_edit ? ['agendar', 'avaliacoes', 'historico'] : []),
          ...(isManager ? ['transferir'] : []),
        ].map((item) => (
          <button
            className={tab === item ? 'active' : ''}
            onClick={() => {
              setTab(item);
              setError('');
            }}
            key={item}
          >
            {item === 'cadastro'
              ? 'Cadastro'
              : item === 'agendar'
                ? 'Agendar avaliação'
                : item === 'avaliacoes'
                  ? 'Avaliações'
                  : item === 'transferir'
                    ? 'Atribuir / transferir'
                    : 'Histórico'}
          </button>
        ))}
      </div>
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
            <label className="full">
              Etapa no funil
              <select name="stage" defaultValue={detail.stage}>
                {Object.entries(stages).map(([key, label]) => (
                  <option disabled={key === 'WON'} key={key} value={key}>
                    {label}
                    {key === 'WON' ? ' — requer validação de contrato' : ''}
                  </option>
                ))}
              </select>
            </label>
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
                O agendamento é registrado no CRM. Confirmações ao paciente devem ser feitas pela
                atendente.
              </span>
            </div>
            <label className="full">
              Data e horário
              <input name="starts_at" type="datetime-local" required />
              <small>
                Fuso deste dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
              </small>
            </label>
            <label className="full">
              Unidade
              <input
                name="unit"
                defaultValue={detail.unit}
                required
                minLength={2}
                maxLength={160}
              />
            </label>
            {error && (
              <p className="form-error full" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button className="button gold" disabled={!connected || saving}>
              {saving ? 'Agendando…' : 'Confirmar avaliação'}
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
          {!detail.appointments.length && (
            <p className="help-text">Nenhuma avaliação registrada.</p>
          )}
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
  const members = data.users.filter((u) => u.role === 'attendant');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
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
      onNotice((error as Error).message);
    } finally {
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
      <form onSubmit={submit} key={data.settings.version}>
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
