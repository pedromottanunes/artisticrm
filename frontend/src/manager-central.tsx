import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Clock3,
  History,
  RefreshCw,
  Search,
  Settings,
  Shuffle,
  Users,
} from 'lucide-react';
import { api, ApiError, isClosedStage, stages, type Lead, type Snapshot } from './api';
import { Badge, Countdown, Empty, Modal } from './components';
import { QueueSettings } from './forms';

type CentralRow = Pick<
  Lead,
  | 'id'
  | 'name'
  | 'phone'
  | 'interest'
  | 'source'
  | 'stage'
  | 'state'
  | 'reserved_to'
  | 'owner_id'
  | 'created_at'
  | 'expires_at'
  | 'claimed_at'
  | 'needs_review'
  | 'version'
>;

type AttendantSummary = Snapshot['users'][number] & {
  queue_rank: number | null;
  is_next: boolean;
  claimed_count: number;
  reserved_count: number;
  expired_today: number;
};

interface CentralBoard {
  users: Snapshot['users'];
  attendants: AttendantSummary[];
  settings: Snapshot['settings'];
  rows: CentralRow[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<string, number>;
  events: {
    id: string;
    opportunity_id: string | null;
    name?: string;
    kind: string;
    description: string;
    created_at: string;
  }[];
  server_time: string;
}

const statusFilters = [
  ['ALL', 'Todos'],
  ['RESERVED', 'Aguardando aceite'],
  ['CLAIMED', 'Em atendimento'],
  ['POOL', 'Bolsão'],
  ['PENDING', 'Sem destino'],
] as const;

const summaryStatuses = statusFilters.slice(1);
const sourceOptions = [
  ['', 'Todas as origens'],
  ['Cadastro manual', 'Cadastro manual'],
  ['Não identificada', 'Não identificada'],
  ['Meta Ads', 'Meta Ads'],
  ['Google Ads', 'Google Ads'],
  ['Indicação', 'Indicação'],
] as const;

const dateTime = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function ManagerCentral({
  leadRevision,
  data,
  connected,
  onSaved,
  onNotice,
  onOpen,
  onConnectionChange,
  onSessionExpired,
}: {
  leadRevision: number;
  data: Snapshot;
  connected: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  onOpen: (id: string, history?: boolean) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const [board, setBoard] = useState<CentralBoard | null>(null);
  const [state, setState] = useState('ALL');
  const [scope, setScope] = useState<'OPEN' | 'CLOSED' | 'ALL'>('OPEN');
  const [attendant, setAttendant] = useState('');
  const [source, setSource] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loadedQuery, setLoadedQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Snapshot | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTrigger = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(0);
  const clock = useRef({ server: 0, monotonic: 0 });

  const query = new URLSearchParams({
    state,
    scope,
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
    const timer = setInterval(() => {
      if (!document.hidden)
        setNow(clock.current.server + performance.now() - clock.current.monotonic);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
        const result = await api<CentralBoard>(`/distribution/board?${query}`, {
          signal: controller.signal,
        });
        if (disposed) return;
        setBoard(result);
        setLoadedQuery(query);
        setError('');
        onConnectionChange(true);
        clock.current = { server: Date.parse(result.server_time), monotonic: performance.now() };
        setNow(clock.current.server);
        if (result.page !== page) setPage(result.page);
      } catch (loadError) {
        if (!disposed) {
          onConnectionChange(false);
          if (loadError instanceof ApiError && loadError.status === 401) {
            await onSessionExpired();
            return;
          }
          setError(
            timedOut
              ? 'O servidor demorou para responder. Tentaremos novamente.'
              : (loadError as Error).message,
          );
        }
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
  }, [query, revision, leadRevision, onConnectionChange, onSessionExpired]);

  const count = (key: string) =>
    board
      ? key === 'ALL'
        ? Object.values(board.counts).reduce((sum, value) => sum + value, 0)
        : (board.counts[key] ?? 0)
      : '—';
  const resultsUpdating = !!board && loadedQuery !== query;
  const selectedAttendant = attendant
    ? board?.attendants.find((user) => user.id === attendant)
    : undefined;

  const selectStatus = (value: string) => {
    setScope('OPEN');
    setState(value);
    setAttendant('');
    setPage(1);
  };

  const selectScope = (value: 'OPEN' | 'CLOSED' | 'ALL') => {
    setScope(value);
    setState('ALL');
    setPage(1);
  };

  const responsibleFor = (lead: CentralRow) =>
    lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id;

  return (
    <div className="manager-central">
      <div className="central-commandbar">
        <span className="central-rule">
          <Clock3 size={16} /> {board?.settings.timeout_minutes ?? '—'} min para aceite
        </span>
        <span className="central-sync" role="status">
          <span className="central-sync-full">
            {error || !connected
              ? 'Atualização interrompida'
              : board
                ? `Atualizado às ${new Date(board.server_time).toLocaleTimeString('pt-BR')}`
                : 'Carregando central…'}
          </span>
          <span className="central-sync-compact">
            {error || !connected
              ? 'Sem conexão'
              : board
                ? `Atualizado ${new Date(board.server_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                : 'Carregando…'}
          </span>
        </span>
        <button
          className="button outline compact"
          aria-label="Atualizar"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={16} /> <span className="central-refresh-label">Atualizar</span>
        </button>
        <button
          className="button outline compact"
          ref={historyTrigger}
          aria-label="Movimentações"
          disabled={!board}
          onClick={() => setHistoryOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={historyOpen}
        >
          <History size={16} /> <span className="central-history-full">Movimentações</span>
          <span className="central-history-compact">Histórico</span>
        </button>
        <button
          className="button outline compact"
          disabled={!board || !!error || !connected}
          onClick={() =>
            board && setSettings({ ...data, users: board.users, settings: board.settings })
          }
        >
          <Settings size={16} /> Rodízio
        </button>
      </div>

      {error && (
        <div className="connection-banner" role="alert">
          {error} Os dados exibidos podem estar desatualizados.
        </div>
      )}

      <section className="central-summary" aria-label="Resumo dos atendimentos">
        {summaryStatuses.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={scope === 'OPEN' && state === key && !attendant}
            onClick={() => selectStatus(key)}
          >
            <span>{label}</span>
            <strong>{count(key)}</strong>
          </button>
        ))}
      </section>

      <section className="central-team" aria-labelledby="central-team-title">
        <div className="central-section-heading">
          <h2 className="eyebrow" id="central-team-title">
            EQUIPE
          </h2>
          <button
            className="text-link"
            disabled={!attendant}
            onClick={() => {
              setAttendant('');
              setPage(1);
            }}
          >
            Todos os atendentes
          </button>
        </div>
        <div className="attendant-strip" role="list" aria-label="Resumo por atendente">
          {board?.attendants.map((user) => (
            <button
              className="attendant-card"
              data-selected={attendant === user.id || undefined}
              key={user.id}
              role="listitem"
              aria-pressed={attendant === user.id}
              onClick={() => {
                setScope('OPEN');
                setState('ALL');
                setAttendant(attendant === user.id ? '' : user.id);
                setPage(1);
              }}
            >
              <span className="attendant-card-head">
                <span>
                  <strong>{user.name}</strong>
                  <small>
                    {!user.active
                      ? 'Conta inativa'
                      : !user.queue_enabled
                        ? 'Fora do rodízio'
                        : user.is_next
                          ? 'Próxima da fila'
                          : `${user.queue_rank}ª da fila`}
                  </small>
                </span>
                {user.is_next && <i>PRÓXIMA</i>}
              </span>
              <span className="attendant-primary">
                <strong>{user.claimed_count}</strong> em atendimento
              </span>
              <span className="attendant-secondary">
                {user.expired_today} {user.expired_today === 1 ? 'retorno' : 'retornos'} ao bolsão
                hoje
              </span>
              {user.reserved_count > 0 && (
                <span className="attendant-reserved">
                  <Clock3 size={13} /> {user.reserved_count} aguardando aceite
                </span>
              )}
            </button>
          ))}
          {board && !board.attendants.length && (
            <div className="attendant-empty">
              <Users size={20} /> Nenhum atendente cadastrado.
            </div>
          )}
          {!board && <div className="attendant-empty">Carregando equipe…</div>}
        </div>
      </section>

      <section
        className="panel central-leads"
        aria-label="Lista de leads"
        aria-busy={resultsUpdating}
      >
        {resultsUpdating && (
          <span className="central-updating" role="status">
            Atualizando resultados…
          </span>
        )}
        <div className="central-list-head">
          <div className="central-list-title">
            <h2 className="eyebrow">LEADS</h2>
            {selectedAttendant && (
              <p className="central-selected-attendant" aria-live="polite">
                {selectedAttendant.name}
              </p>
            )}
          </div>
          <div className="central-scopes" role="group" aria-label="Escopo dos leads">
            {(
              [
                ['OPEN', 'Em aberto'],
                ['CLOSED', 'Encerrados'],
                ['ALL', 'Todos'],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={scope === value} onClick={() => selectScope(value)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {scope === 'OPEN' && (
          <div className="central-status-tabs" aria-label="Situação dos leads">
            {statusFilters.map(([key, label]) => (
              <button key={key} aria-pressed={state === key} onClick={() => selectStatus(key)}>
                {label} <span>{count(key)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="central-filters">
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="Buscar nome ou telefone"
              placeholder="Buscar nome ou telefone"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={100}
            />
          </label>
          <select
            aria-label="Filtrar origem"
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setPage(1);
            }}
          >
            {sourceOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {!board ? (
          <p className="central-loading" role="status">
            {error ? 'Não foi possível carregar a central.' : 'Carregando leads…'}
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="leads-table central-table">
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Situação</th>
                    <th>Atendente</th>
                    <th>Tempo</th>
                    <th>
                      <span className="sr-only">Ações</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((lead) => {
                    const responsible = board.users.find(
                      (user) => user.id === responsibleFor(lead),
                    );
                    const closed = isClosedStage(lead.stage);
                    return (
                      <tr key={lead.id}>
                        <td data-label="Lead">
                          <button className="central-contact" onClick={() => onOpen(lead.id)}>
                            <span>
                              <strong>{lead.name}</strong>
                              <small>{lead.source}</small>
                            </span>
                          </button>
                        </td>
                        <td data-label="Situação">
                          {closed ? (
                            <span className="stage-pill">{stages[lead.stage]}</span>
                          ) : (
                            <Badge state={lead.state} />
                          )}
                          {lead.needs_review && <small className="central-review">Revisão</small>}
                        </td>
                        <td data-label="Atendente">
                          {responsible ? (
                            <span className="central-owner">{responsible.name}</span>
                          ) : lead.state === 'POOL' ? (
                            <span className="muted">Disponível para a equipe</span>
                          ) : (
                            <span className="muted">Sem responsável</span>
                          )}
                        </td>
                        <td data-label="Tempo">
                          {lead.state === 'RESERVED' && !closed ? (
                            <Countdown lead={lead} now={now} />
                          ) : lead.state === 'CLAIMED' && lead.claimed_at ? (
                            <span>Aceito {dateTime(lead.claimed_at)}</span>
                          ) : (
                            <span>Recebido {dateTime(lead.created_at)}</span>
                          )}
                        </td>
                        <td data-label="Ações">
                          <button
                            className="button outline compact"
                            onClick={() => onOpen(lead.id)}
                            aria-label={`Abrir ficha de ${lead.name}`}
                          >
                            Abrir <ArrowUpRight size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!board.rows.length && (
              <Empty
                title="Nenhum lead nesta seleção"
                description="Altere os filtros ou aguarde a chegada de novos contatos."
              />
            )}
            <div className="central-pagination">
              <span>
                {board.total ? (board.page - 1) * board.page_size + 1 : 0}–
                {Math.min(board.page * board.page_size, board.total)} de {board.total}
              </span>
              <button
                className="button outline compact"
                disabled={busy || board.page <= 1}
                onClick={() => setPage(board.page - 1)}
              >
                Anterior
              </button>
              <span>
                {board.page} / {Math.max(1, Math.ceil(board.total / board.page_size))}
              </span>
              <button
                className="button outline compact"
                disabled={busy || board.page * board.page_size >= board.total}
                onClick={() => setPage(board.page + 1)}
              >
                Próxima
              </button>
            </div>
          </>
        )}
      </section>

      {historyOpen && (
        <Modal
          title="Últimas movimentações"
          description="20 movimentações mais recentes da central"
          onClose={() => {
            setHistoryOpen(false);
            requestAnimationFrame(() => historyTrigger.current?.focus({ preventScroll: true }));
          }}
        >
          <div className="modal-body central-history">
            <ol>
              {board?.events.map((event) => (
                <li key={event.id}>
                  <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
                  <div>
                    {event.opportunity_id ? (
                      <button
                        className="text-link"
                        onClick={() => {
                          setHistoryOpen(false);
                          onOpen(event.opportunity_id!, true);
                        }}
                      >
                        {event.name ?? 'Lead'} <ArrowUpRight size={14} />
                      </button>
                    ) : (
                      <strong>Configuração da equipe</strong>
                    )}
                    <p>{event.description}</p>
                  </div>
                </li>
              ))}
            </ol>
            {board && !board.events.length && <p>Nenhuma movimentação registrada.</p>}
          </div>
        </Modal>
      )}

      {settings && (
        <Modal title="Configurar rodízio" onClose={() => setSettings(null)} wide>
          <QueueSettings
            data={settings}
            connected={connected}
            onSaved={async () => {
              setSettings(null);
              await onSaved();
              setRevision((value) => value + 1);
            }}
            onNotice={onNotice}
          />
        </Modal>
      )}
    </div>
  );
}
