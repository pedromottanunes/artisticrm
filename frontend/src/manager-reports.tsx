import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlarmClock,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Inbox,
  MessageSquareReply,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { api, ApiError } from './api';
import { Empty, Modal } from './components';

interface ReportRanking {
  user_id: string;
  name: string;
  count: number;
  lead_ids: string[];
  average_minutes?: number;
}
interface ReportOverview {
  period: { from: string; to: string; days: number };
  leads: Record<string, { id: string; name: string }>;
  unanswered_by_user: ReportRanking[];
  fastest_response_by_user: ReportRanking[];
  top_sources: { source: string; count: number; lead_ids: string[] }[];
  funnel: { key: string; label: string; count: number; lead_ids: string[] }[];
  average_response_minutes: number | null;
  pool_claimed_by_user: ReportRanking[];
  pool_lost_by_user: ReportRanking[];
  same_day_interactions: { date: string; count: number; lead_ids: string[] }[];
  first_interaction_by_user: ReportRanking[];
  closed_by_user: ReportRanking[];
  open_activities_by_user: ReportRanking[];
  server_time: string;
}

const reportDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateValue = (date: Date) => {
  const parts = Object.fromEntries(
    reportDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const shift = (value: string, days: number) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12)).toISOString().slice(0, 10);
};

const duration = (minutes: number | null | undefined) => {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
};

const shortDate = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(
    new Date(`${value}T12:00:00`),
  );

function ReportRows({
  rows,
  value,
  empty,
  onLeads,
}: {
  rows: ReportRanking[];
  value: (row: ReportRanking) => string;
  empty: string;
  onLeads: (title: string, ids: string[]) => void;
}) {
  if (!rows.length) return <p className="report-empty-line">{empty}</p>;
  return (
    <div className="report-compact-list">
      {rows.slice(0, 4).map((row, index) => (
        <div key={row.user_id}>
          <span className="report-rank">{String(index + 1).padStart(2, '0')}</span>
          <strong>{row.name}</strong>
          <button onClick={() => onLeads(row.name, row.lead_ids)}>{value(row)}</button>
        </div>
      ))}
    </div>
  );
}

function HorizontalChart({
  rows,
  metric,
  onLeads,
}: {
  rows: ReportRanking[];
  metric: (row: ReportRanking) => number;
  onLeads: (title: string, ids: string[]) => void;
}) {
  const max = Math.max(1, ...rows.map(metric));
  if (!rows.length)
    return <Empty title="Sem dados no período" description="Não há movimentações para comparar." />;
  return (
    <div className="report-bars">
      {rows.map((row) => (
        <button key={row.user_id} onClick={() => onLeads(row.name, row.lead_ids)}>
          <span>{row.name}</span>
          <i>
            <b style={{ width: `${Math.max(3, (metric(row) / max) * 100)}%` }} />
          </i>
          <strong>{metric(row)}</strong>
        </button>
      ))}
    </div>
  );
}

