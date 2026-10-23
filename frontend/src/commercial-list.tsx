import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { useCommercialEnabled } from './commercial-panel';
import {
  commercialDate,
  commercialMoney,
  commercialReasons,
  type CommercialAssessment,
} from './commercial-api';
interface ListResult {
  total: number;
  page: number;
  page_size: number;
  rows: {
    id: string;
    name: string;
    owner_id: string;
    beneficiary_id: string | null;
    sale_registered: boolean;
    assessment: CommercialAssessment;
  }[];
}
export function CommercialList({
  user,
  users,
  onOpen,
  revision,
}: {
  user: User;
  users: User[];
  onOpen: (id: string) => void;
  revision: number;
}) {
  const enabled = useCommercialEnabled();
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState('');
  const [status, setStatus] = useState('pending');
  const [period, setPeriod] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    owner: user.role === 'manager' ? owner : '',
    status,
    period,
    page: String(page),
  }).toString();
  useEffect(() => {
    if (!enabled || !open) return;
    let active = true,
      pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      setBusy(true);
      try {
        const result = await api<ListResult>(`/commercial/cases?${query}`, {
          signal: controller.signal,
        });
        if (active) {
          setData(result);
          setPage(result.page);
          setError('');
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        pending = false;
        if (active) setBusy(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled, open, query, revision]);
  if (!enabled) return null;
  return (
    <details
      className="ce-list"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Sinal, contratos e elegibilidade de comissão</summary>
      <p className="ce-note">
        Acompanhe as vendas registradas, mesmo sem anexos, e os casos com documentos enviados. Os
        valores declarados no cadastro não são comprovantes.
      </p>
      <div className="ce-list-controls">
        <label>
          Situação
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="pending">Com pendências</option>
            <option value="eligible">Elegíveis</option>
            <option value="all">Todos os casos</option>
          </select>
        </label>
        {user.role === 'manager' && (
          <label>
            Consultor responsável
            <select
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Toda a equipe</option>
              {users
                .filter((u) => u.role === 'attendant')
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.active ? '' : ' (inativo)'}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Competência apurada
          <input
            type="month"
            value={period}
            onChange={(e) => {
              setPeriod(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="ce-note" role="status">
          Atualizando casos…
        </p>
      )}
      {!busy && data?.rows.length === 0 && (
        <p className="ce-note">Nenhum caso encontrado para esses filtros.</p>
      )}
      {data?.rows.map((row) => (
        <div className="ce-list-item" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <small>{users.find((u) => u.id === row.owner_id)?.name ?? 'Sem responsável'}</small>
            {user.role === 'manager' &&
              row.beneficiary_id &&
              row.beneficiary_id !== row.owner_id && (
                <small>
                  Consultor da apuração:{' '}
                  {users.find((u) => u.id === row.beneficiary_id)?.name ?? 'Consultar histórico'}
                </small>
              )}
            {user.role === 'manager' && row.sale_registered && !row.beneficiary_id && (
              <small>
                Consultor da venda sem identificação histórica. Conferir antes do pagamento.
              </small>
            )}
            <small>
              {row.assessment.eligible
                ? 'Elegível para comissão'
                : row.assessment.reasons.map((r) => commercialReasons[r] ?? r).join(' · ')}
            </small>
          </div>
          <div>
            <strong>{commercialMoney(row.assessment.confirmed_cents)}</strong>
            <small>Sinal confirmado</small>
            {row.assessment.expected_payment_on && (
              <small>Previsão: {commercialDate(row.assessment.expected_payment_on)}</small>
            )}
          </div>
          <button type="button" className="button outline" onClick={() => onOpen(row.id)}>
            Abrir paciente
          </button>
        </div>
      ))}
      {data && (
        <div className="ce-list-pagination">
          <button
            type="button"
            className="button outline"
            disabled={busy || page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Anterior
          </button>
          <span>
            {data.total} casos · Página {page} de{' '}
            {Math.max(1, Math.ceil(data.total / data.page_size))}
          </span>
          <button
            type="button"
            className="button outline"
            disabled={busy || page * data.page_size >= data.total}
            onClick={() => setPage(page + 1)}
          >
            Próxima
          </button>
        </div>
      )}
    </details>
  );
}
