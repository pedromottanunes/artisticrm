import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { api, ApiError, type MessageShortcut } from './api';

const emptyForm = { name: '', body: '' };

export function ShortcutsPage({
  connected,
  onConnectionChange,
  onSessionExpired,
}: {
  connected: boolean;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => void;
}) {
  const [shortcuts, setShortcuts] = useState<MessageShortcut[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MessageShortcut | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [error, setError] = useState('');
  const [conflictId, setConflictId] = useState('');
  const createId = useRef('');
  const mutationPending = useRef(false);
  const listSequence = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);
  const busy = saving || !!deletingId;

  const handleError = useCallback(
    (problem: unknown) => {
      if (problem instanceof ApiError && problem.status === 401) onSessionExpired();
      else {
        if (!(problem instanceof ApiError)) onConnectionChange(false);
        setError((problem as Error).message);
      }
    },
    [onConnectionChange, onSessionExpired],
  );

  const load = useCallback(
    async (clearError = true) => {
      const sequence = ++listSequence.current;
      setLoading(true);
      if (clearError) setError('');
      try {
        const result = await api<{ shortcuts: MessageShortcut[] }>('/shortcuts');
        if (sequence !== listSequence.current) return;
        setShortcuts(result.shortcuts);
        onConnectionChange(true);
        return result.shortcuts;
      } catch (problem) {
        if (sequence === listSequence.current) handleError(problem);
      } finally {
        if (sequence === listSequence.current) setLoading(false);
      }
    },
    [handleError, onConnectionChange],
  );

  useEffect(() => {
    void load();
    return () => {
      listSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (formOpen) formRef.current?.scrollIntoView({ block: 'nearest' });
  }, [formOpen, editing?.id]);

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setConflictId('');
    createId.current = '';
  };

  const create = () => {
    if (mutationPending.current) return;
    createId.current = crypto.randomUUID();
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setConflictId('');
    setConfirmDeleteId('');
    setFormOpen(true);
  };

  const edit = (shortcut: MessageShortcut) => {
    if (mutationPending.current) return;
    setEditing(shortcut);
    setForm({ name: shortcut.name, body: shortcut.body });
    setError('');
    setConflictId('');
    setConfirmDeleteId('');
    setFormOpen(true);
  };

  const reloadConflict = async () => {
    const latest = await load(false);
    if (!latest) return;
    const current = latest.find((item) => item.id === conflictId);
    if (current) edit(current);
    else setError('Este atalho não está disponível. Feche o formulário para criar outro.');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = form.name.trim();
    const body = form.body.trim();
    if (!name || !body || mutationPending.current || loading || conflictId || !connected) return;
    mutationPending.current = true;
    listSequence.current += 1;
    setSaving(true);
    setError('');
    try {
      const result = editing
        ? await api<{ shortcut: MessageShortcut }>(`/shortcuts/${editing.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name, body, expected_version: editing.version }),
          })
        : await api<{ shortcut: MessageShortcut }>('/shortcuts', {
            method: 'POST',
            body: JSON.stringify({ id: createId.current, name, body }),
          });
      setShortcuts((current) => [
        result.shortcut,
        ...current.filter((shortcut) => shortcut.id !== result.shortcut.id),
      ]);
      onConnectionChange(true);
      closeForm();
    } catch (problem) {
      if (
        problem instanceof ApiError &&
        ['VERSION_CONFLICT', 'ID_CONFLICT', 'NOT_FOUND'].includes(problem.code)
      ) {
        setConflictId(editing?.id ?? createId.current);
        await load(false);
      }
      handleError(problem);
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  const remove = async (shortcut: MessageShortcut) => {
    if (mutationPending.current || loading || formOpen || !connected) return;
    mutationPending.current = true;
    listSequence.current += 1;
    setDeletingId(shortcut.id);
    setError('');
    try {
      await api(`/shortcuts/${shortcut.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ expected_version: shortcut.version }),
      });
      setShortcuts((current) => current.filter((item) => item.id !== shortcut.id));
      setConfirmDeleteId('');
      onConnectionChange(true);
    } catch (problem) {
      if (problem instanceof ApiError && problem.code === 'VERSION_CONFLICT') {
        setConfirmDeleteId('');
        await load(false);
      }
      handleError(problem);
    } finally {
      mutationPending.current = false;
      setDeletingId('');
    }
  };

  return (
    <section className="shortcuts-page panel" aria-labelledby="shortcuts-title">
      <header className="shortcuts-heading">
        <div>
          <span>RESPOSTAS RÁPIDAS</span>
          <h2 id="shortcuts-title">Cadastre aqui seus atalhos</h2>
        </div>
        <button
          className="button gold compact"
          onClick={create}
          disabled={!connected || formOpen || busy || loading}
        >
          <Plus size={17} /> Criar atalho
        </button>
      </header>

      {formOpen && (
        <form ref={formRef} className="shortcut-form" onSubmit={submit}>
          <div className="shortcut-form-heading">
            <strong>{editing ? 'Editar atalho' : 'Novo atalho'}</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="Fechar"
              onClick={closeForm}
              disabled={busy || loading}
            >
              <X size={18} />
            </button>
          </div>
          <label>
            Nome do atalho
            <input
              autoFocus
              disabled={busy}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              maxLength={60}
              placeholder="Ex.: Saudação inicial"
              required
            />
          </label>
          <label>
            Mensagem
            <textarea
              disabled={busy}
              value={form.body}
              onChange={(event) => setForm((current) => ({ ...current, body: event.target.value }))}
              maxLength={1000}
              rows={5}
              placeholder="Escreva a mensagem que será enviada"
              required
            />
          </label>
          <div className="shortcut-form-footer">
            <small>{form.body.length}/1000</small>
            <button
              className="button gold"
              disabled={
                !form.name.trim() ||
                !form.body.trim() ||
                busy ||
                loading ||
                !!conflictId ||
                !connected
              }
            >
              <Check size={17} /> {saving ? 'Salvando…' : 'Salvar atalho'}
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="shortcut-error" role="alert">
          {error}
          {conflictId ? (
            <button
              className="button outline compact"
              onClick={() => void reloadConflict()}
              disabled={busy || loading || !connected}
            >
              Carregar versão atual
            </button>
          ) : (
            <button
              className="button outline compact"
              onClick={() => void load()}
              disabled={busy || loading}
            >
              Atualizar atalhos
            </button>
          )}
        </div>
      )}

      {loading ? (
        <div className="shortcuts-empty">
          <span className="loader" /> Carregando atalhos…
        </div>
      ) : shortcuts.length ? (
        <div className="shortcuts-list">
          {shortcuts.map((shortcut) => (
            <article className="shortcut-card" key={shortcut.id}>
              <div className="shortcut-card-icon">
                <Zap size={18} />
              </div>
              <div className="shortcut-card-content">
                <strong>{shortcut.name}</strong>
                <p>{shortcut.body}</p>
              </div>
              <div className="shortcut-card-actions">
                {confirmDeleteId === shortcut.id ? (
                  <>
                    <button
                      className="shortcut-confirm-delete"
                      onClick={() => void remove(shortcut)}
                      disabled={busy || !connected}
                    >
                      {deletingId === shortcut.id ? 'Excluindo…' : 'Confirmar'}
                    </button>
                    <button onClick={() => setConfirmDeleteId('')} disabled={busy}>
                      Cancelar
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      aria-label={`Editar ${shortcut.name}`}
                      onClick={() => edit(shortcut)}
                      disabled={busy || formOpen || !connected}
                    >
                      <Pencil size={16} /> <span>Editar</span>
                    </button>
                    <button
                      aria-label={`Excluir ${shortcut.name}`}
                      disabled={busy || formOpen || !connected}
                      onClick={() => setConfirmDeleteId(shortcut.id)}
                    >
                      <Trash2 size={16} /> <span>Excluir</span>
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="shortcuts-empty">
          <Zap size={25} />
          <strong>Nenhum atalho cadastrado</strong>
          <span>Crie sua primeira resposta rápida.</span>
        </div>
      )}
    </section>
  );
}
