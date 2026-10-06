import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';

interface LeadPage {
  items: { id: string; name: string; owner_name: string | null }[];
  next_cursor: string | null;
}

export function MarketingLeads({
  ad,
  period,
  onClose,
  onOpen,
  onSessionExpired,
}: {
  ad: { ad_id: string; ad_name: string };
  period: { from: string; to: string };
  onClose: () => void;
  onOpen: (id: string) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const [after, setAfter] = useState<string | null>(null);
  const [data, setData] = useState<LeadPage | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const query = new URLSearchParams({ ...period, ad_id: ad.ad_id, ...(after ? { after } : {}) });
    void api<LeadPage>(`/reports/meta-ads/leads?${query}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && reason.status === 401) void onSessionExpired();
        else setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [ad.ad_id, period.from, period.to, after, onSessionExpired]);
  return (
    <Modal
      title={ad.ad_name}
      description="Leads atribuídos no período selecionado"
      onClose={onClose}
    >
      <div className="report-lead-list" aria-busy={busy}>
        {error && <p role="alert">{error}</p>}
        {busy ? (
          <p>Carregando…</p>
        ) : (
          data?.items.map((lead) => (
            <button
              key={lead.id}
              onClick={() => {
                onClose();
                onOpen(lead.id);
              }}
            >
              <span>
                {lead.name}
                <small className="marketing-lead-owner">
                  {lead.owner_name || 'Ainda não assumido'}
                </small>
              </span>
              <span>
                Abrir <ArrowUpRight size={15} />
              </span>
            </button>
          ))
        )}
        {!busy && !error && !data?.items.length && <p>Nenhum lead encontrado.</p>}
        <div className="reports-filter">
          {after && (
            <button
              type="button"
              className="button outline compact"
              disabled={busy}
              onClick={() => setAfter(null)}
            >
              Início da lista
            </button>
          )}
          {data?.next_cursor && (
            <button
              type="button"
              className="button outline compact"
              disabled={busy}
              onClick={() => setAfter(data.next_cursor)}
            >
              Próxima página
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
