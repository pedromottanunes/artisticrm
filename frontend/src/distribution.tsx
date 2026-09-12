import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Clock3,
  RefreshCw,
  Search,
  Settings,
  Shuffle,
  Columns3,
  List,
} from 'lucide-react';
import { api, type Lead, type Snapshot } from './api';
import { Avatar, Badge, Countdown, Empty, Modal } from './components';
import { QueueSettings } from './forms';
import './distribution.css';

type Row = Pick<
  Lead,
  | 'id'
  | 'name'
  | 'phone'
  | 'source'
  | 'state'
  | 'reserved_to'
  | 'owner_id'
  | 'created_at'
  | 'expires_at'
  | 'claimed_at'
  | 'needs_review'
  | 'version'
>;
interface Board {
  users: Snapshot['users'];
  settings: Snapshot['settings'];
  rows: Row[];
  total: number;
  page: number;
  page_size: number;
  counts: Record<string, number>;
  team: { user_id: string; state: string; count: number }[];
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
const tabs = [
  ['ALL', 'Todos'],
  ['RESERVED', 'Aguardando aceite'],
  ['CLAIMED', 'Em atendimento'],
  ['POOL', 'Bolsão'],
  ['PENDING', 'Sem destino'],
] as const;
const dateTime = (value: string) =>
  new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

export function Distribution({
  leadRevision,
  data,
  connected,
  onSaved,
  onNotice,
  onOpen,
}: {
  leadRevision: number;
  data: Snapshot;
  connected: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  onOpen: (id: string, history?: boolean) => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState('ALL');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [overviewExpanded, setOverviewExpanded] = useState(
    () => window.matchMedia('(min-width: 761px)').matches,
  );
  useEffect(() => {
    const viewport = window.matchMedia('(min-width: 761px)');
    const update = () => setOverviewExpanded(viewport.matches);
    viewport.addEventListener('change', update);
    return () => viewport.removeEventListener('change', update);
  }, []);
  const [attendant, setAttendant] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(0);
  const clock = useRef({ server: 0, monotonic: 0 });
  const lastQuery = useRef('');
  const query = new URLSearchParams({
    state,
    attendant,
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
    if (lastQuery.current !== query) setBoard(null);
    lastQuery.current = query;
    const load = async () => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      controller = new AbortController();
      let timedOut = false;
      deadline = setTimeout(() => {
        timedOut = true;
        controller?.abort();
      }, 20000);
      setBusy(true);
      try {
        const result = await api<Board>(`/distribution/board?${query}`, {
          signal: controller.signal,
        });
        if (disposed) return;
        setBoard(result);
        setError('');
        clock.current = { server: Date.parse(result.server_time), monotonic: performance.now() };
        setNow(clock.current.server);
        if (result.page !== page) setPage(result.page);
      } catch (e) {
        if (!disposed)
          setError(
            timedOut
              ? 'O servidor demorou para responder. Tentaremos novamente.'
              : (e as Error).message,
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
  }, [query, revision, leadRevision]);

  const members = (board?.users ?? []).filter((u) => u.role === 'attendant');
  const ordered = members
    .filter((u) => u.active && u.queue_enabled)
    .sort(
      (a, b) =>
        (a.queue_position! > board!.settings.last_position ? 0 : 1) -
          (b.queue_position! > board!.settings.last_position ? 0 : 1) ||
        a.queue_position! - b.queue_position!,
    );
  const count = (key: string) =>
    board
      ? key === 'ALL'
        ? Object.values(board.counts).reduce((a, b) => a + b, 0)
        : board.counts[key]
      : '—';
  const changeState = (value: string) => {
    setState(value);
    setPage(1);
  };

  return (
    <div className="distribution-board">
      <div className="workspace-intro">
        <div>
          <span className="eyebrow">CENTRAL DE ATENDIMENTOS</span>
          <h2>Leads, equipe e próximos passos.</h2>
          <p>Acompanhe as reservas e veja quem está cuidando de cada oportunidade.</p>
        </div>
        <div className="view-switch" role="group" aria-label="Visualização da distribuição">
          <button aria-pressed={view === 'board'} onClick={() => setView('board')}>
            <Columns3 size={17} /> Quadro
          </button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List size={17} /> Lista
          </button>
        </div>
      </div>
      <div className="distribution-controls">
        <span className="distribution-rule">
          <Clock3 size={16} /> {board?.settings.timeout_minutes ?? '—'} min para aceite
        </span>
        <span className="distribution-sync" role="status">
          {error || !connected
            ? 'Atualização interrompida'
            : board
              ? `Atualizado às ${new Date(board.server_time).toLocaleTimeString('pt-BR')}`
              : 'Carregando distribuição…'}
        </span>
        <button
          className="button outline compact"
          disabled={busy}
          onClick={() => setRevision((r) => r + 1)}
          aria-label="Atualizar distribuição"
        >
          <RefreshCw size={16} />
          <span>Atualizar</span>
        </button>
        <button
          className="button outline compact"
          disabled={!board || !!error || !connected}
          onClick={() =>
            board && setSettings({ ...data, users: board.users, settings: board.settings })
          }
        >
          <Settings size={16} /> Configurar rodízio
        </button>
      </div>
      {error && (
        <div className="connection-banner" role="alert">
          {error} Os dados exibidos podem estar desatualizados.
        </div>
      )}
      <details
        className="distribution-overview"
        open={overviewExpanded}
        onToggle={(event) => setOverviewExpanded(event.currentTarget.open)}
      >
        <summary>
          Resumo e equipe <span>{count('ALL')} leads abertos</span>
        </summary>
        <div className="distribution-metrics" aria-label="Resumo da distribuição">
          {tabs.slice(1).map(([key, label]) => (
            <button
              key={key}
              className={state === key ? 'selected' : ''}
              onClick={() => changeState(key)}
              aria-pressed={state === key}
            >
              <span>{label}</span>
              <strong>{count(key)}</strong>
            </button>
          ))}
        </div>
        <p className="distribution-scope">
          Indicadores e equipe: todos os leads abertos. Busca e filtros alteram os cartões e a
          lista.
        </p>
        <section className="panel distribution-queue" aria-label="Ordem do rodízio">
          <span>
            <Shuffle size={18} /> Próximas da fila
          </span>
          {ordered.length ? (
            <ol>
              {ordered.map((u, i) => (
                <li key={u.id}>
                  <span className={i === 0 ? 'next-tag' : 'muted'}>
                    {i === 0 ? 'PRÓXIMA' : i + 1}
                  </span>
                  <Avatar user={u} small />
                  <button
                    className="team-filter"
                    aria-label={`Filtrar atendimentos de ${u.name}`}
                    aria-pressed={attendant === u.id}
                    onClick={() => {
                      setAttendant(attendant === u.id ? '' : u.id);
                      setPage(1);
                    }}
                  >
                    {u.name}
                  </button>
                  <small>
                    {board
                      ? (board.team.find((t) => t.user_id === u.id && t.state === 'RESERVED')
                          ?.count ?? 0)
                      : '—'}{' '}
                    reservas ·{' '}
                    {board
                      ? (board.team.find((t) => t.user_id === u.id && t.state === 'CLAIMED')
                          ?.count ?? 0)
                      : '—'}{' '}
                    atendimentos
                  </small>
                </li>
              ))}
            </ol>
          ) : (
            <p>
              {board
                ? 'Nenhuma atendente habilitada. Configure o rodízio para distribuir os próximos leads.'
                : 'Carregando equipe…'}
            </p>
          )}
        </section>
      </details>
      <div className={`distribution-workspace ${view === 'board' ? 'is-board' : ''}`}>
        <section className="panel distribution-results" aria-label="Leads da distribuição">
          <div className="distribution-tabs" aria-label="Situação dos leads">
            {tabs.map(([key, label]) => (
              <button key={key} aria-pressed={state === key} onClick={() => changeState(key)}>
                {label} <span>{count(key)}</span>
              </button>
            ))}
          </div>
          <div className="distribution-filters">
            <label className="search-field">
              <Search size={17} />
              <input
                aria-label="Buscar na distribuição"
                placeholder="Nome ou telefone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={100}
              />
            </label>
            <select
              aria-label="Filtrar responsável na distribuição"
              value={attendant}
              onChange={(e) => {
                setAttendant(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Todas as atendentes</option>
              {members.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {!u.active ? ' (inativa)' : !u.queue_enabled ? ' (pausada)' : ''}
                </option>
              ))}
            </select>
          </div>
          {!board ? (
            <p className="distribution-loading" role="status">
              {error ? 'Não foi possível carregar a distribuição.' : 'Carregando leads…'}
            </p>
          ) : (
            <>
              {view === 'board' ? (
                <OperationalColumns
                  board={board}
                  state={state}
                  now={now}
                  onOpen={onOpen}
                  onSelect={changeState}
                />
              ) : (
                <div className="table-scroll">
                  <table className="leads-table distribution-table">
                    <thead>
                      <tr>
                        <th>Lead / origem</th>
                        <th>Recebido</th>
                        <th>Responsável</th>
                        <th>Prazo / situação</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.rows.map((lead) => {
                        const responsible =
                          lead.state === 'RESERVED'
                            ? lead.reserved_to
                            : lead.state === 'CLAIMED'
                              ? lead.owner_id
                              : null;
                        const user = board.users.find((u) => u.id === responsible);
                        return (
                          <tr key={lead.id}>
                            <td data-label="Lead / origem">
                              <button
                                className="distribution-contact"
                                onClick={() => onOpen(lead.id)}
                              >
                                <strong>{lead.name}</strong>
                                <small>{lead.source}</small>
                              </button>
                            </td>
                            <td data-label="Recebido">
                              <time dateTime={lead.created_at}>{dateTime(lead.created_at)}</time>
                            </td>
                            <td data-label="Responsável">
                              {user ? (
                                <span className="distribution-owner">
                                  <Avatar user={user} small />
                                  {user.name}
                                </span>
                              ) : lead.state === 'POOL' ? (
                                'Disponível para a equipe'
                              ) : (
                                'Aguardando atribuição'
                              )}
                              {lead.needs_review && (
                                <small className="distribution-review">Revisão da gestão</small>
                              )}
                            </td>
                            <td data-label="Prazo / situação">
                              <Badge state={lead.state} />
                              {lead.state === 'RESERVED' &&
                                (Date.parse(lead.expires_at!) <= now ? (
                                  <small className="distribution-review">
                                    Prazo encerrado · atualizando
                                  </small>
                                ) : (
                                  <Countdown lead={lead} now={now} />
                                ))}
                              {lead.state === 'CLAIMED' && (
                                <small className="distribution-claimed">
                                  {lead.claimed_at
                                    ? `Aceito ${dateTime(lead.claimed_at)}`
                                    : 'Atribuído pela gestão'}
                                </small>
                              )}
                            </td>
                            <td data-label="Ações">
                              <button
                                className="text-link"
                                onClick={() => onOpen(lead.id, true)}
                                aria-label={`Histórico de ${lead.name}`}
                              >
                                Histórico <ArrowUpRight size={15} />
                              </button>
                              <button
                                className="text-link distribution-open"
                                onClick={() => onOpen(lead.id)}
                                aria-label={`Gerenciar ${lead.name}`}
                              >
                                Gerenciar
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {view === 'list' && !board.rows.length && (
                <Empty
                  title="Nenhum lead nesta seleção"
                  description="Novos leads e mudanças de situação aparecem automaticamente."
                />
              )}
              <div className="distribution-pagination">
                <span>
                  {board.total ? (board.page - 1) * board.page_size + 1 : 0}–
                  {Math.min(board.page * board.page_size, board.total)} de {board.total} leads
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
        <details className="panel distribution-history" open>
          <summary>
            Últimas movimentações <span>20 mais recentes · toda a central</span>
          </summary>
          <ol>
            {board?.events.map((event) => (
              <li key={event.id}>
                <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
                <div>
                  {event.opportunity_id ? (
                    <button
                      className="text-link"
                      onClick={() => onOpen(event.opportunity_id!, true)}
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
          {board && !board.events.length && (
            <p className="distribution-loading">Nenhuma movimentação registrada.</p>
          )}
        </details>
      </div>
      <p className="distribution-caption">
        Atualização a cada 5 segundos. Aceite no CRM não confirma envio de mensagem no WhatsApp.
      </p>
      {settings && (
        <Modal title="Configurar rodízio" onClose={() => setSettings(null)} wide>
          <QueueSettings
            data={settings}
            connected={connected}
            onSaved={async () => {
              setSettings(null);
              await onSaved();
              setRevision((r) => r + 1);
            }}
            onNotice={onNotice}
          />
        </Modal>
      )}
    </div>
  );
}

function OperationalColumns({
  board,
  state,
  now,
  onOpen,
  onSelect,
}: {
  board: Board;
  state: string;
  now: number;
  onOpen: (id: string, history?: boolean) => void;
  onSelect: (state: string) => void;
}) {
  const columns = [
    ['RESERVED', 'Aguardando aceite', 'Reservas com prazo para assumir'],
    ['CLAIMED', 'Em atendimento', 'Oportunidades com responsável'],
    ['POOL', 'Bolsão', 'Disponíveis para a equipe'],
    ['PENDING', 'Sem destino', 'Precisam de atenção da gestão'],
  ].filter(([key]) =>
    state === 'ALL' ? key !== 'PENDING' || board.counts.PENDING > 0 : key === state,
  );
  return (
    <div className={`operational-columns ${state !== 'ALL' ? 'single-column' : ''}`}>
      {columns.map(([key, title, subtitle]) => {
        const rows = board.rows.filter((lead) => lead.state === key);
        return (
          <section
            className={`operational-lane lane-${key.toLowerCase()}`}
            key={key}
            aria-label={title}
          >
            <header className="lane-heading">
              <div>
                <h3>{title}</h3>
                <p>{subtitle}</p>
              </div>
              <span aria-label={`${rows.length} nesta página`}>{rows.length}</span>
            </header>
            <div className="lane-cards" role="region" aria-label={`Cartões: ${title}`} tabIndex={0}>
              {rows.map((lead) => {
                const user = board.users.find(
                  (u) => u.id === (lead.state === 'RESERVED' ? lead.reserved_to : lead.owner_id),
                );
                return (
                  <article className={`operational-card card-${key.toLowerCase()}`} key={lead.id}>
                    <div className="operational-card-status">
                      <Badge state={lead.state} />
                      {lead.state === 'RESERVED' &&
                        (Date.parse(lead.expires_at!) <= now ? (
                          <small className="distribution-review">
                            Prazo encerrado · atualizando
                          </small>
                        ) : (
                          <Countdown lead={lead} now={now} />
                        ))}
                    </div>
                    <button
                      className="distribution-contact operational-contact"
                      onClick={() => onOpen(lead.id)}
                    >
                      <Avatar name={lead.name} />
                      <span>
                        <strong>{lead.name}</strong>
                        <small>{lead.source}</small>
                      </span>
                    </button>
                    <div className="operational-card-meta">
                      <span>
                        Recebido <time dateTime={lead.created_at}>{dateTime(lead.created_at)}</time>
                      </span>
                      {user ? (
                        <span className="distribution-owner">
                          <Avatar user={user} small />
                          {user.name}
                        </span>
                      ) : (
                        <span>
                          {lead.state === 'POOL'
                            ? 'Disponível para a equipe'
                            : 'Aguardando atribuição'}
                        </span>
                      )}
                      {lead.needs_review && (
                        <small className="distribution-review">Revisão da gestão</small>
                      )}
                      {lead.state === 'CLAIMED' && (
                        <small>
                          {lead.claimed_at
                            ? `Aceito ${dateTime(lead.claimed_at)}`
                            : 'Atribuído pela gestão'}
                        </small>
                      )}
                    </div>
                    <footer>
                      <button
                        className="text-link"
                        onClick={() => onOpen(lead.id, true)}
                        aria-label={`Histórico de ${lead.name}`}
                      >
                        Histórico
                      </button>
                      <button
                        className="button outline compact"
                        onClick={() => onOpen(lead.id)}
                        aria-label={`Gerenciar ${lead.name}`}
                      >
                        Gerenciar <ArrowUpRight size={15} />
                      </button>
                    </footer>
                  </article>
                );
              })}
              {!rows.length && (
                <p className="lane-empty">
                  {board.counts[key] > 0
                    ? 'Nenhum lead desta situação nesta página ou filtro.'
                    : 'Nenhum lead nesta situação.'}
                </p>
              )}
              {state === 'ALL' && board.counts[key] > rows.length && (
                <button className="lane-see-all" onClick={() => onSelect(key)}>
                  Ver esta situação <ArrowUpRight size={14} />
                </button>
              )}
            </div>
          </section>
        );
      })}
      <p className="board-page-note">
        Cartões desta página · use os filtros ou a paginação para consultar os demais leads.
      </p>
    </div>
  );
}
