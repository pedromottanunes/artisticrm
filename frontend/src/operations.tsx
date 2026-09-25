import { useRef, useState, type FormEvent } from 'react';
import { KeyRound, Plus, ShieldCheck, Users, Save } from 'lucide-react';
import {
  api,
  ApiError,
  isClosedStage,
  type Snapshot,
  type User,
  type Detail,
  type Appointment,
} from './api';
import { Modal, dateLabel } from './components';

// Keep the same command key after an ambiguous network failure. Do not let changed
// form data silently replace an operation that the server may already have committed.
function useCommand() {
  const receipt = useRef<{ payload: string; key: string } | null>(null);
  return async (path: string, method: string, body: unknown) => {
    const payload = JSON.stringify(body);
    if (receipt.current && receipt.current.payload !== payload)
      throw new Error(
        'Há uma operação sem confirmação. Reenvie os mesmos dados antes de alterá-los.',
      );
    receipt.current ??= { payload, key: crypto.randomUUID() };
    try {
      const result = await api(path, {
        method,
        body: payload,
        headers: { 'Idempotency-Key': receipt.current.key },
      });
      receipt.current = null;
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) receipt.current = null;
      throw error;
    }
  };
}
export function PasswordChange({
  required = false,
  onDone,
  onCancel,
}: {
  required?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const fields = new FormData(e.currentTarget);
    try {
      if (fields.get('new_password') !== fields.get('confirmation'))
        throw new Error('A confirmação não corresponde à nova senha.');
      await api('/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: fields.get('current_password'),
          new_password: fields.get('new_password'),
        }),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel password-panel">
      <div className="panel-heading">
        <div>
          <h2>{required ? 'Defina sua senha pessoal' : 'Alterar minha senha'}</h2>
          <p>Todas as sessões serão encerradas. Entre novamente com a nova senha.</p>
        </div>
        <KeyRound size={22} />
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="modal-body form-grid">
          <label className="full">
            Senha atual ou temporária
            <input
              name="current_password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <label className="full">
            Nova senha
            <input
              name="new_password"
              aria-label="Nova senha"
              type="password"
              autoComplete="new-password"
              minLength={1}
              maxLength={128}
              required
            />
            <small>A senha precisa apenas estar preenchida.</small>
          </label>
          <label className="full">
            Confirmar nova senha
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={1}
              maxLength={128}
            />
          </label>
          {error && (
            <p className="form-error full" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <div className="modal-actions">
          {onCancel && (
            <button type="button" className="button outline" onClick={onCancel} disabled={busy}>
              Voltar
            </button>
          )}
          <button className="button gold" disabled={busy}>
            {busy ? 'Alterando…' : 'Salvar nova senha'}
          </button>
        </div>
      </form>
    </section>
  );
}

export function Team({
  data,
  onChanged,
  connected,
}: {
  data: Snapshot;
  onChanged: () => Promise<void>;
  connected: boolean;
}) {
  const [selected, setSelected] = useState<User | null>(null),
    [creating, setCreating] = useState(false),
    [reset, setReset] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const command = useCommand();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      if (creating)
        await command('/users', 'POST', {
          name: f.get('name'),
          login: f.get('login'),
          password: f.get('password'),
          queue_position: Number(f.get('position')),
        });
      else if (reset)
        await command(`/users/${selected!.id}/reset-password`, 'POST', {
          password: f.get('password'),
          expected_version: selected!.version,
        });
      else
        await command(`/users/${selected!.id}`, 'PATCH', {
          name: f.get('name'),
          active: f.get('active') === 'on',
          expected_version: selected!.version,
          reason: f.get('reason'),
          ...(f.get('replacement') ? { replacement_id: f.get('replacement') } : {}),
        });
      setCreating(false);
      setSelected(null);
      setReset(false);
      await onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    setCreating(false);
    setSelected(null);
    setReset(false);
    setError('');
  };
  return (
    <section className="panel team-panel">
      <div className="panel-heading">
        <div>
          <h2>Equipe e acessos</h2>
          <p>Pausar o rodízio é diferente de desativar o acesso.</p>
        </div>
        <button
          className="button gold"
          disabled={!connected}
          onClick={() => {
            setCreating(true);
            setError('');
          }}
        >
          <Plus size={16} />
          Nova atendente
        </button>
      </div>
      <div className="team-list">
        {data.users
          .filter((u) => u.role === 'attendant')
          .map((user) => (
            <article key={user.id}>
              <div>
                <strong>{user.name}</strong>
                <small>Login: {user.email}</small>
                <small>
                  {user.active ? 'Acesso ativo' : 'Acesso desativado'} · posição{' '}
                  {user.queue_position}
                  {user.must_change_password ? ' · troca de senha pendente' : ''}
                </small>
              </div>
              <button
                className="button outline compact"
                disabled={!connected}
                onClick={() => {
                  setSelected(user);
                  setReset(false);
                  setError('');
                }}
              >
                Gerenciar
              </button>
              <button
                className="icon-button"
                aria-label={`Redefinir senha de ${user.name}`}
                disabled={!connected || !user.active}
                onClick={() => {
                  setSelected(user);
                  setReset(true);
                  setError('');
                }}
              >
                <KeyRound size={17} />
              </button>
            </article>
          ))}
        {!data.users.some((u) => u.role === 'attendant') && (
          <p className="help-text">Cadastre as atendentes para começar o rodízio.</p>
        )}
      </div>
      {(creating || selected) && (
        <Modal
          title={
            creating ? 'Nova atendente' : reset ? 'Redefinir senha' : `Gerenciar ${selected!.name}`
          }
          onClose={close}
        >
          <form onSubmit={submit}>
            <fieldset className="modal-body form-grid" disabled={busy}>
              {!reset && (
                <label className="full">
                  Nome da atendente
                  <input
                    name="name"
                    required
                    minLength={2}
                    maxLength={160}
                    defaultValue={selected?.name}
                  />
                </label>
              )}
              {creating && (
                <>
                  <label className="full">
                    Login de acesso
                    <input
                      name="login"
                      type="text"
                      autoComplete="username"
                      required
                      maxLength={200}
                    />
                  </label>
                  <label className="full">
                    Posição no rodízio
                    <input
                      name="position"
                      type="number"
                      min={1}
                      max={99}
                      defaultValue={
                        Math.max(0, ...data.users.map((u) => u.queue_position ?? 0)) + 1
                      }
                      required
                    />
                  </label>
                </>
              )}
              {creating || reset ? (
                <>
                  <label className="full">
                    Senha de acesso
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={1}
                      maxLength={128}
                    />
                  </label>
                  <div className="inline-info full">
                    <ShieldCheck size={20} />
                    <span>
                      Esta senha já valerá no próximo acesso. Redefinir encerra todas as sessões
                      atuais dessa atendente.
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <label className="checkbox-label full">
                    <input name="active" type="checkbox" defaultChecked={selected?.active} />
                    Permitir acesso ao CRM
                  </label>
                  <label className="full">
                    Destino dos atendimentos ao desativar
                    <select name="replacement" defaultValue="">
                      <option value="">Selecionar quando necessário</option>
                      {data.users
                        .filter((u) => u.role === 'attendant' && u.active && u.id !== selected!.id)
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                    <small>
                      Reservas e atendimentos abertos serão atribuídos à substituta. Histórico
                      permanece preservado. Reativação não devolve leads.
                    </small>
                  </label>
                  <label className="full">
                    Motivo da alteração
                    <textarea name="reason" required minLength={5} maxLength={500} />
                  </label>
                </>
              )}
              {error && (
                <p className="form-error full" role="alert">
                  {error}
                </p>
              )}
            </fieldset>
            <div className="modal-actions">
              <button className="button outline" type="button" onClick={close} disabled={busy}>
                Cancelar
              </button>
              <button className="button gold" disabled={busy || !connected}>
                <Save size={16} />
                {busy ? 'Salvando…' : 'Confirmar alteração'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function Transfer({
  detail,
  users,
  connected,
  onSaved,
}: {
  detail: Detail;
  users: User[];
  connected: boolean;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const command = useCommand();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      await command(`/opportunities/${detail.id}/transfer`, 'POST', {
        expected_version: detail.version,
        target_id: f.get('target'),
        reason: f.get('reason'),
      });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit}>
      <fieldset className="modal-body form-grid" disabled={busy || !connected}>
        <div className="inline-info full">
          <Users size={20} />
          <span>
            {detail.needs_review
              ? 'Este contato retornou após encerramento. Revise o histórico antes de atribuir a nova oportunidade.'
              : 'A atribuição é imediata e não altera a posição do rodízio.'}{' '}
            A ação não conta como aceite da atendente.
          </span>
        </div>
        <label className="full">
          Nova responsável
          <select name="target" defaultValue="" required>
            <option value="" disabled>
              Selecione uma atendente
            </option>
            {users
              .filter((u) => u.role === 'attendant' && u.active && u.id !== detail.owner_id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
        <label className="full">
          Motivo da transferência
          <textarea name="reason" required minLength={5} maxLength={500} />
        </label>
        {error && (
          <p className="form-error full" role="alert">
            {error}
          </p>
        )}
      </fieldset>
      <div className="modal-actions">
        <button
          className="button gold"
          disabled={busy || !connected || isClosedStage(detail.stage)}
        >
          {busy ? 'Transferindo…' : 'Confirmar atribuição'}
        </button>
      </div>
    </form>
  );
}

export function AppointmentEditor({
  appointment,
  connected,
  onSaved,
}: {
  appointment: Appointment;
  connected: boolean;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const command = useCommand();
  const label =
    {
      scheduled: 'Agendada',
      attended: 'Compareceu',
      no_show: 'Não compareceu',
      cancelled: 'Cancelada',
    }[appointment.status] ?? appointment.status;
  const date = new Date(appointment.starts_at);
  const canConfirmAttendance = date.getTime() <= Date.now();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      await command(`/appointments/${appointment.id}`, 'PATCH', {
        expected_version: appointment.version,
        status: f.get('status'),
        starts_at: new Date(f.get('starts_at') as string).toISOString(),
        unit: f.get('unit'),
        reason: f.get('reason'),
      });
      setEditing(false);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const attendance = async (status: 'attended' | 'no_show') => {
    if (busy || !connected || !canConfirmAttendance) return;
    setBusy(true);
    setError('');
    try {
      await command(`/appointments/${appointment.id}`, 'PATCH', {
        expected_version: appointment.version,
        status,
        starts_at: new Date(appointment.starts_at).toISOString(),
        unit: appointment.unit,
        reason:
          status === 'attended'
            ? 'Comparecimento confirmado pelo atendente.'
            : 'Não comparecimento confirmado pelo atendente.',
      });
      await onSaved();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="appointment-editor">
      <header>
        <div>
          <strong>{dateLabel(appointment.starts_at, true)}</strong>
          <p>
            {appointment.unit} · {label}
          </p>
        </div>
        {appointment.status === 'scheduled' && (
          <button
            className="button outline compact"
            disabled={!connected || busy}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Fechar edição' : 'Alterar consulta'}
          </button>
        )}
      </header>
      {appointment.status === 'scheduled' && (
        <section className="attendance-confirmation" aria-label="Confirmação de presença">
          <div>
            <strong>Foi à consulta?</strong>
            <small>
              {canConfirmAttendance
                ? 'Confirme a presença sem alterar o histórico do agendamento.'
                : 'A confirmação será liberada depois do horário marcado.'}
            </small>
          </div>
          <div>
            <button
              type="button"
              className="button attendance-yes compact"
              disabled={!connected || busy || !canConfirmAttendance}
              onClick={() => void attendance('attended')}
            >
              Sim
            </button>
            <button
              type="button"
              className="button attendance-no compact"
              disabled={!connected || busy || !canConfirmAttendance}
              onClick={() => void attendance('no_show')}
            >
              Não
            </button>
          </div>
        </section>
      )}
      {!editing && error && (
        <p className="form-error appointment-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <form onSubmit={submit}>
          <fieldset className="form-grid" disabled={busy || !connected}>
            <label className="full">
              Ação na consulta
              <select name="status" defaultValue="scheduled">
                <option value="scheduled">Remarcar</option>
                <option value="cancelled">Cancelar consulta</option>
              </select>
            </label>
            <label>
              Novo horário
              <input name="starts_at" type="datetime-local" defaultValue={local} required />
            </label>
            <label>
              Unidade
              <input
                name="unit"
                required
                minLength={2}
                maxLength={160}
                defaultValue={appointment.unit}
              />
            </label>
            <p className="help-text full">
              Ao cancelar, o horário e a unidade originais são preservados. A etapa comercial não é
              alterada automaticamente.
            </p>
            <label className="full">
              Motivo
              <textarea name="reason" required minLength={5} maxLength={500} />
            </label>
            {error && (
              <p className="form-error full" role="alert">
                {error}
              </p>
            )}
          </fieldset>
          <button className="button gold" disabled={busy || !connected}>
            {busy ? 'Confirmando…' : 'Salvar consulta'}
          </button>
        </form>
      )}
    </article>
  );
}
