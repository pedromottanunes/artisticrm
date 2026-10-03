import { useEffect, useState } from 'react';
import { ArrowUpRight, Search } from 'lucide-react';
import {
  api,
  ApiError,
  consultationStatusLabels,
  stages,
  type LeadListCategory,
  type LeadListsResponse,
  type Snapshot,
} from './api';
import { Empty, Source } from './components';

const categories: { id: LeadListCategory; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'NOT_SCHEDULED', label: 'Não agendados' },
  { id: 'SCHEDULED', label: 'Agendados' },
  { id: 'ATTENDED', label: 'Compareceram' },
  { id: 'NO_SHOW', label: 'Não compareceram' },
  { id: 'FOLLOW_UP', label: 'Em follow-up' },
  { id: 'CONTRACT_PENDING', label: 'Contrato pendente' },
  { id: 'CLOSED', label: 'Fechados' },
  { id: 'DECLINED', label: 'Declinados' },
];

export function LeadLists({
  data,
  revision,
  onOpen,
  onConnectionChange,
  onSessionExpired,
}: {
  data: Snapshot;
  revision: number;
  onOpen: (id: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const [category, setCategory] = useState<LeadListCategory>('ALL');
  const [owner, setOwner] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<LeadListsResponse | null>(null);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const isManager = data.user.role === 'manager';

  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const query = new URLSearchParams({
    category,
    owner: isManager ? owner : '',
    search: term,
    page: String(page),
  }).toString();

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      controller = new AbortController();
      let timedOut = false;
      deadline = setTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, 20_000);
      setBusy(true);
      try {
        const next = await api<LeadListsResponse>(`/lead-lists?${query}`, {
          signal: controller.signal,
        });
        if (disposed) return;
        setResult(next);
        setLoadedQuery(query);
        setError('');
        onConnectionChange(true);
        if (next.page !== page) setPage(next.page);
      } catch (loadError) {
        if (disposed) return;
        if (loadError instanceof ApiError && loadError.status === 401) {
          await onSessionExpired();
          return;
        }
        onConnectionChange(false);
        setError(
          timedOut
            ? 'O servidor demorou para responder. Tentaremos novamente.'
            : (loadError as Error).message,
        );
      } finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed) {
          setBusy(false);
          timer = setTimeout(() => {
            if (!document.hidden) void load();
          }, 30_000);
        }
      }
    };
    const resume = () => {
      if (!document.hidden) void load();
    };
    void load();
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [query, revision, page, onConnectionChange, onSessionExpired]);

  const attendants = data.users.filter((user) => user.role === 'attendant');
  const pages = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;
  const updating = !!result && loadedQuery !== query;
  const ownerName = (ownerId: string | null, reservedTo: string | null, state: string) => {
    const id = state === 'RESERVED' ? reservedTo : ownerId;
    return data.users.find((user) => user.id === id)?.name ?? 'Sem responsável';
  };

  return (
    <section className="lead-lists" aria-label="Listas de leads">
      <div className="lead-list-categories" role="group" aria-label="Escolher lista">
        {categories.map((item) => (
          <button
            key={item.id}
            aria-pressed={category === item.id}
            onClick={() => {
              setCategory(item.id);
              setPage(1);
            }}
          >
            <span>{item.label}</span>
            <b>{result?.counts[item.id] ?? '—'}</b>
          </button>
        ))}
      </div>

      <section className="panel lead-list-results">
        <header className="lead-list-toolbar">
          <div>
            <span>RESULTADOS</span>
            <strong>{result?.total ?? '—'}</strong>
          </div>
          <div className="lead-list-controls">
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Buscar nas listas"
                placeholder="Buscar nome ou telefone"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            {isManager && (
              <label>
                <span className="sr-only">Filtrar por consultor</span>
                <select
                  aria-label="Filtrar por consultor"
                  value={owner}
                  onChange={(event) => {
                    setOwner(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Toda a equipe</option>
                  {attendants.map((attendant) => (
                    <option key={attendant.id} value={attendant.id}>
                      {attendant.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </header>

        {updating && (
          <span className="lead-list-updating" role="status">
            Atualizando…
          </span>
        )}
        {error && (
          <div className="connection-banner" role="alert">
            {error} Os dados exibidos podem estar desatualizados.
          </div>
        )}
        {busy && !result ? (
          <div className="lead-list-loading">
            <span className="loader" /> Carregando lista…
          </div>
        ) : result?.rows.length ? (
          <div className="lead-list-rows">
            {result.rows.map((lead) => (
              <button
                key={lead.id}
                className="lead-list-row"
                onClick={() => onOpen(lead.id)}
                aria-label={`Abrir ficha de ${lead.name}`}
              >
                <span className="lead-list-person">
                  <strong>{lead.name}</strong>
                  <small>{lead.next_action || lead.source || 'Próximo passo não definido'}</small>
                </span>
                <span className="lead-list-badges">
                  {lead.consultation_status !== 'UNDEFINED' && (
                    <span
                      className={`consultation-badge is-${lead.consultation_status.toLowerCase()}`}
                    >
                      {consultationStatusLabels[lead.consultation_status]}
                    </span>
                  )}
                  <span className="stage-pill">{stages[lead.stage] ?? lead.stage}</span>
                </span>
                {isManager && (
                  <span className="lead-list-owner">
                    {ownerName(lead.owner_id, lead.reserved_to, lead.state)}
                  </span>
                )}
                <span className="lead-list-source">
                  <Source value={lead.source} />
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
        ) : (
          <Empty
            title="Nenhum lead nesta lista"
            description="Escolha outra lista ou altere a busca."
          />
        )}

        {result && result.total > 0 && (
          <footer className="lead-list-pagination">
            <span>
              Página {result.page} de {pages}
            </span>
            <div>
              <button
                className="button outline compact"
                disabled={result.page <= 1 || busy}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Anterior
              </button>
              <button
                className="button outline compact"
                disabled={result.page >= pages || busy}
                onClick={() => setPage((current) => current + 1)}
              >
                Próxima
              </button>
            </div>
          </footer>
        )}
      </section>
    </section>
  );
}
