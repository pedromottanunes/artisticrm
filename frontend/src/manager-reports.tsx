import { qualityReasons } from './lead-quality';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  AlarmClock,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Inbox,
  Megaphone,
  MessageSquareReply,
  RefreshCw,
  TrendingUp,
  Users,
} from 'lucide-react';
import { api, ApiError } from './api';
import { Empty, Modal } from './components';
import { MarketingLeads } from './marketing-leads';

interface ReportRanking {
  user_id: string;
  name: string;
  count: number;
  lead_ids: string[];
  average_minutes?: number;
}
interface ReportOverview {
  quality?: {
    total_entries: number;
    non_commercial: number;
    commercial: number;
    reasons: Record<string, number>;
  };
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

interface MetaMarketingStatus {
  configured: boolean;
  state: 'disabled' | 'idle' | 'syncing' | 'error';
  account_id?: string;
  last_completed_at: string | null;
  last_error: string | null;
  rows_synced: number;
  queued?: boolean;
  requested_from?: string | null;
  requested_to?: string | null;
  paused_until?: string | null;
}

interface MetaMarketingSyncRequest {
  queued: boolean;
  already_requested: boolean;
  requested_from: string | null;
  requested_to: string | null;
  retry_after: string | null;
}

type MetaAdGroup = 'with_leads' | 'without_leads' | 'all';

interface MetaAdReportRow {
  ad_id: string;
  ad_name: string;
  campaign_name: string;
  adset_name: string;
  post_url: string | null;
  scope: string;
  spend: number;
  currency: string | null;
  clicks: number;
  attributed_leads: number;
  non_commercial_leads: number;
  scheduled: number;
  attended: number;
  no_show: number;
  sales: number;
  signed: number;
  sales_value: number | null;
  cpl: number | null;
  cost_per_scheduled: number | null;
  cost_per_sale: number | null;
  roas: number | null;
}

interface MetaAdsReport {
  period: { from: string; to: string };
  currency: string | null;
  spend: number;
  instagram_leads: number;
  instagram_entries: number;
  non_commercial_leads: number;
  identified_paid_leads: number;
  identified_paid_non_commercial_leads: number;
  matched_attributed_leads: number;
  unmatched_attributed_leads: number;
  unattributed_or_organic_leads: number;
  unattributed_or_organic_non_commercial_leads: number;
  cpl: number | null;
  eligible_spend: number;
  coverage_complete: boolean;
  limited: boolean;
  total: number;
  page: number;
  page_size?: number;
  ad_groups?: Record<MetaAdGroup, number>;
  ads: MetaAdReportRow[];
  campaigns: {
    campaign_id: string;
    campaign_name: string;
    currency: string;
    spend: number;
    impressions: number;
    reach: number | null;
    clicks: number;
    attributed_leads: number;
    non_commercial_leads: number;
    cpl: number | null;
  }[];
  last_sync: string | null;
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

const money = (value: number | null, currency: string | null) => {
  if (value === null) return '—';
  if (!currency || currency === 'MIXED')
    return value.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
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

function MetaAdResult({
  ad,
  currency,
  coverageComplete,
  onLeads,
}: {
  ad: MetaAdReportRow;
  currency: string | null;
  coverageComplete: boolean;
  onLeads: (ad: MetaAdReportRow) => void;
}) {
  const contacts = ad.attributed_leads + ad.non_commercial_leads;
  const direct = ad.scope === 'instagram_direct';
  const cpl =
    ad.cpl !== null
      ? money(ad.cpl, ad.currency || currency)
      : !coverageComplete
        ? 'Calculando'
        : direct && ad.attributed_leads === 0
          ? 'Sem leads'
          : 'Não se aplica';
  return (
    <article className="meta-ad-result">
      <div className="meta-ad-identity">
        <span className={`meta-ad-source ${contacts ? 'confirmed' : ''}`}>
          {contacts
            ? 'Anúncio identificado'
            : direct
              ? 'Anúncio para o Direct'
              : 'Fora do cálculo de custo'}
        </span>
        <h3>{ad.ad_name}</h3>
        <p>{ad.campaign_name || 'Campanha ainda não identificada'}</p>
        {ad.adset_name && <small>{ad.adset_name}</small>}
        <div className="meta-ad-origin-actions">
          {ad.post_url ? (
            <a href={ad.post_url} target="_blank" rel="noopener noreferrer">
              Ver post no Instagram <ArrowUpRight size={13} />
            </a>
          ) : (
            <span>Publicação ainda não localizada</span>
          )}
        </div>
      </div>
      <dl className="meta-ad-metrics">
        <div>
          <dt>Investido</dt>
          <dd>{money(ad.spend, ad.currency || currency)}</dd>
        </div>
        <div>
          <dt>Leads comerciais</dt>
          <dd>{ad.attributed_leads}</dd>
          {ad.non_commercial_leads > 0 && <small>+ {ad.non_commercial_leads} não comerciais</small>}
        </div>
        <div>
          <dt>Custo médio por lead</dt>
          <dd>{cpl}</dd>
        </div>
        <div>
          <dt>Agendaram</dt>
          <dd>{ad.scheduled}</dd>
        </div>
        <div>
          <dt>Compareceram</dt>
          <dd>{ad.attended}</dd>
        </div>
        <div>
          <dt>Vendas</dt>
          <dd>{ad.sales}</dd>
          <small>{money(ad.sales_value, 'BRL')} registrado</small>
        </div>
      </dl>
      <div className="meta-ad-result-actions">
        {contacts > 0 ? (
          <button
            type="button"
            className="button outline compact"
            aria-label={`Ver ${contacts} contatos de ${ad.ad_name}`}
            onClick={() => onLeads(ad)}
          >
            Ver {contacts} contato{contacts === 1 ? '' : 's'}
          </button>
        ) : (
          <span>Nenhum lead atribuído neste período</span>
        )}
      </div>
    </article>
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
  useEffect(() => {
    const changed = () => setRevision((value) => value + 1);
    window.addEventListener('artisti-lead-quality', changed);
    return () => window.removeEventListener('artisti-lead-quality', changed);
  }, []);
  const [selected, setSelected] = useState<{ title: string; ids: string[] } | null>(null);
  const [metaStatus, setMetaStatus] = useState<MetaMarketingStatus | null>(null);
  const [metaAds, setMetaAds] = useState<MetaAdsReport | null>(null);
  const [metaBusy, setMetaBusy] = useState(true);
  const [metaSyncing, setMetaSyncing] = useState(false);
  const [metaError, setMetaError] = useState('');
  const [metaPage, setMetaPage] = useState(1);
  const [metaAdGroup, setMetaAdGroup] = useState<MetaAdGroup>('with_leads');
  const [metaReportRevision, setMetaReportRevision] = useState(0);
  const [metaNotice, setMetaNotice] = useState('');
  const [selectedAd, setSelectedAd] = useState<{ ad_id: string; ad_name: string } | null>(null);

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

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    void api<MetaMarketingStatus>('/meta-marketing/status', { signal: controller.signal })
      .then((status) => {
        if (disposed) return;
        setMetaStatus(status);
        if (!status.configured) {
          setMetaAds(null);
          setMetaError('');
          setMetaBusy(false);
        }
      })
      .catch((loadError) => {
        if (disposed || controller.signal.aborted) return;
        setMetaBusy(false);
        if (loadError instanceof ApiError && loadError.status === 401) {
          void onSessionExpired();
          return;
        }
        setMetaError((loadError as Error).message);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [revision, onSessionExpired]);

  useEffect(() => {
    if (!metaStatus?.configured) return;
    let disposed = false;
    const controller = new AbortController();
    setMetaBusy(true);
    setMetaAds(null);
    void api<MetaAdsReport>(
      `/reports/meta-ads?${new URLSearchParams({
        ...query,
        page: String(metaPage),
        ad_group: metaAdGroup,
      }).toString()}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (disposed) return;
        setMetaAds(result);
        setMetaError('');
      })
      .catch((loadError) => {
        if (disposed || controller.signal.aborted) return;
        if (loadError instanceof ApiError && loadError.status === 401) {
          void onSessionExpired();
          return;
        }
        setMetaError((loadError as Error).message);
      })
      .finally(() => {
        if (!disposed) setMetaBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [
    query,
    revision,
    metaReportRevision,
    metaPage,
    metaAdGroup,
    metaStatus?.configured,
    onSessionExpired,
  ]);

  const metaUpdatePending = Boolean(
    metaStatus?.configured && (metaStatus.queued || metaStatus.state === 'syncing'),
  );

  useEffect(() => {
    if (!metaUpdatePending) return;
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const status = await api<MetaMarketingStatus>('/meta-marketing/status', {
          signal: controller.signal,
        });
        if (disposed) return;
        setMetaStatus(status);
        if (!status.queued && status.state !== 'syncing') {
          setMetaNotice(
            'Atualização concluída. O relatório já está usando os dados mais recentes.',
          );
          setMetaReportRevision((value) => value + 1);
          return;
        }
      } catch (loadError) {
        if (disposed || controller.signal.aborted) return;
        if (loadError instanceof ApiError && loadError.status === 401) {
          void onSessionExpired();
          return;
        }
      }
      timer = window.setTimeout(() => void poll(), 60_000);
    };
    timer = window.setTimeout(() => void poll(), 60_000);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
    };
  }, [metaUpdatePending, onSessionExpired]);

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
    setMetaPage(1);
  };
  const openLeads = (title: string, ids: string[]) => {
    if (ids.length) setSelected({ title, ids });
  };
  const maxDaily = Math.max(1, ...(report?.same_day_interactions.map((item) => item.count) ?? []));
  const received = report?.funnel[0]?.count ?? 0;
  const syncMetaAds = async () => {
    setMetaSyncing(true);
    setMetaError('');
    try {
      const result = await api<MetaMarketingSyncRequest>('/meta-marketing/sync', {
        method: 'POST',
        body: JSON.stringify({ from: query.from, to: query.to }),
      });
      setMetaStatus((status) =>
        status
          ? {
              ...status,
              queued: result.queued,
              requested_from: result.requested_from,
              requested_to: result.requested_to,
            }
          : status,
      );
      const selectedPeriod = `${shortDate(query.from)} a ${shortDate(query.to)}`;
      const queuedPeriod =
        result.requested_from && result.requested_to
          ? `${shortDate(result.requested_from)} a ${shortDate(result.requested_to)}`
          : null;
      const samePeriod = result.requested_from === query.from && result.requested_to === query.to;
      setMetaNotice(
        !result.already_requested
          ? `Atualização de ${selectedPeriod} agendada. O relatório será recarregado quando ela terminar.`
          : result.queued && samePeriod
            ? `O período de ${selectedPeriod} já está sendo atualizado. Nenhuma nova chamada foi feita à Meta.`
            : result.queued && queuedPeriod
              ? `Já existe uma atualização de ${queuedPeriod} em andamento. O período selecionado não gerou outra chamada à Meta.`
              : `Os dados foram atualizados recentemente. Para proteger a API da Meta, aguarde alguns minutos antes de solicitar outra atualização.`,
      );
    } catch (syncError) {
      if (syncError instanceof ApiError && syncError.status === 401) {
        await onSessionExpired();
        return;
      }
      setMetaError((syncError as Error).message);
    } finally {
      setMetaSyncing(false);
    }
  };

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
          {report.quality && (
            <section className="panel quality-report" aria-label="Qualidade das entradas">
              <strong>
                {report.quality.total_entries} entradas · {report.quality.commercial} leads
                comerciais · {report.quality.non_commercial} não comerciais
              </strong>
              <p>
                {Object.entries(report.quality.reasons)
                  .map(([reason, count]) => `${qualityReasons[reason]}: ${count}`)
                  .join(' · ')}
              </p>
            </section>
          )}
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

          <div className="reports-section-heading meta-ads-heading">
            <Megaphone size={17} />
            <div>
              <h2>Origem dos leads do Instagram</h2>
              <p>Veja quais anúncios trouxeram contatos e o que aconteceu depois.</p>
            </div>
            {metaStatus?.configured && (
              <button
                className="button outline compact"
                type="button"
                disabled={metaSyncing || metaUpdatePending}
                onClick={() => void syncMetaAds()}
              >
                <RefreshCw size={14} />
                {metaSyncing
                  ? 'Solicitando'
                  : metaUpdatePending
                    ? 'Atualização em andamento'
                    : 'Atualizar dados'}
              </button>
            )}
          </div>
          {metaError && <div className="reports-error">{metaError}</div>}
          {metaNotice && (
            <p className="meta-ads-note" role="status">
              {metaNotice}
            </p>
          )}
          {!metaError && metaStatus?.state === 'error' && (
            <div className="reports-error">
              A última sincronização de anúncios falhou. Os dados abaixo são da última atualização
              concluída. A rotina respeita o prazo de retomada da Meta. Se houver falta de
              autorização, confira a conexão.
            </div>
          )}
          {!metaBusy && metaStatus && !metaStatus.configured ? (
            <section className="meta-ads-disabled">
              <Megaphone size={22} />
              <div>
                <strong>Marketing API ainda não conectada</strong>
                <p>
                  O atendimento do Instagram continua funcionando. Para exibir investimento e CPL,
                  configure separadamente a conta de anúncios e o token com <code>ads_read</code>.
                </p>
              </div>
            </section>
          ) : null}
          {metaBusy && !metaAds ? (
            <p className="reports-loading compact">Consultando anúncios…</p>
          ) : null}
          {metaAds ? (
            <section className="meta-ads-panel">
              <div className="meta-ads-updated">
                <CheckCircle2 size={15} />
                <span>
                  Período analisado: {shortDate(metaAds.period.from)} a{' '}
                  {shortDate(metaAds.period.to)} ·{' '}
                  {metaStatus?.queued || metaStatus?.state === 'syncing'
                    ? `Atualização em andamento${
                        metaStatus.requested_from && metaStatus.requested_to
                          ? ` para ${shortDate(metaStatus.requested_from)} a ${shortDate(metaStatus.requested_to)}`
                          : ''
                      }, sem interromper o atendimento.`
                    : metaAds.last_sync
                      ? `Dados atualizados em ${new Date(metaAds.last_sync).toLocaleString('pt-BR')}.`
                      : 'Aguardando a primeira atualização.'}
                </span>
              </div>
              <div className="meta-ads-summary">
                <article>
                  <CircleDollarSign size={18} />
                  <span>Investido em anúncios para o Direct</span>
                  <strong>{money(metaAds.eligible_spend, metaAds.currency)}</strong>
                  <small>Conta toda: {money(metaAds.spend, metaAds.currency)}</small>
                </article>
                <article>
                  <MessageSquareReply size={18} />
                  <span>Leads que vieram de anúncio</span>
                  <strong>{metaAds.identified_paid_leads}</strong>
                  <small>{metaAds.matched_attributed_leads} ligados ao anúncio exato</small>
                </article>
                <article>
                  <TrendingUp size={18} />
                  <span>Anúncio exato identificado</span>
                  <strong>{metaAds.matched_attributed_leads}</strong>
                  <small>{metaAds.unmatched_attributed_leads} ainda aguardam identificação</small>
                </article>
                <article>
                  <CircleDollarSign size={18} />
                  <span>Custo médio por lead</span>
                  <strong>
                    {metaAds.coverage_complete
                      ? money(metaAds.cpl, metaAds.currency)
                      : 'Calculando'}
                  </strong>
                  <small>Somente anúncios confirmados para o Direct</small>
                </article>
              </div>
              <section
                className="meta-origin-breakdown"
                aria-label="De onde vieram os leads comerciais"
              >
                <div className="meta-origin-heading">
                  <div>
                    <h3>De onde vieram os {metaAds.instagram_leads} leads comerciais?</h3>
                    <p>
                      O CRM separa origem confirmada de contatos sem referência enviada pela Meta.
                    </p>
                  </div>
                  <span>
                    {metaAds.non_commercial_leads} contatos não comerciais ficam fora do custo
                  </span>
                </div>
                {metaAds.instagram_leads > 0 ? (
                  <>
                    <div
                      className="meta-origin-bar"
                      role="img"
                      aria-label={`${metaAds.matched_attributed_leads} com anúncio identificado, ${metaAds.unmatched_attributed_leads} vindos de anúncio ainda não identificado e ${metaAds.unattributed_or_organic_leads} sem referência de anúncio`}
                    >
                      <i
                        className="identified"
                        style={{
                          width: `${(metaAds.matched_attributed_leads / metaAds.instagram_leads) * 100}%`,
                        }}
                      />
                      <i
                        className="pending"
                        style={{
                          width: `${(metaAds.unmatched_attributed_leads / metaAds.instagram_leads) * 100}%`,
                        }}
                      />
                      <i
                        className="unattributed"
                        style={{
                          width: `${(metaAds.unattributed_or_organic_leads / metaAds.instagram_leads) * 100}%`,
                        }}
                      />
                    </div>
                    <div className="meta-origin-legend">
                      <div className="identified">
                        <i />
                        <p>
                          <strong>{metaAds.matched_attributed_leads} · Anúncio identificado</strong>
                          <span>Sabemos exatamente qual anúncio trouxe o lead.</span>
                        </p>
                      </div>
                      <div className="pending">
                        <i />
                        <p>
                          <strong>
                            {metaAds.unmatched_attributed_leads} · Identificação pendente
                          </strong>
                          <span>Sabemos que foi pago, mas ainda falta ligar ao anúncio.</span>
                        </p>
                      </div>
                      <div className="unattributed">
                        <i />
                        <p>
                          <strong>
                            {metaAds.unattributed_or_organic_leads} · Sem referência de anúncio
                          </strong>
                          <span>Pode ser orgânico ou uma atribuição não enviada pela Meta.</span>
                        </p>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="meta-origin-empty">Nenhum lead comercial neste período.</p>
                )}
              </section>
              {!metaAds.coverage_complete && (
                <p className="meta-ads-sync-note">
                  A atualização deste período ainda está terminando. Os custos médios aparecerão
                  automaticamente quando todos os dias forem consultados.
                </p>
              )}
              {metaAds.limited && (
                <p className="meta-ads-sync-note warning">
                  Há dados demais para este período. Escolha um intervalo menor para ver os totais
                  completos.
                </p>
              )}
              <div className="meta-ads-list-heading">
                <div>
                  <h3>Desempenho por anúncio</h3>
                  <p>Comece pelos anúncios que realmente trouxeram contatos.</p>
                </div>
                <div
                  className="meta-ad-tabs"
                  role="group"
                  aria-label="Filtrar anúncios por resultado"
                >
                  {(
                    [
                      ['with_leads', 'Trouxeram leads'],
                      ['without_leads', 'Não trouxeram leads'],
                      ['all', 'Todos'],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={metaAdGroup === value}
                      onClick={() => {
                        setMetaAdGroup(value);
                        setMetaPage(1);
                      }}
                    >
                      {label}
                      {metaAds.ad_groups ? ` (${metaAds.ad_groups[value]})` : ''}
                    </button>
                  ))}
                </div>
              </div>
              {metaAds.ads?.length ? (
                <div className="meta-ads-results">
                  {metaAds.ads.map((ad) => (
                    <MetaAdResult
                      key={ad.ad_id}
                      ad={ad}
                      currency={metaAds.currency}
                      coverageComplete={metaAds.coverage_complete}
                      onLeads={setSelectedAd}
                    />
                  ))}
                </div>
              ) : (
                <p className="report-empty-line">
                  {metaAdGroup === 'with_leads'
                    ? 'Nenhum anúncio trouxe leads neste período.'
                    : metaAdGroup === 'without_leads'
                      ? 'Todos os anúncios deste período possuem algum contato atribuído.'
                      : 'Nenhum anúncio encontrado no período selecionado.'}
                </p>
              )}
              {metaAds.total > (metaAds.page_size ?? 50) && (
                <div className="reports-filter">
                  <button
                    className="button outline compact"
                    type="button"
                    disabled={metaPage <= 1 || metaBusy}
                    onClick={() => setMetaPage((page) => page - 1)}
                  >
                    Anterior
                  </button>
                  <span>
                    Página {metaPage} de {Math.ceil(metaAds.total / (metaAds.page_size ?? 50))}
                  </span>
                  <button
                    className="button outline compact"
                    type="button"
                    disabled={metaPage * (metaAds.page_size ?? 50) >= metaAds.total || metaBusy}
                    onClick={() => setMetaPage((page) => page + 1)}
                  >
                    Próxima
                  </button>
                </div>
              )}
              <footer>
                O custo por lead é a média do anúncio no período, não o preço individual de cada
                pessoa. Valores de vendas são registros comerciais e não comprovantes de pagamento.
              </footer>
            </section>
          ) : null}

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

      {selectedAd && (
        <MarketingLeads
          key={selectedAd.ad_id}
          ad={selectedAd}
          period={query}
          onClose={() => setSelectedAd(null)}
          onOpen={onOpen}
          onSessionExpired={onSessionExpired}
        />
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
