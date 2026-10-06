import { useEffect, useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import { api, type Detail } from './api';
import { dateLabel } from './components';

interface Performance {
  period: { from: string; to: string } | null;
  coverage_complete: boolean;
  performance: {
    spend: number;
    cpl: number | null;
    currency: string | null;
    attributed_leads: number;
    scheduled: number;
    attended: number;
    sales: number;
    sales_value: number | null;
    roas: number | null;
  } | null;
}
const currency = (amount: number | null, code: string | null = 'BRL') =>
  amount === null
    ? '—'
    : /^[A-Z]{3}$/.test(code ?? '')
      ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: code! }).format(amount)
      : amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 });

function safeReferenceUrl(value?: string | null) {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

const periodFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});
function periodDateLabel(value: string) {
  // A reporting day is a calendar date, not an instant in the user's time zone.
  const date = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(date.getTime())
    ? periodFormatter.format(date)
    : '—';
}

export function LeadMarketing({ detail, isManager }: { detail: Detail; isManager: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<Performance | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setExpanded(false);
    setData(null);
    setError('');
  }, [detail.id]);
  useEffect(() => {
    if (!expanded || !isManager) return;
    const controller = new AbortController();
    setData(null);
    setError('');
    void api<Performance>(`/opportunities/${detail.id}/acquisition-performance`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [expanded, isManager, detail.id, detail.version]);
  if (!detail.can_edit || (detail.channel !== 'instagram' && !detail.attributions.length))
    return null;
  const initialId = detail.acquisition?.kind === 'paid' ? detail.acquisition.ad_id : null;
  const ids = [
    ...new Set(
      [initialId, ...detail.attributions.map((a) => a.source_id)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const organic = detail.acquisition?.kind === 'organic' || (!detail.acquisition && !ids.length);
  return (
    <section className="meta-attributions" aria-label="Origem do lead">
      <header>
        <div>
          <span>ORIGEM DO LEAD</span>
          <h3>{initialId ? 'Meta Ads' : organic ? 'Orgânica' : 'Referências de anúncios'}</h3>
        </div>
        {initialId && (
          <span className="verified-origin">
            <ShieldCheck size={14} /> Verificada
          </span>
        )}
      </header>
      {ids.map((adId) => {
        const ad = detail.marketing_ads?.find((item) => item.ad_id === adId);
        const reference = detail.attributions.find((item) => item.source_id === adId);
        const postUrl = safeReferenceUrl(ad?.post_url);
        const referenceUrl = detail.attributions
          .filter((item) => item.source_id === adId)
          .map((item) => safeReferenceUrl(item.source_url))
          .find((url) => url !== null);
        const originUrl = postUrl || referenceUrl;
        return (
          <article className="meta-attribution" key={adId}>
            <div className="meta-attribution-title">
              <strong>{ad?.ad_name || reference?.headline || `Anúncio ${adId}`}</strong>
              <span>{adId === initialId ? 'Origem inicial' : 'Interação com anúncio'}</span>
            </div>
            <dl>
              {ad?.campaign_name && (
                <div>
                  <dt>Campanha</dt>
                  <dd>{ad.campaign_name}</dd>
                </div>
              )}
              {ad?.adset_name && (
                <div>
                  <dt>Conjunto</dt>
                  <dd>{ad.adset_name}</dd>
                </div>
              )}
              <div>
                <dt>ID do anúncio</dt>
                <dd>{adId}</dd>
              </div>
              {(adId === initialId || reference) && (
                <div>
                  <dt>Recebido em</dt>
                  <dd>
                    {dateLabel(
                      adId === initialId ? detail.acquisition!.occurred_at : reference!.received_at,
                      true,
                    )}
                  </dd>
                </div>
              )}
            </dl>
            {ad?.reference_text && <p>Texto de referência: {ad.reference_text}</p>}
            {originUrl ? (
              <a href={originUrl} target="_blank" rel="noopener noreferrer">
                {postUrl ? 'Publicação vinculada ao anúncio' : 'Abrir referência enviada pela Meta'}{' '}
                <ArrowUpRight size={14} />
              </a>
            ) : (
              <p>
                {ad
                  ? 'Publicação não identificada.'
                  : 'Detalhes do anúncio aguardando sincronização.'}
              </p>
            )}
            {ad?.checked_at && (
              <small>Dados do anúncio consultados em {dateLabel(ad.checked_at, true)}.</small>
            )}
          </article>
        );
      })}
      {detail.attributions_has_more && (
        <p className="meta-attribution">
          Exibindo as 20 referências mais recentes e a origem inicial. O restante permanece no
          histórico armazenado.
        </p>
      )}
      {isManager && initialId && (
        <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
          <summary>Desempenho do anúncio</summary>
          <div className="meta-attribution">
            {error ? (
              <p role="status">{error}</p>
            ) : !data ? (
              <p>Consultando dados salvos…</p>
            ) : (
              <>
                {data.period && (
                  <p>
                    Período: {periodDateLabel(data.period.from)} a {periodDateLabel(data.period.to)}
                    .
                  </p>
                )}
                {!data.coverage_complete && (
                  <p>Investimento parcial: o período ainda não foi totalmente sincronizado.</p>
                )}
                {data.performance ? (
                  <dl>
                    <div>
                      <dt>Investimento do anúncio</dt>
                      <dd>{currency(data.performance.spend, data.performance.currency)}</dd>
                    </div>
                    <div>
                      <dt>Custo médio por lead</dt>
                      <dd>{currency(data.performance.cpl, data.performance.currency)}</dd>
                    </div>
                    <div>
                      <dt>Leads atribuídos</dt>
                      <dd>{data.performance.attributed_leads}</dd>
                    </div>
                    <div>
                      <dt>Agendaram / compareceram</dt>
                      <dd>
                        {data.performance.scheduled} / {data.performance.attended}
                      </dd>
                    </div>
                    <div>
                      <dt>Vendas registradas</dt>
                      <dd>{data.performance.sales}</dd>
                    </div>
                  </dl>
                ) : (
                  <p>Desempenho ainda indisponível.</p>
                )}
                <small>
                  Resultados do anúncio no período; o custo médio não representa o custo individual
                  deste lead.
                </small>
              </>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
