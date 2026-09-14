import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { LayoutGrid, List } from 'lucide-react';
import type { Lead } from './api';
import { Badge, Empty } from './components';

type View = 'list' | 'cards';
const preferenceKey = 'artisti.attendant-view';

function savedView(): View | null {
  try {
    const value = localStorage.getItem(preferenceKey);
    return value === 'list' || value === 'cards' ? value : null;
  } catch {
    return null;
  }
}

export function AttendantLeads({
  leads,
  pool,
  onOpen,
  action,
}: {
  leads: Lead[];
  pool: boolean;
  onOpen: (id: string) => void;
  action: (lead: Lead) => ReactNode;
}) {
  const [preference, setPreference] = useState<View | null>(savedView);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1024px)').matches);
  useEffect(() => {
    const viewport = window.matchMedia('(max-width: 1024px)');
    const update = () => setMobile(viewport.matches);
    viewport.addEventListener('change', update);
    return () => viewport.removeEventListener('change', update);
  }, []);
  const view = preference ?? (mobile ? 'list' : 'cards');
  const selectView = (value: View) => {
    setPreference(value);
    try {
      localStorage.setItem(preferenceKey, value);
    } catch {
      /* Session preference still works. */
    }
  };
  const rows = pool
    ? leads
    : [...leads].sort(
        (a, b) =>
          Number(b.state === 'RESERVED') - Number(a.state === 'RESERVED') ||
          (a.state === 'RESERVED' && b.state === 'RESERVED'
            ? Date.parse(a.expires_at!) - Date.parse(b.expires_at!)
            : 0),
      );
  const newCount = pool ? rows.length : rows.filter((lead) => lead.state === 'RESERVED').length;

  return (
    <section className="attendant-workspace" aria-label={pool ? 'Leads do bolsão' : 'Meus leads'}>
      <div className="attendant-toolbar">
        <p className="attendant-summary">
          <span className="status-dot" />
          {pool
            ? `${newCount} ${newCount === 1 ? 'lead disponível' : 'leads disponíveis'}`
            : `${newCount} ${newCount === 1 ? 'novo lead' : 'novos leads'}`}
        </p>
        <div className="view-switch" role="group" aria-label="Visualização dos leads">
          <button aria-pressed={view === 'list'} onClick={() => selectView('list')}>
            <List size={16} /> Lista
          </button>
          <button aria-pressed={view === 'cards'} onClick={() => selectView('cards')}>
            <LayoutGrid size={16} /> Cartões
          </button>
        </div>
      </div>
      <div className={`lead-cards attendant-leads is-${view}`}>
        {rows.map((lead, index) => (
          <Fragment key={lead.id}>
            {(index === 0 ||
              (rows[index - 1].state === 'RESERVED') !== (lead.state === 'RESERVED')) && (
              <div className="lead-section-heading">
                <h2>
                  {pool
                    ? 'Disponíveis para assumir'
                    : lead.state === 'RESERVED'
                      ? 'Novos leads'
                      : 'Seus atendimentos'}
                </h2>
              </div>
            )}
            <article
              className={`lead-card attendant-lead ${lead.state === 'RESERVED' ? 'reserved-card' : ''}`}
            >
              <button
                className="attendant-lead-details"
                onClick={() => onOpen(lead.id)}
                aria-label={`Abrir ficha de ${lead.name}`}
              >
                <Badge state={lead.state} />
                <strong>{lead.name}</strong>
              </button>
              <div className="attendant-lead-actions">{action(lead)}</div>
            </article>
          </Fragment>
        ))}
      </div>
      {!rows.length && (
        <section className="panel">
          <Empty
            title={pool ? 'Tudo encaminhado por aqui' : 'Nenhum atendimento pendente'}
            description={
              pool
                ? 'Novas oportunidades disponíveis aparecerão aqui.'
                : 'Seus novos leads aparecerão aqui.'
            }
          />
        </section>
      )}
    </section>
  );
}