export function ManagerReports({
  onOpen,
  onConnectionChange,
  onSessionExpired,
}: {
  onOpen: (id: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const today = useMemo(() => dateValue(new Date()), []);
  const [from, setFrom] = useState(() => shift(today, -30));
  const [to, setTo] = useState(today);
  const [query, setQuery] = useState({ from: shift(today, -30), to: today });
  const [report, setReport] = useState<ReportOverview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<{ title: string; ids: string[] } | null>(null);

  useEffect(() => {
    let disposed = false;
    let timedOut = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    setBusy(true);
    void api<ReportOverview>(`/reports/overview?${new URLSearchParams(query).toString()}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (disposed) return;
        setReport(result);
        setError('');
        onConnectionChange(true);
      })
      .catch((loadError) => {
        if (disposed) return;
        if (timedOut) {
          setError('A consulta demorou mais que o esperado.');
          onConnectionChange(false);
        } else if (loadError instanceof ApiError && loadError.status === 401) {
          void onSessionExpired();
          return;
        } else {
          setError((loadError as Error).message);
          onConnectionChange(loadError instanceof ApiError);
        }
      })
      .finally(() => {
        clearTimeout(timeout);
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query, revision, onConnectionChange, onSessionExpired]);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!from || !to) {
      setError('Informe as duas datas do período.');
      return;
    }
    const days = Math.round(
      (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / 86_400_000,
    );
    if (!Number.isFinite(days) || days < 0 || days > 30) {
      setError('O período não pode ultrapassar 31 dias.');
      return;
    }
    setQuery({ from, to });
  };
  const openLeads = (title: string, ids: string[]) => {
    if (ids.length) setSelected({ title, ids });
  };
  const maxDaily = Math.max(1, ...(report?.same_day_interactions.map((item) => item.count) ?? []));
  const received = report?.funnel[0]?.count ?? 0;

  return (
    <div className="manager-reports">
      <form className="reports-filter" onSubmit={apply}>
        <div>
          <CalendarDays size={17} />
          <label>
            <span>De</span>
            <input
              type="date"
              value={from}
              max={to}
              required
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            <span>Até</span>
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              required
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>
        <div>
          {report && <span>{report.period.days} dias</span>}
          <button
            className="button outline compact"
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            <RefreshCw size={15} />
            Atualizar
          </button>
          <button className="button gold compact" type="submit">
            Filtrar
          </button>
        </div>
      </form>

      {error && (
        <div className="reports-error" role="alert">
          {error}
        </div>
      )}
      {busy && !report ? <p className="reports-loading">Carregando relatórios…</p> : null}

      {report && (
        <>
          <section
            className={`reports-overview ${busy ? 'is-updating' : ''}`}
            aria-label="Resumo dos relatórios"
          >
            <article className="report-card">
              <header>
                <AlarmClock size={18} />
                <h2>Usuários com mais leads sem resposta</h2>
              </header>
              <ReportRows
                rows={report.unanswered_by_user}
                value={(row) => `${row.count} lead${row.count === 1 ? '' : 's'}`}
                empty="Nenhum lead sem resposta."
                onLeads={openLeads}
              />
            </article>
            <article className="report-card">
              <header>
                <MessageSquareReply size={18} />
                <h2>Usuários com resposta mais rápida</h2>
              </header>
              <ReportRows
                rows={report.fastest_response_by_user}
                value={(row) => duration(row.average_minutes)}
                empty="Nenhum aceite registrado."
                onLeads={openLeads}
              />
            </article>
            <article className="report-card">
              <header>
                <TrendingUp size={18} />
                <h2>Origens com mais leads</h2>
              </header>
              {!report.top_sources.length ? (
                <p className="report-empty-line">Nenhuma origem no período.</p>
              ) : (
                <div className="report-compact-list">
                  {report.top_sources.slice(0, 4).map((row, index) => (
                    <div key={row.source}>
                      <span className="report-rank">{String(index + 1).padStart(2, '0')}</span>
                      <strong>{row.source}</strong>
                      <button onClick={() => openLeads(row.source, row.lead_ids)}>
                        {row.count} leads
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </article>
            <article className="report-card report-funnel-card">
              <header>
                <TrendingUp size={18} />
                <h2>Acompanhamento</h2>
              </header>
              <div className="report-funnel">
                {report.funnel.map((item) => (
                  <button key={item.key} onClick={() => openLeads(item.label, item.lead_ids)}>
                    <span>{item.label}</span>
                    <i>
                      <b
                        style={{
                          width: `${received ? (item.key === 'RECEIVED' ? 100 : Math.max(2, (item.count / received) * 100)) : 0}%`,
                        }}
                      />
                    </i>
                    <strong>{item.count}</strong>
                  </button>
                ))}
              </div>
            </article>
          </section>

          <section className="report-average" aria-label="Tempo médio de resposta">
            <Clock3 size={21} />
            <div>
              <strong>{duration(report.average_response_minutes)}</strong>
              <span>Tempo médio até o primeiro aceite no CRM</span>
            </div>
          </section>

          <div className="reports-section-heading">
            <Inbox size={17} />
            <h2>Bolsão</h2>
          </div>
          <section className="reports-pair">
            <article className="report-card">
              <header>
                <CheckCircle2 size={18} />
                <h2>Leads assumidos através do bolsão</h2>
              </header>
              <HorizontalChart
                rows={report.pool_claimed_by_user}
                metric={(row) => row.count}
                onLeads={openLeads}
              />
            </article>
            <article className="report-card danger">
              <header>
                <AlarmClock size={18} />
                <h2>Leads perdidos para o bolsão por usuário</h2>
              </header>
              <HorizontalChart
                rows={report.pool_lost_by_user}
                metric={(row) => row.count}
                onLeads={openLeads}
              />
            </article>
          </section>

          <div className="reports-section-heading">
            <Users size={17} />
            <h2>Atendimento e resultado</h2>
          </div>
          <section className="reports-charts">
            <article className="report-card">
              <header>
                <MessageSquareReply size={18} />
                <h2>Leads interagidos no mesmo dia</h2>
              </header>
              {!report.same_day_interactions.length ? (
                <Empty
                  title="Sem dados no período"
                  description="Nenhum aceite no mesmo dia da entrada."
                />
              ) : (
                <div className="report-columns">
                  {report.same_day_interactions.map((item) => (
                    <button
                      key={item.date}
                      onClick={() => openLeads(shortDate(item.date), item.lead_ids)}
                    >
                      <strong>{item.count}</strong>
                      <i style={{ height: `${Math.max(4, (item.count / maxDaily) * 100)}%` }} />
                      <span>{shortDate(item.date)}</span>
                    </button>
                  ))}
                </div>
              )}
            </article>
            <article className="report-card">
              <header>
                <Clock3 size={18} />
                <h2>Tempo de primeira interação por usuário (minutos)</h2>
              </header>
              <HorizontalChart
                rows={report.first_interaction_by_user}
                metric={(row) => row.average_minutes ?? 0}
                onLeads={openLeads}
              />
            </article>
            <article className="report-card">
              <header>
                <CheckCircle2 size={18} />
                <h2>Leads com negócio fechado por usuário</h2>
              </header>
              <HorizontalChart
                rows={report.closed_by_user}
                metric={(row) => row.count}
                onLeads={openLeads}
              />
            </article>
            <article className="report-card">
              <header>
                <CalendarDays size={18} />
                <h2>Atividades em aberto por usuário</h2>
              </header>
              <HorizontalChart
                rows={report.open_activities_by_user}
                metric={(row) => row.count}
                onLeads={openLeads}
              />
            </article>
          </section>
        </>
      )}

      {selected && report && (
        <Modal
          title={selected.title}
          description={`${selected.ids.length} lead${selected.ids.length === 1 ? '' : 's'} no período selecionado`}
          onClose={() => setSelected(null)}
        >
          <div className="report-lead-list">
            {selected.ids.map((id) => (
              <button
                key={id}
                onClick={() => {
                  setSelected(null);
                  onOpen(id);
                }}
              >
                <span>{report.leads[id]?.name ?? 'Lead removido'}</span>
                <span>
                  Abrir <ArrowUpRight size={15} />
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
