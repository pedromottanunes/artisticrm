import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, Clock3, LayoutGrid, List, Search } from 'lucide-react';
import { api, ApiError, stages, type Lead, type Snapshot } from './api';
import { Avatar, Badge, Empty, Source, dateLabel } from './components';

type PipelineRow = Pick<
  Lead,
  | 'id'
  | 'name'
  | 'interest'
  | 'source'
  | 'stage'
  | 'state'
  | 'reserved_to'
  | 'owner_id'
  | 'created_at'
  | 'expires_at'
>;

interface PipelineBoard {
  users: Snapshot['users'];
  rows: PipelineRow[];
  total: number;
  page: number;
  page_size: number;
  server_time: string;
}

interface ManagerPipelineProps {
  data: Snapshot;
  leadRevision: number;
  onOpen: (id: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => Promise<void>;
}

const formatDate = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function ManagerPipeline({
  data,
  leadRevision,
  onOpen,
  onConnectionChange,
  onSessionExpired,
}: ManagerPipelineProps) {
  const [view, setView] = useState<'BOARD' | 'LIST'>(() =>
    sessionStorage.getItem('artisti:pipeline-view') === 'LIST' ? 'LIST' : 'BOARD',
  );
  const [board, setBoard] = useState<PipelineBoard | null>(null);
  const [stage, setStage] = useState('ALL');
  const [attendant, setAttendant] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const query = new URLSearchParams({
    scope: 'ALL',
    state: 'ALL',
    stage,
    order: 'RECENT',
    attendant,
    source,
    search: term,
    page: String(page),
  }).toString();

  useEffect(() => {
    const timer = setTimeout(() => {
      setTerm(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (view !== 'LIST') return;
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
        const result = await api<PipelineBoard>(`/distribution/board?${query}`, {
          signal: controller.signal,
        });
        if (disposed) return;
        setBoard(result);
        setLoadedQuery(query);
        setError('');
        onConnectionChange(true);
        if (result.page !== page) setPage(result.page);
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
          timer = setTimeout(() => void load(), 5000);
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
  }, [view, query, leadRevision, onConnectionChange, onSessionExpired, page]);

  const users = board?.users ?? data.users;
  const attendants = users.filter((user) => user.role === 'attendant');
  const sources = useMemo(
    () =>
      [...new Set([...data.opportunities, ...(board?.rows ?? [])].map((lead) => lead.source))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR')),
    [board?.rows, data.opportunities],
  );
  const pages = board ? Math.max(1, Math.ceil(board.total / board.page_size)) : 1;
  const resultsUpdating = !!board && loadedQuery !== query;

  const selectView = (next: 'BOARD' | 'LIST') => {
    setView(next);
    sessionStorage.setItem('artisti:pipeline-view', next);
  };

  return (
    <div className="manager-pipeline">
      <div className="pipeline-view-switch" role="group" aria-label="Visualização do funil">
        <button aria-pressed={view === 'BOARD'} onClick={() => selectView('BOARD')}>
          <LayoutGrid size={16} /> Quadro
        </button>
        <button aria-pressed={view === 'LIST'} onClick={() => selectView('LIST')}>
          <List size={17} /> Lista
        </button>
      </div>

      {view === 'BOARD' ? (
        <div className="kanban">
          {Object.entries(stages).map(([key, label]) => {
            const rows = data.opportunities.filter((lead) => lead.stage === key);
            return (
              <section className="kanban-column" key={key}>
                <header>
                  <i className={`stage-dot ${key}`} />
                  <h2>{label}</h2>
                  <span>{rows.length}</span>
                </header>
                <div className="kanban-cards">
                  {rows.map((lead) => (
                    <button className="kanban-card" onClick={() => onOpen(lead.id)} key={lead.id}>
                      <Source value={lead.source} />
                      <h3>{lead.name}</h3>
                      <p>{lead.interest || 'Interesse a definir'}</p>
                      <span className="kanban-action">
                        <Clock3 size={13} />
                        {lead.next_action || 'Definir próximo passo'}
                      </span>
                      <footer>
                        <Avatar
                          user={users.find(
                            (user) => user.id === (lead.owner_id ?? lead.reserved_to),
                          )}
                          small
                        />
                        <span>{dateLabel(lead.created_at)}</span>
                        <ArrowUpRight size={14} />
                      </footer>
                    </button>
                  ))}
                  {!rows.length && (
                    <p className="column-empty">
                      {key === 'WON'
                        ? 'A validação de contratos estará disponível na próxima etapa.'
                        : 'Nenhuma oportunidade nesta etapa.'}
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <section className="panel pipeline-list" aria-label="Lista completa do funil">
          {resultsUpdating && (
            <span className="pipeline-updating" role="status">
              Atualizando resultados…
            </span>
          )}
          {error && (
            <div className="connection-banner" role="alert">
              {error} Os dados exibidos podem estar desatualizados.
            </div>
          )}

          <div className="pipeline-list-summary">
            <span>LEADS NO FUNIL</span>
            <strong>{board?.total ?? '—'}</strong>
          </div>

          <div className="pipeline-filters">
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Buscar lead no funil"
                placeholder="Buscar nome ou telefone"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span className="sr-only">Filtrar por etapa</span>
              <select
                aria-label="Filtrar por etapa"
                value={stage}
                onChange={(event) => {
                  setStage(event.target.value);
                  setPage(1);
                }}
              >
                <option value="ALL">Todas as etapas</option>
                {Object.entries(stages).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Filtrar por atendente</span>
              <select
                aria-label="Filtrar por atendente"
                value={attendant}
                onChange={(event) => {
                  setAttendant(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Toda a equipe</option>
                {attendants.map((user) => (
                  <option value={user.id} key={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Filtrar por origem</span>
              <select
                aria-label="Filtrar por origem"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setPage(1);
                }}
              >
                <option value="">Todas as origens</option>
                {sources.map((value) => (
                  <option value={value} key={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="pipeline-table-scroll">
            <table className="pipeline-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Origem</th>
                  <th>Etapa</th>
                  <th>Atendente</th>
                  <th>Situação</th>
                  <th>Entrada</th>
                  <th>
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {board?.rows.map((lead) => {
                  const owner = users.find(
                    (user) => user.id === (lead.owner_id ?? lead.reserved_to),
                  );
                  return (
                    <tr key={lead.id}>
                      <td data-label="Lead">
                        <button className="pipeline-contact" onClick={() => onOpen(lead.id)}>
                          <Avatar name={lead.name} />
                          <span>
                            <strong>{lead.name}</strong>
                            <small>{lead.interest || 'Interesse a identificar'}</small>
                          </span>
                        </button>
                      </td>
                      <td data-label="Origem">
                        <Source value={lead.source} />
                      </td>
                      <td data-label="Etapa">
                        <span className="stage-pill">{stages[lead.stage]}</span>
                      </td>
                      <td data-label="Atendente">
                        {owner ? (
                          <span className="pipeline-owner">
                            <Avatar user={owner} small /> {owner.name}
                          </span>
                        ) : (
                          <span className="muted">Sem atendente</span>
                        )}
                      </td>
                      <td data-label="Situação">
                        <Badge state={lead.state} />
                      </td>
                      <td data-label="Entrada">{formatDate(lead.created_at)}</td>
                      <td data-label="Ações">
                        <button
                          className="button outline compact"
                          aria-label={`Abrir ficha de ${lead.name}`}
                          onClick={() => onOpen(lead.id)}
                        >
                          Abrir <ArrowUpRight size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!board && busy && <div className="pipeline-loading">Carregando lista…</div>}
            {board && !board.rows.length && (
              <Empty
                title="Nenhum lead encontrado"
                description="Ajuste a busca ou os filtros para consultar outros registros."
              />
            )}
          </div>

          {board && board.total > 0 && (
            <footer className="pipeline-pagination">
              <span>
                {(board.page - 1) * board.page_size + 1}–
                {Math.min(board.page * board.page_size, board.total)} de {board.total}
              </span>
              <div>
                <button
                  className="button outline compact"
                  disabled={board.page <= 1 || resultsUpdating}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  Anterior
                </button>
                <span>
                  {board.page}/{pages}
                </span>
                <button
                  className="button outline compact"
                  disabled={board.page >= pages || resultsUpdating}
                  onClick={() => setPage((value) => Math.min(pages, value + 1))}
                >
                  Próxima
                </button>
              </div>
            </footer>
          )}
        </section>
      )}
    </div>
  );
}
