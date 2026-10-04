import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink, Plus } from 'lucide-react';
import { api, type User } from './api';
import { Modal } from './components';
import { signalWithTimeout } from './abort';
import './instagram-prospects.css';

interface Prospect {
  id: string;
  username: string;
  owner_id: string;
  status: 'waiting' | 'matched' | 'review' | 'expired' | 'cancelled';
  expires_at: string;
  opportunity_id: string | null;
  version: number;
}
interface Page {
  configured: boolean;
  items: Prospect[];
  next_cursor: string | null;
}
const labels = {
  waiting: 'Aguardando resposta',
  matched: 'Conversa iniciada',
  review: 'Revisão da gestão',
  expired: 'Reserva vencida',
  cancelled: 'Reserva cancelada',
};

export function InstagramProspectForm({
  isManager,
  users,
  onClose,
  onManual,
  onOpenLead,
}: {
  isManager: boolean;
  users: User[];
  onClose: () => void;
  onManual: () => void;
  onOpenLead: (id: string) => void;
}) {
  const [data, setData] = useState<Page>();
  const [profile, setProfile] = useState('');
  const [source, setSource] = useState('Outra interação');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const mutation = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  async function load(before?: string) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const seq = ++sequence.current;
    setLoading(true);
    const timeout = signalWithTimeout(abort.signal, 15_000);
    try {
      const result = await api<Page>(
        `/instagram/prospects${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        { signal: timeout.signal },
      );
      if (!active.current || seq !== sequence.current) return;
      setData((previous) => ({
        ...result,
        items: before
          ? [
              ...(previous?.items ?? []),
              ...result.items.filter(
                (item) => !previous?.items.some((existing) => existing.id === item.id),
              ),
            ]
          : result.items,
      }));
    } catch (err) {
      if (active.current && !abort.signal.aborted) setError((err as Error).message);
    } finally {
      timeout.dispose();
      if (active.current && seq === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ username: string; status: Prospect['status'] }>(
        '/instagram/prospects',
        { method: 'POST', body: JSON.stringify({ profile, source }) },
      );
      if (!active.current) return;
      setProfile('');
      setNotice(
        result.status === 'waiting'
          ? `@${result.username} reservado para você. Faça a abordagem pelo Instagram.`
          : `@${result.username}: ${labels[result.status]}.`,
      );
      await load();
    } catch (err) {
      if (active.current) setError((err as Error).message);
    } finally {
      mutation.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function cancel(row: Prospect) {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api(`/instagram/prospects/${row.id}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ expected_version: row.version }),
      });
      if (active.current) await load();
    } catch (err) {
      if (active.current) setError((err as Error).message);
    } finally {
      mutation.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={isManager ? 'Reservas do Instagram' : 'Novo lead'}
      onClose={onClose}
      titleAccessory={
        <button className="button outline compact" disabled={busy} onClick={onManual}>
          Cadastro manual
        </button>
      }
    >
      <div className="modal-body prospect-form">
        {!isManager && (
          <form onSubmit={submit} className="form-grid">
            <label className="full">
              Perfil do Instagram
              <input
                name="profile"
                value={profile}
                onChange={(event) => setProfile(event.target.value)}
                placeholder="@usuario ou https://www.instagram.com/usuario/"
                required
                maxLength={500}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                disabled={busy || !data?.configured}
              />
            </label>
            <label className="full">
              Origem informada
              <select
                value={source}
                onChange={(event) => setSource(event.target.value)}
                disabled={busy}
              >
                <option>Curtida</option>
                <option>Novo seguidor</option>
                <option>Outra interação</option>
              </select>
            </label>
            <small className="full">
              Reserve antes de abordar pelo Instagram. A reserva vale por 30 dias; a resposta será
              vinculada após a identificação do perfil.
            </small>
            <button className="button gold full" disabled={busy || !data?.configured}>
              <Plus size={16} />
              {busy ? 'Salvando…' : 'Reservar para mim'}
            </button>
          </form>
        )}
        {notice && (
          <p className="inline-info" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {data && !data.configured && <p>Instagram não configurado neste ambiente.</p>}
        <div className="prospect-list-heading">
          <h3>{isManager ? 'Reservas dos consultores' : 'Meus perfis cadastrados'}</h3>
          <button
            className="button outline compact"
            disabled={loading || busy}
            onClick={() => {
              setError('');
              void load();
            }}
          >
            Atualizar
          </button>
        </div>
        {loading && !data && <p role="status">Carregando…</p>}
        {data?.configured && !data.items.length && (
          <p className="muted">Nenhum perfil cadastrado.</p>
        )}
        <ul className="prospect-list">
          {data?.items.map((row) => (
            <li key={row.id}>
              <div>
                <a
                  href={`https://www.instagram.com/${encodeURIComponent(row.username)}/`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @{row.username} <ExternalLink size={13} />
                </a>
                <small>
                  {labels[row.status]}
                  {isManager
                    ? ` · ${users.find((user) => user.id === row.owner_id)?.name ?? 'Consultor'}`
                    : ''}
                </small>
                {row.status === 'waiting' && (
                  <small>Válida até {new Date(row.expires_at).toLocaleDateString('pt-BR')}</small>
                )}
              </div>
              <div className="prospect-actions">
                {row.opportunity_id && (isManager || row.status === 'matched') && (
                  <button
                    className="button outline compact"
                    onClick={() => onOpenLead(row.opportunity_id!)}
                  >
                    Ver atendimento
                  </button>
                )}
                {['waiting', 'expired'].includes(row.status) ||
                (isManager && row.status === 'review') ? (
                  <button
                    className="button outline compact"
                    disabled={busy}
                    onClick={() => void cancel(row)}
                  >
                    Cancelar reserva
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {data?.next_cursor && (
          <button
            className="button outline"
            disabled={loading || busy}
            onClick={() => void load(data.next_cursor!)}
          >
            {loading ? 'Carregando…' : 'Carregar mais'}
          </button>
        )}
      </div>
      <div className="modal-actions">
        <button className="button outline" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}
