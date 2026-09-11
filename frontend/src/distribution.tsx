import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Clock3, RefreshCw, Search, Settings, Shuffle } from 'lucide-react';
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
  ['POOL', 'Bolsão'],
  ['CLAIMED', 'Em atendimento'],
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
  data,
  connected,
  onSaved,
  onNotice,
  onOpen,
}: {
  data: Snapshot;
  connected: boolean;
  onSaved: () => Promise<void>;
  onNotice: (message: string) => void;
  onOpen: (id: string, history?: boolean) => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [state, setState] = useState('ALL');
  const [attendant, setAttendant] = useState('');
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);
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
    const controller = new AbortController();
    if (lastQuery.current !== query) setBoard(null);
    lastQuery.current = query;
    setBusy(true);
    void api<Board>(`/distribution/board?${query}`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setBoard(result);
        setError('');
        clock.current = { server: Date.parse(result.server_time), monotonic: performance.now() };
        setNow(clock.current.server);
        if (result.page !== page) setPage(result.page);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [query, revision, data.server_time]);

  const members = data.users.filter((u) => u.role === 'attendant');
  const ordered = members
    .filter((u) => u.active && u.queue_enabled)
    .sort(
      (a, b) =>
        (a.queue_position! > data.settings.last_position ? 0 : 1) -
          (b.queue_position! > data.settings.last_position ? 0 : 1) ||
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
      <div className="distribution-controls">
        <span className="distribution-rule">
          <Clock3 size={16} /> {data.settings.timeout_minutes} min para aceite
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
        <button className="button outline compact" onClick={() => setSettings(true)}>
          <Settings size={16} /> Configurar rodízio
        </button>
      </div>
      {error && (
        <div className="connection-banner" role="alert">
          {error} Os dados exibidos podem estar desatualizados.
        </div>
      )}
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
                <strong>{u.name}</strong>
                <small>
                  {board
                    ? (board.team.find((t) => t.user_id === u.id && t.state === 'RESERVED')
                        ?.count ?? 0)
                    : '—'}{' '}
                  reservas ·{' '}
                  {board
                    ? (board.team.find((t) => t.user_id === u.id && t.state === 'CLAIMED')?.count ??
                      0)
                    : '—'}{' '}
                  atendimentos
                </small>
              </li>
            ))}
          </ol>
        ) : (
          <p>
            Nenhuma atendente habilitada. Configure o rodízio para distribuir os próximos leads.
          </p>
        )}
      </section>
      <section className="panel">
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
                    const user = data.users.find((u) => u.id === responsible);
                    return (
                      <tr key={lead.id}>
                        <td data-label="Lead / origem">
                          <button className="distribution-contact" onClick={() => onOpen(lead.id)}>
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
            {!board.rows.length && (
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
      <details className="panel distribution-history">
        <summary>
          Últimas movimentações <span>20 mais recentes · toda a central</span>
        </summary>
        <ol>
          {board?.events.map((event) => (
            <li key={event.id}>
              <time dateTime={event.created_at}>{dateTime(event.created_at)}</time>
              <div>
                {event.opportunity_id ? (
                  <button className="text-link" onClick={() => onOpen(event.opportunity_id!, true)}>
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
      <p className="distribution-caption">
        Atualização a cada 5 segundos. Aceite no CRM não confirma envio de mensagem no WhatsApp.
      </p>
      {settings && (
        <Modal title="Configurar rodízio" onClose={() => setSettings(false)} wide>
          <QueueSettings
            data={data}
            connected={connected}
            onSaved={async () => {
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
